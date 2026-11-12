# dsh-talkback

> 对着麦克风说话 → 本机 ASR 识别 → 文本作为一条用户消息注入当前会话 → 助手回复交给本机 TTS
> 合成 → 音频回传浏览器播放；播报中你一开口就能打断。

[![npm](https://img.shields.io/npm/v/dsh-talkback)](https://www.npmjs.com/package/dsh-talkback)
[![downloads](https://img.shields.io/npm/dw/dsh-talkback)](https://www.npmjs.com/package/dsh-talkback)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-talkback)](https://nodejs.org)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一套**本机语音交互**。
识别与朗读都跑在你自己的机器上：插件不调用任何云服务，音频只在内存里排队，从头到尾不落盘。

输入框旁的语音按钮有两档：**持续监听**（说完自动发送、回复自动朗读，一轮结束继续听）和
**空闲**（不监听、不朗读，麦克风与播放一起释放）。默认是空闲，打开页面不会自己开麦。

插件不关心语音服务背后跑什么模型、什么框架，只认接口契约：ASR 是「上传音频、拿回文本」，
TTS 是「给文本、拿回 WAV」。下文里的「识别服务」「朗读服务」指的就是这两端，具体接哪套
实现由 `asr.endpoint` / `tts.endpoint` 决定；完整契约见 [docs/API.md](docs/API.md)。

**本仓库不含模型，也不含这两个服务。** 它只负责 DSH 与浏览器这一侧：采集、断句、
注入、朗读、打断。你需要自己在本机把识别服务（默认 `:8000`）与朗读服务（默认 `:9880`）
跑起来——任何满足契约的实现都行。

---

## 0. 为什么叫 talkback

`talkback` 是对讲机的「回话」：你说一句，它接一句，中间还能插话打断——正好是这个插件的
行为，也正是它与「语音输入」类插件的区别：**它是一轮完整的对话，不是一次性的听写。**

> 状态：`0.x` 早期版本，配置项与内部路由仍可能调整；接口契约（[docs/API.md](docs/API.md)）
> 与 DSH 侧的注入方式已经稳定。

---

## 1. 四层分工

| 层 | 做什么 | 在哪 |
|---|---|---|
| **Client** | 麦克风采集、两档模式（持续监听 / 空闲）、能量 VAD 断句（预录缓冲 + 起录确认 + 噪音闸门）、PCM16 WAV 编码、音频播放、打断检测 | 浏览器 `lib/client.js` |
| **Host** | 收音频 → 调 ASR → 注入会话；监听回复 → 调 TTS → 把音频交给客户端 | 宿主进程 `lib/index.js` |
| **配置层** | ASR/TTS 的 endpoint、采样率、超时、音色；客户端 VAD/打断参数 | schemastery `Config` |
| **隐私层** | 音频不落盘、日志不落原文，逐项可配置 | `lib/privacy.js` |

```
麦克风 ─┬─ 采集/编码 ──POST /voice/asr──► Host ──HTTP──► 识别服务
        │                                  │
        │                                  └─ agent.followup(文本) ──► 会话里多一条用户消息
        │
        └─ 播放 ◄──GET /voice/audio◄── Host ◄──HTTP── 朗读服务
             ▲                          ▲
             └──长轮询 GET /voice/next───┘        （会话里出现 assistant/message 时入队）
```

宿主侧只有 8 个 HTTP 路由（前缀可配，默认 `/voice`）：

| 路由 | 方向 | 说明 |
|---|---|---|
| `POST /voice/asr?sessionId=&language=` | Client → Host | 请求体是 WAV 字节；返回 `{text, injected, busy}`；`asr.enabled=false` 时直接 403、不读请求体 |
| `POST /voice/next` | Client → Host | 长轮询下一片，`{sessionId}`；有片返回 `{id,index,total}`，超时返回 204 |
| `GET /voice/audio?sessionId=&id=` | Client ← Host | 返回 `audio/wav` 字节，取走即释放 |
| `POST /voice/skip` | Client → Host | 打断：丢掉剩余音频并中止合成 |
| `POST /voice/state` | Client → Host | 上报模式：`listening=true` 持续监听 / `false` 空闲（空闲时丢弃剩余音频并移出朗读名单） |
| `GET /voice/status` | 任何人 | 状态总览，**不含任何文本和音频** |
| `GET /voice/config` | Client ← Host | 设置页读取：当前生效值、patch 里显式写了什么、可选音色 |
| `POST /voice/config` | Client → Host | 设置页保存：只重写 profile patch 里的 `- id: voice` 一段 |

音频只在内存里排队，取走即丢，`retentionSeconds` 到点丢弃——宿主从头到尾不写音频文件。

---

## 2. 安装

```powershell
# 1) 装进 web profile（转发给 pnpm）
dsh plugin add dsh-talkback --profile web

# 2) 确认它进了 profile 的 bundle 列表
dsh --profile web --dump-config | Select-String talkback
```

`dsh plugin add` 会把包装进 profile 的 `node_modules`，并在检测到 `dsh.bundle` 时把它
追加到 `dsh.profile.bundles`。如果第 2 步看不到它，手工补一行：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-talkback"] } }
}
```

然后重启 `dsh web`，打开页面。装完就能起来：bundle 自带的 `cordis.patch.yml` 会 insert
`id: voice`，没写任何配置时全部走默认值。**但音色没有默认值**，不配就只能识别、不能朗读——
第一次用先跑 `/voice doctor`，它会说清缺什么，并把填好的配置片段打出来。

### 2.1 从源码装（改代码 / 提 PR）

```powershell
git clone https://github.com/Frank-Conway/dsh-talkback.git
cd dsh-talkback
dsh plugin add link:$PWD --profile web   # 或 pnpm add link:<插件目录> + 目录联接
```

改完配置或代码后刷新页面（profile 层支持 `patchReload: live` 热重载）；
改的是宿主代码时重启 `dsh web`。

> **浏览器半边是手写的** `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 形式，
> 只 `require("react")`），没有构建步骤，改完保存即可。

### 2.2 换一台机器

三步，**地址通常一行都不用改**（默认 8000 / 9880 两个端口）：装进 profile → 加进
`dsh.profile.bundles` → 重启 `dsh web`。音色要按新机器的参考音频重新配一次。

### 2.3 兼容性

`engines.dsh` 声明为 `>=0.2.1-0 <0.3.0`，装到不兼容的 DSH 上会被插件管理器拦下
（要强行装得显式确认版本豁免）。Node 侧要求 `^22.19.0 || >=24.9.0`。

---

## 3. 配置

两个入口，改的是同一个文件：

- **设置 → 语音**（Web 客户端）：启用插件 / 朗读回复 / ASR 转录 / 预热朗读服务四个开关，
  加上 ASR/TTS 地址、音色目录与音色、静音断句；保存时只重写 `- id: voice` 这一段，
  别人的条目和你写的注释都原样留着。
- **手写** `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`，按 entry id 覆盖
  （**整块替换**，没写的项取默认值）：

```yaml
- id: voice
  name: dsh-talkback
  config:
    enabled: true
    asr:
      enabled: true
      endpoint: http://127.0.0.1:8000
    tts:
      enabled: true
      warmup: true
      voiceDir: 'C:\voices'
      voice: yunmia
```

> 音色由 `ref_info.json` 里成对的「参考音频 + 文本」决定，设置页只挑是哪一条，
> 不再手填这两项。确实想绕开目录直接指定时，仍可手写 `tts.refAudioPath` +
> `tts.promptText`（两项必须成对），页面会把它们当作「本页不管」原样保留；
> 检测到 `refAudioPath` 时，音色下拉下方会明确提示「下拉不生效」。

顶层开关 `enabled`（默认 `true`）是插件总开关：关掉后宿主不注册语音路由、不接音频也不朗读。
禁用状态下设置页仍然可用（只保留 `/voice/config` 一条路由），把「启用插件」勾回来保存即可恢复；
否则关掉插件等于把自己的配置入口一起关掉，只能去手改 YAML。

### 3.1 `transport`

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `/voice` | 路由前缀 |
| `pollWaitMs` | `25000` | 长轮询最长挂起时间 |
| `allowRemote` | `false` | web 服务绑到非回环地址时默认**拒绝启用**（音频会进局域网），确实需要才打开 |

### 3.2 `asr`

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否请求识别服务；关掉后客户端不采集麦克风，只保留朗读（`/voice/asr` 返回 403） |
| `endpoint` | `http://127.0.0.1:8000` | 识别服务地址 |
| `apiKey` | 空 | 请求头 `X-API-Key` |
| `language` | `zh` | `auto` 交给服务端检测；`yue` 按中文送 |
| `format` | `wav` | 上传容器格式（客户端按它编码） |
| `sampleRate` | `16000` | 客户端编码采样率 |
| `timeoutMs` | `120000` | 单次识别超时 |
| `mode` | `sync` | `sync` 一步到位；`async` 上传后轮询（长录音） |
| `pollIntervalMs` | `1000` | 异步轮询间隔 |
| `beamSize` / `vadFilter` / `wordTimestamps` / `priority` / `initialPrompt` | `5` / `true` / `false` / `normal` / 空 | 透传给接口 |

> 识别服务的接口是一问一答（`/sync` 或提交任务后轮询），**没有流式端点**，所以插件里没有流式开关。

### 3.3 `tts`

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否朗读回复 |
| `endpoint` | `http://127.0.0.1:9880` | 朗读服务地址 |
| `format` / `sampleRate` | `wav` / `32000` | 期望的输出格式（日志与校验用） |
| `timeoutMs` | `600000` | 单次合成超时（首次推理要 ~20s） |
| `t2sWeightsPath` / `vitsWeightsPath` | 空 | 按**服务端工作目录**解析；留空表示不改动服务端权重 |
| `refAudioPath` + `promptText` | 空 | 直接指定音色（参考音频 3~10 秒，文本逐字一致）；**仅手写 YAML**，设置页不提供 |
| `voiceDir` + `voice` | 空 | 音色目录（递归 ≤3 层找 `ref_info.json`）+ 选哪条 |
| `textLang` / `promptLang` | `zh` / `zh` | 合成文本与参考文本语种 |
| `speed` | `1` | 0.5~2，1.0 时不下发 |
| `temperature` / `topK` / `topP` / `repetitionPenalty` | `0.5` / `10` / `0.6` / `1.5` | 采样参数 |
| `textSplitMethod` | `cut3` | 首轮切分方式；重试自动换 `cut0`/`cut5` |
| `maxCharsPerChunk` / `maxSpeakChars` | `40` / `1200` | 每片字数上限 / 单条回复最多念多少字 |
| `firstChunkChars` | `14` | 首片再切到不超过这么多字，让第一声早点出来（TTS 单次有 ~3s 固定开销；`0` = 不切） |
| `warmup` | `true` | 启用后预热一次（切权重 + 合成一句），把首次推理建 CUDA Graph 的 ~20s 提前付掉 |
| `maxRetries` | `3` | 每片最多尝试几次（含首次） |
| `minVoicedRatio` / `maxInternalSilence` / `maxTrailingSilence` | `0.45` / `2.5` / `1.5` | 成片校验阈值 |
| `speakSubagentSessions` | `false` | 是否也念子代理会话 |
| `maxQueueChunks` / `retentionSeconds` | `40` / `120` | 队列上限 / 音频在内存里的保留时间 |

### 3.4 `client`（浏览器侧）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxUtteranceMs` / `minUtteranceMs` | `20000` / `400` | 一句话最长 / 最短时长，超时强制断句 |
| `silenceMs` | `900` | 静音多久算说完 |
| `vadThreshold` | `0.02` | 起录能量阈值（RMS），实际阈值还会随本底噪声自适应 |
| `prerollMs` | `600` | 起录/打断时往前保留多少毫秒音频，避免切掉第一个字的起振（`0` = 不留） |
| `onsetMs` | `150` | 连续有声多少毫秒才算开口，挡掉键盘、关门这类一声响 |
| `noiseGate` | `true` | 噪音闸门：整段电平过于平稳（空调、风扇、嗡声）就本地丢弃，不送 ASR |
| `minVoicedRatio` | `0.1` | 闸门：有声帧占比低于此值算「没在说话」 |
| `levelVariance` | `0.15` | 闸门：有声帧电平的变异系数低于此值算稳态噪音（人说话通常 0.3 以上） |
| `bargeIn` / `bargeInThreshold` / `bargeInMs` | `true` / `0.06` / `450` | 播报中检测到人声多久算打断 |
| `playbackGain` | `1` | 播放音量 |
| `echoCancellation` / `noiseSuppression` / `autoGainControl` | `true` | 麦克风约束；外放时回声消除必须开，否则会自己打断自己 |

这些值由宿主在渲染 `index.html` 时注入成 `globalThis.__DSH_VOICE__`，所以客户端不需要额外请求。
同一个全局里还带 `packageName` / `packageVersion`：浏览器模块 id 必须等于包名，而浏览器
读不到 `package.json`，只能由宿主带过去。

### 3.5 `privacy`

| 字段 | 默认 | 说明 |
|---|---|---|
| `logText` | `false` | 日志记录完整文本（默认只记「N 字，内容不记录」） |
| `logAudio` | `false` | 日志记录音频时长（默认只记字节数） |
| `retentionSeconds` | `120` | 音频在内存里的保留时间，到点丢弃 |

无论开关如何：**音频永远不落盘**，宿主只把它当内存里的 Buffer。

### 3.6 接口契约

插件只认契约：字段名按服务端原样透传，不做名字映射；换别的服务端就得保证这些路径与字段对得上。

完整契约见 [docs/API.md](docs/API.md)：两个服务的全部端点与字段、状态码映射、成片校验门槛与重试档位、
退化行为的成因、音色目录规则、插件自身路由，以及一份「换服务端时的验收清单」。

一句话版本：识别服务认 `POST /api/v1/transcriptions/sync`（multipart `file`，可选 `X-API-Key`）与
异步的 upload + 轮询；朗读服务认 `POST /tts` 和两个 `set_*_weights`；自检用 `GET /healthz`（识别）
与 `GET /openapi.json`（朗读）探测连通性。

---

## 4. 用法

输入框旁的语音按钮就是两档模式的开关，点一下切一档：

| 模式 | 按钮显示 | 行为 |
|---|---|---|
| **持续监听** | 麦克风图标（无斜线，容器亮蓝） | 打开麦克风，说完自动断句、识别、作为消息发出；助手回复自动朗读；播报中你一开口就打断。一轮结束后回到监听，可以一直说下去。 |
| **空闲** | 麦克风图标带斜线 | 不监听、不采集、不朗读：关掉麦克风与音频图、停播、清空队列；宿主同时把本会话移出朗读名单。 |

默认是**空闲**：打开页面、刷新、切换会话都不会自己开麦克风（切换会话会主动回到空闲）。
要连续对话就点成「持续监听」；开会、打字、不想被听时点回「空闲」即可，不用刷新页面。
如果开麦被浏览器拒绝，按钮会停在红色错误态并显示原因，再点一下就是重试。

1. 打开一个会话，点语音按钮进入「持续监听」→ 允许麦克风。
2. 直接说话，停下来 ~0.9 秒自动断句、识别、作为你的消息发出去（不用按第二次）。
   起录会往前带 600ms 预录，第一个字不会被切；稳态噪音（空调、风扇）会被识别成「环境太吵，已忽略」，
   不会当成你说的话发出去。
3. 助手开始回复，宿主边合成边把音频推给浏览器播放；**你插话就打断**（阈值见 `bargeInThreshold`）。
   打断是从你开口那一刻开始录的，450ms 的判定时间靠预录补回来，不会只收到半截句子。
4. 点回「空闲」停止监听与朗读；再点回「持续监听」继续。

命令（在输入框里直接发）：

| 命令 | 作用 |
|---|---|
| `/voice` / `/voice status` | 本会话语音状态、队列长度、两端地址 |
| `/voice on` / `/voice off` | 让本会话朗读 / 不朗读（`off` 同时停播） |
| `/voice stop` | 立刻停播并丢弃剩余音频 |
| `/voice say 你好` | 不经过 ASR，直接让宿主念一段（排查 TTS 用） |
| `/voice doctor` | 一次体检：服务连通、接口契约、音色、参考音频、真合成一句；并把可粘贴的配置片段打出来 |

### 4.1 设置页

**设置 → 语音**，页面上有 9 项：四个开关（启用插件、朗读回复、ASR 转录、预热朗读服务），
加上 ASR 地址、TTS 地址、音色目录、音色（下拉来自扫描结果）、静音断句（毫秒）。保存 → 宿主热重载 patch →
刷新页面生效；profile 没开 `patchReload: live` 时要重启 `dsh web`。

- 总开关 `enabled` 关掉后，麦克风按钮和朗读一起下线，但**本页仍然能读能写**（禁用时宿主
  只保留 `/voice/config` 一条路由），勾回来保存即可恢复
- 朗读开关 `tts.enabled` 关掉后不再合成音频：麦克风与语音输入照常，只是没有声音
- 识别开关 `asr.enabled` 关掉后**不申请麦克风、也不上传音频**，语音按钮只做朗读
  （按钮上会说明「语音输入已关闭，仅朗读」）；宿主侧的 `/voice/asr` 同时返回 403 兜底
- 预热开关 `tts.warmup` 控制预热：关掉后启动 3 秒后那次和切到「持续监听」时那次都会跳过，
  首次朗读重新付那 ~20 秒
- 音色只有「目录 + 下拉」一个入口：选中哪条 `ref_info.json`，它的参考音频与文本就整对生效，
  不存在只改一半、音色漂掉的可能（页面不再提供参考音频 / 参考文本两个输入框）
- 手写的 `tts.refAudioPath` / `tts.promptText` 仍然生效（优先于音色目录），页面不改也不删：
  检测到这一项时，音色下拉下方会显示一条黄色提示，写明「当前音色由手写配置指定、下拉不生效」
  以及对应的文件路径，并告诉你删掉哪两行才能让下拉接管
- 只重写 `- id: voice` 这一段，其余条目和你写的注释原样保留（行级修改，不做 YAML round-trip）
- `asr.apiKey` 这类字段不在页面上出现，也不会被覆盖，页面上会标出「这些字段本页不管，原样保留」
- 页面是只读-改-写的薄壳，没有引入任何前端依赖；DSH 的设置分区靠 `settings.section` slot 注册

---

## 5. 自测与干跑

```powershell
node test/run.mjs          # 328 项断言：纯函数 / ASR 客户端 / 分发中心 / 宿主路由 / profile 发现 / 自检 / 配置写回 / 客户端 bundle 与 VAD / 清单一致性
node test/mock-services.mjs --amplitude 0.25   # 在真实端口起假 ASR+TTS
```

干跑时：点麦克风说话 → 会话里出现「（模拟识别结果…）」；助手回复会被念成一段正弦音。
这能证明 DSH 这一侧全通，剩下只是把 `endpoint` 指向真实服务。日志在 `dsh web` 的终端窗口里。

CI 在 Node 22 与 24 上跑同一套测试（见 [.github/workflows/ci.yml](.github/workflows/ci.yml)）。

---

## 6. 排查

| 现象 | 看这里 |
|---|---|
| 不知道缺什么、配什么 | 先发 **`/voice doctor`**：连通性、契约、音色、参考音频、真合成一次全查，并打印可粘贴的配置片段 |
| 输入框的语音按钮显示「空闲」 | 这是默认模式：不监听也不朗读。点一下切到「持续监听」才会开麦 |
| 想让它停下来 / 不想被听 | 点语音按钮切回「空闲」：麦克风、播放、队列和宿主的朗读名单一起停 |
| 输入框没有「语音」按钮 | 刷新页面；`Invoke-RestMethod http://127.0.0.1:3080/voice/status` 有没有响应 |
| 按钮是灰的（宿主插件没启用） | 页面拿不到 `__DSH_VOICE__`：插件没在 profile 的 bundles 里，或路由被 `allowRemote` 拒绝 |
| 点了没反应 / 报权限 | 浏览器麦克风权限；必须 `localhost` 或 https |
| 识别报「连不上识别服务」 | 服务没起或 `asr.endpoint` 不对；`curl http://127.0.0.1:8000/healthz` |
| 识别报「鉴权失败」 | 服务端配了 `ASR_API_KEYS`，插件里 `asr.apiKey` 要一致 |
| 一句话被切成两条 | 停顿超过了 `silenceMs`；调大到 1200~1500 |
| 开头一两个字听不到 | `prerollMs` 调大到 800~1000（默认 600 已覆盖一般起振） |
| 一直提示「环境太吵，已忽略」 | 本底噪声被判成稳态噪音：把 `levelVariance` 调到 0.1 上下，或 `noiseGate: false` 关掉闸门 |
| 咳嗽/键盘声也会触发 | 调大 `onsetMs`（200~300），或调高 `vadThreshold` |
| 环境噪音老是触发 | 调高 `vadThreshold`（0.03~0.06） |
| 播报时自己被打断 | 外放就开 `echoCancellation`，并把 `bargeInThreshold` 调到 0.1 以上 |
| 不朗读 | `/voice status` 看本会话是否开着；`tts.enabled`、音色是否配好 |
| 声音是半句/电流 | 日志里找「未达标」；换音色、降 `temperature`、缩短 `maxCharsPerChunk` |
| 第一次回复特别慢（~20 秒） | 朗读服务首次推理要建 CUDA Graph。插件启动 3 秒后、以及你切到「持续监听」时会各预热一次；若日志里有「TTS 预热失败」，说明当时服务没起来，那次的 20 秒会落在第一句上 |

---

## 7. 已知限制

- 浏览器里的部分（槽位渲染、VAD 手感、设置页的观感）没有自动化测试：`test/run.mjs` 覆盖到
  「bundle 能加载、两个槽位都注册、表单值 ↔ 提交体转换、编码与重采样正确、
  预录/起录确认/打断/噪音闸门的状态机行为」为止，真机手感还得点。
- 设置页只覆盖 9 个字段；`vadThreshold`、`bargeInMs`、`levelVariance` 这类手感旋钮仍在 YAML 里调。
  写回是行级手术：只认扁平的 `section.key: value`，更深的嵌套会被原样保留但页面不认。
- 配置改动要靠宿主重载 patch 生效（`patchReload: live`）；没开这个的 profile 需要重启 `dsh web`。
- 播放发生在**打开页面的那个浏览器**里。换成手机打开同一个 GUI，声音就出在手机上。
- 打断依赖浏览器回声消除；专业麦克风/大音量外放时可能需要手工调阈值。
- 只实现了「一问一答」的接口契约：识别服务没有流式端点；TTS 侧要拿到整段音频才能做
  成片校验与重试，所以首片流式（`streaming_mode`）还没接。现在首声的等待 ≈ 首片合成
  （≈3s 固定开销 + 0.08s/字，首片已压到 `firstChunkChars` 字）+ 整条回复的生成时间；
  想再快就得让 TTS 边生成边播，代价是首句放弃成片校验。
- 没有多用户隔离：DSH 是单人本机工具，路由按 `sessionId` 分队列，但没有鉴权。

---

## 8. 隐私与数据流

一句话：**麦克风音频只在你自己的机器上流动，不落盘、不出网**（除非你把 `endpoint` 指到远端）。

- 浏览器采集 → 上传到**同源**的 `/voice/*`（只接受回环地址；`transport.allowRemote=false` 时
  绑到网卡会直接拒绝启用）→ 宿主转发给你配的识别服务。
- 识别结果作为用户消息注入会话，此后它就是普通会话内容，受 DSH 自己的会话存储与保留策略管。
- 朗读音频是宿主内存里的 Buffer，客户端取走即释放，`retentionSeconds` 到点丢弃。
- 日志默认只记长度与字节数（`privacy.logText` / `logAudio`），不记原文与音频内容。
- 插件不发遥测、不带任何第三方 SDK；运行时依赖只有 DSH 自带的
  `@deepseek-ai/schemastery`（配置 schema），其余全是 Node 内置模块。

发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

---

## 9. 开发与贡献

```powershell
node test/run.mjs     # 全量自测（无需模型、无需网络）
node test/mock-services.mjs --amplitude 0.25   # 假 ASR/TTS，端到端干跑
```

- 目录：`lib/asr.js` 识别客户端、`lib/tts.js` + `lib/quality.js` 合成与成片校验、`lib/split.js`
  分句、`lib/hub.js` 队列与打断、`lib/voices.js` 音色目录、`lib/config-writer.js` 行级配置写回、
  `lib/doctor.js` 自检、`lib/client.js` 浏览器半边、`lib/name.js` 包名单一来源。
- 改包名只需动 `package.json` 里的 `name` + `lib/client.js` 的回落字面量；其余位置都从
  `lib/name.js` 读，`node test/run.mjs` 的清单一致性断言会在漏改时报错。
- 提交前请跑 `node test/run.mjs`；行为改动请补断言，不要只改实现。
- 改动范围建议小而聚焦：一个 PR 一件事，附上「为什么」而不是只写「改了什么」。

发布流程（维护者）：

```powershell
# 1) 版本号 + CHANGELOG，提交并打 tag
npm version patch            # 或 minor / major
git push --follow-tags

# 2) 发布到 npm（建议走 GitHub Actions 的 OIDC 可信发布，见 .github/workflows/release.yml）
npm publish

# 3) 验证别人能装
dsh plugin add dsh-talkback --profile web
```

---

## 10. 许可证

[MIT](./LICENSE) © 2026 kim