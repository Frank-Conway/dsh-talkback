/**
 * 语音插件的浏览器半边（手写的客户端模块，没有构建步骤）。
 *
 * 这一半负责「耳朵和嘴」：
 *   麦克风采集 -> 能量 VAD 断句 -> PCM16 WAV 编码 -> 交给宿主识别；
 *   同时长轮询宿主取回 TTS 音频 -> Web Audio 播放 -> 播报中检测到人声就打断。
 *
 * 宿主在渲染 index.html 时把配置塞进 `globalThis.__DSH_VOICE__`，
 * 所以这里不需要额外的接口就能知道路由前缀、采样率和 VAD 阈值。
 * 包名也走这条路带过来：`__DSH_VOICE__.packageName`（浏览器读不到 package.json，
 * 而模块 id 必须与包名一致，所以不能在这里写死）。
 */

/** 宿主注入的全局配置；脚本执行时已经在 <head> 里了。 */
const HOST_GLOBAL = (typeof globalThis !== 'undefined' && globalThis.__DSH_VOICE__) || null

/** 客户端模块 id = 包名。注入缺失时（宿主插件没启用）退回默认值。 */
const PACKAGE_NAME = (HOST_GLOBAL && HOST_GLOBAL.packageName) || 'dsh-talkback'

window.__ModuleLoader__.load({
  id: PACKAGE_NAME,
  factory: (require) => {
    const React = require('react')
    var module = { exports: {} }
    var exports = module.exports

    const h = React.createElement

    /** 宿主注入的配置；缺失就说明宿主插件没启用。 */
    const INJECTED = (typeof globalThis !== 'undefined' && globalThis.__DSH_VOICE__) || null

    /**
     * 生成 WAV（16bit 单声道 PCM）。
     * @param {Float32Array} samples 归一化样本（-1~1）。
     * @param {number} sampleRate 采样率。
     * @returns {Uint8Array} WAV 字节。
     */
    function encodeWave(samples, sampleRate) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const writeAscii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      writeAscii(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      writeAscii(8, 'WAVE')
      writeAscii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      let offset = 44
      for (let index = 0; index < samples.length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
        offset += 2
      }
      return bytes
    }

    /**
     * 线性重采样到目标采样率。
     * @param {Float32Array} input 输入样本。
     * @param {number} from 输入采样率。
     * @param {number} to 目标采样率。
     * @returns {Float32Array} 输出样本。
     */
    function resample(input, from, to) {
      if (!from || from === to || input.length === 0) return input
      const ratio = from / to
      const length = Math.max(1, Math.round(input.length / ratio))
      const output = new Float32Array(length)
      for (let index = 0; index < length; index += 1) {
        const position = index * ratio
        const left = Math.floor(position)
        const right = Math.min(input.length - 1, left + 1)
        const weight = position - left
        output[index] = input[left] * (1 - weight) + input[right] * weight
      }
      return output
    }

    /**
     * 把若干帧拼成一个 Float32Array。
     * @param {Float32Array[]} frames 帧。
     * @returns {Float32Array} 拼接结果。
     */
    function concat(frames) {
      let total = 0
      for (const frame of frames) total += frame.length
      const output = new Float32Array(total)
      let offset = 0
      for (const frame of frames) {
        output.set(frame, offset)
        offset += frame.length
      }
      return output
    }

    /**
     * 一帧的均方根电平。
     * @param {Float32Array} frame 样本。
     * @returns {number} RMS（0~1 量级）。
     */
    function rms(frame) {
      let sum = 0
      for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index]
      return Math.sqrt(sum / Math.max(1, frame.length))
    }

    /**
     * 可取消的等待。
     * @param {number} ms 毫秒。
     * @returns {Promise<void>} 等待结束。
     */
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** 采了这么久还是一根平的电平，就当环境噪音处理，别再往 ASR 送。 */
    const NOISE_PROBE_MS = 2500

    /** 起录 / 打断时往前多带一点音频，保住第一个字的起振。 */
    const ONSET_MARGIN_MS = 120

    /** 判定为噪音后把本底噪声抬到「均值 × 这个系数」，阈值会到均值的 1.2 倍，刚好盖住噪音。 */
    const NOISE_FLOOR_RISE = 0.4

    /**
     * 读取宿主配置，缺失时给一份保守的默认值。
     * @returns {{ base: string, client: Record<string, any>, asr: Record<string, any>, tts: Record<string, any> }} 配置。
     */
    function readConfig() {
      const inject = INJECTED || {}
      const client = inject.client || {}
      return {
        base: String(inject.base || '/voice').replace(/\/+$/, ''),
        client: {
          sampleRate: client.sampleRate || 16000,
          maxUtteranceMs: client.maxUtteranceMs || 20000,
          minUtteranceMs: client.minUtteranceMs || 400,
          silenceMs: client.silenceMs || 900,
          vadThreshold: client.vadThreshold || 0.02,
          prerollMs: typeof client.prerollMs === 'number' ? client.prerollMs : 600,
          onsetMs: typeof client.onsetMs === 'number' ? client.onsetMs : 150,
          noiseGate: client.noiseGate !== false,
          minVoicedRatio: typeof client.minVoicedRatio === 'number' ? client.minVoicedRatio : 0.1,
          levelVariance: typeof client.levelVariance === 'number' ? client.levelVariance : 0.15,
          bargeIn: client.bargeIn !== false,
          bargeInThreshold: client.bargeInThreshold || 0.06,
          bargeInMs: client.bargeInMs || 450,
          playbackGain: typeof client.playbackGain === 'number' ? client.playbackGain : 1,
          echoCancellation: client.echoCancellation !== false,
          noiseSuppression: client.noiseSuppression !== false,
          autoGainControl: client.autoGainControl !== false,
        },
        asr: {
          enabled: !inject.asr || inject.asr.enabled !== false,
          language: (inject.asr && inject.asr.language) || 'zh',
        },
        tts: { enabled: !inject.tts || inject.tts.enabled !== false },
      }
    }

    /** 语音引擎：麦克风、VAD、编码、播放、打断全在这里。 */
    class VoiceEngine {
      /**
       * @param {{ base: string, client: Record<string, any>, asr: Record<string, any>, tts: Record<string, any> }} config 配置。
       */
      constructor(config) {
        this.config = config
        this.state = {
          phase: 'off',
          /**
           * 交互模式，只有两档：
           *   - `continuous`：持续监听，说完自动识别、朗读，一轮结束回到监听；
           *   - `idle`：空闲，不监听、不朗读，麦克风与播放都释放。
           * `phase` 描述「正在做什么」（说话中/识别中/播报中），`mode` 描述「用户选了哪一档」。
           */
          mode: 'idle',
          level: 0,
          message: '',
          transcript: '',
          error: '',
          ready: INJECTED !== null,
        }
        this.listeners = new Set()
        this.sessionId = ''
        this.epoch = 0
        this.audio = null
        this.stream = null
        this.source = null
        this.analyser = null
        this.processor = null
        this.sink = null
        this.gain = null
        this.sampleRate = 0
        this.frames = []
        this.captureFrames = 0
        this.silenceMs = 0
        this.loudMs = 0
        this.noiseFloor = 0.004
        /** 预录环：最近一段音频，起录与打断都从这里取「已经说出口的部分」。 */
        this.preroll = []
        this.prerollMs = 0
        /** 从开麦起累计的音频时间（毫秒），预录环按它算时间窗。 */
        this.clockMs = 0
        /** listening 时「连续有声」已经持续多久，以及这一轮的起点。 */
        this.onsetRunMs = 0
        this.onsetStartMs = 0
        /** playing 时这一轮「响」的起点，打断时用来把丢掉的头部补回来。 */
        this.loudStartMs = 0
        /** 本句采集内的电平统计，供噪音闸门判断「像不像人说话」。 */
        this.voicedMs = 0
        this.voicedSum = 0
        this.voicedSq = 0
        this.voicedCount = 0
        this.playback = null
        this.lastLevelAt = 0
        this.busy = false
        this.subscribe = (listener) => {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        }
        this.getSnapshot = () => this.state
      }

      /**
       * 更新状态并通知订阅者。
       * @param {Record<string, unknown>} patch 变化。
       * @returns {void}
       */
      set(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      }

      /**
       * 记录当前会话；换会话时先把语音关掉，避免念到别的会话去。
       *
       * 关闭要报给**旧会话**：`this.sessionId` 已经换成新会话，如果按默认值上报，
       * 宿主会以为旧会话还在持续监听，后续回复仍会被合成。
       * @param {string} sessionId 会话 id。
       * @returns {void}
       */
      setSession(sessionId) {
        const next = String(sessionId || '')
        if (next === this.sessionId) return
        const previous = this.sessionId
        const wasOn = this.state.phase !== 'off'
        this.sessionId = next
        if (wasOn) {
          void this.disable(previous)
        }
      }

      /**
       * 切换模式：空闲 <-> 持续监听。
       * @returns {Promise<void>} 完成。
       */
      async toggle() {
        await this.setMode(this.state.mode === 'continuous' ? 'idle' : 'continuous')
      }

      /**
       * 切到指定模式。
       *
       * `continuous` 与 `idle` 是仅有的两档：前者开麦克风、持续对话；后者彻底停下
       * （释放麦克风、停播、清空队列），宿主那边也会把本会话移出朗读名单。
       * 启动中重复点「持续监听」不重复开麦；出错后点它会重试。
       * @param {'continuous' | 'idle'} mode 模式。
       * @returns {Promise<void>} 完成。
       */
      async setMode(mode) {
        if (mode === 'idle') {
          if (this.state.phase === 'off') return
          await this.disable()
          return
        }
        // 已经在这条链路上（启动中/在听/说话/识别/播报）就不重入。
        if (this.state.phase !== 'off' && this.state.phase !== 'error') return
        await this.enable()
      }

      /**
       * 打开持续监听模式。
       * @returns {Promise<void>} 完成。
       */
      async enable() {
        if (this.state.phase !== 'off' && this.state.phase !== 'error') return
        if (!INJECTED) {
          this.set({ phase: 'error', mode: 'idle', error: `宿主插件没启用：检查 ${PACKAGE_NAME} 是否在 profile 里` })
          return
        }
        if (!this.sessionId) {
          this.set({ phase: 'error', mode: 'idle', error: '先打开一个会话再开语音' })
          return
        }
        const epoch = ++this.epoch
        // `asr.enabled=false` 时只开朗读：不申请麦克风权限，也不采集，
        // 但轮询与播放照旧——否则「关闭 ASR」会把朗读一起关掉。
        const withMic = this.config.asr.enabled !== false
        this.set({ phase: 'starting', mode: 'continuous', error: '', message: withMic ? '正在打开麦克风…' : '正在准备朗读…' })
        try {
          await this.ensurePlayback()
          if (this.epoch !== epoch) return
          if (withMic) await this.startCapture()
          if (this.epoch !== epoch) return
          this.set({
            phase: 'listening',
            mode: 'continuous',
            message: withMic ? '' : '语音输入已关闭，仅朗读',
          })
          void this.report(true)
          void this.poll(epoch)
        } catch (error) {
          if (this.epoch !== epoch) return
          await this.stopAudio()
          // 释放音频图期间用户可能已经切回空闲：别再用错误状态把它盖掉。
          if (this.epoch !== epoch) return
          const message = describeMicrophoneError(error)
          // 停在 error 相位：按钮直接显示原因、颜色变红，再点一下就是重试，
          // 不用先「关掉」再「打开」两次点击。开麦失败时模式回到空闲，
          // 不能让界面停在「持续监听」上骗人。
          this.set({ phase: 'error', mode: 'idle', error: message, message: '' })
          void this.reportError(message)
        }
      }

      /**
       * 回到空闲：停播、释放麦克风与音频图，并让宿主把本会话移出朗读名单。
       * @param {string} [sessionId] 要上报的会话；换会话时传旧会话 id。
       * @returns {Promise<void>} 完成。
       */
      async disable(sessionId = this.sessionId) {
        const epoch = ++this.epoch
        this.stopPlayback()
        await this.stopAudio()
        if (this.epoch !== epoch) return
        this.set({ phase: 'off', mode: 'idle', level: 0, message: '', transcript: '' })
        void this.report(false, sessionId)
      }

      /**
       * 释放全部资源。
       * @returns {Promise<void>} 完成。
       */
      async dispose() {
        await this.disable()
        this.listeners.clear()
      }

      /**
       * 准备播放用的音频图：不需要麦克风权限，只朗读时也用它。
       * @returns {Promise<void>} 完成。
       */
      async ensurePlayback() {
        if (this.audio) return
        const AudioContextClass = window.AudioContext || window.webkitAudioContext
        if (!AudioContextClass) throw new Error('这个浏览器不支持 Web Audio')
        const audio = new AudioContextClass()
        await audio.resume().catch(() => {})
        const gain = audio.createGain()
        gain.gain.value = this.config.client.playbackGain
        gain.connect(audio.destination)
        this.audio = audio
        this.gain = gain
      }

      /**
       * 开麦克风并接上分析器 / 采样器（ASR 关掉时不会走这里）。
       * @returns {Promise<void>} 完成。
       */
      async startCapture() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('这个浏览器不支持麦克风采集（需要 https 或 localhost）')
        }
        const audio = this.audio
        if (!audio) throw new Error('播放用的音频上下文还没准备好')
        const options = this.config.client
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: options.echoCancellation,
            noiseSuppression: options.noiseSuppression,
            autoGainControl: options.autoGainControl,
          },
        })
        try {
          const source = audio.createMediaStreamSource(stream)
          const analyser = audio.createAnalyser()
          analyser.fftSize = 1024
          analyser.smoothingTimeConstant = 0.2
          const sunk = audio.createGain()
          sunk.gain.value = 0
          sunk.connect(audio.destination)
          const Processor = audio.createScriptProcessor || audio.createJavaScriptNode
          const processor = Processor.call(audio, 2048, 1, 1)
          processor.onaudioprocess = (event) => {
            const frame = new Float32Array(event.inputBuffer.getChannelData(0))
            this.onFrame(frame, audio.sampleRate)
          }
          source.connect(analyser)
          source.connect(processor)
          processor.connect(sunk)

          this.stream = stream
          this.source = source
          this.analyser = analyser
          this.processor = processor
          this.sink = sunk
          this.sampleRate = audio.sampleRate
          this.resetCapture()
          this.preroll = []
          this.prerollMs = 0
          this.clockMs = 0
        } catch (error) {
          for (const track of stream.getTracks()) track.stop()
          throw error
        }
      }

      /**
       * 关掉麦克风与音频图（播放用的上下文也在这里释放）。
       * @returns {Promise<void>} 完成。
       */
      async stopAudio() {
        const { processor, source, stream, audio, sink, gain } = this
        this.processor = null
        this.source = null
        this.analyser = null
        this.stream = null
        this.audio = null
        this.sink = null
        this.gain = null
        this.sampleRate = 0
        this.resetCapture()
        this.preroll = []
        this.prerollMs = 0
        this.clockMs = 0
        try {
          processor?.disconnect()
        } catch {}
        try {
          source?.disconnect()
        } catch {}
        try {
          sink?.disconnect()
        } catch {}
        try {
          gain?.disconnect()
        } catch {}
        for (const track of stream?.getTracks?.() ?? []) track.stop()
        try {
          await audio?.close?.()
        } catch {}
      }

      /**
       * 当前生效的能量阈值：取配置下限与本底噪声的较大者。
       * @returns {number} RMS 阈值。
       */
      threshold() {
        return Math.max(this.config.client.vadThreshold, this.noiseFloor * 3)
      }

      /**
       * 把一帧塞进预录环，只保留最近 `limitMs` 的音频。
       * @param {Float32Array} frame 样本。
       * @param {number} frameMs 该帧时长。
       * @param {number} limitMs 保留时长。
       * @returns {void}
       */
      pushPreroll(frame, frameMs, limitMs) {
        this.preroll.push({ frame, endMs: this.clockMs + frameMs, ms: frameMs })
        this.prerollMs += frameMs
        this.clockMs += frameMs
        // 至少留一帧，否则 prerollMs 配成 0 时连当帧都取不到。
        const limit = Math.max(frameMs, limitMs)
        while (this.prerollMs > limit && this.preroll.length > 1) {
          this.prerollMs -= this.preroll.shift().ms
        }
      }

      /**
       * 取预录环里从 `fromMs` 之后的部分。
       * @param {number} fromMs 起始音频时间（毫秒）。
       * @returns {{ frames: Float32Array[], ms: number }} 帧与总时长。
       */
      takePreroll(fromMs) {
        const seed = this.preroll.filter((entry) => entry.endMs > fromMs)
        if (seed.length === 0 && this.preroll.length > 0) {
          const last = this.preroll[this.preroll.length - 1]
          return { frames: [last.frame], ms: last.ms }
        }
        return { frames: seed.map((entry) => entry.frame), ms: seed.reduce((sum, entry) => sum + entry.ms, 0) }
      }

      /**
       * 清空当前这一句的采集状态（帧、计时、电平统计）。
       * @returns {void}
       */
      resetCapture() {
        this.frames = []
        this.captureFrames = 0
        this.silenceMs = 0
        this.loudMs = 0
        this.onsetRunMs = 0
        this.voicedMs = 0
        this.voicedSum = 0
        this.voicedSq = 0
        this.voicedCount = 0
      }

      /**
       * 记录一帧的电平统计，用于判断这段话「像不像人说的」。
       * @param {number} level 该帧 RMS。
       * @param {number} threshold 当前阈值。
       * @returns {void}
       */
      trackLevel(level, threshold) {
        if (level <= threshold) return
        this.voicedSum += level
        this.voicedSq += level * level
        this.voicedCount += 1
      }

      /**
       * 有声帧电平的变异系数：人说话抑扬顿挫，稳态噪音（空调、风扇、嗡声）几乎是常数。
       * @returns {number} 变异系数；样本不足时给 0。
       */
      levelSpread() {
        if (this.voicedCount < 2) return 0
        const mean = this.voicedSum / this.voicedCount
        if (mean <= 0) return 0
        const variance = Math.max(0, this.voicedSq / this.voicedCount - mean * mean)
        return Math.sqrt(variance) / mean
      }

      /**
       * 已经采到的这段像不像环境噪音。
       * @returns {boolean} 像噪音则为 true。
       */
      looksLikeNoise() {
        const options = this.config.client
        if (!options.noiseGate || this.voicedCount < 4) return false
        return this.levelSpread() < options.levelVariance
      }

      /**
       * 丢掉当前这句，并把本底噪声抬到噪音电平之上——自己治好，别每 2.5 秒再录一遍。
       * @param {string} message 提示文案。
       * @returns {void}
       */
      dropAsNoise(message) {
        const mean = this.voicedCount > 0 ? this.voicedSum / this.voicedCount : this.noiseFloor
        this.noiseFloor = Math.max(this.noiseFloor, mean * NOISE_FLOOR_RISE)
        this.resetCapture()
        this.set({ phase: 'listening', message })
      }

      /**
       * 每一帧音频进来：记进预录环、算电平、跑 VAD 状态机。
       * @param {Float32Array} frame 样本。
       * @param {number} sampleRate 采样率。
       * @returns {void}
       */
      onFrame(frame, sampleRate) {
        const options = this.config.client
        const level = rms(frame)
        const frameMs = (frame.length / sampleRate) * 1000
        const now = Date.now()

        // 预录环：任何相位都留着最后一段，起录和打断都从这里取「已经说出口的部分」。
        const frameStartMs = this.clockMs
        this.pushPreroll(frame, frameMs, options.prerollMs)

        // 电平表：每 80ms 刷一次就够，别把 React 顶爆。
        if (now - this.lastLevelAt > 80) {
          this.lastLevelAt = now
          this.set({ level })
        }

        if (this.state.phase === 'playing') {
          if (!options.bargeIn) return
          if (level > options.bargeInThreshold) {
            if (this.loudMs === 0) this.loudStartMs = frameStartMs
            this.loudMs += frameMs
          } else {
            this.loudMs = 0
          }
          if (this.loudMs >= options.bargeInMs) this.bargeIn()
          return
        }

        const threshold = this.threshold()

        if (this.state.phase === 'listening') {
          if (level < threshold) {
            // 地板只跟着「比它还安静」的声音往下走。高于地板的声音不抬地板，
            // 否则小声说话会把地板一路顶上去，最后把自己听不见；噪音抬地板交给 dropAsNoise。
            if (level < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.97 + level * 0.03
            this.onsetRunMs = 0
            return
          }
          if (this.onsetRunMs === 0) this.onsetStartMs = frameStartMs
          this.onsetRunMs += frameMs
          // 响一下就没了的多半是键盘、关门声：连续有声够 onsetMs 才算开口。
          if (this.onsetRunMs >= options.onsetMs) this.beginCapture(this.onsetStartMs - ONSET_MARGIN_MS)
          return
        }

        if (this.state.phase === 'capturing') {
          this.frames.push(frame)
          this.captureFrames += frameMs
          this.trackLevel(level, threshold)
          if (level > threshold) {
            this.silenceMs = 0
            this.voicedMs += frameMs
          } else {
            this.silenceMs += frameMs
          }
          if (this.captureFrames >= options.maxUtteranceMs) {
            void this.finishUtterance('到达单句时长上限')
          } else if (this.silenceMs >= options.silenceMs && this.captureFrames >= options.minUtteranceMs) {
            void this.finishUtterance('检测到静音')
          } else if (this.captureFrames >= NOISE_PROBE_MS && this.looksLikeNoise()) {
            this.dropAsNoise('环境太吵，已忽略')
          }
        }
      }

      /**
       * 开始收集一句话：从句首往前多带一点预录音频，别把第一个字的起振切掉。
       * @param {number} onsetMs 句首在音频时间轴上的位置（毫秒）。
       * @returns {void}
       */
      beginCapture(onsetMs) {
        const seed = this.takePreroll(Math.min(onsetMs, this.clockMs - 1))
        this.frames = seed.frames
        this.captureFrames = seed.ms
        this.silenceMs = 0
        this.loudMs = 0
        this.onsetRunMs = 0
        this.voicedMs = 0
        this.voicedSum = 0
        this.voicedSq = 0
        this.voicedCount = 0
        this.set({ phase: 'capturing', message: '' })
      }

      /**
       * 播报中检测到人声：立刻停播、通知宿主丢弃剩余音频，并把这句从头（含预录）录下来。
       * @returns {void}
       */
      bargeIn() {
        this.stopPlayback()
        void this.postSkip('检测到用户插话')
        // 判定打断花掉的时间也在这段预录里，所以插话句的头部不会丢。
        this.beginCapture(this.loudStartMs - ONSET_MARGIN_MS)
        this.set({ message: '已打断朗读' })
      }

      /**
       * 停掉正在播的音频。
       * @returns {void}
       */
      stopPlayback() {
        const playback = this.playback
        this.playback = null
        if (playback) {
          try {
            playback.source.stop()
          } catch {}
          playback.resolve()
        }
      }

      /**
       * 一句话录完：编码、上传、等识别结果。
       * @param {string} reason 结束原因（只写日志）。
       * @returns {Promise<void>} 完成。
       */
      async finishUtterance(reason) {
        if (this.state.phase !== 'capturing') return
        const epoch = this.epoch
        const frames = this.frames
        const sampleRate = this.sampleRate
        const options = this.config.client
        // 闸门要用的统计在 resetCapture 之前取走。
        const capturedMs = this.captureFrames
        const voicedMs = this.voicedMs
        const spread = this.levelSpread()
        const voicedCount = this.voicedCount
        const voicedSum = this.voicedSum
        this.resetCapture()
        if (frames.length === 0) {
          this.set({ phase: 'listening' })
          return
        }
        // 上传前最后一道闸：整段电平平稳得像空调、风扇，就别麻烦 ASR 了——
        // 识别服务遇到这种音频会吐一句「谢谢观看」，然后被当成用户说的话注入会话。
        if (options.noiseGate && voicedCount >= 4) {
          if (spread < options.levelVariance) {
            const mean = voicedSum / voicedCount
            this.noiseFloor = Math.max(this.noiseFloor, mean * NOISE_FLOOR_RISE)
            this.set({ phase: 'listening', message: '环境太吵，已忽略' })
            return
          }
          if (capturedMs > 0 && voicedMs / capturedMs < options.minVoicedRatio) {
            this.set({ phase: 'listening', message: '没听到明显的说话声' })
            return
          }
        }
        const merged = concat(frames)
        const resampled = resample(merged, sampleRate, options.sampleRate)
        const durationMs = (resampled.length / options.sampleRate) * 1000
        if (durationMs < options.minUtteranceMs) {
          this.set({ phase: 'listening', message: '太短了，没听清' })
          return
        }
        this.set({ phase: 'recognizing', message: '识别中…' })
        try {
          const audio = encodeWave(resampled, options.sampleRate)
          const query = new URLSearchParams({ sessionId: this.sessionId, language: this.config.asr.language })
          const response = await fetch(`${this.config.base}/asr?${query.toString()}`, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: audio,
          })
          const payload = await response.json().catch(() => ({}))
          if (this.epoch !== epoch) return
          if (!response.ok) throw new Error(payload.error || `识别失败（HTTP ${response.status}）`)
          this.set({
            phase: 'listening',
            transcript: payload.text || '',
            message: payload.busy ? '已发送（当前回复结束后处理）' : '已发送',
          })
          if (reason !== '检测到静音') this.set({ message: `${reason}，已发送` })
        } catch (error) {
          if (this.epoch !== epoch) return
          this.set({ phase: 'listening', message: '', error: String(error && error.message ? error.message : error) })
        }
      }

      /**
       * 长轮询宿主：有得播就播，没有就继续等。
       * @param {number} epoch 本轮版本号（关掉后会变）。
       * @returns {Promise<void>} 轮询结束。
       */
      async poll(epoch) {
        while (this.epoch === epoch && this.state.phase !== 'off') {
          if (this.state.phase === 'capturing' || this.state.phase === 'recognizing' || this.state.phase === 'starting') {
            await sleep(150)
            continue
          }
          let response
          try {
            response = await fetch(`${this.config.base}/next`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: this.sessionId }),
            })
          } catch {
            await sleep(1500)
            continue
          }
          if (this.epoch !== epoch) return
          // 宿主没挂住长轮询（或者 pollWaitMs 很短）时给事件循环留一口气：
          // 204 立刻返回还继续转，会变成只跑微任务的忙等，定时器都插不进来。
          if (response.status === 204) {
            await sleep(120)
            continue
          }
          if (!response.ok) {
            await sleep(1500)
            continue
          }
          const chunk = await response.json().catch(() => null)
          if (!chunk || !chunk.id) continue
          await this.playChunk(chunk, epoch)
        }
      }

      /**
       * 取回并播放一片音频。
       * @param {{ id: string }} chunk 片段。
       * @param {number} epoch 版本号。
       * @returns {Promise<void>} 播放结束或被中断。
       */
      async playChunk(chunk, epoch) {
        const query = new URLSearchParams({ sessionId: this.sessionId, id: chunk.id })
        let response
        try {
          response = await fetch(`${this.config.base}/audio?${query.toString()}`)
        } catch {
          return
        }
        if (!response.ok || !this.audio) return
        const bytes = await response.arrayBuffer()
        if (this.epoch !== epoch || !this.audio) return
        let buffer
        try {
          buffer = await this.audio.decodeAudioData(bytes)
        } catch {
          this.set({ error: '音频解码失败（宿主返回的可能不是 WAV）' })
          return
        }
        if (this.epoch !== epoch || !this.audio) return
        this.set({ phase: 'playing', message: '', error: '' })
        await new Promise((resolve) => {
          const source = this.audio.createBufferSource()
          source.buffer = buffer
          source.connect(this.gain)
          this.playback = { source, resolve }
          source.onended = () => resolve()
          try {
            source.start()
          } catch {
            resolve()
          }
        })
        this.playback = null
        if (this.epoch === epoch && this.state.phase === 'playing') {
          this.set({
            phase: 'listening',
            message: this.config.asr.enabled === false ? '语音输入已关闭，仅朗读' : '',
          })
        }
      }

      /**
       * 通知宿主丢弃剩余音频。
       * @param {string} reason 原因。
       * @returns {Promise<void>} 完成。
       */
      async postSkip(reason) {
        try {
          await fetch(`${this.config.base}/skip`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, reason }),
          })
        } catch {}
      }

      /**
       * 上报模式（持续监听 / 空闲）或客户端错误。
       * @param {boolean} listening 是否在持续监听。
       * @param {string} [sessionId] 会话 id；默认当前会话，换会话时要显式传旧会话。
       * @returns {Promise<void>} 完成。
       */
      async report(listening, sessionId = this.sessionId) {
        if (!sessionId) return
        try {
          await fetch(`${this.config.base}/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, listening }),
          })
        } catch {}
      }

      /**
       * 上报客户端错误：宿主控制台留一行，`/voice/status` 里也能查到。
       * @param {string} message 错误。
       * @returns {Promise<void>} 完成。
       */
      async reportError(message) {
        if (!this.sessionId) return
        try {
          await fetch(`${this.config.base}/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, error: message }),
          })
        } catch {}
      }
    }

    /**
     * 把麦克风的错误翻成能看懂的中文。
     * @param {any} error 错误。
     * @returns {string} 提示。
     */
    function describeMicrophoneError(error) {
      const name = error && error.name
      if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝：在地址栏的站点设置里允许麦克风'
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没找到可用的麦克风'
      if (name === 'NotReadableError') return '麦克风被别的程序占用了'
      return String(error && error.message ? error.message : error)
    }

    /** 状态文案。 */
    const LABELS = {
      off: '空闲',
      starting: '启动中',
      listening: '持续监听',
      capturing: '说话中',
      recognizing: '识别中',
      playing: '播报中',
      error: '出错',
    }

    /**
     * 从状态快照里取出当前模式。
     *
     * 只有 `continuous` / `idle` 两档；旧快照（热更新前渲染的）没有 `mode`
     * 字段，按 `phase` 推回同样的语义：只要不是 off，就当持续监听。
     * @param {{ phase?: string, mode?: string } | null | undefined} state 状态。
     * @returns {'continuous' | 'idle'} 模式。
     */
    function voiceMode(state) {
      if (state?.mode === 'continuous') return 'continuous'
      if (state?.mode === 'idle') return 'idle'
      return state?.phase && state.phase !== 'off' ? 'continuous' : 'idle'
    }

    /** 麦克风图标；空闲时加一道斜线，跟「持续监听」区分开。 */
    function micIcon(active) {
      const children = [
        h('path', { key: 'body', d: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
        h('path', { key: 'arc', d: 'M19 10v1a7 7 0 0 1-14 0v-1' }),
        h('path', { key: 'stem', d: 'M12 18v3' }),
      ]
      if (!active) children.push(h('path', { key: 'off', d: 'M4 4l16 16' }))
      return h('svg', {
        key: 'icon',
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2.4 : 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, children)
    }

    /**
     * 输入框里的语音控件。
     * @param {{ sessionId?: string, engine: VoiceEngine }} props 属性。
     * @returns {import('react').ReactElement} 元素。
     */
    function VoiceControl(props) {
      const engine = props.engine
      const sessionId = props.sessionId || ''
      const state = React.useSyncExternalStore(engine.subscribe, engine.getSnapshot)

      React.useEffect(() => {
        engine.setSession(sessionId)
        return () => engine.setSession('')
      }, [engine, sessionId])

      const phase = state.phase
      // 两档模式：`continuous` = 持续监听，`idle` = 空闲。
      const mode = voiceMode(state)
      const active = mode === 'continuous'
      const label = LABELS[phase] || phase
      const error = state.error
      // 提示文案和状态名共用一个固定宽度的文本槽：`starting` 阶段的
      // 「正在打开麦克风…」若作为独立元素插入，会把右对齐的工具条撑宽再缩回，
      // 按钮跟着左右跳两次——看起来就是闪烁。
      // 启动太快（权限已给过），这句提示只会闪一下，所以启动阶段只留状态名。
      // 出错时优先显示原因：之前只写在 title 里，界面上只剩一个红色的「语音」。
      const notice = phase === 'starting' ? '' : (state.message || state.transcript)
      const text = error || notice || label
      const tone = error ? '#d9534f' : 'inherit'
      const level = Math.min(1, (state.level || 0) * 6)
      const title = error
        || state.transcript
        || state.message
        || ((active
          ? '持续监听：说完自动发送并朗读，一轮结束继续听。点一下切到空闲。'
          : '空闲：当前不监听、也不朗读。点一下进入持续监听。')
          + (engine.config?.asr?.enabled === false ? '（ASR 已关闭，只朗读）' : ''))

      return h('div', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          boxSizing: 'border-box',
          // 固定宽度：状态文案长短、有没有提示，都不许改变工具条的排版。
          width: 160,
          height: 28,
          padding: '0 8px',
          borderRadius: 8,
          border: `1px solid ${active ? 'rgba(64,158,255,0.55)' : 'rgba(127,127,127,0.28)'}`,
          background: active ? 'rgba(64,158,255,0.12)' : 'transparent',
          color: tone,
          fontSize: 12,
          lineHeight: 1,
          userSelect: 'none',
          whiteSpace: 'nowrap',
        },
        title,
      }, [
        h('button', {
          key: 'btn',
          type: 'button',
          // 点按钮别把焦点从编辑器抢走：编辑器失焦会让宿主整条工具条重画，
          // 按钮会跟着闪一下。
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => { void engine.toggle() },
          disabled: !state.ready,
          'aria-pressed': active,
          'aria-label': active ? '切到空闲' : '进入持续监听',
          title: state.ready ? (active ? '切到空闲：停止监听与朗读' : '进入持续监听：一直听，说完自动发送') : '宿主插件没启用',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: '1 1 auto',
            minWidth: 0,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: state.ready ? 'pointer' : 'not-allowed',
            fontSize: 12,
            opacity: state.ready ? 1 : 0.5,
          },
        }, [micIcon(active), h('span', {
          key: 'label',
          style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
        }, text)]),
        h('div', {
          key: 'meter',
          style: {
            flex: '0 0 auto',
            position: 'relative',
            width: 34,
            height: 4,
            borderRadius: 2,
            overflow: 'hidden',
            background: 'rgba(127,127,127,0.28)',
            opacity: active ? 1 : 0.45,
          },
        }, h('div', {
          style: {
            position: 'absolute',
            inset: 0,
            width: `${Math.round(level * 100)}%`,
            background: phase === 'playing' ? '#4caf50' : '#409eff',
            transition: 'width 80ms linear',
          },
        })),
      ])
    }

    /** 客户端插件依赖的服务。 */
    const inject = ['slots']

    /**
     * 把宿主给的配置快照整理成表单初值。
     * @param {any} data `GET /voice/config` 的响应。
     * @returns {{ enabled: boolean, ttsEnabled: boolean, asrEnabled: boolean, warmup: boolean, asrEndpoint: string, ttsEndpoint: string, voiceDir: string, voice: string, explicitVoicePath: string, silenceMs: string, voices: any[], patchFile: string | null, patched: boolean, others: string[] }} 表单值。
     */
    function settingsForm(data) {
      const info = data || {}
      return {
        // 宿主没返回这两项时按默认（开）处理，别因为读不到就把开关画成关。
        enabled: info.enabled !== false,
        ttsEnabled: info.tts?.enabled !== false,
        asrEnabled: info.asr?.enabled !== false,
        warmup: info.tts?.warmup !== false,
        asrEndpoint: String(info.asr?.endpoint ?? ''),
        ttsEndpoint: String(info.tts?.endpoint ?? ''),
        voiceDir: String(info.tts?.voiceDir ?? ''),
        voice: String(info.tts?.voice ?? ''),
        // 只用来提示「下拉不生效」；页面不提供编辑入口，也不提交。
        explicitVoicePath: String(info.tts?.refAudioPath ?? ''),
        silenceMs: String(info.client?.silenceMs ?? ''),
        voices: Array.isArray(info.voices) ? info.voices : [],
        patchFile: info.patchFile ?? null,
        patched: Boolean(info.patched),
        others: Array.isArray(info.others) ? info.others : [],
      }
    }

    /**
     * 手写 `tts.refAudioPath` 生效时的提示文案。
     *
     * 这是个「隐式优先」：`resolveVoice` 先看显式参考音频，再扫音色目录，所以只要
     * YAML 里写了它，页面上的音色下拉选了也不会变——不解释清楚，用户会以为换了音色。
     * @param {{ explicitVoicePath?: string }} form 表单值。
     * @returns {string} 提示；没有手写覆盖时为空串。
     */
    function overrideNotice(form) {
      if (!String(form?.explicitVoicePath ?? '').trim()) return ''
      return '当前音色由手写 tts.refAudioPath 指定，音色下拉不生效。'
    }

    /**
     * 表单值 → 提交体（空字符串表示「删掉这条覆盖，回落到默认值」）。
     *
     * 只提交页面上真实存在的字段：`tts.refAudioPath` / `tts.promptText` 已经不在
     * 页面上，也不提交——音色由「音色目录 + 音色」选中的 `ref_info.json` 成对给出，
     * 手写 YAML 里的那两项保持原样，不被保存动作抹掉。
     *
     * 两个开关每次都显式提交 `true` / `false`：布尔没有「留空回落到默认」的写法，
     * 而且总开关关掉后还得靠这个值把它重新打开。
     * @param {Record<string, any>} form 表单值。
     * @returns {Record<string, string | number | boolean>} 提交体。
     */
    function settingsPayload(form) {
      /** @type {Record<string, string | number | boolean>} */
      const payload = {
        enabled: Boolean(form.enabled),
        'asr.enabled': Boolean(form.asrEnabled),
        'asr.endpoint': String(form.asrEndpoint ?? '').trim(),
        'tts.enabled': Boolean(form.ttsEnabled),
        'tts.endpoint': String(form.ttsEndpoint ?? '').trim(),
        'tts.warmup': Boolean(form.warmup),
        'tts.voiceDir': String(form.voiceDir ?? '').trim(),
        'tts.voice': String(form.voice ?? '').trim(),
      }
      const silenceMs = Number(String(form.silenceMs ?? '').trim())
      if (Number.isInteger(silenceMs) && silenceMs > 0) payload['client.silenceMs'] = silenceMs
      return payload
    }

    /**
     * 读一份配置。
     * @param {string} base 路由前缀。
     * @returns {Promise<any>} 配置。
     */
    async function fetchSettings(base) {
      const response = await fetch(`${base}/config`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`读取配置失败（HTTP ${response.status}）`)
      return await response.json()
    }

    /**
     * 保存一份配置。
     * @param {string} base 路由前缀。
     * @param {Record<string, any>} payload 提交体。
     * @returns {Promise<any>} 保存结果。
     */
    async function postSettings(base, payload) {
      const response = await fetch(`${base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `保存失败（HTTP ${response.status}）`)
      return data
    }

    /** 设置页里的一行：标签 + 提示 + 输入控件。 */
    function fieldRow(key, label, hint, control) {
      return h('label', {
        key,
        style: { display: 'grid', gap: 4, marginBottom: 10 },
      }, [
        h('span', { key: 'l', style: { fontSize: 12, opacity: 0.85 } },
          hint ? `${label} · ${hint}` : label),
        control,
      ])
    }

    /** 设置页里的一行开关：复选框 + 标题。 */
    function checkboxRow(key, label, checked, onChange) {
      return h('label', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12, cursor: 'pointer' },
      }, [
        h('input', {
          key: 'c',
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { key: 't' }, label),
      ])
    }

    /** 输入框的统一样式。 */
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      fontFamily: 'inherit',
    }

    /**
     * 设置 → 语音：改 ASR/TTS 地址与音色。
     * @param {{ base?: string }} props 宿主提供的成员（`close` 由设置外壳注入）。
     * @returns {any} 组件。
     */
    function VoiceSettings(props) {
      const base = props?.base || '/voice'
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState({ kind: 'idle', text: '' })

      React.useEffect(() => {
        let alive = true
        void fetchSettings(base)
          .then((data) => { if (alive) setForm(settingsForm(data)) })
          .catch((error) => { if (alive) setStatus({ kind: 'error', text: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, [base])

      const update = (key, value) => setForm((current) => (current ? { ...current, [key]: value } : current))
      const reload = async () => {
        setBusy(true)
        try {
          setForm(settingsForm(await fetchSettings(base)))
          setStatus({ kind: 'ok', text: '已重新读取' })
        } catch (error) {
          setStatus({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }
      const save = async () => {
        if (!form) return
        setBusy(true)
        try {
          const result = await postSettings(base, settingsPayload(form))
          setForm(settingsForm(await fetchSettings(base)))
          setStatus({
            kind: 'ok',
            text: result.created ? '已写入配置（新建了 voice 段）。宿主热重载后生效，刷新页面即可。' : '已保存。宿主热重载后生效，刷新页面即可。',
          })
        } catch (error) {
          setStatus({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      if (!form) {
        return h('div', { style: { fontSize: 12, opacity: 0.8, padding: 4 } },
          status.kind === 'error' ? status.text : '读取配置…')
      }

      const tone = status.kind === 'error' ? '#e34d59' : 'rgba(76,175,80,1)'
      return h('div', { style: { display: 'grid', gap: 2, maxWidth: 520, padding: 4 } }, [
        form.enabled
          ? null
          : h('div', {
            key: 'off',
            style: {
              margin: '0 0 10px',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(217,83,79,0.55)',
              background: 'rgba(217,83,79,0.12)',
              fontSize: 12,
              lineHeight: 1.5,
            },
          }, '插件已禁用：麦克风与朗读不可用。勾上「启用语音插件」保存即可恢复。'),

        checkboxRow('enabled', '启用语音插件', form.enabled, (value) => update('enabled', value)),
        checkboxRow('tts', '朗读回复', form.ttsEnabled, (value) => update('ttsEnabled', value)),
        checkboxRow('asr', 'ASR 转录', form.asrEnabled, (value) => update('asrEnabled', value)),
        checkboxRow('warmup', '预热朗读服务', form.warmup, (value) => update('warmup', value)),

        fieldRow('asr', '识别服务地址', '', h('input', {
          key: 'i',
          value: form.asrEndpoint,
          spellCheck: false,
          onChange: (event) => update('asrEndpoint', event.target.value),
          style: inputStyle,
        })),
        fieldRow('tts', '朗读服务地址', '', h('input', {
          key: 'i',
          value: form.ttsEndpoint,
          spellCheck: false,
          onChange: (event) => update('ttsEndpoint', event.target.value),
          style: inputStyle,
        })),
        fieldRow('dir', '音色目录', '含 ref_info.json 的目录', h('input', {
          key: 'i',
          value: form.voiceDir,
          spellCheck: false,
          onChange: (event) => update('voiceDir', event.target.value),
          style: inputStyle,
        })),
        fieldRow('voice', '音色', form.voices.length > 0 ? `${form.voices.length} 条可选` : '音色目录下没扫到，先填目录', h('select', {
          key: 'i',
          value: form.voice,
          onChange: (event) => update('voice', event.target.value),
          style: inputStyle,
        }, [
          h('option', { key: '', value: '' }, '自动（第一条）'),
          ...form.voices.map((item, index) => h('option', {
            key: `${item.voiceId || index}`,
            value: item.voiceId || item.label,
          }, item.label)),
          ...(form.voice && !form.voices.some((item) => (item.voiceId || item.label) === form.voice)
            ? [h('option', { key: 'custom', value: form.voice }, `${form.voice}（配置里写的，当前没扫到）`)]
            : []),
        ])),
        // 手写 tts.refAudioPath 时把「下拉不生效」摆到明面上：这是隐式优先，
        // 不解释的话用户会以为选了下拉却没换音色（页面上又看不到那一项）。
        overrideNotice(form)
          ? h('div', {
            key: 'override',
            style: {
              display: 'grid',
              gap: 4,
              margin: '-2px 0 10px',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(230,162,60,0.55)',
              background: 'rgba(230,162,60,0.12)',
              fontSize: 12,
              lineHeight: 1.5,
            },
          }, [
            h('div', { key: 'text' }, overrideNotice(form)),
            h('div', { key: 'path', style: { fontSize: 11, opacity: 0.75, wordBreak: 'break-all' } }, form.explicitVoicePath),
            h('div', { key: 'fix', style: { fontSize: 11, opacity: 0.75 } },
              '要恢复下拉：删掉 tts.refAudioPath 与 tts.promptText 后重新读取。'),
          ])
          : null,
        fieldRow('silence', '静音断句（毫秒）', '停多久算说完', h('input', {
          key: 'i',
          type: 'number',
          min: 200,
          max: 10000,
          step: 50,
          value: form.silenceMs,
          onChange: (event) => update('silenceMs', event.target.value),
          style: inputStyle,
        })),

        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } }, [
          h('button', {
            key: 'save',
            type: 'button',
            onClick: () => { void save() },
            disabled: busy,
            style: {
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid rgba(64,158,255,0.55)',
              background: 'rgba(64,158,255,0.12)',
              color: 'inherit',
              fontSize: 12,
              cursor: busy ? 'progress' : 'pointer',
            },
          }, busy ? '处理中…' : '保存'),
          h('button', {
            key: 'reload',
            type: 'button',
            onClick: () => { void reload() },
            disabled: busy,
            style: {
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid rgba(127,127,127,0.35)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              cursor: busy ? 'progress' : 'pointer',
            },
          }, '重新读取'),
          status.text
            ? h('span', { key: 'status', style: { fontSize: 12, color: tone } }, status.text)
            : null,
        ]),

        form.patchFile
          ? h('p', { key: 'path', style: { fontSize: 11, opacity: 0.6, margin: '10px 0 0', wordBreak: 'break-all' } },
            `${form.patched ? '配置来自' : '还没写过配置，保存后写入'}：${form.patchFile}`)
          : h('p', { key: 'path', style: { fontSize: 11, opacity: 0.6, margin: '10px 0 0' } },
            `没找到装了 ${PACKAGE_NAME} 的 profile，无法写回配置。`),
        form.others.length > 0
          ? h('p', { key: 'others', style: { fontSize: 11, opacity: 0.6, margin: '4px 0 0' } },
            `这些字段本页不管，原样保留：${form.others.join('、')}`)
          : null,
      ].filter(Boolean))
    }

    /**
     * 客户端插件入口。
     * @param {{ slots: any, effect: Function }} ctx 客户端上下文。
     * @returns {Promise<() => Promise<void>>} 卸载函数。
     */
    function apply(ctx) {
      const engine = new VoiceEngine(readConfig())
      const base = readConfig().base
      // 注入对象保持同一引用：宿主每次重画工具条都会重新取注入值，
      // 返回新对象会让控件跟着做无谓的重渲染。
      const injected = { engine }
      ctx.effect(() => () => {
        void engine.dispose()
      })
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity',
        id: PACKAGE_NAME,
        order: 10,
        inject: () => injected,
      }, VoiceControl))
      // 设置 → 语音：只在设置外壳存在时才注册，没装也不影响麦克风按钮。
      // 外壳对 label 的约定是「取当前语言的函数」（官方分区都传 locale 绑定），
      // 顺手补个 toString，万一哪儿按字符串拼了也不会变成函数源码。
      const sectionLabel = () => '语音'
      sectionLabel.toString = () => '语音'
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PACKAGE_NAME,
        order: 60,
        label: sectionLabel,
        inject: () => ({ base }),
      }, VoiceSettings))
      return async () => {
        await engine.dispose()
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.VoiceEngine = VoiceEngine
    exports.VoiceControl = VoiceControl
    exports.readConfig = readConfig
    exports.voiceMode = voiceMode
    exports.settingsForm = settingsForm
    exports.settingsPayload = settingsPayload
    exports.overrideNotice = overrideNotice
    exports.VoiceSettings = VoiceSettings
    exports.encodeWave = encodeWave
    exports.resample = resample
    return module.exports
  },
})
