/**
 * 隐私层：日志里能出现什么，由配置决定。
 *
 * 默认什么都不落：音频只在内存里以 Buffer 形式活 `retentionSeconds` 秒，
 * 日志里只出现长度（`42 字`、`18.2 KB`），不出现原文。
 */

/** 默认隐私配置（与 schemastery 的默认值保持一致）。 */
export const PRIVACY_DEFAULTS = {
  logText: false,
  logAudio: false,
  retentionSeconds: 120,
}

/**
 * 描述一段文本：允许记录时给原文，否则只给长度。
 * @param {string} text 文本。
 * @param {{ logText?: boolean }} privacy 隐私配置。
 * @returns {string} 可安全写进日志的字符串。
 */
export function describeText(text, privacy = {}) {
  const value = String(text ?? '')
  if (privacy.logText) return value
  const chars = [...value].length
  return `«${chars} 字，内容不记录»`
}

/**
 * 描述一段音频：允许记录时给大小与时长，否则只给大小。
 * @param {{ length: number }} audio 音频字节（Buffer / Uint8Array）。
 * @param {{ logAudio?: boolean }} privacy 隐私配置。
 * @param {number} [seconds] 时长（可选）。
 * @returns {string} 可安全写进日志的字符串。
 */
export function describeAudio(audio, privacy = {}, seconds) {
  const size = audio?.length ?? 0
  const human = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`
  if (!privacy.logAudio) return human
  return seconds === undefined ? `${human}` : `${human} / ${seconds.toFixed(2)}s`
}

/**
 * 生成一个只保留必要信息的日志包装：调用点不用自己判断隐私开关。
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} logger 宿主 logger。
 * @param {{ logText?: boolean, logAudio?: boolean }} privacy 隐私配置。
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, text: (value: string) => string, audio: (value: { length: number }, seconds?: number) => string }} 包装后的 logger。
 */
export function privateLogger(logger, privacy) {
  const bound = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    bound[level] = (...args) => logger?.[level]?.(...args)
  }
  return {
    ...bound,
    text: (value) => describeText(value, privacy),
    audio: (value, seconds) => describeAudio(value, privacy, seconds),
  }
}
