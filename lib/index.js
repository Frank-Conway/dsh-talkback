/**
 * 语音插件的宿主半边。
 *
 * 职责只有两件事：
 *   1. 收客户端的音频 -> 调本地 ASR 接口 -> 把文本注入当前会话；
 *   2. 监听会话里的助手回复 -> 调本地 TTS 接口 -> 把音频交给客户端播放。
 *
 * 除此之外的东西都归客户端：麦克风、VAD、编码、播放、打断。
 * 本地服务是哪一个实现、什么模型，这里一概不问，只按接口契约说话。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { readVoiceSection, writeVoiceValues, MANAGED_FIELDS } from './config-writer.js'
import { diagnose } from './doctor.js'
import { SpeechHub, createRetryingSynthesizer } from './hub.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from './name.js'
import { privateLogger } from './privacy.js'
import { findVoiceProfiles, tildePath } from './profile.js'
import { TtsClient, SPLIT_METHODS } from './tts.js'
import { resolveVoice, scanVoices } from './voices.js'
import { wavDuration } from './wav.js'
import { AsrClient } from './asr.js'

/** 插件名（也是客户端模块 id），来自 package.json。 */
export const name = PACKAGE_NAME

/** 宿主侧依赖：HTTP 路由、agent 注册表、命令表。 */
export const inject = ['webServer', 'agents', 'commands']

/** 音频上传上限（默认 32 MB，约 10 分钟 16 kHz PCM16）。 */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024

/** 插件配置：接口、音频格式、超时、以及隐私开关。 */
export const Config = z.object({
  /** 总开关。关掉后宿主不接音频也不朗读。 */
  enabled: z.boolean().default(true),

  transport: z.object({
    /** 宿主暴露给浏览器的路由前缀（客户端从同源相对路径调用）。 */
    path: z.string().default('/voice'),
    /** 长轮询最长挂起毫秒：客户端一次 `next` 最多等这么久。 */
    pollWaitMs: z.natural().min(1000).max(120000).default(25000),
    /** 服务端只监听回环地址时才放行；绑到网卡上又没开这个开关时拒绝启用。 */
    allowRemote: z.boolean().default(false),
  }).default({}),

  asr: z.object({
    /** 是否请求识别服务；关掉后客户端不采集麦克风，只保留朗读。 */
    enabled: z.boolean().default(true),
    /** 识别服务地址。 */
    endpoint: z.string().min(1).default('http://127.0.0.1:8000'),
    /** 可选 `X-API-Key`；服务端没开鉴权就留空。 */
    apiKey: z.string().default(''),
    /** 转写语言：auto 交给服务端检测。 */
    language: z.string().default('zh'),
    /** 上传的音频容器格式（客户端编码成这个格式）。 */
    format: z.string().default('wav'),
    /** 音频采样率（客户端按这个采样率编码）。 */
    sampleRate: z.natural().default(16000),
    /** 单次识别超时毫秒。 */
    timeoutMs: z.natural().default(120000),
    /** `sync` 一次请求拿结果；`async` 提交任务后轮询（适合长录音）。 */
    mode: z.union(['sync', 'async']).default('sync'),
    /** 轮询间隔毫秒（异步模式）。 */
    pollIntervalMs: z.natural().min(200).default(1000),
    beamSize: z.natural().min(1).max(10).default(5),
    vadFilter: z.boolean().default(true),
    wordTimestamps: z.boolean().default(false),
    priority: z.string().default('normal'),
    initialPrompt: z.string().default(''),
  }).default({}),

  tts: z.object({
    /** 是否朗读助手回复。 */
    enabled: z.boolean().default(true),
    /** 朗读服务地址。 */
    endpoint: z.string().min(1).default('http://127.0.0.1:9880'),
    /** 期望的音频容器格式（当前契约输出 wav）。 */
    format: z.string().default('wav'),
    /** 输出采样率，仅用于日志与校验（实际由服务端决定）。 */
    sampleRate: z.natural().default(32000),
    /** 单次合成超时毫秒。 */
    timeoutMs: z.natural().default(600000),
    /** 启用后在后台预热一次（切权重 + 合成一句），把首次推理建 CUDA Graph 的 ~20s 提前付掉。 */
    warmup: z.boolean().default(true),
    /** T2S 权重，按服务端工作目录解析；留空不改动。 */
    t2sWeightsPath: z.string().default(''),
    /** 声码器（VITS）权重，按服务端工作目录解析；留空不改动。 */
    vitsWeightsPath: z.string().default(''),
    /** 直接指定参考音频（3~10 秒）与逐字文本；填了就优先于 voiceDir。 */
    refAudioPath: z.string().default(''),
    promptText: z.string().default(''),
    /** 音色目录：递归 ≤3 层找 ref_info.json。 */
    voiceDir: z.string().default(''),
    /** 选哪条音色（voice_id / voice_name / 显示名片段）；留空取第一条。 */
    voice: z.string().default(''),
    textLang: z.string().default('zh'),
    promptLang: z.string().default('zh'),
    speed: z.number().min(0.5).max(2).default(1),
    temperature: z.number().min(0).max(2).default(0.5),
    topK: z.natural().min(1).default(10),
    topP: z.number().min(0.1).max(1).default(0.6),
    repetitionPenalty: z.number().min(1).max(2).default(1.5),
    textSplitMethod: z.union(SPLIT_METHODS).default('cut3'),
    /** 每片字数上限：太长容易退化。 */
    maxCharsPerChunk: z.natural().min(10).max(80).default(40),
    /** 首片字数上限：首片短一点，第一声就早一点出来（TTS 单次有 ~3s 固定开销，0 = 不额外切）。 */
    firstChunkChars: z.natural().max(80).default(14),
    /** 单条回复最多念多少字（0 = 不限）。 */
    maxSpeakChars: z.natural().default(1200),
    /** 每片最多尝试几次。 */
    maxRetries: z.natural().min(1).max(6).default(3),
    /** 成片校验：有声时长占估算值的下限。 */
    minVoicedRatio: z.number().min(0).max(1).default(0.45),
    /** 成片校验：句内最长静音秒数。 */
    maxInternalSilence: z.number().min(0).default(2.5),
    /** 成片校验：片尾最长静音秒数。 */
    maxTrailingSilence: z.number().min(0).default(1.5),
    /** 是否朗读子代理会话的回复。 */
    speakSubagentSessions: z.boolean().default(false),
    /** 队列最多缓存多少片（积压时丢最早的）。 */
    maxQueueChunks: z.natural().min(1).default(40),
    /** 音频在内存里最多留多久（没人取就丢）。 */
    retentionSeconds: z.natural().min(10).default(120),
  }).default({}),

  client: z.object({
    /** 一句话最长录制时长毫秒，超过强制结束。 */
    maxUtteranceMs: z.natural().min(1000).default(20000),
    /** 一句话最短时长毫秒，太短直接丢弃（防误触）。 */
    minUtteranceMs: z.natural().min(100).default(400),
    /** 静音多久算这句话说完（毫秒）。 */
    silenceMs: z.natural().min(200).default(900),
    /** 启动 VAD 的能量阈值（0~1，RMS）。 */
    vadThreshold: z.number().min(0.001).max(1).default(0.02),
    /** 起录前往前保留多少毫秒音频，避免把第一个字的起振切掉。 */
    prerollMs: z.natural().max(3000).default(600),
    /** 连续有声多少毫秒才算开口（挡掉键盘、关门这类一声响）。 */
    onsetMs: z.natural().max(1000).default(150),
    /** 噪音闸门：整段电平平稳得像空调/风扇就不送去识别，免得识别服务幻觉出文本。 */
    noiseGate: z.boolean().default(true),
    /** 闸门：有声帧占整段的比例低于这个值，视为没在说话。 */
    minVoicedRatio: z.number().min(0).max(1).default(0.1),
    /** 闸门：有声帧电平的变异系数低于这个值视为稳态噪音（人说话通常 0.3 以上）。 */
    levelVariance: z.number().min(0.01).max(2).default(0.15),
    /** 播报中检测到用户说话就打断。 */
    bargeIn: z.boolean().default(true),
    /** 打断阈值：播报时要盖过自己的声音，所以通常比 vadThreshold 高。 */
    bargeInThreshold: z.number().min(0.001).max(1).default(0.06),
    /** 连续超过阈值多久才算打断（毫秒）。 */
    bargeInMs: z.natural().min(100).default(450),
    /** 播放音量（0~1）。 */
    playbackGain: z.number().min(0).max(1).default(1),
    /** 麦克风约束：回声消除（外放时必须开）。 */
    echoCancellation: z.boolean().default(true),
    noiseSuppression: z.boolean().default(true),
    autoGainControl: z.boolean().default(true),
  }).default({}),

  privacy: z.object({
    /** 日志里记录完整文本（默认关：只记字数）。 */
    logText: z.boolean().default(false),
    /** 日志里记录音频大小与时长（默认关：只记字节数）。 */
    logAudio: z.boolean().default(false),
    /** 音频在内存里的保留秒数，超时丢弃。 */
    retentionSeconds: z.natural().min(10).default(120),
  }).default({}),
})

/**
 * 从助手消息里挑出可朗读的文字（只要 text 块，思考与工具调用都不念）。
 * @param {{ content?: Array<{ type?: string, text?: string }> }} message 助手消息。
 * @returns {string} 纯文本。
 */
export function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const pieces = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) pieces.push(block.text)
  }
  return pieces.join('\n').trim()
}

/**
 * 判断会话是不是子代理会话。
 * @param {{ header?: { origin?: string, delegationDepth?: number } }} session 会话。
 * @returns {boolean} 是否子代理。
 */
function isSubAgentSession(session) {
  const header = session?.header
  if (!header) return false
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/**
 * 造一条用户消息。内容与 `createUserMessage` 等价，只是不引入额外依赖。
 * @param {string} text 文本。
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'user' } }} 冻结后的消息。
 */
function userMessage(text) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  return deepFreeze(message)
}

/**
 * 递归冻结。
 * @template T
 * @param {T} value 待冻结的值。
 * @returns {T} 同一个值。
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 读请求体，超过上限直接断开。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} [limit] 字节上限。
 * @returns {Promise<Buffer>} 请求体。
 */
async function readBody(req, limit = MAX_AUDIO_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      req.destroy()
      throw new Error(`请求体超过 ${limit} 字节上限`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 回一个 JSON。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {unknown} payload 内容。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 回一段 WAV。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {Buffer} wav 音频。
 * @returns {void}
 */
function sendWav(res, wav) {
  res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' })
  res.end(wav)
}

/**
 * 判断服务端是否只绑在回环地址上。
 * @param {string} host 监听地址。
 * @returns {boolean} 是否回环。
 */
function isLoopback(host) {
  const value = String(host ?? '').toLowerCase()
  return value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1'
    || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

/**
 * 校验配置页提交的字段。
 *
 * 只认 `MANAGED_FIELDS` 里那几个：别的键一律忽略，避免页面成了「可以改任何配置」
 * 的后门。空字符串表示「删掉这条覆盖，回落到默认值」。
 * @param {unknown} payload 请求体。
 * @returns {{ values?: Record<string, string | number>, error?: string }} 校验结果。
 */
export function validateConfigInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '请求体必须是对象' }
  }
  /** @type {Record<string, string | number>} */
  const values = {}
  const raw = /** @type {Record<string, unknown>} */ (payload)

  for (const key of ['asr.endpoint', 'tts.endpoint']) {
    if (!Object.hasOwn(raw, key)) continue
    const value = String(raw[key] ?? '').trim().replace(/\/+$/, '')
    if (!value) return { error: `${key} 不能为空` }
    if (!/^https?:\/\/\S+$/i.test(value)) return { error: `${key} 必须是 http(s) 地址` }
    if (value.length > 500) return { error: `${key} 太长` }
    values[key] = value
  }

  for (const key of ['enabled', 'asr.enabled', 'tts.enabled', 'tts.warmup']) {
    if (!Object.hasOwn(raw, key)) continue
    if (typeof raw[key] !== 'boolean') return { error: `${key} 必须是 true / false` }
    values[key] = raw[key]
  }

  for (const key of ['tts.voiceDir', 'tts.voice']) {
    if (!Object.hasOwn(raw, key)) continue
    const value = String(raw[key] ?? '').trim()
    if (value.length > 1024) return { error: `${key} 太长` }
    values[key] = value
  }

  if (Object.hasOwn(raw, 'client.silenceMs')) {
    const value = String(raw['client.silenceMs'] ?? '').trim()
    if (value === '') {
      values['client.silenceMs'] = ''
    } else {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 200 || number > 10000) {
        return { error: 'client.silenceMs 必须是 200~10000 的整数' }
      }
      values['client.silenceMs'] = number
    }
  }

  if (Object.keys(values).length === 0) {
    return { error: `没有可写的字段（支持：${Object.keys(MANAGED_FIELDS).join('、')}）` }
  }
  return { values }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {ReturnType<typeof Config>} config 配置。
 * @param {Record<string, unknown>} [deps] 注入点（测试用）。
 */
export function apply(ctx, config, deps = {}) {
  const privacy = { logText: config.privacy.logText, logAudio: config.privacy.logAudio }
  const logger = privateLogger(ctx.logger, privacy)
  const base = config.transport.path.replace(/\/+$/, '') || '/voice'

  const asr = deps.asr ?? new AsrClient({
    baseUrl: config.asr.endpoint,
    apiKey: config.asr.apiKey,
    mode: config.asr.mode,
    language: config.asr.language,
    format: config.asr.format,
    sampleRate: config.asr.sampleRate,
    beamSize: config.asr.beamSize,
    vadFilter: config.asr.vadFilter,
    wordTimestamps: config.asr.wordTimestamps,
    priority: config.asr.priority,
    timeoutMs: config.asr.timeoutMs,
    pollIntervalMs: config.asr.pollIntervalMs,
    initialPrompt: config.asr.initialPrompt,
  }, { logger })

  /** 当前处于持续监听模式的会话（客户端切到空闲时移除）。 */
  const voiceSessions = new Set()
  /** 客户端最近一次上报的错误（只留一行，不含文本内容）。 */
  let lastClientError = null

  /** TTS 客户端：合成与预热共用一份，权重只切一轮。 */
  const tts = deps.tts ?? new TtsClient({
    baseUrl: config.tts.endpoint,
    t2sWeightsPath: config.tts.t2sWeightsPath,
    vitsWeightsPath: config.tts.vitsWeightsPath,
    timeoutMs: config.tts.timeoutMs,
  }, { logger })

  const hub = new SpeechHub({
    synthesize: deps.synthesize ?? createSynthesizer(),
    logger,
    maxCharsPerChunk: config.tts.maxCharsPerChunk,
    firstChunkChars: config.tts.firstChunkChars,
    maxSpeakChars: config.tts.maxSpeakChars,
    maxQueueChunks: config.tts.maxQueueChunks,
    retentionSeconds: Math.min(config.tts.retentionSeconds, config.privacy.retentionSeconds),
  })

  /** 预热状态：`done` 表示已经付过那笔开销，`pending` 是进行中的那一轮（并发调用共用）。 */
  const warmState = { done: false, pending: null }

  /**
   * 预热一次：切权重 + 合成一句极短文本，把首次推理建 CUDA Graph 的 ~20s 提前付掉。
   * 失败不记「已预热」，下次调用（切到持续监听、下一条回复）还会再试一次。
   * @param {string} reason 触发原因（只写日志）。
   * @returns {Promise<void>} 预热完成（失败也算完成）。
   */
  function warmupOnce(reason) {
    if (warmState.done) return Promise.resolve()
    if (warmState.pending) return warmState.pending
    if (!config.tts.enabled || !config.tts.warmup) return Promise.resolve()
    warmState.pending = (async () => {
      try {
        const selected = await resolveVoiceConfig()
        if (!selected) return
        await tts.warmup(selected, {
          textLang: config.tts.textLang,
          promptLang: config.tts.promptLang,
          temperature: config.tts.temperature,
          repetitionPenalty: config.tts.repetitionPenalty,
          topK: config.tts.topK,
          topP: config.tts.topP,
          speed: config.tts.speed,
        })
        warmState.done = true
        logger.info?.('TTS 已预热（%s）', reason)
      } catch (error) {
        logger.warn?.('TTS 预热失败（%s），首次朗读会慢一些：%s', reason, error?.message ?? error)
      } finally {
        warmState.pending = null
      }
    })()
    return warmState.pending
  }

  /**
   * 组装合成函数：解析音色、切权重、按句合成并可重试。
   * @returns {(text: string, signal: AbortSignal) => Promise<Buffer | null>} 合成器。
   */
  function createSynthesizer() {
    let voicePromise = null
    const voice = async () => {
      voicePromise ??= (async () => {
        const resolved = await resolveVoiceConfig()
        return resolved
      })()
      return await voicePromise
    }
    const attempts = []
    const safeTemperature = Math.max(0.3, config.tts.temperature - 0.15)
    const safePenalty = Math.min(2, config.tts.repetitionPenalty + 0.15)
    const ladder = [
      { split: config.tts.textSplitMethod, temperature: config.tts.temperature, repetitionPenalty: config.tts.repetitionPenalty },
      { split: 'cut0', temperature: safeTemperature, repetitionPenalty: safePenalty },
      { split: 'cut5', temperature: safeTemperature, repetitionPenalty: safePenalty },
      { split: 'cut0', temperature: safeTemperature, repetitionPenalty: safePenalty },
      { split: 'cut3', temperature: safeTemperature, repetitionPenalty: safePenalty },
      { split: 'cut5', temperature: safeTemperature, repetitionPenalty: safePenalty },
    ]
    for (const step of ladder.slice(0, config.tts.maxRetries)) attempts.push(step)
    return createRetryingSynthesizer({
      logger,
      speed: config.tts.speed,
      thresholds: {
        minVoicedRatio: config.tts.minVoicedRatio,
        maxInternalSilence: config.tts.maxInternalSilence,
        maxTrailingSilence: config.tts.maxTrailingSilence,
      },
      attempts,
      synthesize: async (text, attempt, signal) => {
        // 预热还在跑就先等它：同一张卡上并发推理容易抢显存，也容易把首句挤慢。
        if (warmState.pending) await warmState.pending
        const selected = await voice()
        if (!selected) throw new Error('没有可用的音色：请配置 tts.refAudioPath + tts.promptText，或 tts.voiceDir')
        await tts.ensureWeights(signal)
        const wav = await tts.synthesize(text, synthesisOptions(selected, attempt), signal)
        logger.debug?.('合成一片：%s，时长 %.2fs', logger.audio(wav, wavDuration(wav)), wavDuration(wav))
        return wav
      },
    })
  }

  /**
   * 一次合成请求的参数（重试档位只改切分方式与采样温度）。
   * @param {{ refAudioPath: string, promptText: string, label: string, duration: number | null }} selected 音色。
   * @param {{ split: string, temperature?: number, repetitionPenalty?: number }} attempt 档位。
   * @returns {{ voice: any, textLang: string, promptLang: string, splitMethod: string, temperature?: number, repetitionPenalty?: number, topK: number, topP: number, speed: number }} 合成参数。
   */
  function synthesisOptions(selected, attempt) {
    return {
      voice: selected,
      textLang: config.tts.textLang,
      promptLang: config.tts.promptLang,
      splitMethod: attempt.split,
      temperature: attempt.temperature,
      repetitionPenalty: attempt.repetitionPenalty,
      topK: config.tts.topK,
      topP: config.tts.topP,
      speed: config.tts.speed,
    }
  }

  /**
   * 合成一句（不给重试、不校验），给 `/voice doctor` 做契约探测用。
   * @param {string} text 文本。
   * @returns {Promise<Buffer>} WAV 字节。
   */
  async function synthesizeOnce(text) {
    const selected = await resolveVoiceConfig()
    if (!selected) throw new Error('没有可用的音色')
    await tts.ensureWeights()
    return await tts.synthesize(text, synthesisOptions(selected, {
      split: config.tts.textSplitMethod,
      temperature: config.tts.temperature,
      repetitionPenalty: config.tts.repetitionPenalty,
    }), AbortSignal.timeout(config.tts.timeoutMs))
  }

  /**
   * 解析音色配置（依赖 voices.js，按需加载以免启动即扫盘）。
   * @returns {Promise<{ refAudioPath: string, promptText: string, label: string, duration: number | null } | null>} 音色。
   */
  async function resolveVoiceConfig() {
    const selected = await resolveVoice({
      refAudioPath: config.tts.refAudioPath,
      promptText: config.tts.promptText,
      voiceDir: config.tts.voiceDir,
      voice: config.tts.voice,
    }, logger)
    if (selected) logger.info?.('朗读音色：%s', selected.label)
    return selected
  }

  /**
   * 找到会话对应的 agent，找不到就抛错。
   * @param {string} sessionId 会话 id。
   * @returns {any} agent。
   */
  function requireAgent(sessionId) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) throw new Error(`会话 ${sessionId} 不在运行中：先打开一个会话再说话`)
    if (typeof agent.followup !== 'function') throw new Error('当前会话的 agent 不支持注入消息')
    return agent
  }

  /**
   * 注入一条用户消息到会话，让它像用户敲进来一样跑起来。
   * @param {string} sessionId 会话 id。
   * @param {string} text 文本。
   * @returns {{ injected: boolean, busy: boolean }} 注入结果。
   */
  function injectPrompt(sessionId, text) {
    const agent = requireAgent(sessionId)
    const busy = agent.status === 'running'
    agent.followup(userMessage(text))
    voiceSessions.add(sessionId)
    return { injected: true, busy }
  }

  /**
   * 处理一次识别请求。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 处理完成。
   */
  async function handleAsr(req, res) {
    // 关掉识别时先拒，连请求体都不读：区分「不想上传音频」和「服务出错」。
    if (!config.asr.enabled) {
      sendJson(res, 403, { error: 'ASR 已禁用（asr.enabled=false）' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!sessionId) {
      sendJson(res, 400, { error: '缺少 sessionId' })
      return
    }
    const audio = await readBody(req)
    if (audio.length === 0) {
      sendJson(res, 400, { error: '没有收到音频' })
      return
    }
    const seconds = wavDuration(audio)
    // 先确认会话还在，再花算力识别：陌生会话不该白跑一次推理。
    try {
      requireAgent(sessionId)
    } catch (error) {
      sendJson(res, 409, { error: String(error?.message ?? error), kind: 'session' })
      return
    }
    logger.info?.('收到语音：%s，%s', logger.audio(audio, seconds), sessionId)
    let transcript
    try {
      transcript = await asr.transcribe(audio, {
        language: url.searchParams.get('language') || config.asr.language,
        audioSeconds: seconds,
      })
    } catch (error) {
      const kind = error?.kind ?? 'unknown'
      logger.warn?.('识别失败（%s）：%s', kind, error?.message ?? error)
      sendJson(res, 502, { error: String(error?.message ?? error), kind })
      return
    }
    logger.info?.('识别完成：%s（%.2fs）', logger.text(transcript.text), transcript.inferenceSeconds)
    try {
      const result = injectPrompt(sessionId, transcript.text)
      logger.info?.('已注入会话 %s（%s）', sessionId, result.busy ? '当前有回复在跑，排到下一轮' : '立即开始新一轮')
      sendJson(res, 200, {
        text: transcript.text,
        chars: [...transcript.text].length,
        inferenceSeconds: Number(transcript.inferenceSeconds.toFixed(2)),
        audioSeconds: Number(seconds.toFixed(2)),
        ...result,
      })
    } catch (error) {
      logger.warn?.('注入失败：%s', error?.message ?? error)
      sendJson(res, 409, { error: String(error?.message ?? error), kind: 'inject' })
    }
  }

  /**
   * 取下一片待播放音频（长轮询）。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 处理完成。
   */
  async function handleNext(req, res) {
    const body = await readBody(req, 64 * 1024)
    let payload = {}
    try {
      payload = body.length ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) {
      sendJson(res, 400, { error: '缺少 sessionId' })
      return
    }
    const chunk = await hub.next(sessionId, { waitMs: config.transport.pollWaitMs })
    if (!chunk) {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, chunk)
  }

  /**
   * 取一片音频字节。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {void}
   */
  function handleAudio(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const id = url.searchParams.get('id') ?? ''
    if (!sessionId || !id) {
      sendJson(res, 400, { error: !sessionId ? '缺少 sessionId' : '缺少 id' })
      return
    }
    const piece = hub.take(sessionId, id)
    if (!piece) {
      sendJson(res, 404, { error: '这一段音频已经过期或被取走了' })
      return
    }
    logger.debug?.('送出第 %d/%d 片：%s', piece.index + 1, piece.total, logger.audio(piece.wav))
    sendWav(res, piece.wav)
  }

  /**
   * 打断当前朗读。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 处理完成。
   */
  async function handleSkip(req, res) {
    const body = await readBody(req, 64 * 1024)
    let payload = {}
    try {
      payload = body.length ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      payload = {}
    }
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) {
      sendJson(res, 400, { error: '缺少 sessionId' })
      return
    }
    const skipped = hub.skip(sessionId, String(payload.reason ?? '客户端打断'))
    sendJson(res, 200, { skipped })
  }

  /**
   * 客户端上报模式：`listening=true` 是持续监听，`false` 是空闲。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 处理完成。
   */
  async function handleState(req, res) {
    const body = await readBody(req, 64 * 1024)
    let payload = {}
    try {
      payload = body.length ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      payload = {}
    }
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) {
      sendJson(res, 400, { error: '缺少 sessionId' })
      return
    }
    // 浏览器侧开麦失败之类的错误：照原样留痕，控制台和 /status 都能看到。
    const clientError = String(payload.error ?? '').slice(0, 400).trim()
    if (clientError) {
      lastClientError = { at: new Date().toISOString(), sessionId, message: clientError }
      logger.warn?.('语音客户端报错：%s', clientError)
    }
    if (typeof payload.listening !== 'boolean') {
      sendJson(res, 200, { ok: true, sessions: [...voiceSessions] })
      return
    }
    const listening = payload.listening
    if (listening) {
      voiceSessions.add(sessionId)
      // 用户刚切到持续监听：趁他还在说话，把首次推理的开销先付掉。
      void warmupOnce('切到持续监听')
    } else {
      voiceSessions.delete(sessionId)
      hub.skip(sessionId, '空闲：停止监听与朗读')
    }
    sendJson(res, 200, { listening, sessions: [...voiceSessions] })
  }

  /**
   * 状态总览（不含任何文本内容）。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {void}
   */
  function handleStatus(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    sendJson(res, 200, {
      enabled: config.enabled,
      enabledSessions: [...voiceSessions],
      asr: { enabled: config.asr.enabled, endpoint: config.asr.endpoint, mode: config.asr.mode, language: config.asr.language, sampleRate: config.asr.sampleRate },
      tts: { endpoint: config.tts.endpoint, format: config.tts.format, sampleRate: config.tts.sampleRate, voice: config.tts.voice || null },
      queue: sessionId ? hub.status(sessionId) : null,
      lastClientError,
      privacy: { logText: config.privacy.logText, logAudio: config.privacy.logAudio, retentionSeconds: config.privacy.retentionSeconds },
    })
  }

  /**
   * 当前装了本插件的 profile（配置页与自检共用；测试可注入）。
   * @returns {Promise<Array<{ name: string, dir: string, patchFile: string, patched: boolean }>>} profile 列表。
   */
  async function voiceProfiles() {
    return await Promise.resolve((deps.findProfiles ?? findVoiceProfiles)()).catch(() => [])
  }

  /**
   * 配置页读取：当前生效值 + 配置文件里显式写了什么 + 可选音色。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 无。
   */
  async function handleConfigGet(req, res) {
    const profiles = await voiceProfiles()
    const profile = profiles[0] ?? null
    const written = profile
      ? await readVoiceSection(profile.patchFile).catch(() => ({ exists: false, values: {}, others: [] }))
      : { exists: false, values: {}, others: [] }
    const voiceDir = String(config.tts.voiceDir ?? '').trim()
    const voices = voiceDir ? await scanVoices(path.resolve(voiceDir)).catch(() => []) : []
    sendJson(res, 200, {
      patchFile: profile?.patchFile ?? null,
      patched: written.exists,
      written: written.values,
      others: written.others,
      enabled: config.enabled,
      voices: voices.map((item) => ({ label: item.label, voiceId: item.voiceId, dur: item.dur })),
      asr: {
        enabled: config.asr.enabled,
        endpoint: config.asr.endpoint,
        language: config.asr.language,
        mode: config.asr.mode,
        hasApiKey: Boolean(config.asr.apiKey),
      },
      tts: {
        enabled: config.tts.enabled,
        warmup: config.tts.warmup,
        endpoint: config.tts.endpoint,
        voiceDir: config.tts.voiceDir,
        voice: config.tts.voice,
        refAudioPath: config.tts.refAudioPath,
        promptText: config.tts.promptText,
      },
      client: {
        silenceMs: config.client.silenceMs,
        onsetMs: config.client.onsetMs,
        prerollMs: config.client.prerollMs,
        vadThreshold: config.client.vadThreshold,
        bargeInThreshold: config.client.bargeInThreshold,
        noiseGate: config.client.noiseGate,
      },
    })
  }

  /**
   * 配置页保存：校验后只改 `- id: voice` 那一段，别人的条目和注释原样保留。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 无。
   */
  async function handleConfigPost(req, res) {
    let payload
    try {
      payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const checked = validateConfigInput(payload)
    if (checked.error) {
      sendJson(res, 400, { error: checked.error })
      return
    }
    const profiles = await voiceProfiles()
    const profile = profiles[0]
    if (!profile) {
      sendJson(res, 409, { error: `没找到装了 ${PACKAGE_NAME} 的 profile，无法写回配置` })
      return
    }
    try {
      const result = await writeVoiceValues(profile.patchFile, checked.values ?? {})
      logger.info?.('配置已写入 %s（%d 个字段）', tildePath(profile.patchFile), Object.keys(checked.values ?? {}).length)
      sendJson(res, 200, {
        ok: true,
        patchFile: profile.patchFile,
        values: result.values,
        created: result.created,
      })
    } catch (error) {
      logger.warn?.('写配置失败：%s', error?.message ?? error)
      sendJson(res, 500, { error: `写配置失败：${error?.message ?? error}` })
    }
  }

  ctx.effect(() => {
    const host = ctx.webServer?.host ?? ''
    const exposed = isLoopback(host) || config.transport.allowRemote
    if (!config.enabled) {
      ctx.logger?.info?.(`${PACKAGE_NAME} 已禁用（enabled=false）`)
      if (!exposed) return () => {}
      // 关掉总开关时只留配置页的路由：设置页得能把 enabled 改回来。
      // 否则「关掉插件」等于把自己的入口也关掉，之后只能去手改 YAML。
      return ctx.webServer.register({
        kind: 'exact',
        path: `${base}/config`,
        handler: (req, res) => (req.method === 'POST' ? handleConfigPost(req, res) : handleConfigGet(req, res)),
      })
    }
    if (!exposed) {
      ctx.logger?.warn?.(
        `${PACKAGE_NAME} 拒绝启用：web 服务监听在 %s 而不是回环地址，语音路由会把麦克风音频暴露给局域网。`
        + '确实需要时把 transport.allowRemote 打开。',
        host,
      )
      return () => {}
    }

    const disposeRoutes = [
      ctx.webServer.register({ kind: 'exact', path: `${base}/asr`, handler: (req, res) => handleAsr(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/next`, handler: (req, res) => handleNext(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/audio`, handler: (req, res) => handleAudio(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/skip`, handler: (req, res) => handleSkip(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/state`, handler: (req, res) => handleState(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/status`, handler: (req, res) => handleStatus(req, res) }),
      ctx.webServer.register({ kind: 'exact', path: `${base}/config`, handler: (req, res) => (req.method === 'POST' ? handleConfigPost(req, res) : handleConfigGet(req, res)) }),
    ]
    // 把客户端要用的配置注入页面：客户端不需要额外请求就能知道路由与阈值。
    const disposeInject = ctx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'global',
        name: '__DSH_VOICE__',
        value: {
          base,
          // 客户端模块 id 与包名一致；浏览器半边读不到 package.json，由这里带过去。
          packageName: PACKAGE_NAME,
          packageVersion: PACKAGE_VERSION,
          client: {
            sampleRate: config.asr.sampleRate,
            maxUtteranceMs: config.client.maxUtteranceMs,
            minUtteranceMs: config.client.minUtteranceMs,
            silenceMs: config.client.silenceMs,
            vadThreshold: config.client.vadThreshold,
            prerollMs: config.client.prerollMs,
            onsetMs: config.client.onsetMs,
            noiseGate: config.client.noiseGate,
            minVoicedRatio: config.client.minVoicedRatio,
            levelVariance: config.client.levelVariance,
            bargeIn: config.client.bargeIn,
            bargeInThreshold: config.client.bargeInThreshold,
            bargeInMs: config.client.bargeInMs,
            playbackGain: config.client.playbackGain,
            echoCancellation: config.client.echoCancellation,
            noiseSuppression: config.client.noiseSuppression,
            autoGainControl: config.client.autoGainControl,
          },
          asr: { enabled: config.asr.enabled, language: config.asr.language },
          tts: { enabled: config.tts.enabled },
        },
      })
    })
    const sweeper = setInterval(() => hub.sweep(), 30000)
    sweeper.unref?.()
    // 预热：多数人把朗读服务当常驻进程开着，先把首次推理那 ~20s 付掉。
    // 延迟几秒再打，别和页面首次加载抢资源；服务还没起来就失败，等切到持续监听时再试。
    const warmTimer = setTimeout(() => void warmupOnce('宿主启动'), 3000)
    warmTimer.unref?.()
    ctx.logger?.info?.(
      `${PACKAGE_NAME} ${PACKAGE_VERSION} 已就绪：路由 %s，ASR %s，TTS %s（音色%s）`,
      base,
      config.asr.endpoint,
      config.tts.endpoint,
      config.tts.voice || config.tts.refAudioPath || config.tts.voiceDir ? '已配置' : '未配置',
    )

    return () => {
      clearInterval(sweeper)
      clearTimeout(warmTimer)
      disposeInject()
      for (const dispose of disposeRoutes) dispose()
      hub.dispose()
    }
  })

  ctx.on('session/event', (session, event) => {
    if (!config.enabled || !config.tts.enabled) return
    const sessionId = session?.id
    if (!sessionId) return
    if (event.type === 'user/message') {
      // 用户自己发消息：说明他在用键盘，把还在排队的朗读丢掉，别念上一轮的旧话。
      if (voiceSessions.has(sessionId) && hub.status(sessionId).pending > 0) hub.skip(sessionId, '用户开始输入')
      return
    }
    if (event.type !== 'assistant/message') return
    if (!voiceSessions.has(sessionId)) return
    if (isSubAgentSession(session) && !config.tts.speakSubagentSessions) return
    const text = assistantText(event.data?.message)
    if (!text) return
    const chunks = hub.enqueue(sessionId, text)
    if (chunks > 0) logger.info?.('回复入队：%d 片（%s）', chunks, logger.text(text))
  })

  ctx.commands.register({
    name: 'voice',
    description: '语音交互：/voice status|doctor|on|off|stop|say <文本>',
    handler: async (invocation) => {
      const sessionId = invocation?.agent?.id ?? ''
      const arg = String(invocation?.rawInput ?? '').trim()
      const [verb, ...rest] = arg.split(/\s+/)
      const tail = rest.join(' ').trim()
      switch ((verb || 'status').toLowerCase()) {
        case 'status': {
          const queue = sessionId ? hub.status(sessionId) : { pending: 0, synthesizing: false }
          return {
            kind: 'success',
            text: [
              config.enabled ? '语音已启用' : '语音已禁用',
              voiceSessions.has(sessionId)
                ? '本会话：持续监听'
                : '本会话：空闲（点输入框的麦克风进入持续监听）',
              `队列 ${queue.pending} 片${queue.synthesizing ? '（合成中）' : ''}`,
              `ASR ${config.asr.endpoint}`,
              `TTS ${config.tts.endpoint}`,
            ].join(' · '),
          }
        }
        case 'doctor': {
          // 体检要真打接口，最坏几秒钟；给个进度提示免得像卡住。
          const profiles = await voiceProfiles()
          try {
            const result = await diagnose({
              config,
              asr,
              tts,
              profiles,
              synthesize: synthesizeOnce,
              resolveVoice: resolveVoiceConfig,
              tilde: tildePath,
            })
            // 体检里那句真合成把 CUDA Graph 建好了，别让预热再付一次。
            if (result.synthesized) warmState.done = true
            logger.info?.('语音自检：%s', result.ok ? '通过' : '有待处理项')
            return { kind: result.ok ? 'success' : 'error', text: result.text }
          } catch (error) {
            return { kind: 'error', text: `自检失败：${String(error?.message ?? error)}` }
          }
        }
        case 'on':
          if (sessionId) voiceSessions.add(sessionId)
          return { kind: 'success', text: '本会话的语音朗读已开启' }
        case 'off':
          if (sessionId) {
            voiceSessions.delete(sessionId)
            hub.skip(sessionId, '/voice off')
          }
          return { kind: 'success', text: '本会话的语音朗读已关闭' }
        case 'stop':
          if (sessionId) hub.skip(sessionId, '/voice stop')
          return { kind: 'success', text: '已停止朗读' }
        case 'say':
          if (!tail) return { kind: 'error', text: '用法：/voice say <要朗读的文本>' }
          if (!sessionId) return { kind: 'error', text: '当前没有会话，无法朗读' }
          voiceSessions.add(sessionId)
          hub.enqueue(sessionId, tail)
          return { kind: 'success', text: `开始朗读（${[...tail].length} 字）` }
        default:
          return { kind: 'error', text: '用法：/voice status|doctor|on|off|stop|say <文本>' }
      }
    },
  })
}
