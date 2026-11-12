/**
 * `/voice doctor`：一次性体检，回答「为什么没声音」。
 *
 * 设计前提：别人装完插件最常见的三种失败都发生在**运行期**，而且都没有报错——
 * 服务没起、音色没配、参考音频/参考文本不合规。所以这里不只查配置，而是真的
 * 打一次接口：ASR 发 0.3 秒静音看返回形状，TTS 真合成一句三个字并过成片校验
 * （退化、音色漂、参考音频超长都会在这一步暴露）。
 *
 * 只读：不改配置、不写盘、不往会话里塞消息。唯一的副作用是顺手把 TTS 的
 * CUDA Graph 建好了（合成那句话本身就是预热）。
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { PACKAGE_NAME } from './name.js'
import { evaluateSpeech } from './quality.js'
import { joinPcmToWav, silencePcm } from './wav.js'
import { scanVoices } from './voices.js'

/** 连通性探测的超时毫秒。 */
const PROBE_MS = 5000
/** 契约探测（ASR 一次真实推理）的超时毫秒。 */
const ASR_PROBE_MS = 15000
/** 体检用的短句：三个字足够暴露音色与退化问题，又几乎不增加等待。 */
const PROBE_TEXT = '你好。'

/** 体检报告。 */
class Report {
  constructor() {
    /** @type {Array<{ level: 'ok' | 'warn' | 'error', name: string, detail: string }>} */
    this.items = []
  }

  /**
   * 记一条。
   * @param {'ok' | 'warn' | 'error'} level 等级。
   * @param {string} name 项目名。
   * @param {string} detail 说明。
   * @returns {this} 自身，便于链式调用。
   */
  add(level, name, detail) {
    this.items.push({ level, name, detail })
    return this
  }

  ok(name, detail) { return this.add('ok', name, detail) }
  warn(name, detail) { return this.add('warn', name, detail) }
  error(name, detail) { return this.add('error', name, detail) }

  /**
   * 数某一级的条目。
   * @param {'ok' | 'warn' | 'error'} level 等级。
   * @returns {number} 条数。
   */
  count(level) {
    return this.items.filter((item) => item.level === level).length
  }

  /**
   * 渲染成命令结果。
   * @param {string[]} [tail] 结尾的建议行。
   * @returns {string} 多行文本。
   */
  render(tail = []) {
    const icon = { ok: '√', warn: '!', error: '×' }
    const head = [
      '语音自检',
      `${this.count('ok')} 项通过`,
      this.count('warn') > 0 ? `${this.count('warn')} 项提醒` : '',
      this.count('error') > 0 ? `${this.count('error')} 项待处理` : '',
    ].filter(Boolean).join(' · ')
    const body = this.items.map((item) => `${icon[item.level]} ${item.name}：${item.detail}`)
    return [head, '', ...body, ...(tail.length > 0 ? ['', ...tail] : [])].join('\n')
  }
}

/**
 * 打一个 GET 看服务在不在。
 * @param {string} url 地址。
 * @param {number} [ms] 超时毫秒。
 * @returns {Promise<{ status: number, ms: number }>} 状态码与耗时。
 */
async function probe(url, ms = PROBE_MS) {
  const started = Date.now()
  const response = await fetch(url, { signal: AbortSignal.timeout(ms) })
  // 读完再放：keep-alive 连接挂着会让进程退出时多等几秒。
  await response.arrayBuffer().catch(() => {})
  return { status: response.status, ms: Date.now() - started }
}

/**
 * 把网络错误翻成一句人话。
 * @param {unknown} error 错误。
 * @returns {string} 描述。
 */
function reasonOf(error) {
  const anyError = /** @type {any} */ (error)
  if (anyError?.name === 'TimeoutError') return '超时'
  const cause = anyError?.cause ?? anyError
  const code = cause?.code
  if (code) {
    const where = cause?.address ? `（${cause.address}:${cause.port}）` : ''
    return `${code}${where}`
  }
  return String(anyError?.message ?? cause?.message ?? error)
}

/**
 * 本地配置自查：不联网，只查互相矛盾的旋钮和危险开关。
 * @param {any} config 插件配置。
 * @param {Report} report 报告。
 * @returns {void}
 */
function checkLocal(config, report) {
  if (!config.enabled) {
    report.error('插件状态', 'enabled=false：宿主既不接音频也不朗读')
  } else {
    report.ok('插件状态', `enabled=true，路由前缀 ${config.transport?.path ?? '/voice'}`)
  }
  if (config.enabled && !config.tts.enabled) {
    report.warn('朗读开关', 'tts.enabled=false：只做识别，不朗读回复')
  }
  if (config.asr.mode === 'async') {
    report.warn('ASR 模式', 'async 多一次轮询往返，只有单次音频超过 60 秒才需要')
  }
  if (config.client.silenceMs < config.client.onsetMs + 100) {
    report.warn('断句参数', `silenceMs=${config.client.silenceMs} 与 onsetMs=${config.client.onsetMs} 太接近，可能刚开口就判定说完`)
  }
  if (config.tts.firstChunkChars > config.tts.maxCharsPerChunk) {
    report.warn('首片字数', `firstChunkChars=${config.tts.firstChunkChars} 大于 maxCharsPerChunk=${config.tts.maxCharsPerChunk}，首片短切分不会生效`)
  }
  if (config.privacy.logText) {
    report.warn('隐私', 'privacy.logText=true：日志会记录完整文本')
  }
  report.ok('音频参数', `ASR ${config.asr.sampleRate}Hz / TTS ${config.tts.sampleRate}Hz，单句上限 ${Math.round(config.client.maxUtteranceMs / 1000)}s`)
}

/**
 * 查音色：能不能解析出「参考音频 + 参考文本」，时长是否在服务端要求的 3~10 秒内。
 * @param {any} config 插件配置。
 * @param {() => Promise<any>} resolveVoice 解析函数（复用宿主那份缓存）。
 * @param {Report} report 报告。
 * @returns {Promise<{ label: string, refAudioPath: string, promptText: string } | null>} 解析到的音色。
 */
async function checkVoice(config, resolveVoice, report) {
  let voice = null
  try {
    voice = await resolveVoice()
  } catch (error) {
    report.error('音色解析', reasonOf(error))
    return null
  }
  if (!voice) {
    report.error('音色', '未配置：填 tts.refAudioPath + tts.promptText，或 tts.voiceDir + tts.voice')
    if (config.tts.voiceDir) {
      const list = await scanVoices(path.resolve(config.tts.voiceDir)).catch(() => [])
      if (list.length > 0) {
        const shown = list.slice(0, 5).map((item) => item.label).join('、')
        report.warn('可用音色', `${list.length} 条：${shown}${list.length > 5 ? ' …' : ''}`)
      } else {
        report.warn('音色目录', `${config.tts.voiceDir} 下没有可用的 ref_info.json（需要 wav + text）`)
      }
    }
    return null
  }
  if (voice.duration === null) {
    report.error('参考音频', `读不出时长，路径可能不对：${voice.refAudioPath}`)
  } else if (voice.duration < 3 || voice.duration > 10) {
    report.error('参考音频', `${voice.duration.toFixed(2)}s 不在 3~10 秒，服务端大概率拒绝`)
  } else {
    report.ok('参考音频', `${voice.label}（${voice.duration.toFixed(2)}s）`)
  }
  if (!String(voice.promptText ?? '').trim()) {
    report.error('参考文本', 'promptText 为空：音色会漂，也容易被判成退化片')
  }
  return voice
}

/**
 * 查 ASR：先看服务在不在，再发 0.3 秒静音确认接口形状对得上。
 * @param {any} config 插件配置。
 * @param {{ transcribe: Function }} asr 识别客户端。
 * @param {Report} report 报告。
 * @returns {Promise<void>} 无。
 */
async function checkAsr(config, asr, report) {
  const endpoint = config.asr.endpoint
  try {
    const health = await probe(`${endpoint}/healthz`)
    if (health.status === 401) {
      report.error('ASR 鉴权', `healthz 返回 401：asr.apiKey 与服务端 ASR_API_KEYS 不一致`)
    } else if (health.status === 200) {
      report.ok('ASR 连通', `${endpoint}（${health.ms}ms）`)
    } else {
      report.warn('ASR 连通', `${endpoint} 返回 HTTP ${health.status}（版本较老？继续验契约）`)
    }
  } catch (error) {
    report.error('ASR 连通', `${endpoint} 连不上：${reasonOf(error)}（服务没启动？）`)
    return
  }

  const pcm = silencePcm(0.3, config.asr.sampleRate)
  const wav = joinPcmToWav([{ pcm, sampleRate: config.asr.sampleRate }])
  const started = Date.now()
  try {
    const result = await asr.transcribe(wav, {
      language: config.asr.language,
      audioSeconds: 0.3,
      signal: AbortSignal.timeout(ASR_PROBE_MS),
    })
    const text = String(result?.text ?? '')
    report.ok('ASR 契约', `0.3s 静音 → ${text ? `「${text}」` : '空文本'}（${Date.now() - started}ms）`)
  } catch (error) {
    // 静音识别出空文本是「契约正确」的正常结果，不是故障。
    if (/** @type {any} */ (error)?.kind === 'empty') {
      report.ok('ASR 契约', `0.3s 静音 → 空文本（${Date.now() - started}ms，符合预期）`)
    } else {
      report.error('ASR 契约', `调用失败：${reasonOf(error)}`)
    }
  }
}

/**
 * 查 TTS：连通、权重、真合成一句并过成片校验。
 * @param {any} config 插件配置。
 * @param {{ ensureWeights: Function }} tts 合成客户端。
 * @param {(text: string) => Promise<Buffer>} synthesize 单次合成（与生产同一套采样参数）。
 * @param {any} voice 解析到的音色。
 * @param {Report} report 报告。
 * @returns {Promise<boolean>} 是否真的合成成功（用于把预热标记成已完成）。
 */
async function checkTts(config, tts, synthesize, voice, report) {
  const endpoint = config.tts.endpoint
  try {
    const info = await probe(`${endpoint}/openapi.json`)
    report.ok('TTS 连通', `${endpoint}（${info.ms}ms）`)
    if (info.status !== 200) {
      report.warn('TTS 契约', `没有 openapi.json（HTTP ${info.status}），跳过版本判断，下面以真合成为准`)
    }
  } catch (error) {
    report.error('TTS 连通', `${endpoint} 连不上：${reasonOf(error)}（服务没启动？）`)
    return false
  }

  try {
    const switched = await tts.ensureWeights()
    report.ok('权重', switched
      ? '已切到配置的 t2sWeightsPath / vitsWeightsPath'
      : '沿用服务端当前权重（没配权重路径时正常）')
  } catch (error) {
    report.error('权重', reasonOf(error))
    return false
  }

  if (!voice) {
    report.warn('TTS 合成', '跳过：音色还没配好')
    return false
  }

  const started = Date.now()
  let wav
  try {
    wav = await synthesize(PROBE_TEXT)
  } catch (error) {
    report.error('TTS 合成', reasonOf(error))
    return false
  }
  const seconds = (Date.now() - started) / 1000
  const verdict = evaluateSpeech(wav, PROBE_TEXT, {
    speed: config.tts.speed,
    minVoicedRatio: config.tts.minVoicedRatio,
    maxInternalSilence: config.tts.maxInternalSilence,
    maxTrailingSilence: config.tts.maxTrailingSilence,
  })
  if (verdict.ok) {
    report.ok('TTS 合成', `「${PROBE_TEXT}」用时 ${seconds.toFixed(1)}s，成片 ${verdict.duration.toFixed(2)}s`)
  } else {
    report.error('TTS 合成', `成片不达标（会被重试机制拦下）：${verdict.reasons.join('；')}`)
  }
  return true
}

/**
 * 生成可直接粘到 profile patch 里的片段。
 * @param {any} config 插件配置。
 * @returns {string[]} 若干行 YAML。
 */
function patchLines(config) {
  const quote = (value) => String(value ?? '').replace(/'/g, "''")
  const lines = [
    '- id: voice',
    `  name: ${PACKAGE_NAME}`,
    '  config:',
    '    asr:',
    `      endpoint: '${quote(config.asr.endpoint)}'`,
    '    tts:',
    `      endpoint: '${quote(config.tts.endpoint)}'`,
  ]
  if (String(config.tts.refAudioPath ?? '').trim()) {
    lines.push(
      `      refAudioPath: '${quote(config.tts.refAudioPath)}'`,
      `      promptText: '${quote(config.tts.promptText)}'`,
    )
  } else if (String(config.tts.voiceDir ?? '').trim()) {
    lines.push(
      `      voiceDir: '${quote(config.tts.voiceDir)}'`,
      config.tts.voice ? `      voice: '${quote(config.tts.voice)}'` : '      # voice: <音色 id，留空取第一条>',
    )
  }
  return lines
}

/**
 * 在 patch 文件里找 `- id: voice` 这一条。
 * @param {string | null} patchFile patch 文件路径。
 * @returns {Promise<boolean>} 有没有。
 */
async function isPatched(patchFile) {
  if (!patchFile) return false
  try {
    return /^-\s*id:\s*voice\b/m.test(await readFile(patchFile, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 跑一次完整体检。
 * @param {{
 *   config: any,
 *   asr: { transcribe: Function },
 *   tts: { ensureWeights: Function },
 *   synthesize: (text: string) => Promise<Buffer>,
 *   resolveVoice: () => Promise<any>,
 *   profiles?: Array<{ name: string, patchFile: string, patched: boolean }>,
 *   tilde?: (target: string) => string,
 * }} options 依赖。
 * @returns {Promise<{ ok: boolean, text: string, synthesized: boolean }>} 结果：是否无错误、渲染后的文本、TTS 是否真合成成功。
 */
export async function diagnose(options) {
  const { config, asr, tts, synthesize, resolveVoice, profiles = [], tilde = (value) => value } = options
  const report = new Report()
  checkLocal(config, report)
  const voice = await checkVoice(config, resolveVoice, report)
  await checkAsr(config, asr, report)
  const synthesized = await checkTts(config, tts, synthesize, voice, report)

  const patchFile = profiles[0]?.patchFile ?? null
  const patched = patchFile ? await isPatched(patchFile) : false
  const tail = []
  if (report.count('error') === 0) {
    tail.push('全部通过。想立刻听一句：在输入框发 /voice say 你好。')
  }
  if (!patchFile) {
    tail.push(`没找到装了 ${PACKAGE_NAME} 的 profile（可用 $DSH_HOME 指定主目录）。`)
  } else if (!patched) {
    tail.push(`当前 profile 没有覆盖配置，跑的是默认值：${tilde(patchFile)}`)
    tail.push('要显式写死，把下面几行加到该文件末尾：')
    tail.push(...patchLines(config))
  } else {
    tail.push(`配置来自：${tilde(patchFile)}`)
  }
  return { ok: report.count('error') === 0, text: report.render(tail), synthesized }
}