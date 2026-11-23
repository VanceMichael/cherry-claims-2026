// 采收服务 HTTP 接口：小票追溯报告、单批处置申请、服务健康检查。
// 处置申请通过操作号保持幂等；申请后强制回读售后台，已受理克数不会重复申请。

import http from 'node:http'
import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildTicketReport } from './report.mjs'
import { RefundClient, RefundError } from './refund-client.mjs'
import { SourceError } from './source-client.mjs'
import { ColdError } from './cold-client.mjs'

const DEFAULT_PORT = 8702

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload, null, 2))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

export function createHarvestService(options = {}) {
  const config = {
    sourceUrl: process.env.SOURCE_URL || 'http://127.0.0.1:8700',
    providerUrl: process.env.PROVIDER_URL || 'http://127.0.0.1:8701',
    journalPath: process.env.JOURNAL_PATH || './data/harvest-journal.jsonl',
    timeoutMs: Number(process.env.TIMEOUT_MS || 8000),
    ...options
  }

  async function journal(entry) {
    await mkdir(dirname(config.journalPath), { recursive: true })
    await appendFile(config.journalPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  }

  // 判定一个操作号是否已经提交过（用于区分同号重放与新的超量申请）。
  async function findJournalEntry(path, criteria) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    return entries.find(entry => Object.entries(criteria).every(([field, value]) => entry[field] === value)) ?? null
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    try {
      if (url.pathname === '/health') {
        return send(response, 200, { service: 'harvest', sourceUrl: config.sourceUrl, providerUrl: config.providerUrl })
      }

      if (request.method === 'GET' && /^\/tickets\/[^/]+\/report$/.test(url.pathname)) {
        const ticket = decodeURIComponent(url.pathname.split('/')[2])
        const edition = url.searchParams.get('edition') ?? undefined
        const report = await buildTicketReport({
          ticket, edition,
          sourceUrl: config.sourceUrl,
          providerUrl: config.providerUrl,
          timeoutMs: config.timeoutMs
        })
        return send(response, 200, report)
      }

      if (request.method === 'POST' && /^\/tickets\/[^/]+\/claims$/.test(url.pathname)) {
        const ticket = decodeURIComponent(url.pathname.split('/')[2])
        const body = await readJson(request)
        const line = Number(body.line)
        const lot = String(body.lot)
        const requestedGrams = body.grams === undefined ? undefined : Number(body.grams)
        const key = String(body.key ?? `${ticket}-${line}-${lot}`)

        // 申请前先用最新凭据重算可处理范围。
        const before = await buildTicketReport({
          ticket, edition: body.edition,
          sourceUrl: config.sourceUrl,
          providerUrl: config.providerUrl,
          timeoutMs: config.timeoutMs
        })
        const lineReport = before.lines.find(item => item.line === line)
        if (!lineReport) return send(response, 404, { error: '小票行不存在', ticket, line })
        const lotReport = lineReport.lots.find(item => item.lot === lot)
        if (!lotReport) return send(response, 404, { error: '该源批不在当前混盘来源中', ticket, line, lot })
        // 证据类条件始终拦截；克数类条件在提交后结合售后台回执判断，以便重复申请拿到 409 并回读。
        const evidenceBlockers = lotReport.blockers.filter(item =>
          !['no-claimable-grams', 'over-occupied'].includes(item.reason))
        if (evidenceBlockers.length > 0) {
          return send(response, 422, {
            error: '该批当前不具备处理条件',
            blockers: lotReport.blockers,
            evidence: lotReport.evidence
          })
        }
        const grams = requestedGrams ?? lotReport.occupancy.claimableGrams
        if (!Number.isInteger(grams) || grams <= 0) {
          return send(response, 422, { error: '申请克数必须为正整数' })
        }
        // 同一操作号的重放透传给售后台，由其 409 确认并回读实际占额；
        // 新操作号一旦超量就在本地拦截，避免售后台只按票+批判重时误认成重复申请。
        const replay = await findJournalEntry(config.journalPath, { action: 'propose', ticket, line, lot, key })
        if (!replay && grams > lotReport.occupancy.claimableGrams) {
          return send(response, 422, {
            error: lotReport.occupancy.claimableGrams === 0
              ? '该批已无可用克数（份额占满或行总帽用尽），相同操作号的重复申请可凭原操作号回读'
              : '申请克数超过可处理范围（行实购帽或该批份额已占用）',
            requestedGrams: grams,
            claimableGrams: lotReport.occupancy.claimableGrams
          })
        }

        const refunds = new RefundClient(config.providerUrl, { timeoutMs: config.timeoutMs })
        const result = await refunds.propose({ ticket, line, lot, grams, key })
        await journal({ action: 'propose', ticket, line, lot, grams, key, result })

        // 无论新建还是 409 重复，都回读售后台并重建台账，保证门店看到的是实际占额。
        const after = await buildTicketReport({
          ticket, edition: body.edition,
          sourceUrl: config.sourceUrl,
          providerUrl: config.providerUrl,
          timeoutMs: config.timeoutMs
        })
        const afterLine = after.lines.find(item => item.line === line)
        const afterLot = afterLine.lots.find(item => item.lot === lot)
        return send(response, result.duplicate ? 409 : 202, {
          duplicate: result.duplicate,
          receipt: result.receipt,
          state: result.state,
          ticket, line, lot, grams, key,
          ledger: afterLine.ledger.summary,
          lot: afterLot
        })
      }

      if (request.method === 'GET' && url.pathname === '/journal') {
        try {
          const text = await readFile(config.journalPath, 'utf8')
          const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
          return send(response, 200, { entries })
        } catch (error) {
          if (error.code === 'ENOENT') return send(response, 200, { entries: [] })
          throw error
        }
      }

      return send(response, 404, { error: '没有该接口' })
    } catch (error) {
      const status = error instanceof SourceError || error instanceof ColdError || error instanceof RefundError
        ? (error.status || 502)
        : 500
      return send(response, status, { error: error.message })
    }
  })

  return { server, config }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createHarvestService()
  server.listen(Number(process.env.PORT || DEFAULT_PORT), '127.0.0.1', () => {
    console.log(`采收服务已启动：http://127.0.0.1:${process.env.PORT || DEFAULT_PORT}`)
  })
}
