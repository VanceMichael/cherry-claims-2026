// 温度网关客户端：读取滚动探头文件清单，解析 TEMP 二进制，按最新区域绑定建立观测。

export class ColdError extends Error {
  constructor(status, message, path) {
    super(message)
    this.name = 'ColdError'
    this.status = status
    this.path = path
  }
}

const TEMP_MAGIC = Buffer.from('TEMP')
const RECORD_SIZE = 5
const DEFAULT_TIMEOUT_MS = 8000

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 二进制以 TEMP 开头，每条记录为：分钟 uint16 LE、温度*10 int16 LE、有效标志 uint8。
export function parseTempBuffer(buffer) {
  if (buffer.length < TEMP_MAGIC.length || !buffer.subarray(0, 4).equals(TEMP_MAGIC)) {
    throw new ColdError(502, '温度文件缺少 TEMP 头')
  }
  const records = []
  for (let offset = TEMP_MAGIC.length; offset + RECORD_SIZE <= buffer.length; offset += RECORD_SIZE) {
    const minute = buffer.readUInt16LE(offset)
    const deciCelsius = buffer.readInt16LE(offset + 2)
    const valid = buffer.readUInt8(offset + 4) === 1
    records.push({ minute, celsius: deciCelsius / 10, valid })
  }
  return records
}

export class ColdClient {
  #baseUrl
  #timeoutMs

  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#timeoutMs = timeoutMs
  }

  async listFiles() {
    const response = await fetchWithTimeout(this.#baseUrl + '/cold/files', {}, this.#timeoutMs)
    if (!response.ok) throw new ColdError(response.status, '探头文件清单读取失败', '/cold/files')
    return response.json()
  }

  // 返回 { file, records, gone, reason }；410 表示该档当天已移出，不能当作空档之外的成功观测。
  async readFile(file) {
    const target = new URL(this.#baseUrl + file.path)
    const response = await fetchWithTimeout(target, {}, this.#timeoutMs)
    if (response.status === 410) {
      return { file, records: [], gone: true, reason: 'file-expired' }
    }
    if (!response.ok) throw new ColdError(response.status, '温度原件读取失败', file.path)
    return { file, records: parseTempBuffer(Buffer.from(await response.arrayBuffer())), gone: false }
  }

  // 拉取清单中的全部原件并按“最新区域绑定优先”建立索引。
  // 同一探头若有重复文件，后出现的清单条目覆盖旧条目；读取失败/失效的文件保留缺口原因。
  async loadObservations() {
    const files = await this.listFiles()
    const zones = new Map()
    const covering = []
    const failures = []

    for (const file of files) {
      let read
      try {
        read = await this.readFile(file)
      } catch (error) {
        failures.push({ path: file.path, zone: file.zone, sensor: file.sensor, reason: 'fetch-failed', detail: error.message })
        continue
      }
      if (read.gone) {
        failures.push({ path: file.path, zone: file.zone, sensor: file.sensor, reason: 'file-expired' })
        continue
      }
      if (!zones.has(file.zone)) zones.set(file.zone, new Map())
      const byMinute = zones.get(file.zone)
      for (const record of read.records) {
        if (record.minute < file.from || record.minute >= file.until) continue
        if (!byMinute.has(record.minute)) byMinute.set(record.minute, [])
        byMinute.get(record.minute).push({
          sensor: file.sensor,
          celsius: record.celsius,
          valid: record.valid,
          path: file.path
        })
      }
      covering.push({
        zone: file.zone,
        sensor: file.sensor,
        from: file.from,
        until: file.until,
        path: file.path
      })
    }

    return {
      files,
      covering,
      failures,
      // samplesAt(zone, minute) 返回该区域该分钟经最新绑定过滤后的全部有效/无效读数。
      samplesAt(zone, minute) {
        return zones.get(zone)?.get(minute) ?? []
      },
      hasFileCovering(zone, minute) {
        return covering.some(item =>
          item.zone === zone && minute >= item.from && minute < item.until)
      }
    }
  }
}
