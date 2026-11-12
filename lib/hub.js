/**
 * 朗读分发中心：把「助手的一条回复」变成「客户端可以按顺序取走的音频片段」。
 *
 * 为什么不是一次请求要一整段音频：
 *   - 整段合成完才播放，首句要等十几秒；
 *   - 一次只合成一片，客户端播完再来取，片与片之间又会有合成空档。
 * 所以这里做的是**流水线**：一条回复进来就按句切片，后台按顺序合成到内存，
 * 客户端用长轮询取走已经合成好的下一片。播放端永远不必等合成。
 *
 * 音频只存在内存里，取走即丢；过期时间由 `retentionSeconds` 控制。
 */

import { randomUUID } from 'node:crypto'
import { evaluateSpeech, pickBest } from './quality.js'
import { limitSpeech, splitFirstChunk, splitForSpeech, stripForSpeech } from './split.js'

/** 一片音频。 */
class Chunk {
  /**
   * @param {string} text 这一片的文本。
   * @param {number} index 序号。
   * @param {number} total 总片数。
   */
  constructor(text, index, total) {
    this.id = randomUUID()
    this.text = text
    this.index = index
    this.total = total
    /** @type {Buffer | null} */
    this.wav = null
    this.createdAt = Date.now()
    /** @type {((wav: Buffer | null) => void) | null} */
    this.resolve = null
    this.failed = false
  }

  /** 已合成好的音频（等待中的调用方拿到它）。 */
  get ready() {
    return this.wav !== null || this.failed
  }
}

/** 一个会话的朗读队列。 */
class SessionQueue {
  constructor() {
    /** @type {Chunk[]} */
    this.chunks = []
    /** @type {AbortController | null} */
    this.work = null
    /** @type {Set<(chunk: Chunk | null) => void>} */
    this.waiters = new Set()
  }
}

/**
 * 朗读分发中心。
 */
export class SpeechHub {
  /**
   * @param {{
   *   synthesize: (text: string, signal: AbortSignal) => Promise<Buffer | null>,
   *   logger?: any,
   *   maxCharsPerChunk?: number,
   *   firstChunkChars?: number,
   *   maxSpeakChars?: number,
   *   stripCodeBlocks?: boolean,
   *   stripMarkdown?: boolean,
   *   maxQueueChunks?: number,
   *   retentionSeconds?: number,
   * }} options 合成函数与切片参数。
   */
  constructor(options) {
    this.synthesize = options.synthesize
    this.logger = options.logger ?? {}
    this.maxCharsPerChunk = options.maxCharsPerChunk ?? 40
    this.firstChunkChars = options.firstChunkChars ?? 14
    this.maxSpeakChars = options.maxSpeakChars ?? 1200
    this.stripCodeBlocks = options.stripCodeBlocks ?? true
    this.stripMarkdown = options.stripMarkdown ?? true
    this.maxQueueChunks = options.maxQueueChunks ?? 40
    this.retentionSeconds = options.retentionSeconds ?? 120
    /** @type {Map<string, SessionQueue>} */
    this.sessions = new Map()
  }

  /**
   * 取（或建）一个会话的队列。
   * @param {string} sessionId 会话 id。
   * @returns {SessionQueue} 队列。
   */
  #queue(sessionId) {
    let queue = this.sessions.get(sessionId)
    if (!queue) {
      queue = new SessionQueue()
      this.sessions.set(sessionId, queue)
    }
    return queue
  }

  /**
   * 一条回复入队。
   * @param {string} sessionId 会话 id。
   * @param {string} text 助手回复原文（Markdown 会被清理）。
   * @returns {number} 切片数量（0 表示没有可念的内容）。
   */
  enqueue(sessionId, text) {
    const clean = stripForSpeech(text, { codeBlocks: this.stripCodeBlocks, markdown: this.stripMarkdown })
    const limited = limitSpeech(clean, this.maxSpeakChars)
    const pieces = splitForSpeech(limited, this.maxCharsPerChunk)
    if (pieces.length === 0) return 0
    // 首片再切短一点：首声的等待几乎全是首片的固定开销，后面各片照旧。
    const firstPieces = splitFirstChunk(pieces[0], this.firstChunkChars)
    if (firstPieces.length > 0) pieces.splice(0, 1, ...firstPieces)

    const queue = this.#queue(sessionId)
    const base = queue.chunks.length
    const total = base + pieces.length
    for (const [offset, piece] of pieces.entries()) {
      queue.chunks.push(new Chunk(piece, base + offset, total))
    }
    // 队列太长说明积压了（用户没在听）：丢最早还没合成完的，别让内存和 GPU 白转。
    if (queue.chunks.length > this.maxQueueChunks) {
      const dropped = queue.chunks.splice(0, queue.chunks.length - this.maxQueueChunks)
      this.logger.warn?.('朗读队列积压，丢弃最早的 %d 片', dropped.length)
      for (const chunk of dropped) {
        chunk.failed = true
        chunk.resolve?.(null)
      }
    }
    void this.#work(sessionId, queue)
    return pieces.length
  }

  /**
   * 客户端来取下一片：已合成好就立即返回，否则等到合成完或超时。
   * @param {string} sessionId 会话 id。
   * @param {{ signal?: AbortSignal, waitMs?: number }} [options] 取消信号与最长等待。
   * @returns {Promise<{ id: string, index: number, total: number, chars: number } | null>} 片段描述；null 表示暂时没有。
   */
  async next(sessionId, options = {}) {
    const queue = this.#queue(sessionId)
    const waitMs = options.waitMs ?? 25000
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return null
      const head = queue.chunks[0]
      if (!head) {
        // 空队列：挂起等待，直到有新片入队、被跳过或超时。
        const arrived = await this.#wait(queue, Math.min(1000, deadline - Date.now()), options.signal)
        if (arrived === undefined) return null
        continue
      }
      if (head.ready) {
        if (head.failed || !head.wav) {
          queue.chunks.shift()
          continue
        }
        return { id: head.id, index: head.index, total: head.total, chars: [...head.text].length }
      }
      const arrived = await this.#wait(queue, Math.min(1000, deadline - Date.now()), options.signal)
      if (arrived === undefined) return null
    }
    return null
  }

  /**
   * 等一小段时间，看队列有没有变化。
   * @param {SessionQueue} queue 队列。
   * @param {number} ms 最长等待毫秒。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<Chunk | null | undefined>} 变化后的队首；undefined 表示被取消。
   */
  #wait(queue, ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(undefined)
        return
      }
      const finish = (value) => {
        queue.waiters.delete(finish)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), Math.max(0, ms))
      const onAbort = () => finish(undefined)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      queue.waiters.add(finish)
    })
  }

  /**
   * 唤醒所有等待者。
   * @param {SessionQueue} queue 队列。
   */
  #wake(queue) {
    for (const waiter of [...queue.waiters]) waiter(queue.chunks[0] ?? null)
  }

  /**
   * 取出并消费一片音频。
   * @param {string} sessionId 会话 id。
   * @param {string} id 片段 id。
   * @returns {{ wav: Buffer, index: number, total: number } | null} 音频；已经不在队列里则为 null。
   */
  take(sessionId, id) {
    const queue = this.sessions.get(sessionId)
    if (!queue) return null
    const index = queue.chunks.findIndex((chunk) => chunk.id === id)
    if (index < 0) return null
    if (index > 0) {
      this.logger.warn?.('客户端跳过了 %d 片未播放的音频', index)
      const dropped = queue.chunks.splice(0, index)
      for (const chunk of dropped) chunk.wav = null
    }
    const chunk = queue.chunks.shift()
    if (!chunk || chunk.id !== id || !chunk.wav) return null
    const wav = chunk.wav
    // 取走即释放：客户端已经拿到字节，内存里不再留副本。
    chunk.wav = null
    if (queue.chunks.length === 0 && !queue.work) this.sessions.delete(sessionId)
    return { wav, index: chunk.index, total: chunk.total }
  }

  /**
   * 打断：清空队列并中止正在进行的合成。
   * @param {string} sessionId 会话 id。
   * @param {string} [reason] 原因（只写日志）。
   * @returns {boolean} 是否真的有东西被打断。
   */
  skip(sessionId, reason = '打断') {
    const queue = this.sessions.get(sessionId)
    if (!queue) return false
    const pending = queue.chunks.length
    queue.work?.abort(new Error(reason))
    queue.work = null
    for (const chunk of queue.chunks) {
      chunk.failed = true
      chunk.wav = null
      chunk.resolve?.(null)
    }
    queue.chunks.length = 0
    this.sessions.delete(sessionId)
    this.logger.info?.('已打断朗读（%s），丢弃 %d 片', reason, pending)
    return pending > 0
  }

  /**
   * 会话是否还有待播放内容。
   * @param {string} sessionId 会话 id。
   * @returns {{ pending: number, synthesizing: boolean }} 状态。
   */
  status(sessionId) {
    const queue = this.sessions.get(sessionId)
    if (!queue) return { pending: 0, synthesizing: false }
    return { pending: queue.chunks.length, synthesizing: queue.work !== null }
  }

  /**
   * 后台合成循环：严格按顺序把队列里的片段合成成音频。
   * @param {string} sessionId 会话 id。
   * @param {SessionQueue} queue 队列。
   * @returns {Promise<void>} 队列合成完毕或被中止。
   */
  async #work(sessionId, queue) {
    if (queue.work) return
    const controller = new AbortController()
    queue.work = controller
    try {
      while (!controller.signal.aborted) {
        const chunk = queue.chunks.find((item) => !item.ready)
        if (!chunk) break
        let wav = null
        try {
          wav = await this.synthesize(chunk.text, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) return
          this.logger.warn?.('合成第 %d 片失败：%s', chunk.index, error?.message ?? error)
        }
        chunk.wav = wav
        chunk.failed = wav === null
        chunk.resolve?.(wav)
        chunk.resolve = null
        this.#wake(queue)
      }
    } finally {
      if (queue.work === controller) queue.work = null
      if (this.sessions.get(sessionId) === queue && queue.chunks.length === 0) this.sessions.delete(sessionId)
      this.#wake(queue)
    }
  }

  /**
   * 丢掉过期且没人取的音频（客户端关掉页面时留下的）。
   * @param {number} [now] 当前时间。
   * @returns {number} 丢弃的片段数。
   */
  sweep(now = Date.now()) {
    const cutoff = now - this.retentionSeconds * 1000
    let dropped = 0
    for (const [sessionId, queue] of this.sessions) {
      const survivors = []
      for (const chunk of queue.chunks) {
        if (chunk.wav && chunk.createdAt < cutoff) {
          chunk.wav = null
          chunk.failed = true
          chunk.resolve?.(null)
          dropped += 1
          continue
        }
        if (chunk.failed && !chunk.wav) continue
        survivors.push(chunk)
      }
      queue.chunks = survivors
      if (queue.chunks.length === 0 && !queue.work) this.sessions.delete(sessionId)
    }
    if (dropped > 0) this.logger.debug?.('清理了 %d 片过期音频', dropped)
    return dropped
  }

  /** 卸载：停掉所有会话的合成。 */
  dispose() {
    for (const sessionId of [...this.sessions.keys()]) this.skip(sessionId, '插件卸载')
    this.sessions.clear()
  }
}

/**
 * 「多试几次，取最好的一次」的合成器。
 * @param {{ synthesize: (text: string, options: any, signal: AbortSignal) => Promise<Buffer>, attempts: Array<Record<string, unknown>>, evaluate?: typeof evaluateSpeech, speed?: number, thresholds?: Record<string, number>, logger?: any }} options 合成函数与重试档位。
 * @returns {(text: string, signal: AbortSignal) => Promise<Buffer | null>} 合成器。
 */
export function createRetryingSynthesizer(options) {
  const evaluate = options.evaluate ?? evaluateSpeech
  return async (text, signal) => {
    /** @type {Array<{ wav: Buffer, verdict: ReturnType<typeof evaluateSpeech>, attempt: number }>} */
    const candidates = []
    for (const [index, attempt] of options.attempts.entries()) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消')
      try {
        const wav = await options.synthesize(text, attempt, signal)
        const verdict = evaluate(wav, text, { speed: options.speed ?? 1, ...options.thresholds })
        candidates.push({ wav, verdict, attempt: index })
        if (verdict.ok) return wav
        options.logger?.warn?.(
          '第 %d 片未达标（第 %d 次尝试）：%s（有声 %.2fs / 共 %.2fs）',
          index,
          index + 1,
          verdict.reasons.join('；'),
          verdict.voicedSeconds,
          verdict.duration,
        )
      } catch (error) {
        if (signal.aborted) throw error
        options.logger?.warn?.('合成失败（第 %d 次尝试）：%s', index + 1, error?.message ?? error)
      }
    }
    if (candidates.length === 0) return null
    const best = pickBest(candidates)
    options.logger?.warn?.('都不理想，取打分最高的一次（有声 %.2fs / 共 %.2fs）', best.verdict.voicedSeconds, best.verdict.duration)
    return best.wav
  }
}
