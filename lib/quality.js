/**
 * 合成成片的质量判定。
 *
 * 朗读服务有一个已知行为：偶发退化成「半句人声 + 一长段静音」，
 * WAV 头里写着 20 多秒，其实只有前 2~3 秒有声音。所以：
 * - 判断能不能用，看**有声时长**，不看文件时长；
 * - 多次重试都不理想时，取**打分最高**的一次，而不是「取最短」——
 *   退化片子头长、真人有声短，取最短恰好会挑中「只说了半句」的那次。
 *
 * 阈值与「取最高分而不是取最短」的理由见 docs/API.md 的「成片校验」。
 */

import { analyzeWav } from './wav.js'

/** 中文语速估算：约 4.5 字/秒（与参考实现的默认值一致）。 */
export const CHARS_PER_SECOND = 4.5

/**
 * 估算一句话念出来大约要多久。
 * @param {string} text 片段文本。
 * @param {number} [speed] 语速倍数。
 * @returns {number} 估算秒数，下限 0.4 秒。
 */
export function estimateSeconds(text, speed = 1) {
  const chars = [...String(text ?? '').replace(/\s+/g, '')].length
  const rate = CHARS_PER_SECOND * (speed > 0 ? speed : 1)
  return Math.max(0.4, chars / rate)
}

/**
 * 判定一份成片是否达标。
 * @param {Uint8Array | Buffer} wav 合成结果。
 * @param {string} text 该片段文本。
 * @param {{ speed?: number, minVoicedRatio?: number, maxInternalSilence?: number, maxTrailingSilence?: number }} [options] 阈值。
 * @returns {{ ok: boolean, score: number, reasons: string[], duration: number, voicedSeconds: number, expectedSeconds: number, leadingSilence: number, trailingSilence: number, longestSilence: number }} 判定结果。
 */
export function evaluateSpeech(wav, text, options = {}) {
  const minVoicedRatio = options.minVoicedRatio ?? 0.45
  const maxInternalSilence = options.maxInternalSilence ?? 2.5
  const maxTrailingSilence = options.maxTrailingSilence ?? 1.5
  const expectedSeconds = estimateSeconds(text, options.speed ?? 1)

  let analysis
  try {
    analysis = analyzeWav(wav)
  } catch (error) {
    return {
      ok: false,
      score: 0,
      reasons: [`音频无法解析：${error?.message ?? error}`],
      duration: 0,
      voicedSeconds: 0,
      expectedSeconds,
      leadingSilence: 0,
      trailingSilence: 0,
      longestSilence: 0,
    }
  }

  const reasons = []
  const voicedRatio = analysis.duration > 0 ? analysis.voicedSeconds / analysis.duration : 0
  if (analysis.voicedSeconds < expectedSeconds * minVoicedRatio) {
    reasons.push(`有声 ${analysis.voicedSeconds.toFixed(2)}s 不足估算 ${expectedSeconds.toFixed(2)}s 的 ${Math.round(minVoicedRatio * 100)}%`)
  }
  if (analysis.longestSilence > maxInternalSilence) {
    reasons.push(`句内最长静音 ${analysis.longestSilence.toFixed(2)}s 超过 ${maxInternalSilence}s`)
  }
  if (analysis.trailingSilence > maxTrailingSilence) {
    reasons.push(`片尾静音 ${analysis.trailingSilence.toFixed(2)}s 超过 ${maxTrailingSilence}s`)
  }

  // 打分以「有声占比」为主，静音扣分，用于多次尝试之间挑最好的一份。
  const score = voicedRatio
    - Math.min(0.5, analysis.longestSilence / 10)
    - Math.min(0.3, analysis.trailingSilence / 10)

  return {
    ok: reasons.length === 0,
    score,
    reasons,
    duration: analysis.duration,
    voicedSeconds: analysis.voicedSeconds,
    expectedSeconds,
    leadingSilence: analysis.leadingSilence,
    trailingSilence: analysis.trailingSilence,
    longestSilence: analysis.longestSilence,
  }
}

/**
 * 从多次尝试里挑最可用的一份。
 * @param {Array<{ wav: Buffer, verdict: ReturnType<typeof evaluateSpeech>, attempt: number }>} candidates 尝试结果。
 * @returns {{ wav: Buffer, verdict: ReturnType<typeof evaluateSpeech>, attempt: number }} 最优的一份。
 */
export function pickBest(candidates) {
  if (candidates.length === 0) throw new Error('没有可用的合成结果')
  return candidates.reduce((best, item) => (item.verdict.score > best.verdict.score ? item : best))
}
