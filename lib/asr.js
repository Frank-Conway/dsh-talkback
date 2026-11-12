/**
 * 识别服务客户端：只认接口契约，不关心对面跑的是什么模型。
 *
 * 契约（见 docs/API.md 的「同步转写」「异步转写」）：
 *   POST /api/v1/transcriptions/sync   multipart 上传，阻塞返回结果（≤60s 音频）
 *   POST /api/v1/transcriptions/upload 提交任务，随即 GET /{task_id} 轮询
 *   鉴权：可选 `X-API-Key`
 */

import { classifyFailure, combineSignals, describePayload } from './http.js'

/** 识别服务调用失败。 */
export class AsrError extends Error {
  /**
   * @param {string} message 中文说明。
   * @param {{ kind?: string, status?: number, cause?: unknown }} [options] 失败分类。
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause })
    this.name = 'AsrError'
    this.kind = options.kind ?? 'unknown'
    this.status = options.status
  }
}

/**
 * 把界面上的语言标签映射成 ASR 的语言参数。
 * @param {string} language 语言标签，例如 `auto` / `zh` / `yue`。
 * @returns {string} 空字符串表示交给服务端检测。
 */
export function asrLanguage(language) {
  const value = String(language ?? '').toLowerCase()
  if (!value || value === 'auto') return ''
  if (value === 'yue') return 'zh'
  if (value.startsWith('zh')) return 'zh'
  return value.replace(/_.*$/, '')
}

/**
 * 解析识别服务的响应体。
 * @param {any} payload 响应 JSON。
 * @returns {string} 识别文本。
 */
function textOf(payload) {
  if (!payload) throw new AsrError('识别服务返回了空响应')
  const status = payload.status
  if (status === 'failed') {
    const detail = describePayload(payload.error) || describePayload(payload) || '未知原因'
    throw new AsrError(`识别服务转写失败：${detail}`, { kind: 'task-failed' })
  }
  if (status && status !== 'completed') {
    throw new AsrError(`识别任务未完成（状态 ${status}）`, { kind: 'task-incomplete' })
  }
  const result = payload.result ?? payload
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  if (!text) throw new AsrError('识别服务没有识别出文字（可能是录音太短或全是噪音）', { kind: 'empty' })
  return text
}

/**
 * HTTP 失败翻成能直接照着做的中文提示。
 * @param {number} status 状态码。
 * @param {unknown} payload 响应体。
 * @returns {AsrError} 错误。
 */
function httpFailure(status, payload) {
  const detail = describePayload(payload)
  const suffix = detail ? `：${detail}` : ''
  if (status === 401 || status === 403) {
    return new AsrError(`识别服务鉴权失败（${status}），检查 asr.apiKey 与服务端 ASR_API_KEYS 是否一致${suffix}`, { kind: 'auth', status })
  }
  if (status === 404) {
    return new AsrError(`识别服务没有这个接口（404），确认 baseUrl 指向服务根地址${suffix}`, { kind: 'route', status })
  }
  if (status === 413) {
    return new AsrError(`录音超出识别服务的大小上限（413），调小 asr.maxUtteranceMs 试试${suffix}`, { kind: 'too-large', status })
  }
  if (status === 422) {
    return new AsrError(`识别服务拒绝了这次参数（422）${suffix}`, { kind: 'invalid', status })
  }
  if (status === 504) {
    return new AsrError(`识别服务处理超时（504），录音太长或机器太忙${suffix}`, { kind: 'gateway-timeout', status })
  }
  return new AsrError(`识别服务返回 ${status}${suffix}`, { kind: 'http', status })
}

/**
 * 网络异常翻成中文提示。
 * @param {string} base 服务地址。
 * @param {unknown} error 原始异常。
 * @returns {AsrError} 错误。
 */
function networkFailure(base, error) {
  const failure = classifyFailure(error)
  switch (failure.kind) {
    case 'cancelled':
      return new AsrError('识别请求已取消', { kind: 'cancelled', cause: error })
    case 'timeout':
      return new AsrError(`识别请求超时（${base}，asr.timeoutMs=${failure.timeout ?? '?'}ms）`, { kind: 'timeout', cause: error })
    case 'refused':
      return new AsrError(`连不上识别服务（${base}），请确认服务已启动`, { kind: 'refused', cause: error })
    case 'dns':
      return new AsrError(`无法解析识别服务地址（${base}）`, { kind: 'dns', cause: error })
    default:
      return new AsrError(`请求识别服务失败：${failure.message}`, { kind: 'network', cause: error })
  }
}

/** 识别服务客户端。 */
export class AsrClient {
  /**
   * @param {{ baseUrl: string, apiKey?: string, mode?: 'sync'|'async', language?: string, format?: string, sampleRate?: number, beamSize?: number, vadFilter?: boolean, wordTimestamps?: boolean, priority?: string, timeoutMs?: number, pollIntervalMs?: number, initialPrompt?: string }} config ASR 配置。
   * @param {{ logger?: any, fetchImpl?: typeof fetch, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [deps] 注入点。
   */
  constructor(config, deps = {}) {
    this.baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '')
    this.apiKey = config.apiKey ?? ''
    this.mode = config.mode ?? 'sync'
    this.language = config.language ?? 'zh'
    this.format = config.format ?? 'wav'
    this.sampleRate = config.sampleRate ?? 16000
    this.beamSize = config.beamSize ?? 5
    this.vadFilter = config.vadFilter ?? true
    this.wordTimestamps = config.wordTimestamps ?? false
    this.priority = config.priority ?? 'normal'
    this.timeoutMs = config.timeoutMs ?? 120000
    this.pollIntervalMs = config.pollIntervalMs ?? 1000
    this.initialPrompt = config.initialPrompt ?? ''
    this.fetch = deps.fetchImpl ?? globalThis.fetch
    this.logger = deps.logger ?? {}
    this.sleep = deps.sleep ?? defaultSleep
  }

  /**
   * 转写一段音频。
   * @param {Uint8Array} audio 音频字节（WAV）。
   * @param {{ language?: string, audioSeconds?: number, signal?: AbortSignal }} [options] 语言、时长、取消信号。
   * @returns {Promise<{ text: string, inferenceSeconds: number, audioSeconds: number }>} 识别结果。
   */
  async transcribe(audio, options = {}) {
    const startedAt = Date.now()
    const language = asrLanguage(options.language ?? this.language)
    const signal = combineSignals(options.signal, this.timeoutMs)
    const text = this.mode === 'async'
      ? await this.#transcribeAsync(audio, language, signal)
      : await this.#transcribeSync(audio, language, signal)
    return {
      text,
      inferenceSeconds: (Date.now() - startedAt) / 1000,
      audioSeconds: options.audioSeconds ?? 0,
    }
  }

  /**
   * 同步接口：一次请求拿结果。
   * @param {Uint8Array} audio 音频。
   * @param {string} language 语言。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<string>} 文本。
   */
  async #transcribeSync(audio, language, signal) {
    const query = new URLSearchParams()
    if (language) query.set('language', language)
    query.set('beam_size', String(this.beamSize))
    query.set('vad_filter', String(this.vadFilter))
    if (this.wordTimestamps) query.set('word_timestamps', 'true')
    if (this.initialPrompt) query.set('initial_prompt', this.initialPrompt)
    const url = `${this.baseUrl}/api/v1/transcriptions/sync?${query.toString()}`
    const payload = await this.#upload(url, audio, signal)
    return textOf(payload)
  }

  /**
   * 异步接口：提交任务后轮询到完成。
   * @param {Uint8Array} audio 音频。
   * @param {string} language 语言。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<string>} 文本。
   */
  async #transcribeAsync(audio, language, signal) {
    const query = new URLSearchParams()
    if (language) query.set('language', language)
    query.set('beam_size', String(this.beamSize))
    query.set('vad_filter', String(this.vadFilter))
    query.set('priority', this.priority)
    if (this.initialPrompt) query.set('initial_prompt', this.initialPrompt)
    const submitted = await this.#upload(`${this.baseUrl}/api/v1/transcriptions/upload?${query.toString()}`, audio, signal)
    const taskId = submitted?.task_id
    if (!taskId) throw new AsrError('识别服务没有返回 task_id，无法轮询', { kind: 'protocol' })
    for (;;) {
      signal.throwIfAborted()
      const payload = await this.#json(`${this.baseUrl}/api/v1/transcriptions/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal)
      const status = payload?.status
      if (status === 'completed') return textOf(payload)
      if (status === 'failed') return textOf(payload)
      await this.sleep(this.pollIntervalMs, signal)
    }
  }

  /**
   * multipart 上传音频。
   * @param {string} url 目标地址。
   * @param {Uint8Array} audio 音频字节。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<any>} 响应 JSON。
   */
  async #upload(url, audio, signal) {
    const filename = `speech.${this.format}`
    const type = this.format === 'wav' ? 'audio/wav' : `audio/${this.format}`
    const form = new FormData()
    form.append('file', new Blob([audio], { type }), filename)
    this.logger.debug?.('识别服务上传 %s（%s）', filename, `${audio.length} B`)
    return await this.#json(url, { method: 'POST', body: form }, signal)
  }

  /**
   * 发一次请求并解析 JSON，统一处理失败。
   * @param {string} url 目标地址。
   * @param {RequestInit} init 请求参数。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<any>} 响应 JSON。
   */
  async #json(url, init, signal) {
    let response
    const headers = { ...(init.headers ?? {}) }
    // 所有请求都带鉴权头：轮询任务状态同样要走 API Key。
    if (this.apiKey) headers['x-api-key'] = this.apiKey
    try {
      response = await this.fetch(url, { ...init, headers, signal })
    } catch (error) {
      throw networkFailure(this.baseUrl, error)
    }
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text ? { detail: text.slice(0, 200) } : null
    }
    if (!response.ok) throw httpFailure(response.status, payload)
    return payload
  }
}

/**
 * 可被取消的 sleep。
 * @param {number} ms 毫秒。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<void>} 等待结束。
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
