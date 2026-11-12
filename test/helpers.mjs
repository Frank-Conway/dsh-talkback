/**
 * 测试用的小工具：合成 WAV（正弦音 / 静音 / 混合），以及极简断言。
 */

/**
 * 生成一段 16bit 单声道 PCM WAV。
 * @param {{ seconds: number, sampleRate?: number, amplitude?: number, frequency?: number }} options 时长、采样率、幅度、频率；幅度 0 表示静音。
 * @returns {Buffer} WAV 字节。
 */
export function makeWav(options) {
  const sampleRate = options.sampleRate ?? 16000
  const amplitude = options.amplitude ?? 0.3
  const frequency = options.frequency ?? 440
  const samples = Math.max(1, Math.round(options.seconds * sampleRate))
  const pcm = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const value = amplitude === 0
      ? 0
      : Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2)
  }
  return wrapPcm(pcm, sampleRate)
}

/**
 * 用给定 PCM 数据包一个 WAV 头。
 * @param {Buffer} pcm 16bit 单声道 PCM。
 * @param {number} sampleRate 采样率。
 * @returns {Buffer} WAV 字节。
 */
export function wrapPcm(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 拼一段「先有声后面一长段静音」的 WAV，模拟朗读服务退化。
 * @param {{ voiced: number, silence: number, sampleRate?: number }} options 有声时长与静音时长。
 * @returns {Buffer} WAV 字节。
 */
export function makeDegenerateWav(options) {
  const sampleRate = options.sampleRate ?? 32000
  const voiced = makeWav({ seconds: options.voiced, sampleRate, amplitude: 0.4 })
  const silence = Buffer.alloc(Math.round(options.silence * sampleRate) * 2)
  const header = voiced.subarray(0, 44)
  const pcm = Buffer.concat([voiced.subarray(44), silence])
  const out = Buffer.alloc(44)
  header.copy(out)
  out.writeUInt32LE(36 + pcm.length, 4)
  out.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([out, pcm])
}

/**
 * 解析 WAV 的采样率（测试断言用）。
 * @param {Buffer} wav WAV 字节。
 * @returns {number} 采样率。
 */
export function sampleRateOf(wav) {
  return wav.readUInt32LE(24)
}

/** 断言器。 */
export class Checks {
  constructor() {
    this.passed = 0
    /** @type {string[]} */
    this.failures = []
  }

  /**
   * 断言为真。
   * @param {boolean} condition 条件。
   * @param {string} message 失败描述。
   */
  ok(condition, message) {
    if (condition) this.passed += 1
    else this.failures.push(message)
  }

  /**
   * 断言相等。
   * @param {unknown} actual 实际值。
   * @param {unknown} expected 期望值。
   * @param {string} message 失败描述。
   */
  equal(actual, expected, message) {
    this.ok(Object.is(actual, expected), `${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
  }

  /**
   * 断言包含。
   * @param {string} haystack 被搜索的文本。
   * @param {string} needle 子串。
   * @param {string} message 失败描述。
   */
  contains(haystack, needle, message) {
    this.ok(String(haystack).includes(needle), `${message}（${JSON.stringify(String(haystack).slice(0, 200))} 里没有 ${JSON.stringify(needle)}）`)
  }

  /**
   * 打印汇总并以退出码表示结果。
   * @returns {void}
   */
  report() {
    if (this.failures.length === 0) {
      console.log(`\n全部通过：${this.passed} 项断言`)
      return
    }
    console.error(`\n失败 ${this.failures.length} 项（通过 ${this.passed} 项）：`)
    for (const failure of this.failures) console.error(`  ✗ ${failure}`)
    process.exitCode = 1
  }
}

/**
 * 起一个监听 127.0.0.1 随机端口的 HTTP 服务。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>} handler 请求处理函数。
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} 服务地址与关闭函数。
 */
export async function serve(handler) {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ message: String(error?.message ?? error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<Buffer>} 请求体。
 */
export async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}
