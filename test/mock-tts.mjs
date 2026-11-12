/**
 * 朗读服务的假服务端：实现 /tts 与两个切权重接口。
 *
 * 默认按「字数 / 每秒 4.5 字」生成一段有声 WAV；文本以「退化」开头时第一次请求
 * 故意返回「短有声 + 长静音」的坏音频，用来验证重试与取最优逻辑。
 */

import { makeDegenerateWav, makeWav, readBody } from './helpers.mjs'

/**
 * 起一个假朗读服务。
 * @param {{ failWeights?: boolean, degenerateOnce?: boolean }} [options] 是否让切权重失败、是否制造一次退化。
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: any[], weights: number }>} 服务信息。
 */
export async function startMockTts(options = {}) {
  const { serve } = await import('./helpers.mjs')
  const state = {
    /** @type {any[]} */
    requests: [],
    weights: 0,
    degenerateUsed: new Set(),
    failWeights: options.failWeights ?? false,
    degenerateOnce: options.degenerateOnce ?? false,
  }

  const service = await serve(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
    let json = null
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      json = null
    }
    state.requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: json,
    })

    if (url.pathname === '/set_gpt_weights' || url.pathname === '/set_sovits_weights') {
      if (state.failWeights) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ message: '权重路径不存在', Exception: 'FileNotFoundError' }))
        return
      }
      state.weights += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: 'success' }))
      return
    }

    if (url.pathname === '/tts') {
      if (!json || typeof json.text !== 'string') {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ message: '参数错误', Exception: 'text missing' }))
        return
      }
      const text = json.text
      const key = text
      const shouldDegenerate = state.degenerateOnce && text.startsWith('退化') && !state.degenerateUsed.has(key)
      if (shouldDegenerate) state.degenerateUsed.add(key)
      let wav
      if (shouldDegenerate) {
        wav = makeDegenerateWav({ voiced: 0.4, silence: 5.0, sampleRate: 32000 })
      } else {
        const seconds = Math.max(0.35, text.length / 4.5)
        wav = makeWav({ seconds, sampleRate: 32000, amplitude: 0.35, frequency: 220 })
      }
      res.setHeader('content-type', 'audio/wav')
      res.end(wav)
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })

  return {
    url: service.url,
    close: service.close,
    get requests() {
      return state.requests
    },
    get weights() {
      return state.weights
    },
  }
}
