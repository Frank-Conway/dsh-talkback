/**
 * 自测：`node test/run.mjs`
 *
 * 分四层：
 *   1. 纯函数：WAV 解析、分句、成片打分、音色扫描、隐私开关；
 *   2. 识别服务客户端：同步 / 异步 / 鉴权失败 / 服务不在；
 *   3. 朗读分发中心：排队、按序取片、打断、过期清理、重试取最优；
 *   4. 宿主接线：真 HTTP 路由 + 假 agent，跑「音频进 -> 文本注入会话」和
 *      「助手回复 -> 切片 -> 取片 -> 取音频」，以及隐私开关真的不落文本；
 *   5. 客户端 bundle：加载、注册槽位、WAV 编码与重采样。
 *
 * 不碰真实服务、不发声：识别客户端与合成器都是替身。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { Checks, makeDegenerateWav, makeWav } from './helpers.mjs'
import { startMockTts } from './mock-tts.mjs'
import { startMockAsr } from './mock-asr.mjs'
import { analyzeWav, joinPcmToWav, parseWav, wavDuration } from '../lib/wav.js'
import { limitSpeech, splitFirstChunk, splitForSpeech, stripForSpeech } from '../lib/split.js'
import { evaluateSpeech, pickBest } from '../lib/quality.js'
import { resolveVoice, scanVoices } from '../lib/voices.js'
import { describeAudio, describeText, privateLogger } from '../lib/privacy.js'
import { readVoiceSection, writeVoiceValues } from '../lib/config-writer.js'
import { dshHome, findVoiceProfiles, tildePath } from '../lib/profile.js'
import { SpeechHub, createRetryingSynthesizer } from '../lib/hub.js'
import { TtsClient } from '../lib/tts.js'
import { AsrClient, asrLanguage } from '../lib/asr.js'
import { Config as VoiceConfig, apply as applyVoice, assistantText, validateConfigInput } from '../lib/index.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../lib/name.js'

const checks = new Checks()
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/**
 * 等一个条件成立。
 * @param {() => boolean} predicate 条件。
 * @param {string} label 超时提示。
 * @param {number} [timeoutMs] 超时毫秒。
 * @returns {Promise<void>} 条件成立。
 */
async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * 用 schema 默认值补全配置。
 * @param {any} schema schemastery schema。
 * @param {Record<string, unknown>} patch 覆盖项。
 * @returns {any} 完整配置。
 */
function withDefaults(schema, patch) {
  const result = schema['~standard'].validate(patch)
  if (result.issues) throw new Error(`配置校验失败：${JSON.stringify(result.issues)}`)
  return result.value
}

/**
 * 造一个假的 http 响应对象。
 * @returns {{ res: any, result: { status: number, headers: Record<string, string>, body: Buffer } }} 响应与结果。
 */
function fakeResponse() {
  const result = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    writeHead(status, headers) {
      result.status = status
      Object.assign(result.headers, headers ?? {})
      return res
    },
    end(body) {
      if (body) result.body = Buffer.isBuffer(body) ? body : Buffer.from(body)
      result.ended = true
    },
  }
  result.ended = false
  return { res, result }
}

/**
 * 造一个假的 http 请求对象。
 * @param {string} method 方法。
 * @param {string} url 相对地址。
 * @param {Buffer} [body] 请求体。
 * @returns {any} 请求。
 */
function fakeRequest(method, url, body) {
  const stream = Readable.from(body && body.length ? [body] : [])
  stream.method = method
  stream.url = url
  stream.headers = {}
  return stream
}

/**
 * 造一个最小的宿主 ctx。
 * @param {{ agent?: any }} [options] 注入的 agent。
 * @returns {any} 宿主环境。
 */
function fakeHost(options = {}) {
  /** @type {Map<string, Function>} */
  const routes = new Map()
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const commands = []
  /** @type {Function[]} */
  const disposers = []
  const logs = []
  const logger = {
    debug: (...args) => logs.push(['debug', args]),
    info: (...args) => logs.push(['info', args]),
    warn: (...args) => logs.push(['warn', args]),
    error: (...args) => logs.push(['error', args]),
  }
  const ctx = {
    logger,
    webServer: {
      host: '127.0.0.1',
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    agents: {
      get(id) {
        return options.agent && options.agent.id === id ? options.agent : undefined
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    listeners,
    commands,
    logs,
    /** 触发一个事件。 */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose?.()
    },
  }
}

/**
 * 造一个记录注入消息的假 agent。
 * @param {string} id 会话 id。
 * @returns {any} agent。
 */
function fakeAgent(id) {
  return {
    id,
    status: 'idle',
    received: [],
    followup(message) {
      this.received.push(message)
    },
  }
}

/**
 * 发一次请求到注册的路由。
 * @param {any} host 宿主环境。
 * @param {string} url 地址。
 * @param {{ method?: string, body?: Buffer }} [options] 方法与请求体。
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>} 响应。
 */
async function call(host, url, options = {}) {
  const handler = host.routes.get(url.split('?')[0])
  if (!handler) throw new Error(`没有注册路由：${url}`)
  const { res, result } = fakeResponse()
  await handler(fakeRequest(options.method ?? 'GET', url, options.body), res)
  return result
}

async function testWav() {
  const tone = makeWav({ seconds: 1, sampleRate: 16000, amplitude: 0.4 })
  const info = parseWav(tone)
  checks.equal(info.sampleRate, 16000, 'WAV 采样率解析')
  checks.equal(info.channels, 1, 'WAV 声道数解析')
  checks.ok(Math.abs(info.duration - 1) < 0.01, `WAV 时长解析（${info.duration.toFixed(3)}s）`)

  const silentClip = analyzeWav(makeWav({ seconds: 1, amplitude: 0 }))
  checks.equal(silentClip.voicedSeconds, 0, '纯静音没有有声帧')
  checks.ok(analyzeWav(tone).voicedSeconds > 0.9, '有声帧覆盖整段')

  const degenerate = makeDegenerateWav({ voiced: 0.5, silence: 5, sampleRate: 32000 })
  const analysis = analyzeWav(degenerate)
  checks.ok(Math.abs(analysis.voicedSeconds - 0.5) <= 0.1, `退化片有声时长 ≈0.5s（实际 ${analysis.voicedSeconds.toFixed(2)}s）`)
  checks.ok(analysis.trailingSilence > 4, `退化片片尾静音被量出来（${analysis.trailingSilence.toFixed(2)}s）`)

  const joined = joinPcmToWav([
    { pcm: tone.subarray(44), sampleRate: 16000 },
    { pcm: tone.subarray(44), sampleRate: 16000 },
  ], 0.2)
  checks.ok(Math.abs(wavDuration(joined) - 2.2) < 0.02, '拼接 WAV 时长正确')
  checks.equal(wavDuration(Buffer.from('不是wav')), 0, '坏音频时长为 0 而不是抛错')
}

async function testSplit() {
  const markdown = [
    '# 标题',
    '',
    '- 第一点：**要点**',
    '- 第二点：[链接](https://example.com)',
    '',
    '```js',
    'console.log(1)',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '结论是：可以。',
  ].join('\n')
  const clean = stripForSpeech(markdown)
  checks.ok(!clean.includes('```') && !clean.includes('console.log'), '代码块被丢弃')
  checks.ok(!clean.includes('|'), '表格被丢弃')
  checks.ok(!clean.includes('https://'), '链接地址被丢弃')
  checks.contains(clean, '要点', '加粗内容保留文字')
  checks.contains(clean, '结论是：可以。', '正文保留')

  const chunks = splitForSpeech('第一句话。第二句话！第三句话？', 40)
  checks.equal(chunks.length, 1, '三个短句合成一片')
  const long = '这是一句很长的话，' + '里面有很多内容，'.repeat(6) + '最后才结束。'
  const pieces = splitForSpeech(long, 20)
  checks.ok(pieces.length > 1 && pieces.every((piece) => piece.length <= 20), '超长句被切开且每片不超限')
  checks.equal(splitForSpeech('   ', 40).length, 0, '空白文本不产出片段')
  checks.ok(limitSpeech('一二三四五六七八九十。', 8, '（省略）').endsWith('（省略）'), '超长文本被截断')
  checks.equal(limitSpeech('短句。', 0), '短句。', '0 表示不限制长度')

  // 首片短切分：优先切在逗号后，切太碎就不切
  const cut = splitFirstChunk('今天天气很好，我们下午三点开会，记得带上材料。', 14)
  checks.equal(cut.length, 2, '首片能切开')
  checks.equal(cut[0], '今天天气很好，', '切在第一个逗号后')
  checks.contains(cut[1], '我们下午三点开会', '剩下的部分完整保留')
  checks.equal(splitFirstChunk('短句。', 14).length, 1, '短句不切')
  checks.equal(splitFirstChunk('短句。', 0).length, 1, '0 表示不额外切')
  checks.equal(splitFirstChunk('abcdefghijklmnop', 10)[0], 'abcdefghij', '没有标点时硬切')
  checks.equal(splitFirstChunk('Hello there world', 12)[0], 'Hello there', '英文切在空格处')
}

async function testQuality() {
  const text = '这是一句用来估时长的测试文本，大约二十多个字。'
  const good = makeWav({ seconds: 3, sampleRate: 32000, amplitude: 0.35 })
  const goodVerdict = evaluateSpeech(good, text)
  checks.ok(goodVerdict.ok, '正常成片通过')
  const bad = makeDegenerateWav({ voiced: 0.4, silence: 5, sampleRate: 32000 })
  const badVerdict = evaluateSpeech(bad, text)
  checks.ok(!badVerdict.ok, '退化成片被拦下')
  checks.ok(badVerdict.reasons.length > 0, '退化原因可读')
  checks.equal(pickBest([{ wav: bad, verdict: badVerdict, attempt: 0 }, { wav: good, verdict: goodVerdict, attempt: 1 }]).attempt, 1, '取打分最高的一次')
}

async function testPrivacy() {
  checks.equal(describeText('你好世界', { logText: false }), '«4 字，内容不记录»', '默认不记录文本内容')
  checks.equal(describeText('你好世界', { logText: true }), '你好世界', '开启后记录原文')
  checks.equal(describeAudio({ length: 2048 }, { logAudio: false }), '2.0 KB', '默认只记音频大小')
  checks.equal(describeAudio({ length: 2048 }, { logAudio: true }, 1.5), '2.0 KB / 1.50s', '开启后附带时长')
  const lines = []
  const logger = privateLogger({ info: (...args) => lines.push(args.join(' ')) }, { logText: false, logAudio: false })
  logger.info('文本 %s 音频 %s', logger.text('秘密'), logger.audio({ length: 100 }))
  checks.ok(!lines.join('').includes('秘密'), '包装后的 logger 不会泄漏文本')
}

async function testVoices(tmp) {
  const dir = path.join(tmp, 'voices', 'yunmia')
  await mkdir(path.join(dir, 'refs'), { recursive: true })
  await writeFile(path.join(dir, 'refs', 'r1.wav'), makeWav({ seconds: 4, sampleRate: 32000, amplitude: 0.3 }))
  await writeFile(path.join(dir, 'ref_info.json'), JSON.stringify({
    voice_id: 'yunmia',
    voice_name: '云梦',
    dur: 4.02,
    wav: 'refs/r1.wav',
    text: '这是参考音频里说的那句话，需要逐字一致。',
  }))
  const broken = path.join(tmp, 'voices', 'broken')
  await mkdir(broken, { recursive: true })
  await writeFile(path.join(broken, 'ref_info.json'), JSON.stringify({ voice_name: '坏的' }))

  const voices = await scanVoices(path.join(tmp, 'voices'))
  checks.equal(voices.length, 1, '只收有文本的音色')
  checks.equal(voices[0].voiceId, 'yunmia', '音色 id 解析')
  checks.contains(voices[0].label, '云梦', '显示名含名称')

  const byName = await resolveVoice({ voiceDir: path.join(tmp, 'voices'), voice: '云梦' }, silent)
  checks.ok(byName && byName.refAudioPath.endsWith('r1.wav'), '按名字选中音色')
  checks.contains(byName.promptText, '逐字一致', '带出参考文本')
  const explicit = await resolveVoice({ refAudioPath: path.join(dir, 'refs', 'r1.wav'), promptText: '手动文本' }, silent)
  checks.equal(explicit.promptText, '手动文本', '显式配置优先')
  checks.equal(await resolveVoice({}, silent), null, '什么都没配时返回 null 而不是抛错')
}

async function testAsr() {
  checks.equal(asrLanguage('auto'), '', 'auto 交给服务端检测')
  checks.equal(asrLanguage('yue'), 'zh', '粤语映射成中文')

  const mock = await startMockAsr({ apiKey: 'test-key' })
  try {
    const client = new AsrClient({
      baseUrl: mock.url,
      apiKey: 'test-key',
      mode: 'sync',
      language: 'zh',
      format: 'wav',
      sampleRate: 16000,
      beamSize: 5,
      timeoutMs: 10000,
    }, { logger: silent })

    const audio = makeWav({ seconds: 1 })
    const sync = await client.transcribe(audio, { audioSeconds: 1 })
    checks.contains(sync.text, '识别结果', '同步识别拿到文本')
    checks.ok(sync.inferenceSeconds >= 0, '记录推理耗时')

    const request = mock.requests.at(-1)
    checks.equal(request.path, '/api/v1/transcriptions/sync', '走同步接口')
    checks.equal(request.query.language, 'zh', '语言参数下发')
    checks.equal(request.query.beam_size, '5', 'beam_size 下发')
    checks.equal(request.headers['x-api-key'], 'test-key', 'X-API-Key 下发')
    checks.contains(request.contentType, 'multipart/form-data', 'multipart 上传')
    checks.ok(request.bodyLength > 1000, '音频确实上传了')

    const asyncClient = new AsrClient({
      baseUrl: mock.url,
      apiKey: 'test-key',
      mode: 'async',
      language: 'auto',
      pollIntervalMs: 200,
      timeoutMs: 10000,
    }, { logger: silent })
    const asyncResult = await asyncClient.transcribe(audio, {})
    checks.contains(asyncResult.text, '识别结果', '异步识别拿到文本')
    checks.ok(mock.polls >= 1, '异步模式轮询到完成')

    const wrongKey = new AsrClient({ baseUrl: mock.url, apiKey: 'wrong', timeoutMs: 5000 }, { logger: silent })
    let failure = null
    try {
      await wrongKey.transcribe(audio, {})
    } catch (error) {
      failure = error
    }
    checks.contains(String(failure?.message), '鉴权失败', '鉴权失败提示可读')

    const offline = new AsrClient({ baseUrl: 'http://127.0.0.1:59999', timeoutMs: 2000 }, { logger: silent })
    let offlineFailure = null
    try {
      await offline.transcribe(audio, {})
    } catch (error) {
      offlineFailure = error
    }
    checks.contains(String(offlineFailure?.message), '连不上识别服务', '服务没起时提示启动服务')

    const empty = new AsrClient({ baseUrl: mock.url, apiKey: 'test-key', timeoutMs: 5000 }, { logger: silent })
    const emptyMock = await startMockAsr({ text: '   ' })
    try {
      const emptyClient = new AsrClient({ baseUrl: emptyMock.url, timeoutMs: 5000 }, { logger: silent })
      let emptyFailure = null
      try {
        await emptyClient.transcribe(audio, {})
      } catch (error) {
        emptyFailure = error
      }
      checks.contains(String(emptyFailure?.message), '没有识别出文字', '空结果有明确提示')
    } finally {
      await emptyMock.close()
    }
    void empty
  } finally {
    await mock.close()
  }
}

async function testHub() {
  /** @type {string[]} */
  const synthesized = []
  const hub = new SpeechHub({
    logger: silent,
    maxCharsPerChunk: 8,
    maxSpeakChars: 0,
    maxQueueChunks: 4,
    retentionSeconds: 10,
    synthesize: async (text) => {
      synthesized.push(text)
      return makeWav({ seconds: Math.max(0.3, [...text].length / 4.5), sampleRate: 32000, amplitude: 0.3 })
    },
  })

  const count = hub.enqueue('s1', '第一句话。第二句话！第三句话？')
  checks.equal(count, 3, '按句切成 3 片')
  const first = await hub.next('s1')
  checks.ok(first !== null, '能取到第一片')
  checks.equal(first.index, 0, '第一片序号为 0')
  const piece = hub.take('s1', first.id)
  checks.ok(piece && piece.wav.length > 44, '取到音频字节')
  checks.equal(hub.take('s1', first.id), null, '同一片不能取两次')

  const second = await hub.next('s1', { waitMs: 3000 })
  checks.ok(second !== null && second.index === 1, '按顺序取第二片')
  hub.take('s1', second.id)

  hub.skip('s1', '测试打断')
  checks.equal(hub.status('s1').pending, 0, '打断后队列清空')
  const noMore = await hub.next('s1', { waitMs: 200 })
  checks.equal(noMore, null, '打断后取不到东西')

  // 首片短切分：第一声更早出来，原文不丢
  const firstTexts = []
  const shortFirst = new SpeechHub({
    logger: silent,
    maxCharsPerChunk: 40,
    firstChunkChars: 10,
    maxSpeakChars: 0,
    retentionSeconds: 10,
    synthesize: async (text) => {
      firstTexts.push(text)
      return makeWav({ seconds: 0.4, sampleRate: 32000, amplitude: 0.3 })
    },
  })
  shortFirst.enqueue('s-first', '这是一句很长的话，后面还有很多字要念出来。')
  const head = await shortFirst.next('s-first', { waitMs: 2000 })
  checks.ok(head && head.total === 2, '首片切分后共 2 片')
  checks.ok(head.chars <= 10, `首片不超过上限（${head.chars} 字）`)
  shortFirst.take('s-first', head.id)
  const rest = await shortFirst.next('s-first', { waitMs: 2000 })
  checks.ok(rest.chars > head.chars, '第二片回到正常长度')
  shortFirst.take('s-first', rest.id)
  checks.equal(firstTexts[0] + firstTexts[1], '这是一句很长的话，后面还有很多字要念出来。', '切开后原文一个字没丢')

  // 过期清理：合成的音频没人取，超时后丢弃
  hub.enqueue('s2', '会过期的一句话。')
  await hub.next('s2', { waitMs: 2000 })
  checks.ok(hub.status('s2').pending > 0, '有待取音频')
  hub.retentionSeconds = 0
  hub.sweep(Date.now() + 1000)
  checks.equal(hub.status('s2').pending, 0, '过期音频被清理')

  // 积压上限
  const many = new SpeechHub({
    logger: silent,
    maxCharsPerChunk: 6,
    maxSpeakChars: 0,
    maxQueueChunks: 3,
    retentionSeconds: 10,
    synthesize: async () => makeWav({ seconds: 0.3, sampleRate: 32000, amplitude: 0.3 }),
  })
  many.enqueue('s3', '一。二。三。四。五。六。七。八。')
  await new Promise((resolve) => setTimeout(resolve, 50))
  checks.ok(many.status('s3').pending <= 3, `积压时队列不超过上限（${many.status('s3').pending}）`)

  // 重试合成器：第一次退化、第二次达标，取第二次
  const attempts = []
  const synth = createRetryingSynthesizer({
    logger: silent,
    attempts: [{ split: 'cut3' }, { split: 'cut0' }],
    synthesize: async (text) => {
      attempts.push(text)
      if (attempts.length === 1) return makeDegenerateWav({ voiced: 0.3, silence: 5, sampleRate: 32000 })
      return makeWav({ seconds: 3, sampleRate: 32000, amplitude: 0.35 })
    },
  })
  const wav = await synth('这是一句用来估时长的测试文本，大约二十多个字。', new AbortController().signal)
  checks.equal(attempts.length, 2, '退化片触发了重试')
  checks.ok(evaluateSpeech(wav, '这是一句用来估时长的测试文本，大约二十多个字。').ok, '重试后取到达标成片')
  checks.ok(synthesized.length >= 3, '合成器被复用')
  hub.dispose()
  many.dispose()
}

async function testProfile(tmp) {
  const home = path.join(tmp, 'home')
  const webDir = path.join(home, 'profiles', 'web')
  await mkdir(webDir, { recursive: true })
  await writeFile(path.join(webDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { [PACKAGE_NAME]: `link:C:/${PACKAGE_NAME}` },
    dsh: { profile: { bundles: [PACKAGE_NAME] } },
  }))
  await writeFile(path.join(webDir, 'cordis.patch.yml'), '# 空\n')
  const cliDir = path.join(home, 'profiles', 'cli')
  await mkdir(cliDir, { recursive: true })
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-cli' }))

  checks.equal(dshHome({ DSH_HOME: home }), home, 'DSH_HOME 优先')
  checks.ok(dshHome({ DSH_HOME: '   ' }).endsWith('.dsh'), '空白 DSH_HOME 视为未设置')

  const found = await findVoiceProfiles({ home })
  checks.equal(found.length, 1, '只认出装了插件的 profile')
  checks.equal(found[0].name, 'web', 'profile 名正确')
  checks.equal(found[0].patched, false, '没有 - id: voice 时判为未配置')

  await writeFile(path.join(webDir, 'cordis.patch.yml'), `- id: voice\n  name: ${PACKAGE_NAME}\n`)
  checks.equal((await findVoiceProfiles({ home }))[0].patched, true, '写进去之后判为已配置')
  checks.equal(tildePath(path.join(home, 'x.yml'), home), `~${path.sep}x.yml`, '提示里用 ~ 缩短路径')
}

async function testConfigWriter(tmp) {
  const file = path.join(tmp, 'cordis.patch.yml')
  const created = await writeVoiceValues(file, {
    'asr.endpoint': 'http://127.0.0.1:8000',
    'tts.endpoint': 'http://127.0.0.1:9880',
    'tts.voiceDir': 'D:\\voices',
    'client.silenceMs': 900,
  })
  checks.equal(created.created, true, '没配置时新建 - id: voice 段')
  const first = await readFile(file, 'utf8')
  checks.contains(first, '- id: voice', '段落头写对了')
  checks.contains(first, "      endpoint: 'http://127.0.0.1:8000'", 'ASR 端点带引号写入')
  checks.equal(created.values['client.silenceMs'], '900', '回读数字字段')
  checks.equal(created.values['tts.voiceDir'], 'D:\\voices', '回读带反斜杠的路径')

  // 已有别的条目、注释、和本插件不认识的字段
  await writeFile(file, [
    '# 顶部注释：别丢',
    '- id: other',
    '  name: some-plugin',
    '  config:',
    '    a: 1',
    '',
    '- id: voice',
    `  name: ${PACKAGE_NAME}`,
    '  config:',
    '    asr:',
    "      endpoint: 'http://old:8000'  # 旧地址",
    "      apiKey: 'secret'",
    '    tts:',
    "      endpoint: 'http://old:9880'",
    '    privacy:',
    '      logText: true',
    '',
    '- id: tail',
    '  name: another',
    '',
  ].join('\n'))

  const updated = await writeVoiceValues(file, {
    'asr.endpoint': 'http://new:8000',
    'tts.voiceDir': 'D:\\v2',
    'client.silenceMs': 1200,
  })
  const second = await readFile(file, 'utf8')
  checks.equal(updated.created, false, '已有段落时不新建')
  checks.contains(second, '# 顶部注释：别丢', '别的条目的注释保留')
  checks.contains(second, '- id: other', '别的条目保留')
  checks.contains(second, '- id: tail', '后面的条目保留')
  checks.contains(second, "      endpoint: 'http://new:8000' # 旧地址", '改了值但保留行尾注释')
  checks.contains(second, "      apiKey: 'secret'", '不认识的字段原样保留')
  checks.contains(second, '    privacy:', '不认识的整节保留')
  checks.contains(second, "      voiceDir: 'D:\\v2'", '新键插在 tts 的末尾')
  checks.contains(second, '      silenceMs: 1200', '新节插在 config 末尾')
  const readBack = await readVoiceSection(file)
  checks.ok(readBack.others.includes('asr.apiKey'), '读回时把不认识的字段列出来')
  checks.equal(readBack.values['asr.endpoint'], 'http://new:8000', '读回改后的值')

  await writeVoiceValues(file, { 'tts.voiceDir': '' })
  const third = await readFile(file, 'utf8')
  checks.ok(!third.includes('voiceDir'), '空值 = 移除该键')
  checks.contains(third, "      silenceMs: 1200", '移除只影响那一个键')

  // 布尔开关：总开关在 config 顶层，其余挂在各自节里
  const toggled = await writeVoiceValues(file, {
    enabled: false,
    'asr.enabled': false,
    'tts.enabled': false,
    'tts.warmup': false,
  })
  const fourth = await readFile(file, 'utf8')
  checks.contains(fourth, '    enabled: false', '总开关写成 config 下的顶层键')
  checks.contains(fourth, '      warmup: false', '预热开关写进 tts 节')
  checks.equal(
    fourth.split('\n').filter((line) => line.trim() === 'enabled: false').length,
    3,
    '顶层 / asr / tts 三处 enabled 都写进去了',
  )
  checks.equal(toggled.values.enabled, 'false', '回读总开关')
  checks.equal(toggled.values['asr.enabled'], 'false', '回读 ASR 开关')
  checks.equal(toggled.values['tts.enabled'], 'false', '回读朗读开关')
  checks.equal(toggled.values['tts.warmup'], 'false', '回读预热开关')
  await writeVoiceValues(file, { enabled: true })
  const fifth = await readFile(file, 'utf8')
  checks.contains(fifth, '    enabled: true', '布尔值能改回 true')
  checks.equal((await readVoiceSection(file)).values['asr.enabled'], 'false', '只改总开关时别的开关不动')

  const missing = await readVoiceSection(path.join(tmp, 'nope.yml'))
  checks.equal(missing.exists, false, '文件不存在时当成未配置')
}

async function testHost(tmp) {
  const mockAsr = await startMockAsr({ text: '你好，这是语音输入的文本。' })
  const mockTts = await startMockTts({})
  try {
    const agent = fakeAgent('sess-1')
    const host = fakeHost({ agent })
    const config = withDefaults(VoiceConfig, {
      transport: { pollWaitMs: 5000 },
      asr: { endpoint: mockAsr.url, apiKey: '', language: 'zh', sampleRate: 16000 },
      tts: {
        endpoint: mockTts.url,
        refAudioPath: path.join(tmp, 'ref.wav'),
        promptText: '参考文本',
        maxCharsPerChunk: 10,
        maxRetries: 1,
      },
      privacy: { logText: false, logAudio: false },
      client: { minUtteranceMs: 100, silenceMs: 300 },
    })
    await writeFile(path.join(tmp, 'ref.wav'), makeWav({ seconds: 4, sampleRate: 32000, amplitude: 0.3 }))

    const tts = new TtsClient({ baseUrl: mockTts.url, timeoutMs: 20000 }, { logger: silent })
    // 自检会读 profile 的 patch 文件判断「有没有显式配置」，这里给一个只有注释的假 profile。
    const patchFile = path.join(tmp, 'cordis.patch.yml')
    await writeFile(patchFile, '# 只有注释，没有 - id: voice\n')
    applyVoice(host.ctx, config, {
      tts,
      findProfiles: async () => [{ name: 'web', patchFile, patched: false }],
    })

    // 0) 配置层：死开关已删掉，VAD 新旋钮有默认值
    const defaults = withDefaults(VoiceConfig, {})
    checks.ok(!('streaming' in defaults.asr), 'asr.streaming 已从配置里移除（识别服务没有流式端点）')
    checks.ok(!('streaming' in defaults.tts), 'tts.streaming 已从配置里移除（首片流式还没落地）')
    checks.equal(defaults.client.prerollMs, 600, '预录默认 600ms')
    checks.equal(defaults.client.onsetMs, 150, '起录确认默认 150ms')
    checks.equal(defaults.client.noiseGate, true, '噪音闸门默认开')
    checks.equal(defaults.tts.firstChunkChars, 14, '首片默认压到 14 字')
    checks.equal(defaults.tts.warmup, true, '预热默认开')
    checks.equal(defaults.asr.enabled, true, 'ASR 默认开')
    checks.equal(defaults.tts.enabled, true, '朗读默认开')
    checks.ok(withDefaults(VoiceConfig, { asr: { streaming: true } }).client.vadThreshold > 0, '老配置里的 streaming 不会让插件起不来')

    // 0b) 打开语音模式 -> 后台预热一次（把首次推理的 ~20s 提前付掉）
    const state = await call(host, '/voice/state', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ sessionId: 'sess-1', listening: true })),
    })
    checks.equal(state.status, 200, '语音模式开关返回 200')
    let warmed = false
    try {
      await waitFor(() => mockTts.requests.some((item) => item.path === '/tts' && item.body?.text === '预热。'), '预热请求', 1500)
      warmed = true
    } catch {}
    checks.ok(warmed, '打开语音模式触发一次 TTS 预热')

    // 0c) 浏览器侧开麦失败：错误上报不改语音开关，但状态接口里查得到
    const failed = await call(host, '/voice/state', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ sessionId: 'sess-1', error: '麦克风权限被拒绝' })),
    })
    checks.equal(failed.status, 200, '错误上报返回 200')
    const afterError = JSON.parse((await call(host, '/voice/status')).body.toString('utf8'))
    checks.equal(afterError.lastClientError?.message, '麦克风权限被拒绝', '状态接口回带客户端错误')
    checks.equal(afterError.enabledSessions.length, 1, '错误上报不会把会话踢出语音模式')

    // 1) 音频进 -> 识别 -> 注入会话
    const audio = makeWav({ seconds: 1.2, sampleRate: 16000, amplitude: 0.3 })
    const asr = await call(host, '/voice/asr?sessionId=sess-1&language=zh', { method: 'POST', body: audio })
    checks.equal(asr.status, 200, 'ASR 路由返回 200')
    const asrJson = JSON.parse(asr.body.toString('utf8'))
    checks.contains(asrJson.text, '语音输入', 'ASR 路由回传识别文本')
    checks.equal(asrJson.injected, true, 'ASR 路由注入了会话')
    checks.equal(agent.received.length, 1, 'agent 收到一条用户消息')
    checks.equal(agent.received[0].role, 'user', '注入的消息角色是 user')
    checks.equal(agent.received[0].content[0].type, 'text', '注入的是 text 块')
    checks.contains(agent.received[0].content[0].text, '语音输入', '注入内容就是识别结果')
    checks.ok(Object.isFrozen(agent.received[0]), '注入的消息被冻结')

    // 1b) 陌生会话：先拒掉，不该白跑一次识别
    const beforeGhost = mockAsr.requests.length
    const ghost = await call(host, '/voice/asr?sessionId=ghost-session', { method: 'POST', body: audio })
    checks.equal(ghost.status, 409, '陌生会话被拒绝')
    checks.equal(JSON.parse(ghost.body.toString('utf8')).kind, 'session', '陌生会话的错误类型是 session')
    checks.equal(mockAsr.requests.length, beforeGhost, '陌生会话不会白跑识别')

    // 2) 助手回复 -> 切片 -> 长轮询取片 -> 取音频
    host.emit('session/event', { id: 'sess-1', header: { origin: 'root' } }, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想法' }, { type: 'text', text: '第一句回答。第二句回答！' }] } },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    checks.ok(mockTts.requests.filter((item) => item.path === '/tts').length >= 1, '回复触发了 TTS 合成')

    const nextBody = Buffer.from(JSON.stringify({ sessionId: 'sess-1' }))
    const next = await call(host, '/voice/next', { method: 'POST', body: nextBody })
    checks.equal(next.status, 200, '取片返回 200')
    const chunk = JSON.parse(next.body.toString('utf8'))
    checks.ok(chunk.id, '取片返回片段 id')
    checks.equal(chunk.index, 0, '第一片序号为 0')

    const audioResponse = await call(host, `/voice/audio?sessionId=sess-1&id=${encodeURIComponent(chunk.id)}`)
    checks.equal(audioResponse.status, 200, '取音频返回 200')
    checks.equal(audioResponse.headers['content-type'], 'audio/wav', '取音频的 content-type 是 wav')
    checks.ok(parseWav(audioResponse.body).sampleRate > 0, '取到的是可解析的 WAV')
    checks.equal((await call(host, `/voice/audio?sessionId=sess-1&id=${encodeURIComponent(chunk.id)}`)).status, 404, '同一片不能取两次')
    checks.equal((await call(host, '/voice/audio?sessionId=sess-1')).status, 400, '缺 id 返回 400')
    checks.equal((await call(host, '/voice/audio?id=x')).status, 400, '缺 sessionId 返回 400')

    // 3) 停播：清空队列
    const skip = await call(host, '/voice/skip', { method: 'POST', body: Buffer.from(JSON.stringify({ sessionId: 'sess-1', reason: '测试' })) })
    checks.equal(skip.status, 200, 'skip 返回 200')
    const empty = await call(host, '/voice/next', { method: 'POST', body: nextBody })
    checks.equal(empty.status, 204, '清空后长轮询返回 204')

    // 4) 没开语音的会话不会被朗读
    host.emit('session/event', { id: 'sess-other', header: { origin: 'root' } }, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '不该被念的回复。' }] } },
    })
    const other = await call(host, '/voice/next', { method: 'POST', body: Buffer.from(JSON.stringify({ sessionId: 'sess-other' })) })
    checks.equal(other.status, 204, '没登记语音模式的会话不朗读')

    // 5) 隐私：日志里不能出现识别文本
    const joined = host.logs.map(([, args]) => args.map((item) => String(item)).join(' ')).join('\n')
    checks.ok(!joined.includes('语音输入'), '日志里没有识别文本原文')
    checks.ok(!joined.includes('第一句回答'), '日志里没有回复文本原文')

    // 6) 页面注入：客户端配置
    const table = []
    host.emit('webserver/index-inject', table)
    checks.equal(table.length, 1, '注入一行 index 配置')
    checks.equal(table[0].kind, 'global', '注入形式是全局变量')
    checks.equal(table[0].value.base, '/voice', '注入的路由前缀')
    checks.equal(table[0].value.client.sampleRate, 16000, '注入的采样率来自 asr.sampleRate')
    checks.ok(typeof table[0].value.client.vadThreshold === 'number', '注入的 VAD 阈值')
    checks.equal(table[0].value.client.prerollMs, 600, '注入预录时长')
    checks.equal(table[0].value.client.onsetMs, 150, '注入起录确认时长')
    checks.equal(table[0].value.client.noiseGate, true, '注入噪音闸门开关')
    checks.ok(!('streaming' in table[0].value.asr), '注入的 ASR 配置里没有 streaming')

    // 7) 命令
    checks.equal(host.commands.length, 1, '注册了 /voice 命令')
    const status = await host.commands[0].handler({ agent, rawInput: '' })
    checks.contains(status.text, 'ASR', '/voice status 可读')
    checks.contains(status.text, '持续监听', '/voice status 报持续监听')
    const say = await host.commands[0].handler({ agent, rawInput: 'say 你好' })
    checks.equal(say.kind, 'success', '/voice say 可用')

    // 7a) 切到空闲：listening=false 把会话移出朗读名单，剩下的音频也丢掉
    const idle = await call(host, '/voice/state', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ sessionId: 'sess-1', listening: false })),
    })
    checks.equal(idle.status, 200, '空闲上报返回 200')
    const idleStatus = JSON.parse((await call(host, '/voice/status')).body.toString('utf8'))
    checks.equal(idleStatus.enabledSessions.length, 0, '空闲后会话不再朗读')
    const idleText = await host.commands[0].handler({ agent, rawInput: 'status' })
    checks.contains(idleText.text, '空闲', '/voice status 报空闲')

    // 7b) /voice doctor：全通时给通过项 + 可粘贴的 patch 片段
    const doctor = await host.commands[0].handler({ agent, rawInput: 'doctor' })
    checks.equal(doctor.kind, 'success', '自检全通时返回 success')
    checks.contains(doctor.text, 'ASR 连通', '报了 ASR 连通性')
    checks.contains(doctor.text, '路由前缀 /voice', '报了实际路由前缀')
    checks.contains(doctor.text, 'ASR 契约', '真打了一次 ASR 契约探测')
    checks.contains(doctor.text, 'TTS 合成', '真合成了一句并过成片校验')
    checks.contains(doctor.text, '参考音频', '报了参考音频时长')
    checks.contains(doctor.text, '- id: voice', 'profile 没写配置时给出可粘贴的片段')

    // 7c) 服务连不上：返回 error 并说清是哪个不通
    const broken = fakeHost({ agent })
    applyVoice(broken.ctx, withDefaults(VoiceConfig, {
      asr: { endpoint: 'http://127.0.0.1:9' },
      tts: { endpoint: 'http://127.0.0.1:9' },
    }), {
      tts: new TtsClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 }, { logger: silent }),
      findProfiles: async () => [],
    })
    const brokenDoctor = await broken.commands[0].handler({ agent, rawInput: 'doctor' })
    checks.equal(brokenDoctor.kind, 'error', '服务不通时返回 error')
    checks.contains(brokenDoctor.text, '连不上', '连不上会说原因')
    checks.contains(brokenDoctor.text, '音色', '同时指出音色没配')
    await broken.dispose()

    // 7d) 配置页：读 + 写（只动 - id: voice 那一段）
    const configGet = await call(host, '/voice/config')
    checks.equal(configGet.status, 200, 'GET /voice/config 返回 200')
    const configJson = JSON.parse(configGet.body.toString('utf8'))
    checks.equal(configJson.tts.endpoint, mockTts.url, '返回当前生效的 TTS 端点')
    checks.equal(configJson.patchFile, patchFile, '返回 profile 的 patch 路径')
    checks.equal(configJson.enabled, true, '返回总开关状态')
    checks.equal(configJson.tts.warmup, true, '返回预热开关状态')
    checks.equal(configJson.asr.enabled, true, '返回 ASR 开关状态')
    checks.equal(configJson.tts.enabled, true, '返回朗读开关状态')
    checks.ok(!('tts.endpoint' in configJson.written), '没写过 patch 时 written 是空的')

    const saved = await call(host, '/voice/config', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({
        'tts.voiceDir': 'D:\\voices',
        'tts.voice': 'yunmia',
        'client.silenceMs': 1100,
      })),
    })
    checks.equal(saved.status, 200, 'POST /voice/config 返回 200')
    checks.equal(JSON.parse(saved.body.toString('utf8')).values['tts.voiceDir'], 'D:\\voices', '回读写入的音色目录')
    const patchText = await readFile(patchFile, 'utf8')
    checks.contains(patchText, '# 只有注释，没有 - id: voice', '原有注释保留')
    checks.contains(patchText, '- id: voice', '新建了 - id: voice 段')
    checks.contains(patchText, '      silenceMs: 1100', '数字字段按数字写')

    const badEndpoint = await call(host, '/voice/config', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ 'asr.endpoint': 'ftp://nope' })),
    })
    checks.equal(badEndpoint.status, 400, '非法端点被拒绝')
    checks.contains(JSON.parse(badEndpoint.body.toString('utf8')).error, 'http(s)', '错误信息说清要求')

    checks.equal(validateConfigInput(null).error !== undefined, true, '非对象请求体被拒绝')
    checks.equal(validateConfigInput({ 'client.silenceMs': 50 }).error !== undefined, true, 'silenceMs 越界被拒绝')
    const mixed = validateConfigInput({ 'tts.enabled': false, 'tts.temperature': 0.4 })
    checks.equal(mixed.error, undefined, '不归页面管的字段被忽略')
    checks.equal(mixed.values['tts.temperature'], undefined, '不归页面管的字段不进提交结果')
    checks.equal(
      validateConfigInput({ 'tts.refAudioPath': 'C:\\r.wav' }).error !== undefined,
      true,
      '参考音频已不在页面上，提交也被拒绝（只能手写 YAML）',
    )
    checks.equal(validateConfigInput({ enabled: false }).values.enabled, false, '总开关可被页面写入')
    checks.equal(validateConfigInput({ 'tts.warmup': false }).values['tts.warmup'], false, '预热开关可被页面写入')
    checks.equal(validateConfigInput({ 'asr.enabled': false }).values['asr.enabled'], false, 'ASR 开关可被页面写入')
    checks.equal(validateConfigInput({ 'tts.enabled': false }).values['tts.enabled'], false, '朗读开关可被页面写入')
    checks.equal(validateConfigInput({ 'asr.enabled': 'no' }).error !== undefined, true, '非布尔的 ASR 开关被拒绝')
    checks.equal(validateConfigInput({ enabled: 'no' }).error !== undefined, true, '非布尔的总开关被拒绝')
    checks.equal(validateConfigInput({ 'client.silenceMs': '' }).values['client.silenceMs'], '', '空字符串表示移除覆盖')

    // 8) 拒绝在不安全的监听地址上启用
    const unsafe = fakeHost({ agent })
    unsafe.ctx.webServer.host = '0.0.0.0'
    applyVoice(unsafe.ctx, withDefaults(VoiceConfig, {}), { tts })
    checks.equal(unsafe.routes.size, 0, '非回环监听且未显式允许时不注册路由')
    checks.ok(unsafe.logs.some(([level]) => level === 'warn'), '非回环监听会告警')

    // 8b) 总开关关掉：只留配置页路由，否则设置页会把「重新打开」的入口一起关掉
    const off = fakeHost({ agent })
    applyVoice(off.ctx, withDefaults(VoiceConfig, { enabled: false }), {
      findProfiles: async () => [{ name: 'web', patchFile, patched: false }],
    })
    checks.equal(off.routes.size, 1, '禁用时只注册一个路由')
    checks.ok(off.routes.has('/voice/config'), '禁用时配置页仍可访问')
    const offGet = await call(off, '/voice/config')
    checks.equal(JSON.parse(offGet.body.toString('utf8')).enabled, false, '配置页能读到「已禁用」')
    const reenabled = await call(off, '/voice/config', {
      method: 'POST',
      body: Buffer.from(JSON.stringify({ enabled: true })),
    })
    checks.equal(reenabled.status, 200, '禁用状态下仍能把总开关写回去')
    checks.equal(JSON.parse(reenabled.body.toString('utf8')).values.enabled, 'true', '写回的 enabled 是 true')
    await off.dispose()

    // 8c) 关掉 ASR：识别入口直接拒绝，不去读上传的音频
    const noAsr = fakeHost({ agent })
    applyVoice(noAsr.ctx, withDefaults(VoiceConfig, { asr: { enabled: false } }), { tts })
    const rejected = await call(noAsr, '/voice/asr?sessionId=sess-1', {
      method: 'POST',
      body: Buffer.from('ignored'),
    })
    checks.equal(rejected.status, 403, 'ASR 关闭时识别请求被拒绝')
    checks.contains(JSON.parse(rejected.body.toString('utf8')).error, 'ASR 已禁用', '拒绝理由指明是开关')
    await noAsr.dispose()

    await host.dispose()
    await unsafe.dispose()
  } finally {
    await mockAsr.close()
    await mockTts.close()
  }
}

async function testClientBundle() {
  /** @type {any[]} */
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded.push(definition)
      },
    },
  }
  globalThis.__DSH_VOICE__ = {
    base: '/voice',
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    client: { sampleRate: 16000, vadThreshold: 0.02, minUtteranceMs: 300, silenceMs: 900, bargeIn: true, playbackGain: 1 },
    asr: { language: 'zh' },
    tts: { enabled: true },
  }
  try {
    await import(`../lib/client.js?fresh=${Date.now()}`)
    checks.equal(loaded.length, 1, '客户端 bundle 注册了一个模块')
    checks.equal(loaded[0].id, PACKAGE_NAME, '客户端模块 id 是包名')

    const React = {
      createElement: (type, props, children) => ({ type, props, children }),
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      useEffect: () => {},
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    }
    const exports = loaded[0].factory((id) => {
      if (id === 'react') return React
      throw new Error(`客户端不应 require ${id}`)
    })
    checks.equal(typeof exports.apply, 'function', '导出 apply')
    checks.ok(Array.isArray(exports.inject), '导出 inject 数组')

    const registrations = []
    const fakeCtx = {
      slots: {
        inject(name, callback) {
          checks.ok(['conversation.input.activity', 'settings.section'].includes(name), `等待槽位 ${name}`)
          callback()
        },
        register(meta, component) {
          registrations.push({ meta, component })
          return () => {}
        },
      },
      effect(fn) {
        fn()
        return () => {}
      },
    }
    const dispose = await exports.apply(fakeCtx)
    checks.equal(registrations.length, 2, '注册了两个槽位组件（输入区 + 设置分区）')
    checks.equal(registrations[0].meta.name, 'conversation.input.activity', '注册到输入区活动槽位')
    checks.equal(typeof registrations[0].component, 'function', '槽位组件是函数组件')

    const settingsReg = registrations.find((item) => item.meta.name === 'settings.section')
    checks.ok(settingsReg, '注册了设置分区')
    checks.equal(settingsReg.meta.id, PACKAGE_NAME, '设置分区 id 用包名')
    checks.equal(settingsReg.meta.label(), '语音', '设置分区有导航名（函数形式，跟外壳约定一致）')
    checks.equal(settingsReg.meta.inject().base, '/voice', '设置分区拿到路由前缀')

    // 设置面板：读失败时不抛异常，只显示错误
    const rendered = settingsReg.component({ base: '/voice' })
    checks.equal(typeof rendered, 'object', '设置面板能渲染（加载中态）')
    checks.equal(typeof exports.settingsForm, 'function', '导出 settingsForm')
    const form = exports.settingsForm({
      enabled: false,
      asr: { enabled: false, endpoint: 'http://a:8000' },
      tts: { enabled: false, endpoint: 'http://b:9880', voiceDir: 'D:\\v', voice: 'x', warmup: false, refAudioPath: 'C:\\r.wav', promptText: '手写文本' },
      client: { silenceMs: 900 },
      voices: [{ label: 'x', voiceId: 'x' }],
      patchFile: 'C:\\p.yml',
      patched: true,
      others: ['asr.apiKey'],
    })
    checks.equal(form.asrEndpoint, 'http://a:8000', '表单读 ASR 地址')
    checks.equal(form.enabled, false, '表单读总开关')
    checks.equal(form.ttsEnabled, false, '表单读朗读开关')
    checks.equal(form.asrEnabled, false, '表单读 ASR 开关')
    checks.equal(form.warmup, false, '表单读预热开关')
    const defaultForm = exports.settingsForm({})
    checks.equal(defaultForm.enabled, true, '宿主没给总开关时按「开」显示')
    checks.equal(defaultForm.ttsEnabled, true, '宿主没给朗读开关时按「开」显示')
    checks.equal(defaultForm.asrEnabled, true, '宿主没给 ASR 开关时按「开」显示')
    checks.equal(defaultForm.warmup, true, '宿主没给预热开关时按「开」显示')
    checks.equal(form.silenceMs, '900', '表单把数字转成字符串给输入框')
    checks.equal(form.voices.length, 1, '表单带音色候选')
    checks.equal(form.refAudioPath, undefined, '参考音频不再进表单')
    checks.equal(form.promptText, undefined, '参考文本不再进表单')
    checks.equal(form.explicitVoicePath, 'C:\\r.wav', '表单带上手写参考音频路径（只用于提示）')
    checks.contains(exports.overrideNotice(form), '不生效', '手写 refAudioPath 时提示下拉不生效')
    checks.contains(exports.overrideNotice(form), 'tts.refAudioPath', '提示里点名是哪一项在抢先')
    checks.equal(exports.overrideNotice({}), '', '没有手写覆盖时不提示')
    checks.equal(exports.settingsPayload(form)['tts.voiceDir'], 'D:\\v', '提交体带音色目录')
    checks.equal(exports.settingsPayload(form).enabled, false, '提交体带总开关')
    checks.equal(exports.settingsPayload(form)['tts.enabled'], false, '提交体带朗读开关')
    checks.equal(exports.settingsPayload(form)['asr.enabled'], false, '提交体带 ASR 开关')
    checks.equal(exports.settingsPayload(form)['tts.warmup'], false, '提交体带预热开关')
    checks.equal(exports.settingsPayload(form)['tts.refAudioPath'], undefined, '提交体不再写参考音频')
    checks.equal(exports.settingsPayload(form)['tts.promptText'], undefined, '提交体不再写参考文本')
    checks.equal(exports.settingsPayload(form)['client.silenceMs'], 900, '提交体把毫秒转成数字')
    checks.equal(
      exports.settingsPayload({ ...form, silenceMs: '' })['client.silenceMs'],
      undefined,
      '毫秒留空时不提交该字段',
    )

    const engine = registrations[0].meta.inject().engine
    checks.ok(engine, '组件拿到引擎')
    checks.equal(engine.getSnapshot().phase, 'off', '初始状态是关闭')
    checks.equal(engine.getSnapshot().mode, 'idle', '初始模式是空闲')
    checks.equal(engine.getSnapshot().ready, true, '读到宿主注入的配置')
    checks.equal(engine.config.base, '/voice', '引擎使用注入的路由前缀')

    // 模式映射：新快照看 mode，旧快照按 phase 推回
    checks.equal(exports.voiceMode({ mode: 'idle', phase: 'listening' }), 'idle', 'mode 优先于 phase')
    checks.equal(exports.voiceMode({ mode: 'continuous', phase: 'off' }), 'continuous', 'mode=continuous 即使相位是 off 也算持续监听')
    checks.equal(exports.voiceMode({ phase: 'listening' }), 'continuous', '旧快照：非 off 相位当持续监听')
    checks.equal(exports.voiceMode({ phase: 'off' }), 'idle', '旧快照：off 相位当空闲')
    checks.equal(exports.voiceMode(null), 'idle', '没有快照时按空闲处理')

    // 输入区控件：两档模式的文案与提示
    const collectText = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(collectText).join('')
      return collectText(node.children)
    }
    const controlEngine = {
      config: { asr: { enabled: true } },
      state: { phase: 'off', mode: 'idle', level: 0, ready: true },
      subscribe: () => () => {},
      getSnapshot: () => controlEngine.state,
      setSession: () => {},
      toggle: () => {},
    }
    const idleControl = exports.VoiceControl({ engine: controlEngine, sessionId: 'sess-ui' })
    checks.contains(collectText(idleControl), '空闲', '空闲模式按钮显示「空闲」')
    checks.contains(idleControl.props.title, '空闲', '空闲模式提示说明当前不监听')
    checks.equal(idleControl.props.title.includes('持续监听'), true, '空闲提示告诉用户点一下进持续监听')
    controlEngine.state = { phase: 'listening', mode: 'continuous', level: 0.1, ready: true }
    const activeControl = exports.VoiceControl({ engine: controlEngine, sessionId: 'sess-ui' })
    checks.contains(collectText(activeControl), '持续监听', '持续监听模式按钮显示「持续监听」')
    checks.contains(activeControl.props.title, '持续监听', '持续监听提示说明会一直听')
    checks.equal(activeControl.props.title.includes('空闲'), true, '持续监听提示告诉用户点一下切空闲')

    const wave = exports.encodeWave(new Float32Array([0, 0.5, -0.5]), 16000)
    checks.equal(wave.length, 44 + 6, 'WAV 编码长度正确')
    checks.equal(String.fromCharCode(...wave.slice(0, 4)), 'RIFF', 'WAV 头正确')
    checks.equal(new DataView(wave.buffer).getUint32(24, true), 16000, 'WAV 采样率正确')

    const resampled = exports.resample(new Float32Array(48).fill(0.25), 48000, 16000)
    checks.equal(resampled.length, 16, '48k -> 16k 重采样长度正确')
    checks.ok(Math.abs(resampled[0] - 0.25) < 0.001, '重采样保留幅值')

    // ASR 关掉时只朗读：不申请麦克风，但仍建立播放上下文
    let micStarted = false
    const quiet = new exports.VoiceEngine({ ...exports.readConfig(), asr: { enabled: false } })
    quiet.sessionId = 'sess-quiet'
    quiet.startCapture = async () => { micStarted = true }
    window.AudioContext = class {
      constructor() {
        this.sampleRate = 48000
        this.destination = {}
      }
      resume() { return Promise.resolve() }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
      close() { return Promise.resolve() }
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) })
    try {
      await quiet.enable()
      checks.equal(micStarted, false, 'ASR 关闭时不开麦克风')
      checks.ok(quiet.audio, '只朗读时仍准备播放上下文')
      checks.equal(quiet.state.phase, 'listening', '只朗读时仍在等朗读队列')
      checks.equal(quiet.state.mode, 'continuous', '打开后进入持续监听模式')
      checks.equal(quiet.state.message, '语音输入已关闭，仅朗读', '界面上说明只剩朗读')
      // 这一段只验证「只朗读」；先切回空闲，别让它的轮询影响后面的等待。
      await quiet.setMode('idle')
      checks.equal(quiet.state.mode, 'idle', '只朗读也能切到空闲')

      // 两档模式：持续监听 <-> 空闲
      let captures = 0
      const reports = []
      const modeEngine = new exports.VoiceEngine(exports.readConfig())
      modeEngine.sessionId = 'sess-mode'
      modeEngine.startCapture = async () => { captures += 1 }
      const baseReport = modeEngine.report.bind(modeEngine)
      modeEngine.report = async (listening) => { reports.push(listening); return baseReport(listening) }
      await modeEngine.setMode('continuous')
      checks.equal(modeEngine.state.mode, 'continuous', '进入持续监听')
      checks.equal(modeEngine.state.phase, 'listening', '持续监听时在等说话')
      checks.equal(captures, 1, '进入持续监听时开一次麦克风')
      checks.equal(reports.at(-1), true, '持续监听上报给宿主 listening=true')
      await modeEngine.setMode('continuous')
      checks.equal(captures, 1, '重复点「持续监听」不重复开麦')
      await modeEngine.toggle()
      checks.equal(modeEngine.state.mode, 'idle', '再点一下切到空闲')
      checks.equal(modeEngine.state.phase, 'off', '空闲时关掉语音链路')
      checks.equal(reports.at(-1), false, '空闲上报给宿主 listening=false')
      await modeEngine.setMode('idle')
      checks.equal(modeEngine.state.phase, 'off', '重复点「空闲」不产生副作用')

      // 开麦失败要回到空闲，不能停在「持续监听」上
      const failing = new exports.VoiceEngine(exports.readConfig())
      failing.sessionId = 'sess-fail'
      failing.startCapture = async () => {
        const error = new Error('denied')
        error.name = 'NotAllowedError'
        throw error
      }
      await failing.setMode('continuous')
      checks.equal(failing.state.mode, 'idle', '开麦失败后模式回到空闲')
      checks.equal(failing.state.phase, 'error', '开麦失败停在出错相位')
      checks.contains(failing.state.error, '麦克风权限', '开麦失败显示可读的原因')
      await failing.setMode('idle')
      checks.equal(failing.state.phase, 'off', '空闲能清掉出错相位')

      // 换会话：空闲要报给旧会话，否则宿主还会合成旧会话的回复
      const switcher = new exports.VoiceEngine(exports.readConfig())
      switcher.sessionId = 'sess-old'
      switcher.set({ phase: 'listening', mode: 'continuous' })
      const switched = []
      switcher.report = async (listening, sessionId) => { switched.push([listening, sessionId]) }
      switcher.setSession('sess-new')
      await waitFor(() => switched.length > 0, '换会话时上报空闲')
      checks.equal(switched[0][0], false, '换会话上报 listening=false')
      checks.equal(switched[0][1], 'sess-old', '换会话上报给旧会话')
      checks.equal(switcher.state.phase, 'off', '换会话后回到空闲')
      checks.equal(switcher.state.mode, 'idle', '换会话后模式是空闲')
    } finally {
      await quiet.disable()
      globalThis.fetch = realFetch
    }

    await dispose()
  } finally {
    delete globalThis.window
    delete globalThis.__DSH_VOICE__
  }
}

/** 一帧的采样数：48kHz 下 960 样本 = 20ms。 */
const FRAME_SAMPLES = 960

/**
 * 造一帧正弦音。
 * @param {number} amplitude 幅度（RMS ≈ 0.707 × 幅度）。
 * @returns {Float32Array} 样本。
 */
function toneFrame(amplitude) {
  const frame = new Float32Array(FRAME_SAMPLES)
  for (let index = 0; index < FRAME_SAMPLES; index += 1) {
    frame[index] = Math.sin((2 * Math.PI * 200 * index) / 48000) * amplitude
  }
  return frame
}

/**
 * 造一帧「像人说话」的音频：幅度忽大忽小，变异系数约 0.6。
 * @param {number} index 帧序号。
 * @returns {Float32Array} 样本。
 */
function speechFrame(index) {
  return toneFrame(index % 2 === 0 ? 0.12 : 0.5)
}

/**
 * 造一帧「像稳态噪音」的音频：每帧幅度一致，变异系数接近 0。
 * @returns {Float32Array} 样本。
 */
function noiseFrame() {
  return toneFrame(0.2)
}

/**
 * 喂若干帧给引擎。
 * @param {import('../lib/client.js').VoiceEngine} engine 引擎。
 * @param {() => Float32Array} makeFrame 造帧函数。
 * @param {number} count 帧数。
 * @returns {void}
 */
function feed(engine, makeFrame, count) {
  for (let index = 0; index < count; index += 1) engine.onFrame(makeFrame(index), 48000)
}

/**
 * 采集里已经攒了多少毫秒音频。
 * @param {import('../lib/client.js').VoiceEngine} engine 引擎。
 * @returns {number} 毫秒。
 */
function capturedMs(engine) {
  return engine.frames.reduce((sum, frame) => sum + frame.length, 0) / 48
}

async function testClientVad() {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded.push(definition)
      },
    },
  }
  globalThis.__DSH_VOICE__ = {
    base: '/voice',
    client: {
      sampleRate: 16000,
      vadThreshold: 0.02,
      minUtteranceMs: 200,
      silenceMs: 400,
      bargeIn: true,
      bargeInThreshold: 0.06,
      bargeInMs: 450,
      playbackGain: 1,
      prerollMs: 600,
      onsetMs: 150,
      noiseGate: true,
      minVoicedRatio: 0.1,
      levelVariance: 0.15,
    },
    asr: { language: 'zh' },
    tts: { enabled: true },
  }
  const realFetch = globalThis.fetch
  /** @type {Array<{ url: string, body: any }>} */
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return { ok: true, json: async () => ({ text: '测试', busy: false }) }
  }
  try {
    await import(`../lib/client.js?vad=${Date.now()}`)
    const exports = loaded[0].factory((id) => {
      if (id === 'react') return { createElement: () => null, useSyncExternalStore: () => ({}), useEffect: () => {} }
      throw new Error(`客户端不应 require ${id}`)
    })

    // 1) 预录 + 起录确认
    const engine = new exports.VoiceEngine(exports.readConfig())
    engine.sampleRate = 48000
    engine.set({ phase: 'listening' })
    feed(engine, () => toneFrame(0.001), 25)
    checks.equal(engine.state.phase, 'listening', '安静时不开录')
    engine.onFrame(speechFrame(0), 48000)
    checks.equal(engine.state.phase, 'listening', '单帧响声不算开口')
    feed(engine, speechFrame, 7)
    checks.equal(engine.state.phase, 'capturing', '连续有声够 onsetMs 才开口')
    checks.ok(engine.frames.length >= 10, '起录带上了预录缓冲，第一个字没被切掉')
    checks.ok(capturedMs(engine) >= 250, '预录让这句的时长包含起振前的那一小段')

    // 说完 -> 静音 -> 上传识别
    feed(engine, () => toneFrame(0.001), 25)
    await waitFor(() => calls.some((call) => call.url.includes('/asr')), '上传识别')
    await waitFor(() => engine.state.phase === 'listening', '识别后回到在听')
    const upload = calls.find((call) => call.url.includes('/asr'))
    checks.ok(upload.body.length > 44, '上传的是有内容的 WAV')
    const seconds = wavDuration(Buffer.from(upload.body))
    checks.ok(seconds >= 0.6 && seconds <= 0.75, `上传时长 = 预录 + 整句 + 尾静音（实际 ${seconds.toFixed(3)}s）`)

    // 2) 打断不丢头
    const barge = new exports.VoiceEngine(exports.readConfig())
    barge.sampleRate = 48000
    barge.set({ phase: 'playing' })
    feed(barge, () => toneFrame(0.06), 20)
    checks.equal(barge.state.phase, 'playing', '只有回声时不打断（回声低于 bargeInThreshold）')
    feed(barge, speechFrame, 25)
    checks.equal(barge.state.phase, 'capturing', '持续人声触发打断')
    checks.ok(capturedMs(barge) >= 400, `打断带上预录，插话句没丢头（实际 ${capturedMs(barge).toFixed(0)}ms）`)

    // 3) 噪音闸门
    const noisy = new exports.VoiceEngine(exports.readConfig())
    noisy.sampleRate = 48000
    noisy.set({ phase: 'listening' })
    calls.length = 0
    feed(noisy, noiseFrame, 150)
    checks.equal(calls.filter((call) => call.url.includes('/asr')).length, 0, '稳态噪音不上传识别')
    checks.contains(noisy.state.message, '环境太吵', '噪音丢弃时有提示')
    checks.ok(noisy.noiseFloor > 0.04, `噪音后本底噪声被抬高（实际 ${noisy.noiseFloor.toFixed(3)}）`)
    checks.ok(noisy.threshold() > 0.1414, '噪音后阈值自动高过噪音电平，不再循环触发')
    const floorAfterNoise = noisy.noiseFloor
    feed(noisy, () => toneFrame(0.15), 50)
    checks.ok(noisy.noiseFloor <= floorAfterNoise + 1e-9, '低于阈值的说话声不会把本底噪声继续往上顶')

    // 4) 短促噪音：一次响完就静，留给上传前那道闸拦（时长短、别让识别服务编话）
    const blip = new exports.VoiceEngine(exports.readConfig())
    blip.sampleRate = 48000
    blip.set({ phase: 'listening' })
    calls.length = 0
    feed(blip, () => toneFrame(0.2), 30)
    feed(blip, () => toneFrame(0.001), 30)
    await new Promise((resolve) => setTimeout(resolve, 30))
    checks.equal(calls.filter((call) => call.url.includes('/asr')).length, 0, '短促稳态噪音也不上传识别')
    checks.contains(blip.state.message, '太吵', '短促噪音给的是噪音提示')
  } finally {
    globalThis.fetch = realFetch
    delete globalThis.window
    delete globalThis.__DSH_VOICE__
  }
}

async function testAssistantText() {
  checks.equal(
    assistantText({ content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '说' }] }),
    '说',
    '只取 text 块',
  )
  checks.equal(assistantText({ content: [] }), '', '空消息给空串')
  checks.equal(assistantText(null), '', '没有消息时给空串')
}

async function testManifest() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  checks.equal(manifest.name, PACKAGE_NAME, 'name.js 与 package.json 的包名一致')
  checks.equal(manifest.version, PACKAGE_VERSION, 'name.js 与 package.json 的版本一致')
  checks.ok(/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name) && manifest.name.length <= 64, '包名符合 npm 规则')
  checks.ok(!manifest.private, '不再标记 private（否则 npm publish 会被拒）')
  checks.equal(manifest.license, 'MIT', '声明了许可证')
  checks.ok(manifest.repository?.url?.includes('github.com'), '声明了仓库地址')
  checks.ok(manifest.engines?.dsh, '声明了 engines.dsh，安装时才会做兼容检查')
  checks.ok(Array.isArray(manifest.files) && manifest.files.includes('lib'), 'files 里带上了 lib')

  // bundle patch 里的 name 必须与包名一致，否则 profile 里那一行指不到插件。
  const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
  const patched = /^\s*-?\s*name:\s*(\S+)\s*$/m.exec(patch)
  checks.equal(patched?.[1], PACKAGE_NAME, 'cordis.patch.yml 里的 name 是包名')

  // 浏览器半边读不到 package.json，回落字面量也得跟着改。
  const client = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  const fallback = /HOST_GLOBAL\s*&&\s*HOST_GLOBAL\.packageName\)\s*\|\|\s*'([^']+)'/.exec(client)
  checks.equal(fallback?.[1], PACKAGE_NAME, 'client.js 的包名回落值与包名一致')
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), `${PACKAGE_NAME}-test-`))
  try {
    await testWav()
    await testSplit()
    await testQuality()
    await testPrivacy()
    await testVoices(tmp)
    await testAsr()
    await testHub()
    await testProfile(tmp)
    await testConfigWriter(tmp)
    await testHost(tmp)
    await testClientBundle()
    await testClientVad()
    await testAssistantText()
    await testManifest()
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  checks.report()
}

await main()
