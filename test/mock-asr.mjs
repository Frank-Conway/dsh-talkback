/**
 * 识别服务的假服务端：只实现插件用到的几个端点，并记录收到的请求，
 * 方便断言「语言参数、鉴权头、multipart 都发对了」。
 */

import { readBody } from './helpers.mjs'

/**
 * 起一个假识别服务。
 * @param {{ apiKey?: string, text?: string, failFirstPoll?: boolean }} [options] 鉴权 Key、返回文本、异步任务第一次轮询是否返回处理中。
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: any[], polls: number }>} 服务信息。
 */
export async function startMockAsr(options = {}) {
  const { serve } = await import('./helpers.mjs')
  const state = {
    /** @type {any[]} */
    requests: [],
    polls: 0,
    text: options.text ?? '你好，这是识别服务的识别结果。',
    apiKey: options.apiKey ?? '',
  }

  const service = await serve(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
    state.requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      bodyLength: body.length,
      contentType: req.headers['content-type'] ?? '',
    })

    if (state.apiKey) {
      if (req.headers['x-api-key'] !== state.apiKey) {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ detail: '无效或缺失的 API Key' }))
        return
      }
    }

    if (url.pathname === '/healthz') {
      res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }))
      return
    }

    if (url.pathname === '/api/v1/transcriptions/sync') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        task_id: 'task-sync',
        status: 'completed',
        result: {
          text: state.text,
          language: url.searchParams.get('language') || 'zh',
          duration: 1.5,
          segments: [],
        },
      }))
      return
    }

    if (url.pathname === '/api/v1/transcriptions/upload') {
      res.statusCode = 202
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ task_id: 'task-async', status: 'pending', priority: 'normal' }))
      return
    }

    if (url.pathname === '/api/v1/transcriptions/task-async') {
      state.polls += 1
      res.setHeader('content-type', 'application/json')
      if (state.polls < 2) {
        res.end(JSON.stringify({ task_id: 'task-async', status: 'processing', progress: 0.5 }))
        return
      }
      res.end(JSON.stringify({
        task_id: 'task-async',
        status: 'completed',
        progress: 1,
        result: { text: state.text, language: 'zh', duration: 1.5, segments: [] },
        error: null,
      }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ detail: 'not found' }))
  })

  return {
    url: service.url,
    close: service.close,
    get requests() {
      return state.requests
    },
    get polls() {
      return state.polls
    },
  }
}
