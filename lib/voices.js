/**
 * 音色解析：朗读服务的「音色」= 权重 + 参考音频 + 参考文本。
 *
 * 服务端没有「列出音色」的接口，音色清单只能靠扫盘：音色目录下每个
 * `ref_info.json` 描述一条音色（参考音频路径与它的逐字文本）。这里的扫描
 * 规则与 docs/API.md 的「音色目录」保持一致：
 * - 只看深度 ≤3 层的 `ref_info.json`；
 * - 缺 `text` 的整条跳过（没有参考文本硬凑只会让音色漂移）；
 * - 缺 `wav` 时回退到同目录 `refs/r1.wav`；
 * - json 解析失败只记 warning，不拖垮整个清单。
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { wavDuration } from './wav.js'

/**
 * 扫出目录下的候选音色。
 * @param {string} root 音色目录。
 * @param {number} [maxDepth] 最大递归层数。
 * @returns {Promise<Array<{ label: string, wav: string, text: string, voiceId: string, voiceName: string, dur: number | null, dir: string }>>} 音色列表。
 */
export async function scanVoices(root, maxDepth = 3) {
  /** @type {Array<{ label: string, wav: string, text: string, voiceId: string, voiceName: string, dur: number | null, dir: string }>} */
  const found = []
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'ref_info.json')) {
      const voice = await readVoiceInfo(dir)
      if (voice) found.push(voice)
    }
    if (depth >= maxDepth) continue
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  found.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  return found
}

/**
 * 读一条 `ref_info.json`。
 * @param {string} dir 音色目录。
 * @returns {Promise<{ label: string, wav: string, text: string, voiceId: string, voiceName: string, dur: number | null, dir: string } | null>} 音色条目。
 */
async function readVoiceInfo(dir) {
  /** @type {any} */
  let info
  try {
    info = JSON.parse(await readFile(path.join(dir, 'ref_info.json'), 'utf8'))
  } catch {
    return null
  }
  const text = String(info?.text ?? '').trim()
  if (!text) return null
  let wav = String(info?.wav ?? '').trim()
  if (!wav) wav = path.join(dir, 'refs', 'r1.wav')
  if (!path.isAbsolute(wav)) wav = path.resolve(dir, wav)
  const voiceId = String(info?.voice_id ?? '').trim()
  const voiceName = String(info?.voice_name ?? '').trim()
  const dur = Number.isFinite(info?.dur) ? Number(info.dur) : null
  return {
    label: buildLabel(voiceId, voiceName, dur, path.basename(dir)),
    wav,
    text,
    voiceId,
    voiceName,
    dur,
    dir,
  }
}

/**
 * 拼下拉显示名：`<id> <name>（<dur>s）`。
 * @param {string} voiceId 音色 id。
 * @param {string} voiceName 音色名。
 * @param {number | null} dur 参考音频时长。
 * @param {string} fallback 兜底名字（目录名）。
 * @returns {string} 显示名。
 */
function buildLabel(voiceId, voiceName, dur, fallback) {
  const name = [voiceId, voiceName].filter(Boolean).join(' ') || fallback
  return dur ? `${name}（${dur.toFixed(2)}s）` : name
}

/**
 * 读一个音频文件的时长（秒）；读不了返回 null。
 * @param {string} file 音频路径。
 * @returns {Promise<number | null>} 时长。
 */
export async function describeAudio(file) {
  try {
    const bytes = await readFile(file)
    const duration = wavDuration(bytes)
    return duration > 0 ? duration : null
  } catch {
    return null
  }
}

/**
 * 决定这次合成用哪个音色。
 *
 * 优先级：显式 `refAudioPath` + `promptText` > 扫 `voiceDir` 后按 `voice` 选。
 * @param {{ refAudioPath?: string, promptText?: string, voiceDir?: string, voice?: string }} config 配置。
 * @param {{ warn?: Function, info?: Function }} [logger] 日志。
 * @returns {Promise<{ refAudioPath: string, promptText: string, label: string, duration: number | null } | null>} 选中的音色，选不出为 null。
 */
export async function resolveVoice(config, logger = {}) {
  const explicitAudio = String(config.refAudioPath ?? '').trim()
  const explicitText = String(config.promptText ?? '').trim()
  if (explicitAudio) {
    const file = path.resolve(explicitAudio)
    const duration = await describeAudio(file)
    if (duration === null) {
      logger.warn?.('参考音频读取失败（路径可能不对）：%s', file)
    } else if (duration < 3 || duration > 10) {
      logger.warn?.('参考音频时长 %.2fs 超出服务端要求的 3~10 秒，服务端大概率会拒绝：%s', duration, file)
    }
    if (!explicitText) {
      logger.warn?.('没有配置参考文本（promptText），音色参照不足、稳定性会变差')
    }
    return {
      refAudioPath: file,
      promptText: explicitText,
      label: path.basename(path.dirname(file)) || path.basename(file),
      duration,
    }
  }

  const dir = String(config.voiceDir ?? '').trim()
  if (!dir) {
    logger.warn?.('语音朗读未启用：既没有配置 refAudioPath，也没有配置 voiceDir（音色目录）')
    return null
  }
  const voices = await scanVoices(path.resolve(dir))
  if (voices.length === 0) {
    logger.warn?.('语音朗读未启用：%s 下没有可用的 ref_info.json（需要 wav + text）', path.resolve(dir))
    return null
  }
  const wanted = String(config.voice ?? '').trim().toLowerCase()
  const picked = wanted
    ? voices.find((item) => item.voiceId.toLowerCase() === wanted)
      ?? voices.find((item) => item.voiceName.toLowerCase() === wanted)
      ?? voices.find((item) => item.label.toLowerCase().includes(wanted))
      ?? voices.find((item) => path.basename(item.dir).toLowerCase().includes(wanted))
    : voices[0]
  if (!picked) {
    logger.warn?.('没找到配置指定的音色「%s」，可选项：%s', config.voice, voices.map((item) => item.label).join('、'))
    return null
  }
  return {
    refAudioPath: picked.wav,
    promptText: picked.text,
    label: picked.label,
    duration: picked.dur,
  }
}
