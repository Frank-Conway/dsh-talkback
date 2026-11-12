/**
 * 两个本地服务（识别服务 / 朗读服务）共用的小工具：
 * 合成取消信号、读 JSON、把网络层异常分成「连不上 / 超时 / 其它」三类。
 */

/**
 * 把调用方的取消信号与服务端超时合成为一个信号。
 * @param {AbortSignal | undefined} signal 调用方信号。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {AbortSignal} 合成信号。
 */
export function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 读响应体并尽力解析 JSON；空体或坏 JSON 返回 null / 原文占位。
 * @param {Response} response 响应。
 * @returns {Promise<any>} 解析结果。
 */
export async function readJsonSafe(response) {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text.slice(0, 500) }
  }
}

/**
 * 判断一次 fetch 失败的真实原因。
 * @param {unknown} error 捕获到的异常。
 * @returns {{ kind: 'cancelled' | 'timeout' | 'refused' | 'dns' | 'unknown', code?: string, message: string }} 归类结果。
 */
export function classifyFailure(error) {
  const cause = /** @type {any} */ (error)
  const name = cause?.name
  const message = cause?.message ?? String(error)
  if (name === 'AbortError') return { kind: 'cancelled', message }
  if (name === 'TimeoutError') return { kind: 'timeout', message }
  const codes = new Set()
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.code === 'string') codes.add(node.code)
    if (Array.isArray(node.errors)) node.errors.forEach(collect)
    if (node.cause) collect(node.cause)
  }
  collect(cause)
  if (codes.has('ECONNREFUSED') || codes.has('ECONNRESET') || codes.has('EHOSTUNREACH')) {
    return { kind: 'refused', code: [...codes][0], message }
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return { kind: 'dns', code: [...codes][0], message }
  }
  return { kind: 'unknown', code: codes.values().next().value, message }
}

/**
 * 把响应里的错误字段拼成一句话（识别服务用 detail，朗读服务用 message/Exception）。
 * @param {any} payload 响应体。
 * @returns {string} 可读的错误描述，没有则空串。
 */
export function describePayload(payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (payload.__raw) return payload.__raw
  const parts = []
  if (typeof payload.message === 'string' && payload.message) parts.push(payload.message)
  if (typeof payload.Exception === 'string' && payload.Exception) parts.push(payload.Exception)
  if (typeof payload.detail === 'string' && payload.detail) parts.push(payload.detail)
  else if (payload.detail) parts.push(JSON.stringify(payload.detail).slice(0, 300))
  if (typeof payload.error === 'string' && payload.error) parts.push(payload.error)
  return parts.join('：')
}
