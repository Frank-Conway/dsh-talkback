/**
 * TTS 客户端（朗读服务：`POST /tts` 与两个切权重接口）。
 *
 * 只做「把一段文字变成一份 WAV」这一件事，重试与质量判定放在调用方，
 * 因为重试要换采样参数、而质量判定属于「成片校验」策略。
 *
 * 几个契约里踩过的坑（见 docs/API.md 的「错误」「权重切换」），这里都按文档处理：
 * - **推理异常也是 400**，不能把 400 一律当成「参数写错」，要看 `Exception`；
 * - 切权重**先 T2S 后声码器**，只切一个会出现底模与声码器不匹配；
 * - 切权重失败**不阻断合成**（服务端可能本来配好了权重），下次再试；
 * - 服务重启后要重新切，所以遇到连接错误要清掉「已切换」标记。
 */

import { combineSignals, describePayload, readJsonSafe } from './http.js'
import { classifyFailure } from './http.js'

/** 允许的切分方式，与服务端 `text_split_method` 一致。 */
export const SPLIT_METHODS = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']

/**
 * 朗读服务调用失败。
 */
export class TtsError extends Error {
  /**
   * @param {string} message 中文错误描述。
   * @param {{ status?: number, kind?: string, cause?: unknown }} [details] 附加信息。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'TtsError'
    this.status = details.status
    this.kind = details.kind
    if (details.cause !== undefined) this.cause = details.cause
  }
}

/**
 * 一个本地朗读服务（TTS）的客户端。
 */
export class TtsClient {
  /**
   * @param {{ baseUrl: string, t2sWeightsPath?: string, vitsWeightsPath?: string, timeoutMs?: number, weightsTimeoutMs?: number }} config 连接与权重配置。
   * @param {{ logger?: any, fetchImpl?: typeof fetch }} [deps] 注入点。
   */
  constructor(config, deps = {}) {
    this.config = config
    this.baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 600000
    this.weightsTimeoutMs = config.weightsTimeoutMs ?? 180000
    this.logger = deps.logger
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
    /** 进程内只切一轮权重；服务重启或连接失败时清掉。 */
    this.weightsLoaded = false
  }

  /** 清掉「权重已切换」标记（服务重启、连接错误后调用）。 */
  reset() {
    this.weightsLoaded = false
  }

  /**
   * 确保权重已切到配置的版本。幂等，失败时抛错但保留标记为「未切换」。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<boolean>} 是否真的执行了切换。
   */
  async ensureWeights(signal) {
    if (this.weightsLoaded) return false
    const steps = [
      ['set_gpt_weights', this.config.t2sWeightsPath],
      ['set_sovits_weights', this.config.vitsWeightsPath],
    ]
    let switched = false
    for (const [endpoint, weightsPath] of steps) {
      if (!weightsPath) continue
      const url = new URL(`${this.baseUrl}/${endpoint}`)
      url.searchParams.set('weights_path', weightsPath)
      let response
      try {
        response = await this.fetchImpl(url, { signal: combineSignals(signal, this.weightsTimeoutMs) })
      } catch (error) {
        const failure = classifyFailure(error)
        throw new TtsError(this.#describeFailure(failure, `切换权重（${endpoint}）`), {
          kind: failure.kind,
          cause: error,
        })
      }
      const payload = await readJsonSafe(response)
      if (!response.ok) {
        throw new TtsError(
          `切换权重失败（${endpoint}）：${describePayload(payload) || `HTTP ${response.status}`}`,
          { status: response.status, kind: 'http' },
        )
      }
      switched = true
    }
    this.weightsLoaded = true
    return switched
  }

  /**
   * 合成一段文本。
   * @param {string} text 待合成文本（调用方已切成短片段）。
   * @param {{ voice: { refAudioPath: string, promptText: string }, textLang: string, promptLang: string, splitMethod: string, temperature?: number, repetitionPenalty?: number, topK?: number, topP?: number, speed?: number }} options 音色与采样参数。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<Buffer>} WAV 字节。
   */
  async synthesize(text, options, signal) {
    if (!text.trim()) throw new TtsError('文本为空，无法合成')
    if (!options.voice?.refAudioPath) throw new TtsError('没有可用的参考音频，无法合成')

    /** @type {Record<string, unknown>} */
    const body = {
      text,
      text_lang: options.textLang || 'zh',
      ref_audio_path: options.voice.refAudioPath,
      prompt_text: options.voice.promptText ?? '',
      prompt_lang: options.promptLang || 'zh',
      top_k: options.topK ?? 10,
      top_p: options.topP ?? 0.6,
      temperature: options.temperature ?? 0.5,
      repetition_penalty: options.repetitionPenalty ?? 1.5,
      text_split_method: options.splitMethod || 'cut3',
      media_type: 'wav',
      // 固定整段合成：要拿到完整 WAV 才能做静音裁剪与成片校验（docs/API.md 的「退化成片」）。
      // 流式（streaming_mode>0）返回的是「WAV 头 + 裸 PCM 帧」，那条路等首片流式真正落地再说。
      streaming_mode: false,
    }
    // 语速 1.0 时不下发，保持与「没有这个参数」的请求一致（旧服务端也友好）。
    if (options.speed !== undefined && Math.abs(options.speed - 1) > 1e-6) {
      body.speed_factor = Math.min(2, Math.max(0.5, options.speed))
    }

    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combineSignals(signal, this.timeoutMs),
      })
    } catch (error) {
      const failure = classifyFailure(error)
      if (failure.kind === 'refused') this.reset()
      throw new TtsError(this.#describeFailure(failure, '合成'), { kind: failure.kind, cause: error })
    }

    if (!response.ok) {
      const payload = await readJsonSafe(response)
      throw new TtsError(
        `朗读服务返回 HTTP ${response.status}：${describePayload(payload) || '（无响应体）'}`,
        { status: response.status, kind: 'http' },
      )
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF') {
      throw new TtsError('朗读服务返回的不是 WAV（很可能是 JSON 错误体），请检查服务端日志')
    }
    return bytes
  }

  /**
   * 预热：切权重 + 合成一句极短文本，把首次推理建 CUDA Graph 的开销提前付掉。
   * @param {{ refAudioPath: string, promptText: string }} voice 音色。
   * @param {{ textLang?: string, promptLang?: string, temperature?: number, repetitionPenalty?: number, topK?: number, topP?: number, speed?: number }} options 语言与采样参数（与真实请求保持一致，预热才有代表性）。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<void>} 预热完成。
   */
  async warmup(voice, options, signal) {
    await this.ensureWeights(signal)
    await this.synthesize('预热。', {
      voice,
      textLang: options.textLang ?? 'zh',
      promptLang: options.promptLang ?? 'zh',
      splitMethod: 'cut3',
      temperature: options.temperature,
      repetitionPenalty: options.repetitionPenalty,
      topK: options.topK,
      topP: options.topP,
      speed: options.speed,
    }, signal)
  }

  /**
   * 把网络层失败翻成能照着修的中文提示。
   * @param {{ kind: string }} failure 归类结果。
   * @param {string} action 正在做的事。
   * @returns {string} 中文错误。
   */
  #describeFailure(failure, action) {
    switch (failure.kind) {
      case 'cancelled':
        return `${action}已取消`
      case 'timeout':
        return `${action}超时（${this.baseUrl}）`
      case 'refused':
        return `连不上朗读服务（${this.baseUrl}），请先启动本机的朗读服务`
      case 'dns':
        return `无法解析朗读服务地址（${this.baseUrl}）`
      default:
        return `${action}失败：${failure.message ?? '网络错误'}`
    }
  }
}
