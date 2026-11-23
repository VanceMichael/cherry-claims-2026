// 售后台客户端：读取按小票行/源批占额的处置，并提交新的处理回执。
// 退款本身仍由售后台操作，本服务只做凭据核对与申请提交。

export class RefundError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'RefundError'
    this.status = status
    this.body = body
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

export class RefundClient {
  #baseUrl
  #timeoutMs

  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#timeoutMs = timeoutMs
  }

  // 返回已经提交的按行按源批处理；accepted 与 paid 都占用可处理克数。
  async listLines(ticket) {
    const url = this.#baseUrl + '/refunds/lines?ticket=' + encodeURIComponent(ticket)
    const response = await fetchWithTimeout(url, {}, this.#timeoutMs)
    if (!response.ok) throw new RefundError(response.status, '售后台处置读取失败')
    return response.json()
  }

  // 提交处置。返回 { ok, status, receipt, state, duplicate, body }。
  // 409 表示相同申请已存在（已受理克数不得再申请），交由调用方回读核对。
  async propose({ ticket, line, lot, grams, key }) {
    const response = await fetchWithTimeout(this.#baseUrl + '/refunds/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, line, lot, grams, key })
    }, this.#timeoutMs)
    let body = null
    const text = await response.text()
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (response.status === 409) {
      return { ok: false, status: 409, duplicate: true, body }
    }
    if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
      throw new RefundError(response.status, '处置提交失败', body)
    }
    return {
      ok: true,
      status: response.status,
      receipt: body?.receipt ?? null,
      state: body?.state ?? null,
      duplicate: false,
      body
    }
  }
}
