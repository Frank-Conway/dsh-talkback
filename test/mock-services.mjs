/**
 * 假服务端（干跑用）：在本机真实端口上扮演识别服务与朗读服务。
 *
 * 用途：朗读服务 / 识别服务还没装好时，先把 DSH 这一侧的链路验证通
 * （麦克风按钮、识别、朗读、播放），确认是「服务没起」而不是「插件有问题」。
 *
 *   node test/mock-services.mjs                 # ASR:8000  TTS:9880，振幅 0.02（几乎无声）
 *   node test/mock-services.mjs --amplitude 0.3 # 能听见的"说话"（正弦音，不是人声）
 *   node test/mock-services.mjs --asr 8001 --tts 9881
 *
 * 每个请求都会打到控制台，并追加到 `--log` 指定的文件（默认系统临时目录下
 * `<包名>-mock.log`），方便对照 DSH 里发生了什么。
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PACKAGE_NAME } from '../lib/name.js'
import { makeWav } from './helpers.mjs'

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = {
    asr: 8000,
    tts: 9880,
    amplitude: 0.02,
    sampleRate: 32000,
    log: path.join(tmpdir(), `${PACKAGE_NAME}-mock.log`),
    clear: true,
    asrText: '这是模拟识别结果：语音输入的链路已经通了。',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => argv[++index]
    switch (flag) {
      case '--asr': options.asr = Number(next()); break
      case '--tts': options.tts = Number(next()); break
      case '--amplitude': options.amplitude = Number(next()); break
      case '--sample-rate': options.sampleRate = Number(next()); break
      case '--log': options.log = path.resolve(next()); break
      case '--text': options.asrText = next(); break
      case '--no-clear': options.clear = false; break
      case '--help':
        console.log('用法：node test/mock-services.mjs [--asr 8000] [--tts 9880] [--amplitude 0.02] [--log 路径]')
        process.exit(0)
        break
      default:
        if (flag.startsWith('--')) console.warn(`忽略未知参数：${flag}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.clear) writeFileSync(options.log, '', 'utf8')

/**
 * 记一行日志：控制台 + 文件。
 * @param {string} line 内容。
 */
function log(line) {
  const stamp = new Date().toISOString().slice(11, 19)
  const text = `[${stamp}] ${line}`
  console.log(text)
  appendFileSync(options.log, `${text}\n`, 'utf8')
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<Buffer>} 请求体。
 */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * 极简路由。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {string} kind 'asr' | 'tts'。
 * @returns {Promise<void>} 处理完成。
 */
async function route(req, res, kind) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
  const query = Object.fromEntries(url.searchParams)

  if (kind === 'asr') {
    if (url.pathname === '/healthz') {
      res.end(JSON.stringify({ status: 'ok', version: 'mock' }))
      return
    }
    if (url.pathname === '/readyz') {
      res.end(JSON.stringify({ status: 'ready' }))
      return
    }
    if (url.pathname === '/api/v1/transcriptions/sync') {
      log(`ASR 同步转写 语言=${query.language || '(自动)'} beam=${query.beam_size} 音频=${body.length}B`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ task_id: 'mock-sync', status: 'completed', result: { text: options.asrText, language: 'zh', duration: 2, segments: [] } }))
      return
    }
    if (url.pathname === '/api/v1/transcriptions/upload') {
      log(`ASR 提交任务 语言=${query.language || '(自动)'} 音频=${body.length}B`)
      res.statusCode = 202
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ task_id: 'mock-async', status: 'pending', priority: 'normal' }))
      return
    }
    if (url.pathname === '/api/v1/transcriptions/mock-async') {
      log('ASR 轮询任务 -> completed')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ task_id: 'mock-async', status: 'completed', progress: 1, result: { text: options.asrText, language: 'zh', duration: 2, segments: [] }, error: null }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ detail: 'not found' }))
    return
  }

  if (url.pathname === '/set_gpt_weights' || url.pathname === '/set_sovits_weights') {
    log(`TTS 切权重 ${url.pathname.replace('/set_', '').replace('_weights', '')}=${query.weights_path ?? ''}`)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ message: 'success' }))
    return
  }
  if (url.pathname === '/tts') {
    let payload = null
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      payload = null
    }
    if (!payload || typeof payload.text !== 'string') {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: '参数错误', Exception: 'text missing' }))
      return
    }
    const text = payload.text
    log(`TTS 合成 ${[...text].length} 字 split=${payload.text_split_method} ref=${String(payload.ref_audio_path ?? '').split(/[\\/]/).pop()}`)
    const seconds = Math.max(0.35, [...text].length / 4.5)
    const wav = makeWav({ seconds, sampleRate: options.sampleRate, amplitude: options.amplitude, frequency: 220 })
    res.setHeader('content-type', 'audio/wav')
    res.end(wav)
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ message: 'not found' }))
}

const asrServer = createServer((req, res) => {
  route(req, res, 'asr').catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ detail: String(error?.message ?? error) }))
  })
})
const ttsServer = createServer((req, res) => {
  route(req, res, 'tts').catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ message: String(error?.message ?? error) }))
  })
})

/**
 * 尝试监听，端口被占时给出明确提示。
 * @param {import('node:http').Server} server 服务。
 * @param {number} port 端口。
 * @param {string} label 名字。
 * @returns {Promise<void>} 监听完成。
 */
function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(`${label} 端口 ${port} 已被占用：可能真实服务已经在跑，先用真实服务即可`))
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      log(`${label} 假服务已就绪：http://127.0.0.1:${port}`)
      resolve()
    })
  })
}

try {
  await listen(asrServer, options.asr, '识别服务')
  await listen(ttsServer, options.tts, '朗读服务')
  log(`日志文件：${options.log}（振幅 ${options.amplitude}，Ctrl+C 结束）`)
} catch (error) {
  console.error(`启动失败：${error?.message ?? error}`)
  process.exit(1)
}
