import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { parseTempBuffer, ColdClient } from '../harvest/cold-client.mjs'
import { resolveLineLots, evaluateWindow, EXCURSION_LIMIT } from '../harvest/trace.mjs'
import { buildLedger, capacities } from '../harvest/ledger.mjs'
import http from 'node:http'

const media = new URL('../records/media/', import.meta.url)

test('TEMP 二进制：分钟、十分之一摄氏度与有效标志', async () => {
  const buffer = await readFile(new URL('temp-b.bin', media))
  const records = parseTempBuffer(buffer)
  assert.deepEqual(records.map(r => r.minute), [0, 1, 2, 3])
  assert.equal(records[2].celsius, 8.2)
  assert.equal(records[2].valid, false)
  assert.equal(records[0].celsius, 4.5)
  assert.equal(records[0].valid, true)
})

test('混盘份额：两盘拼行后按来源份额与行重量整数分摊且合计守恒', () => {
  // P：L1 900 / L2 300；Q：L3 800
  const mix = [['P', 'L1', 900], ['P', 'L2', 300], ['Q', 'L3', 800]]
  const p = resolveLineLots(600, 'P', mix)
  assert.deepEqual(p.allocations.map(a => [a.lot, a.grams]), [['L1', 450], ['L2', 150]])
  assert.equal(p.allocations.reduce((s, a) => s + a.grams, 0), 600)
  const q = resolveLineLots(400, 'Q', mix)
  assert.deepEqual(q.allocations, [{ lot: 'L3', grams: 400, exact: '400/1' }])
})

test('无来源记录的盘单独留原因，不归给最近一批', () => {
  const resolved = resolveLineLots(100, 'X', [['P', 'L1', 1]])
  assert.deepEqual(resolved.allocations, [])
  assert.equal(resolved.unresolved[0].reason, 'no-source-record')
})

function observationsFixture(zoneSamples, { covering = [], failures = [] } = {}) {
  const map = new Map()
  for (const [zone, minute, samples] of zoneSamples) {
    if (!map.has(zone)) map.set(zone, new Map())
    map.get(zone).set(minute, samples)
  }
  return {
    covering, failures,
    samplesAt: (zone, minute) => map.get(zone)?.get(minute) ?? [],
    hasFileCovering: (zone, minute) =>
      covering.some(item => item.zone === zone && minute >= item.from && minute < item.until)
  }
}

const sample = (sensor, celsius, valid, path = '/cold/read?file=x') => ({ sensor, celsius, valid, path })

test('完整观测且无越线才能说未发现过温', () => {
  const obs = observationsFixture([
    ['north', 0, [sample('B', 4.5, true)]],
    ['north', 1, [sample('B', 4.4, true)]],
    ['north', 2, [sample('B', 4.9, true)]]
  ], { covering: [{ zone: 'north', sensor: 'B', from: 0, until: 3, path: '/cold/read?file=b' }] })
  const window = evaluateWindow({ plate: 'P', zone: 'north', from: 0, until: 3 }, obs, new Map())
  assert.equal(window.verdict, 'complete-no-excursion')
  assert.equal(window.gaps.length, 0)
})

test('一个无效读数造成缺口，即使其他分钟正常也不能排除过温', () => {
  const obs = observationsFixture([
    ['north', 0, [sample('B', 4.5, true)]],
    ['north', 1, [sample('B', 4.4, true)]],
    ['north', 2, [sample('B', 8.2, false)]]
  ], { covering: [{ zone: 'north', sensor: 'B', from: 0, until: 3, path: '/cold/read?file=b' }] })
  const window = evaluateWindow({ plate: 'P', zone: 'north', from: 0, until: 3 }, obs, new Map())
  assert.equal(window.verdict, 'incomplete')
  assert.deepEqual(window.gaps.map(g => g.reason), ['invalid-reading'])
})

test('存在适用越线样本即可证实过温，其余时段仍待补', () => {
  const obs = observationsFixture([
    ['south', 3, [sample('S', 5.8, true)]],
    ['south', 4, [sample('S', 9.1, true)]]
  ], { covering: [{ zone: 'south', sensor: 'S', from: 3, until: 5, path: '/cold/read?file=s' }] })
  const window = evaluateWindow({ plate: 'Q', zone: 'south', from: 3, until: 5 }, obs, new Map())
  assert.equal(window.verdict, 'confirmed-excursion')
  assert.equal(window.excursionSamples[0].celsius, 9.1)
  assert.equal(window.excursionSamples[0].minute, 4)
})

test('网关未取文件与探头划走分别给出缺口原因', () => {
  const obs = observationsFixture([
    ['south', 3, [sample('S', 5.8, true)]]
  ], { covering: [{ zone: 'south', sensor: 'S', from: 3, until: 4, path: '/cold/read?file=s' }] })
  const window = evaluateWindow({ plate: 'Q', zone: 'south', from: 3, until: 5 }, obs, new Map())
  assert.equal(window.verdict, 'incomplete')
  assert.equal(window.gaps[0].reason, 'file-not-fetched')

  const remapped = observationsFixture([], {
    // 同区有文件但该分钟没有任何样本：原探头已被划走或该样本被新分区排除，不能当作没取文件
    covering: [{ zone: 'south', sensor: 'A', from: 0, until: 4, path: '/cold/read?file=a' }]
  })
  const window2 = evaluateWindow({ plate: 'Q', zone: 'south', from: 3, until: 4 }, remapped, new Map())
  assert.equal(window2.gaps[0].reason, 'probe-remapped')
})

test('旧版摘要越线但最新分区无有效越线样本时只记冲突不定责', () => {
  const obs = observationsFixture([
    ['north', 0, [sample('B', 4.5, true)]],
    ['north', 1, [sample('B', 4.4, true)]],
    ['north', 2, [sample('B', 8.2, false)]]
  ], { covering: [{ zone: 'north', sensor: 'B', from: 0, until: 3, path: '/cold/read?file=b' }] })
  const legacy = new Map([['north', [
    ['A', 'north', '0', '3'], ['A', 'north', '1', '8'], ['A', 'north', '2', '4']
  ]]])
  const window = evaluateWindow({ plate: 'P', zone: 'north', from: 0, until: 3 }, obs, legacy)
  assert.equal(window.verdict, 'incomplete')
  assert.deepEqual(window.legacy.conflict.map(c => c.minute), [1])
  assert.equal(window.excursionSamples.length, 0)
})

test('台账：payout 与售后台同批同克数合并占额，争议批单独保留', () => {
  const ledger = buildLedger({
    ticket: 'R', line: 1,
    payoutRows: [['R', '1', 'L1', '450', 'pay1']],
    refundLines: [{ ticket: 'R', line: 1, lot: 'L1', grams: 450, state: 'accepted', receipt: 'H1' }],
    currentLots: ['L2', 'L3']
  })
  assert.equal(ledger.totals.occupiedGrams, 450)
  assert.equal(ledger.dispositions.length, 1)
  assert.deepEqual(ledger.dispositions[0].receipts, ['pay1', 'H1'])
  assert.equal(ledger.disputed[0].lot, 'L1')
  assert.equal(ledger.disputed[0].reason, 'lot-not-in-current-mix')
})

test('可处理克数同时受行总帽和批份额约束', () => {
  const ledger = buildLedger({
    ticket: 'R', line: 1, payoutRows: [],
    refundLines: [{ ticket: 'R', line: 1, lot: 'L1', grams: 450, state: 'paid', receipt: 'H1' }],
    currentLots: ['L1', 'L2', 'L3']
  })
  const lotReports = [
    { lot: 'L1', grams: 450, verdict: 'confirmed-excursion', plates: ['P'], blockers: [] },
    { lot: 'L2', grams: 150, verdict: 'incomplete', plates: ['P'], blockers: [] },
    { lot: 'L3', grams: 400, verdict: 'confirmed-excursion', plates: ['Q'], blockers: [] }
  ]
  const cap = capacities({ lineGrams: 1000, lotReports, ledger })
  assert.equal(cap.lineRemainingGrams, 550)
  assert.deepEqual(cap.lots.map(l => [l.lot, l.claimableGrams]), [['L1', 0], ['L2', 150], ['L3', 400]])
  assert.ok(EXCURSION_LIMIT === 6)
})

test('温度原件 410 移出时记为 file-expired 缺口，不当作有效观测', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/cold/files') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify([{ sensor: 'A', zone: 'north', from: 0, until: 2, path: '/cold/read?file=a' }]))
    } else {
      response.writeHead(410).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const root = 'http://127.0.0.1:' + server.address().port
  try {
    const client = new ColdClient(root)
    const observations = await client.loadObservations()
    assert.deepEqual(observations.failures.map(f => f.reason), ['file-expired'])
    const window = evaluateWindow({ plate: 'P', zone: 'north', from: 0, until: 2 }, observations, new Map())
    assert.equal(window.verdict, 'incomplete')
    assert.ok(window.gaps.every(g => g.reason === 'file-expired' || g.reason === 'file-not-fetched'))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
