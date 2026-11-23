// 报告编排：来一张小票，追出混盘份额、柜区时窗、温度证据缺口、台账占额与可处理范围。

import { SourceClient, SourceError } from './source-client.mjs'
import { ColdClient } from './cold-client.mjs'
import { RefundClient } from './refund-client.mjs'
import {
  resolveLineLots, evaluatePlate, rollupLots, indexLotsToPlates
} from './trace.mjs'
import { buildLedger, capacities, lotBlockers } from './ledger.mjs'

const num = value => Number(value)

async function safe(fn, fallback) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error, ...fallback }
  }
}

export async function buildTicketReport({
  ticket,
  sourceUrl,
  providerUrl,
  edition,
  timeoutMs
} = {}) {
  const source = new SourceClient(sourceUrl, { timeoutMs })
  const cold = new ColdClient(providerUrl, { timeoutMs })
  const refunds = new RefundClient(providerUrl, { timeoutMs })

  const catalog = await source.getCatalog()
  const effectiveEdition = edition ?? catalog.edition

  const labelRows = await source.fetchAll('label', { edition: effectiveEdition, key: ticket })
  if (labelRows.length === 0) {
    throw new SourceError(404, `小票 ${ticket} 在资料版 ${effectiveEdition} 中没有称重行`, 'label')
  }
  const mixRows = await source.fetchAll('mix', { edition: effectiveEdition })
  const platesInMix = new Set(mixRows.map(row => row[0]))

  // 该小票涉及的盘只拉自己的在柜记录；区域温度摘要按区拉取（网关 cold 绑定优先，摘要仅作对照）。
  const plateSet = new Set(labelRows.map(row => row[2]))
  const resideRows = []
  for (const plate of plateSet) {
    resideRows.push(...await source.fetchAll('reside', { edition: effectiveEdition, key: plate }))
  }
  const zones = new Set(resideRows.map(row => row[1]))
  const legacyTempRows = []
  for (const zone of zones) {
    legacyTempRows.push(...await source.fetchAll('temp', { edition: effectiveEdition, key: zone }))
  }
  const legacyByZone = new Map()
  for (const zone of zones) legacyByZone.set(zone, legacyTempRows.filter(row => row[1] === zone))

  const payoutRows = await source.fetchAll('payout', { edition: effectiveEdition, key: ticket })

  const observationsResult = await safe(() => cold.loadObservations())
  const refundResult = await safe(() => refunds.listLines(ticket))
  const observations = observationsResult.ok
    ? observationsResult.value
    : { files: [], covering: [], failures: [{ reason: 'gateway-unavailable', detail: observationsResult.error.message }], samplesAt: () => [], hasFileCovering: () => false }
  const refundLines = refundResult.ok ? refundResult.value : []

  const lotToPlates = indexLotsToPlates(mixRows)
  const lines = []

  // 同一小票可能有多行，逐行处理。
  const lineIds = [...new Set(labelRows.map(row => Number(row[1])))]
  for (const lineId of lineIds) {
    const lineRows = labelRows.filter(row => Number(row[1]) === lineId)
    const lineGrams = lineRows.reduce((sum, row) => sum + num(row[3]), 0)

    const plates = lineRows.map(row => ({
      plate: row[2],
      weighedGrams: num(row[3])
    }))

    // 两个柜拼盘后分别按进入本盘的来源份额分摊，再按小票该行重量确认处理范围。
    const lineLots = []
    const unresolved = []
    const trees = []
    for (const item of plates) {
      const resolved = resolveLineLots(item.weighedGrams, item.plate, mixRows)
      for (const allocation of resolved.allocations) {
        const existing = lineLots.find(lot => lot.lot === allocation.lot)
        if (existing) existing.grams += allocation.grams
        else lineLots.push({ ...allocation })
      }
      unresolved.push(...resolved.unresolved.map(entry => ({ plate: item.plate, ...entry })))
      if (resolved.tree) trees.push(resolved.tree)
    }
    lineLots.sort((a, b) => b.grams - a.grams || a.lot.localeCompare(b.lot))

    const plateReports = [...new Set(plates.map(item => item.plate))]
      .map(plate => evaluatePlate(plate, resideRows, observations, legacyByZone))

    // 以行级合计份额重算每批承载盘与判定。
    const lotReports = rollupLots(lineLots, plateReports, lotToPlates)

    const ledger = buildLedger({
      ticket, payoutRows, refundLines, line: lineId,
      currentLots: lineLots.map(item => item.lot)
    })
    const capacity = capacities({ lineGrams, lotReports, ledger })

    const lots = lotReports.map(report => {
      const cap = capacity.lots.find(item => item.lot === report.lot)
      const blockers = lotBlockers(report, cap)
      return {
        lot: report.lot,
        shareGrams: report.grams,
        verdict: report.verdict,
        carriedByPlates: report.plates,
        occupancy: {
          occupiedGrams: cap.occupiedGrams,
          claimableGrams: cap.claimableGrams,
          lotRemainingGrams: cap.lotRemainingGrams
        },
        blockers,
        processable: blockers.length === 0,
        evidence: collectEvidence(report, plateReports)
      }
    })

    lines.push({
      line: lineId,
      purchasedGrams: lineGrams,
      plates,
      windows: plateReports.flatMap(report => report.windows),
      unresolvedSources: unresolved,
      lots,
      ledger: {
        ...ledger,
        lineRemainingGrams: capacity.lineRemainingGrams,
        summary: {
          paidGrams: ledger.totals.paidGrams,
          acceptedGrams: ledger.totals.acceptedGrams,
          occupiedGrams: ledger.totals.occupiedGrams,
          remainingGrams: capacity.lineRemainingGrams
        }
      },
      dataWarnings: [
        ...(observationsResult.ok ? [] : [{ reason: 'cold-gateway-unavailable', detail: observationsResult.error.message }]),
        ...(refundResult.ok ? [] : [{ reason: 'refund-desk-unavailable', detail: refundResult.error.message }])
      ]
    })
  }

  return {
    ticket,
    edition: effectiveEdition,
    generatedAt: new Date().toISOString(),
    cold: {
      files: observations.files,
      failures: observations.failures,
      gatewayOk: observationsResult.ok,
      gatewayError: observationsResult.ok ? null : observationsResult.error.message,
      refundDeskOk: refundResult.ok,
      refundDeskError: refundResult.ok ? null : refundResult.error.message
    },
    lines
  }
}

function collectEvidence(lotReport, plateReports) {
  const evidence = { excursionSamples: [], gaps: [], requiredFiles: [], legacyConflicts: [] }
  for (const plate of lotReport.plates) {
    const report = plateReports.find(item => item.plate === plate)
    for (const window of report?.windows ?? []) {
      evidence.excursionSamples.push(...window.excursionSamples.map(sample => ({ plate, zone: window.zone, ...sample })))
      evidence.gaps.push(...window.gaps.map(gap => ({ plate, zone: window.zone, ...gap })))
      evidence.requiredFiles.push(...window.requiredFiles.map(file => ({ plate, zone: window.zone, ...file })))
      evidence.legacyConflicts.push(...window.legacy.conflict.map(item => ({ plate, zone: window.zone, ...item })))
    }
  }
  return evidence
}
