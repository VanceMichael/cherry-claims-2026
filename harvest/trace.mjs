// 追溯核心：小票行 -> 混盘来源份额 -> 柜区时窗 -> 温度观测证据。
// 判定原则：
//   1. 该盘每个在柜分钟都须有同区有效读数，才能说“这一段未发现过温”；
//   2. 任一有效读数超过 6°C 即可证实过温，即使其余时段仍待补；
//   3. 网关 cold 的区域绑定优先于历史 temp 摘要；校正后旧报告的越线若落不到该盘当前位置，只标记冲突，不据此定责。

export const EXCURSION_LIMIT = 6

const num = value => Number(value)
const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b))

function rational(numerator, denominator) {
  let n = BigInt(numerator)
  let d = BigInt(denominator)
  if (d < 0n) { n = -n; d = -d }
  const g = gcd(n < 0n ? -n : n, d)
  return { n: n / g, d: d / g }
}
const mul = (a, b) => rational(a.n * b.n, a.d * b.d)
const one = rational(1, 1)
const floorOf = fraction => Number(fraction.n / fraction.d)
const fractionPart = fraction => rational(fraction.n % fraction.d, fraction.d)
const cmpRational = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0

// 对外的行级展开：逐层用精确分数传播，最后在整行克数上做一次最大余数取整。
export function resolveLineLots(lineGrams, rootPlate, mixRows) {
  const mixByChild = new Map()
  const platesSet = new Set(mixRows.map(row => row[0]))
  for (const row of mixRows) {
    if (!mixByChild.has(row[0])) mixByChild.set(row[0], [])
    mixByChild.get(row[0]).push({ parentId: row[1], weightGrams: num(row[2]) })
  }

  const unresolved = []
  const exactLeaves = new Map() // lot -> rational grams
  const visited = new Set()

  function walk(plate, weight) {
    if (visited.has(plate)) {
      unresolved.push({ id: plate, reason: 'mix-cycle' })
      return
    }
    visited.add(plate)
    const components = mixByChild.get(plate)
    if (!components || components.length === 0) {
      unresolved.push({ id: plate, reason: 'no-source-record' })
      return
    }
    const totalWeight = components.reduce((sum, item) => sum + item.weightGrams, 0)
    for (const component of components) {
      const nextWeight = mul(weight, rational(component.weightGrams, totalWeight))
      if (platesSet.has(component.parentId)) {
        walk(component.parentId, nextWeight)
      } else {
        const grams = mul(rational(lineGrams, 1), nextWeight)
        const prev = exactLeaves.get(component.parentId)
        exactLeaves.set(component.parentId, prev ? rational(prev.n * grams.d + grams.n * prev.d, prev.d * grams.d) : grams)
      }
    }
  }

  if (!platesSet.has(rootPlate)) {
    unresolved.push({ id: rootPlate, reason: 'no-source-record' })
    return { allocations: [], unresolved, tree: null }
  }
  walk(rootPlate, one)

  // 最大余数法整数化，保证合计等于实购克数。
  const entries = [...exactLeaves.entries()].map(([lot, exact]) => ({
    lot, exact, floor: floorOf(exact), frac: fractionPart(exact)
  }))
  let allocated = entries.reduce((sum, item) => sum + item.floor, 0)
  let remainder = lineGrams - allocated
  entries.sort((a, b) => cmpRational(b.frac, a.frac) || (a.lot < b.lot ? -1 : 1))
  for (const item of entries) {
    if (remainder <= 0) break
    item.floor += 1
    remainder -= 1
  }
  const allocations = entries
    .map(item => ({ lot: item.lot, grams: item.floor, exact: item.exact.n + '/' + item.exact.d }))
    .sort((a, b) => b.grams - a.grams || a.lot.localeCompare(b.lot))

  return {
    allocations,
    unresolved,
    tree: buildTree(rootPlate, mixByChild, platesSet)
  }
}

function buildTree(plate, mixByChild, platesSet, depth = 0, seen = new Set()) {
  if (seen.has(plate) || depth > 20) return { plate, components: [], cycle: true }
  const nextSeen = new Set(seen).add(plate)
  const components = (mixByChild.get(plate) ?? []).map(component => ({
    id: component.parentId,
    weightGrams: component.weightGrams,
    kind: platesSet.has(component.parentId)
      ? { plate: buildTree(component.parentId, mixByChild, platesSet, depth + 1, nextSeen) }
      : { lot: true }
  }))
  return { plate, components, cycle: false }
}

// 评估单个在柜时窗（半开区间 [from, until)）。
export function evaluateWindow({ plate, zone, from, until }, observations, legacyByZone) {
  const minutes = []
  const excursionSamples = []
  const gaps = []
  const usedFiles = new Set()

  for (let minute = from; minute < until; minute += 1) {
    const samples = observations.samplesAt(zone, minute)
    const covered = observations.hasFileCovering(zone, minute)
    const validSamples = samples.filter(sample => sample.valid)

    if (covered && samples.length === 0) {
      // 现行文件覆盖该分钟却没有任何样本落入本区：该探头已按最新分区划到其他柜区。
      gaps.push({ minute, reason: 'probe-remapped', detail: '该分钟原探头已按最新分区划到其他柜区' })
      minutes.push({ minute, status: 'gap', reason: 'probe-remapped' })
      continue
    }
    if (covered) {
      for (const sample of samples) usedFiles.add(sample.path)
      if (validSamples.length === 0) {
        gaps.push({ minute, reason: 'invalid-reading', detail: '该分钟探头读数无效' })
        minutes.push({ minute, status: 'invalid' })
        continue
      }
      const hot = validSamples.find(sample => sample.celsius > EXCURSION_LIMIT)
      if (hot) {
        excursionSamples.push({ minute, celsius: hot.celsius, sensor: hot.sensor, path: hot.path })
        minutes.push({ minute, status: 'excursion', celsius: hot.celsius, sensor: hot.sensor })
      } else {
        minutes.push({
          minute,
          status: 'ok',
          celsius: Math.max(...validSamples.map(sample => sample.celsius))
        })
      }
      continue
    }

    // 没有任何现行文件覆盖该分钟：区分文件失效、探头被划走、根本没取到文件。
    const failed = observations.failures.find(item =>
      item.zone === zone && minute >= (item.from ?? Number.NEGATIVE_INFINITY) &&
      minute < (item.until ?? Number.POSITIVE_INFINITY))
    let reason
    let detail
    if (failed) {
      reason = failed.reason
      detail = failed.path
    } else if (observations.covering.some(item =>
      item.zone === zone && minute >= item.from && minute < item.until)) {
      // 同区文件覆盖该分钟但没有任何样本记录：原探头已按最新分区划走，样本不再落在本区。
      reason = 'probe-remapped'
      detail = '该分钟原探头已按最新分区划到其他柜区'
    } else if (observations.samplesAt(zone, minute).length > 0) {
      reason = 'invalid-reading'
      detail = '该分钟同区探头读数均无效'
      gaps.push({ minute, reason, detail })
      minutes.push({ minute, status: 'gap', reason })
      continue
    } else {
      reason = 'file-not-fetched'
      detail = '网关尚未提供覆盖该分钟的文件'
    }
    gaps.push({ minute, reason, detail })
    minutes.push({ minute, status: 'gap', reason })
  }

  // 所需文件：实际覆盖本时窗的现行文件，加上缺口对应的待补范围。
  const requiredFiles = observations.covering
    .filter(item => item.zone === zone && item.until > from && item.from < until)
    .map(item => ({ path: item.path, sensor: item.sensor, from: Math.max(item.from, from), until: Math.min(item.until, until) }))
  const missingCoverage = summarizeGaps(gaps, zone)

  // 历史 temp 摘要（旧版报告口径），仅用于对照，不用于定责。
  const legacyRows = legacyByZone.get(zone) ?? []
  const legacyInWindow = legacyRows.filter(row => num(row[2]) >= from && num(row[2]) < until)
  const legacyExcursion = legacyInWindow
    .filter(row => num(row[3]) > EXCURSION_LIMIT)
    .map(row => ({ minute: num(row[2]), celsius: num(row[3]), sensor: row[0] }))
  const confirmedMinutes = new Set(excursionSamples.map(sample => sample.minute))
  const legacyConflict = legacyExcursion
    .filter(sample => !confirmedMinutes.has(sample.minute))
    .map(sample => ({
      ...sample,
      detail: '旧版摘要在该分钟越线，但按最新探头分区该位置无有效越线样本'
    }))

  let verdict
  if (excursionSamples.length > 0) verdict = 'confirmed-excursion'
  else if (gaps.length === 0) verdict = 'complete-no-excursion'
  else verdict = 'incomplete'

  return {
    plate, zone, from, until,
    verdict,
    minutes,
    excursionSamples,
    gaps,
    requiredFiles,
    missingCoverage,
    legacy: { rows: legacyInWindow.map(row => ({ sensor: row[0], minute: num(row[2]), celsius: num(row[3]) })), excursion: legacyExcursion, conflict: legacyConflict }
  }
}

function summarizeGaps(gaps, zone) {
  const ranges = []
  for (const gap of gaps) {
    const last = ranges[ranges.length - 1]
    if (last && last.reason === gap.reason && last.until === gap.minute) {
      last.until = gap.minute + 1
    } else {
      ranges.push({ zone, from: gap.minute, until: gap.minute + 1, reason: gap.reason, detail: gap.detail })
    }
  }
  for (const range of ranges) {
    if (range.reason === 'file-not-fetched' || range.reason === 'probe-remapped') {
      range.needed = '需要覆盖该时窗的探头文件'
    } else if (range.reason === 'invalid-reading') {
      range.needed = '需要该分钟的有效读数或换探头后的补档'
    } else {
      range.needed = '需要重新可取的温度原件'
    }
  }
  return ranges
}

// 组装一个盘的全部时窗与汇总判定。
export function evaluatePlate(plate, resideRows, observations, legacyByZone) {
  const windows = resideRows
    .filter(row => row[0] === plate)
    .map(row => evaluateWindow(
      { plate, zone: row[1], from: num(row[2]), until: num(row[3]) },
      observations, legacyByZone))
  let verdict
  if (windows.some(window => window.verdict === 'confirmed-excursion')) verdict = 'confirmed-excursion'
  else if (windows.length > 0 && windows.every(window => window.verdict === 'complete-no-excursion')) {
    verdict = 'complete-no-excursion'
  } else {
    verdict = 'incomplete'
  }
  return { plate, verdict, windows }
}

// 源批级判定：任一承载该批的盘有适用越线样本即可证实；全部完整且无越线才能排除；其余待补。
export function rollupLots(allocations, plateReports, plateOfLots) {
  return allocations.map(allocation => {
    const plates = plateOfLots.get(allocation.lot) ?? []
    const reports = plates.map(plate => plateReports.find(item => item.plate === plate)).filter(Boolean)
    let verdict
    if (reports.some(report => report.verdict === 'confirmed-excursion')) verdict = 'confirmed-excursion'
    else if (reports.length > 0 && reports.every(report => report.verdict === 'complete-no-excursion')) {
      verdict = 'complete-no-excursion'
    } else {
      verdict = 'incomplete'
    }
    const blockers = []
    // 逐分钟证据缺口统一放在报告 evidence 中展示；批级 blockers 只保留判定类原因，
    // 已证实越线的批不会被同一盘其他待补分钟挡住处理。
    return { lot: allocation.lot, grams: allocation.grams, exact: allocation.exact, verdict, plates, blockers }
  })
}

// 建立 源批 -> 承载盘 的索引（只看当前资料版的混盘记录）。
export function indexLotsToPlates(mixRows) {
  const platesSet = new Set(mixRows.map(row => row[0]))
  const map = new Map()
  const walk = (plate, seen = new Set()) => {
    if (seen.has(plate)) return
    const nextSeen = new Set(seen).add(plate)
    for (const row of mixRows.filter(item => item[0] === plate)) {
      const id = row[1]
      if (platesSet.has(id)) walk(id, nextSeen)
      else {
        if (!map.has(id)) map.set(id, [])
        if (!map.get(id).includes(plate)) map.get(id).push(plate)
      }
    }
  }
  for (const plate of platesSet) walk(plate)
  return map
}
