/**
 * WAV 读取与「成片质量」分析。
 *
 * 朗读服务偶发退化：WAV 头里写着 20 多秒，前 2~3 秒是人声、后面全是静音。
 * 所以判断一份合成结果能不能用，必须按**有声时长**而不是文件时长。
 * 这里只覆盖 PCM（format=1）的 16bit 单/多声道 WAV —— 朗读服务的输出与
 * 浏览器录音都是这种，其它格式直接报错，避免拿错数据蒙混过关。
 */

/** @typedef {{ channels: number, sampleRate: number, bits: number, format: number, dataOffset: number, dataLength: number, duration: number, buffer: Buffer }} WavInfo */

/**
 * 把任意二进制视图转成 Buffer（不复制）。
 * @param {Uint8Array | ArrayBuffer | Buffer} input 原始字节。
 * @returns {Buffer} 同一块内存的 Buffer 视图。
 */
export function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new TypeError('需要二进制音频数据（Buffer / Uint8Array / ArrayBuffer）')
}

/**
 * 解析 WAV 头，定位 `data` 块。
 * @param {Uint8Array | ArrayBuffer | Buffer} bytes WAV 字节。
 * @returns {WavInfo} 采样参数与 `data` 块位置。
 * @throws 当文件不是 PCM WAV 或头部不完整时。
 */
export function parseWav(bytes) {
  const buffer = toBuffer(bytes)
  if (buffer.length < 44) throw new Error(`WAV 太短（${buffer.length} 字节）`)
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件（缺少 RIFF/WAVE 标识）')
  }

  let offset = 12
  /** @type {null | { format: number, channels: number, sampleRate: number, bits: number }} */
  let fmt = null
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.max(0, Math.min(size, buffer.length - body))
      // 有些写入方把 size 写成 0/0xFFFFFFFF，以实际剩余字节为准。
      if (dataLength === 0) dataLength = Math.max(0, buffer.length - body)
    }
    offset = body + size + (size % 2) // 块按偶数字节对齐
    if (dataOffset >= 0 && fmt) break
  }

  if (!fmt) throw new Error('WAV 缺少 fmt 块')
  if (dataOffset < 0) throw new Error('WAV 缺少 data 块')
  if (fmt.format !== 1) throw new Error(`不支持的 WAV 编码（format=${fmt.format}，只支持 PCM）`)
  if (fmt.channels < 1) throw new Error('WAV 声道数非法')
  if (fmt.sampleRate <= 0) throw new Error('WAV 采样率非法')

  const blockAlign = Math.max(1, fmt.channels * Math.max(1, Math.floor(fmt.bits / 8)))
  const frames = Math.floor(dataLength / blockAlign)

  return {
    buffer,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bits: fmt.bits,
    format: fmt.format,
    dataOffset,
    dataLength,
    duration: frames / fmt.sampleRate,
  }
}

/**
 * 只取时长（秒）；解析失败返回 0，供「有就用、没有就算」的场景调用。
 * @param {Uint8Array | ArrayBuffer | Buffer} bytes WAV 字节。
 * @returns {number} 时长（秒），解析失败为 0。
 */
export function wavDuration(bytes) {
  try {
    return parseWav(bytes).duration
  } catch {
    return 0
  }
}

/**
 * 逐帧计算音量包络，得出有声/静音结构。
 * @param {Uint8Array | ArrayBuffer | Buffer} bytes WAV 字节。
 * @param {{ frameMs?: number, silenceRms?: number }} [options] 帧长与静音阈值（0~1 满刻度）。
 * @returns {{ duration: number, voicedSeconds: number, leadingSilence: number, trailingSilence: number, longestSilence: number, peakRms: number }} 成片结构。
 */
export function analyzeWav(bytes, options = {}) {
  const frameMs = options.frameMs ?? 20
  const silenceRms = options.silenceRms ?? 0.01
  const wav = parseWav(bytes)
  const sampleWidth = Math.max(1, Math.floor(wav.bits / 8))
  const blockAlign = wav.channels * sampleWidth
  const frameSamples = Math.max(1, Math.round((wav.sampleRate * frameMs) / 1000))
  const frameBytes = frameSamples * blockAlign
  const totalFrames = Math.floor(wav.dataLength / frameBytes)

  let voicedFrames = 0
  let leading = 0
  let trailing = 0
  let longestSilence = 0
  let run = 0
  let peak = 0
  let sawVoice = false

  for (let index = 0; index < totalFrames; index += 1) {
    const start = wav.dataOffset + index * frameBytes
    const sum = sampleRms(wav.buffer, start, frameBytes, wav.channels, sampleWidth)
    if (sum > peak) peak = sum
    if (sum >= silenceRms) {
      if (!sawVoice) {
        leading = index
        sawVoice = true
      }
      voicedFrames += 1
      run = 0
    } else {
      run += 1
      if (run > longestSilence) longestSilence = run
      if (sawVoice) trailing = run
    }
  }

  const frameSeconds = frameSamples / wav.sampleRate
  return {
    duration: wav.duration,
    voicedSeconds: voicedFrames * frameSeconds,
    leadingSilence: leading * frameSeconds,
    trailingSilence: trailing * frameSeconds,
    longestSilence: longestSilence * frameSeconds,
    peakRms: peak,
  }
}

/**
 * 一段 PCM 的均方根（已按满刻度归一）。
 * @param {Buffer} buffer WAV 字节。
 * @param {number} start 起始字节偏移。
 * @param {number} length 字节长度。
 * @param {number} channels 声道数。
 * @param {number} sampleWidth 每样本字节数。
 * @returns {number} 0~1 的均方根。
 */
function sampleRms(buffer, start, length, channels, sampleWidth) {
  const end = Math.min(buffer.length, start + length)
  const step = sampleWidth * channels
  let sum = 0
  let count = 0
  for (let offset = start; offset + step <= end; offset += step) {
    let value = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const at = offset + channel * sampleWidth
      value += sampleWidth === 2
        ? buffer.readInt16LE(at) / 32768
        : buffer.readInt32LE(at) / 2147483648
    }
    value /= channels
    sum += value * value
    count += 1
  }
  return count === 0 ? 0 : Math.sqrt(sum / count)
}

/**
 * 单声道 16bit PCM 纯静音（用于片段之间的停顿）。
 * @param {number} seconds 时长（秒）。
 * @param {number} sampleRate 采样率。
 * @returns {Buffer} 静音 PCM 数据。
 */
export function silencePcm(seconds, sampleRate) {
  return Buffer.alloc(Math.max(0, Math.round(seconds * sampleRate)) * 2)
}

/**
 * 把若干 PCM16 片段拼成一个 WAV 文件字节。
 * @param {Array<{ pcm: Buffer, sampleRate: number }>} parts 片段，采样率必须一致。
 * @param {number} [gapSeconds] 片段之间插入的静音时长。
 * @returns {Buffer} 完整 WAV 字节。
 */
export function joinPcmToWav(parts, gapSeconds = 0) {
  if (parts.length === 0) throw new Error('没有可拼接的音频片段')
  const sampleRate = parts[0].sampleRate
  const gap = gapSeconds > 0 ? silencePcm(gapSeconds, sampleRate) : Buffer.alloc(0)
  const chunks = []
  parts.forEach((part, index) => {
    if (part.sampleRate !== sampleRate) throw new Error('拼接的片段采样率不一致')
    if (index > 0 && gap.length > 0) chunks.push(gap)
    chunks.push(toBuffer(part.pcm))
  })
  const pcm = Buffer.concat(chunks)
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
