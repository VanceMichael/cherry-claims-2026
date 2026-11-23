// 业务资料来源客户端：处理分页 TSV、资料版隔离、ETag 条件请求与错误分类。

export class SourceError extends Error {
  constructor(status, message, url) {
    super(message)
    this.name = 'SourceError'
    this.status = status
    this.url = url
  }
}

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

function parseTsv(text) {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => line.split('\t'))
}

export class SourceClient {
  #baseUrl
  #timeoutMs
  // 键为“不含 cursor 的首页 URL”，缓存首页 ETag 与该筛选条件下聚合后的全部行。
  #cache = new Map()

  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#timeoutMs = timeoutMs
  }

  #buildUrl(stream, filters = {}) {
    const url = new URL(this.#baseUrl + '/records/' + stream)
    if (filters.edition !== undefined) url.searchParams.set('edition', filters.edition)
    if (filters.key !== undefined) url.searchParams.set('key', filters.key)
    if (filters.from !== undefined) url.searchParams.set('from', String(filters.from))
    if (filters.until !== undefined) url.searchParams.set('until', String(filters.until))
    return url
  }

  async getCatalog() {
    const response = await fetchWithTimeout(this.#baseUrl + '/catalog', {}, this.#timeoutMs)
    if (!response.ok) throw new SourceError(response.status, '目录读取失败', this.#baseUrl + '/catalog')
    return response.json()
  }

  async setEdition(edition) {
    const response = await fetchWithTimeout(
      this.#baseUrl + '/control?edition=' + encodeURIComponent(edition),
      { method: 'POST' },
      this.#timeoutMs
    )
    if (!response.ok) throw new SourceError(response.status, '资料版切换失败', response.url)
    return response.json()
  }

  // 按筛选条件领取某个流的全部行，自动跟随 Link rel="next"。
  // 继续标记只在同一资料版与筛选条件下有效，因此不重写游标链接里的任何参数。
  async fetchAll(stream, filters = {}) {
    const firstUrl = this.#buildUrl(stream, filters)
    const cacheKey = firstUrl.href
    const cached = this.#cache.get(cacheKey)
    const headers = {}
    if (cached) headers['If-None-Match'] = cached.etag

    let response = await fetchWithTimeout(firstUrl, { headers }, this.#timeoutMs)
    if (response.status === 304 && cached) return cached.rows
    if (response.status === 409) {
      this.#cache.delete(cacheKey)
      throw new SourceError(409, '继续标记已失效，需要重新领取', firstUrl.href)
    }
    if (!response.ok) {
      throw new SourceError(response.status, '资料读取失败：' + stream, firstUrl.href)
    }

    const firstEtag = response.headers.get('ETag')
    const edition = response.headers.get('X-Edition') ?? null
    const rows = parseTsv(await response.text())
    let next = response.headers.get('link')

    // 逐页领取，游标 URL 原样使用，不追加或改动 edition/筛选参数。
    let guard = 0
    while (next) {
      const match = /^<([^>]+)>/.exec(next)
      if (!match) throw new SourceError(502, 'Link 表头无法解析', firstUrl.href)
      const pageUrl = new URL(match[1], this.#baseUrl)
      response = await fetchWithTimeout(pageUrl, {}, this.#timeoutMs)
      if (response.status === 409) {
        this.#cache.delete(cacheKey)
        throw new SourceError(409, '分页继续标记冲突', pageUrl.href)
      }
      if (!response.ok) throw new SourceError(response.status, '分页资料读取失败', pageUrl.href)
      rows.push(...parseTsv(await response.text()))
      next = response.headers.get('link')
      if (++guard > 10000) throw new SourceError(508, '分页循环超出上限', firstUrl.href)
    }

    if (firstEtag) this.#cache.set(cacheKey, { etag: firstEtag, rows })
    Object.defineProperty(rows, 'edition', { value: edition, enumerable: true })
    return rows
  }
}
