// 售后台账：合并业务资料里的 payout 记录与售后台实时处置，按小票行计算占额。
// 规则：
//   - accepted 与 paid 都占可处理克数，已受理克数不得再次申请；
//   - 同一 (票,行,批,克数) 只占一次额，两边凭据都保留，避免重复赔付；
//   - 一行合计处置不得超过该行实购克数；
//   - 后到处置把责任从 A 批移到 B 批时，旧批回执原样保留，记入 disputed（有争议/待回收），不从台账消失。

const keyOf = (ticket, line, lot, grams) => `${ticket}\u0000${line}\u0000${lot}\u0000${grams}`

export function buildLedger({ ticket, payoutRows, refundLines, line, currentLots }) {
  const currentLotSet = new Set(currentLots)
  const dispositions = new Map()

  const upsert = entry => {
    const key = keyOf(entry.ticket, entry.line, entry.lot, entry.grams)
    const existing = dispositions.get(key)
    if (!existing) {
      dispositions.set(key, { ...entry, receipts: [...entry.receipts], sources: [...entry.sources] })
      return
    }
    for (const receipt of entry.receipts) if (!existing.receipts.includes(receipt)) existing.receipts.push(receipt)
    for (const source of entry.sources) if (!existing.sources.includes(source)) existing.sources.push(source)
    // 售后台实时状态优先；paid 优先于 accepted。
    const rank = { paid: 3, accepted: 2, submitted: 1 }
    if ((rank[entry.state] ?? 0) > (rank[existing.state] ?? 0)) existing.state = entry.state
  }

  for (const row of payoutRows) {
    upsert({
      ticket: row[0],
      line: Number(row[1]),
      lot: row[2],
      grams: Number(row[3]),
      state: 'submitted',
      receipts: [row[4]],
      sources: ['payout']
    })
  }
  for (const item of refundLines) {
    upsert({
      ticket: item.ticket,
      line: Number(item.line),
      lot: item.lot,
      grams: Number(item.grams),
      state: item.state,
      receipts: [item.receipt],
      sources: ['refund-desk']
    })
  }

  const all = [...dispositions.values()]
    .filter(item => item.ticket === ticket && item.line === line)
    .sort((a, b) => a.lot.localeCompare(b.lot) || a.grams - b.grams)

  const occupied = all.reduce((sum, item) => sum + item.grams, 0)
  const paidGrams = all.filter(item => item.state === 'paid').reduce((sum, item) => sum + item.grams, 0)
  const acceptedGrams = all.filter(item => item.state === 'accepted').reduce((sum, item) => sum + item.grams, 0)

  // 当前混盘里仍存在的源批：其占额记在该批名下；已不在当前混盘的占额单独留原因，不把整盘归给最近一批。
  const perLot = new Map()
  const disputed = []
  for (const item of all) {
    if (currentLotSet.has(item.lot)) {
      const bucket = perLot.get(item.lot) ?? { lot: item.lot, occupiedGrams: 0, paidGrams: 0, acceptedGrams: 0, receipts: [] }
      bucket.occupiedGrams += item.grams
      if (item.state === 'paid') bucket.paidGrams += item.grams
      if (item.state === 'accepted') bucket.acceptedGrams += item.grams
      for (const receipt of item.receipts) if (!bucket.receipts.includes(receipt)) bucket.receipts.push(receipt)
      perLot.set(item.lot, bucket)
    } else {
      disputed.push({ ...item, reason: 'lot-not-in-current-mix', detail: '该批已不在当前混盘来源中，旧回执保留，责任转移后须由售后台回收或改挂' })
    }
  }

  return {
    line,
    dispositions: all,
    lotOccupancy: [...perLot.values()].sort((a, b) => a.lot.localeCompare(b.lot)),
    disputed,
    totals: { occupiedGrams: occupied, paidGrams, acceptedGrams }
  }
}

// 计算每个当前源批还可申请的克数：先受行总帽约束（含争议批旧占额），再受该批按小票行重量确认的份额约束。
export function capacities({ lineGrams, lotReports, ledger }) {
  // 争议批占额不消失：它继续占用行总帽，剩余空间才允许在当前各批之间分配。
  const disputedGrams = ledger.disputed.reduce((sum, item) => sum + item.grams, 0)
  const lineRemaining = Math.max(0, lineGrams - ledger.totals.occupiedGrams)
  let runningRemaining = lineRemaining
  const result = []
  for (const report of [...lotReports].sort((a, b) => a.lot.localeCompare(b.lot))) {
    const occupied = ledger.lotOccupancy.find(item => item.lot === report.lot)?.occupiedGrams ?? 0
    const lotRemainingRaw = report.grams - occupied
    const lotRemaining = Math.max(0, lotRemainingRaw)
    const claimable = Math.min(lotRemaining, runningRemaining)
    runningRemaining = Math.max(0, runningRemaining - claimable)
    result.push({
      lot: report.lot,
      lotShareGrams: report.grams,
      occupiedGrams: occupied,
      lotRemainingGrams: lotRemaining,
      lineRemainingGrams: lineRemaining,
      claimableGrams: claimable,
      overOccupied: lotRemainingRaw < 0
    })
  }
  return { lineRemainingGrams: lineRemaining, disputedGrams, lots: result }
}

// 汇总某批当前不能处理的原因。
export function lotBlockers(report, capacity) {
  const blockers = []
  if (report.verdict === 'incomplete') blockers.push({ reason: 'evidence-incomplete', detail: '存在未补齐的在柜分钟，不能判定未过温' })
  if (report.verdict === 'complete-no-excursion') blockers.push({ reason: 'no-excursion-found', detail: '完整观测未发现过温，无过温责任' })
  if (capacity.claimableGrams <= 0) blockers.push({ reason: 'no-claimable-grams', detail: '该批份额已被占满或行总帽已用尽' })
  if (capacity.overOccupied) blockers.push({ reason: 'over-occupied', detail: '该批已受理/已付克数超过当前份额，须售后台核对' })
  for (const blocker of report.blockers) blockers.push(blocker)
  return blockers
}
