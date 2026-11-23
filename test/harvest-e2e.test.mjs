import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { createHarvestService } from '../harvest/service.mjs'
import { buildTicketReport } from '../harvest/report.mjs'

async function listen(serverFactory) {
  const server = serverFactory()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port }
}

async function harness(t) {
  const source = await listen(() => createSource())
  const ext = await listen(() => provider())
  const dir = await mkdtemp(join(tmpdir(), 'harvest-'))
  const journalPath = join(dir, 'journal.jsonl')
  const harvest = await listen(() => createHarvestService({
    sourceUrl: `http://127.0.0.1:${source.port}`,
    providerUrl: `http://127.0.0.1:${ext.port}`,
    journalPath
  }).server)
  t.after(async () => {
    await Promise.all([
      new Promise(resolve => source.server.close(resolve)),
      new Promise(resolve => ext.server.close(resolve)),
      new Promise(resolve => harvest.server.close(resolve)),
      rm(dir, { recursive: true, force: true })
    ])
  })
  return {
    sourceRoot: `http://127.0.0.1:${source.port}`,
    providerRoot: `http://127.0.0.1:${ext.port}`,
    harvestRoot: `http://127.0.0.1:${harvest.port}`,
    journalPath,
    setStage: stage => fetch(`http://127.0.0.1:${ext.port}/lab?stage=${stage}`, { method: 'POST' }).then(r => r.json()),
    setEdition: edition => fetch(`http://127.0.0.1:${source.port}/control?edition=${edition}`, { method: 'POST' }).then(r => r.json())
  }
}

const findLot = (report, line, lot) =>
  report.lines.find(item => item.line === line).lots.find(item => item.lot === lot)
const findWindow = (report, line, plate, zone) =>
  report.lines.find(item => item.line === line).windows.find(w => w.plate === plate && w.zone === zone)

test('first 档：P 北区越线可证实；Q 南区无文件覆盖只能待补', async t => {
  const h = await harness(t)
  const report = await buildTicketReport({ ticket: 'R', sourceUrl: h.sourceRoot, providerUrl: h.providerRoot })
  assert.equal(report.edition, 'r1')

  const pWindow = findWindow(report, 1, 'P', 'north')
  assert.equal(pWindow.verdict, 'confirmed-excursion')
  assert.equal(pWindow.excursionSamples[0].minute, 1)
  assert.equal(pWindow.excursionSamples[0].celsius, 7.2)
  assert.ok(pWindow.requiredFiles.some(f => f.path === '/cold/read?file=a'))

  const qWindow = findWindow(report, 1, 'Q', 'south')
  assert.equal(qWindow.verdict, 'incomplete')
  assert.ok(qWindow.gaps.every(g => g.reason === 'file-not-fetched'))
  assert.deepEqual(qWindow.requiredFiles, [])

  // L1 已被售后台受理 450 克，本批无可再申请空间；L2 证据充分且行内仍有余量，可处理 150 克。
  const l1 = findLot(report, 1, 'L1')
  const l2 = findLot(report, 1, 'L2')
  const l3 = findLot(report, 1, 'L3')
  assert.equal(l1.occupancy.claimableGrams, 0)
  assert.equal(l1.processable, false)
  assert.equal(l2.verdict, 'confirmed-excursion')
  assert.equal(l2.processable, true)
  assert.equal(l2.occupancy.claimableGrams, 150)
  assert.equal(l3.verdict, 'incomplete')
  assert.ok(l3.blockers.some(b => b.reason === 'evidence-incomplete'))

  const summary = report.lines[0].ledger.summary
  assert.deepEqual(summary, { paidGrams: 0, acceptedGrams: 450, occupiedGrams: 450, remainingGrams: 550 })
})

test('remapped 档：校正后旧越线与 P 无关，P 待补，Q 越线可按 L3 申请', async t => {
  const h = await harness(t)
  await h.setStage('remapped')
  await h.setEdition('r2')
  const report = await buildTicketReport({ ticket: 'R', sourceUrl: h.sourceRoot, providerUrl: h.providerRoot })
  assert.equal(report.edition, 'r2')

  const pWindow = findWindow(report, 1, 'P', 'north')
  assert.equal(pWindow.verdict, 'incomplete')
  assert.equal(pWindow.excursionSamples.length, 0)
  assert.deepEqual(pWindow.gaps.map(g => g.reason), ['invalid-reading'])
  assert.deepEqual(pWindow.legacy.conflict.map(c => c.minute), [1])

  const qWindow = findWindow(report, 1, 'Q', 'south')
  assert.equal(qWindow.verdict, 'confirmed-excursion')
  assert.equal(qWindow.excursionSamples[0].minute, 4)

  // r2 中 L1 已被 L4 替换，旧 H1/pay1 回执保留为争议，不消失也不重复占批。
  const line = report.lines[0]
  assert.equal(line.ledger.disputed[0].lot, 'L1')
  assert.deepEqual(line.ledger.disputed[0].receipts, ['pay1', 'H1'])
  const l3 = findLot(report, 1, 'L3')
  assert.equal(l3.processable, true)
  assert.equal(l3.occupancy.claimableGrams, 400)
  const l4 = findLot(report, 1, 'L4')
  assert.equal(l4.processable, false)
  assert.ok(l4.blockers.some(b => b.reason === 'evidence-incomplete'))

  const response = await fetch(h.harvestRoot + '/tickets/R/claims', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: 1, lot: 'L3', grams: 400, key: 'R-1-L3' })
  })
  assert.equal(response.status, 202)
  const accepted = await response.json()
  assert.equal(accepted.receipt, 'H2')
  assert.deepEqual(accepted.ledger, { paidGrams: 0, acceptedGrams: 850, occupiedGrams: 850, remainingGrams: 150 })

  // 再次申请同一批：409 回读，已受理克数不重复占用，行合计不超过实购 1000。
  const again = await fetch(h.harvestRoot + '/tickets/R/claims', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: 1, lot: 'L3', grams: 400, key: 'R-1-L3' })
  })
  assert.equal(again.status, 409)
  const conflict = await again.json()
  assert.equal(conflict.duplicate, true)
  assert.equal(conflict.ledger.occupiedGrams, 850)
  assert.equal(conflict.lot.occupancy.occupiedGrams, 400)
})

test('paid 档：财务到账后区分实际赔出与已受理未结', async t => {
  const h = await harness(t)
  await h.setStage('paid')
  await h.setEdition('r2')
  const report = await buildTicketReport({ ticket: 'R', sourceUrl: h.sourceRoot, providerUrl: h.providerRoot })
  const summary = report.lines[0].ledger.summary
  assert.equal(summary.paidGrams, 450)
  assert.equal(summary.acceptedGrams, 0)
  assert.equal(summary.remainingGrams, 550)
})

test('超帽与证据不足的申请被服务拒绝，缺凭据部分给出原因', async t => {
  const h = await harness(t)
  await h.setStage('remapped')
  await h.setEdition('r2')

  const tooLarge = await fetch(h.harvestRoot + '/tickets/R/claims', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: 1, lot: 'L3', grams: 401, key: 'oversize' })
  })
  assert.equal(tooLarge.status, 422)
  const body = await tooLarge.json()
  assert.equal(body.claimableGrams, 400)

  const blocked = await fetch(h.harvestRoot + '/tickets/R/claims', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: 1, lot: 'L2', grams: 150, key: 'blocked' })
  })
  assert.equal(blocked.status, 422)
  const blockedBody = await blocked.json()
  assert.ok(blockedBody.blockers.some(b => b.reason === 'evidence-incomplete'))
  assert.ok(blockedBody.evidence.gaps.some(g => g.reason === 'invalid-reading'))
})

test('小票 S 的独立行同样可追盘与分摊', async t => {
  const h = await harness(t)
  await h.setStage('remapped')
  await h.setEdition('r2')
  const report = await buildTicketReport({ ticket: 'S', sourceUrl: h.sourceRoot, providerUrl: h.providerRoot })
  const line = report.lines[0]
  assert.equal(line.purchasedGrams, 300)
  assert.equal(line.lots[0].lot, 'L3')
  assert.equal(line.lots[0].shareGrams, 300)
  assert.equal(line.lots[0].verdict, 'confirmed-excursion')
  assert.equal(line.ledger.summary.remainingGrams, 300)
})
