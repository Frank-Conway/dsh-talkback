# 两端接口契约

插件只认契约，不认对面跑的是什么实现：下面这些路径、字段、状态码，就是它全部的外部依赖。
字段名按服务端契约**原样透传**，中间不做名字映射——换一个服务端，只要这份契约对得上，插件就照常工作。

三个参与者：

```
浏览器（采集 / 播放）  ⇄  宿主插件（/voice/*）  ⇄  识别服务 + 朗读服务（本机 HTTP）
```

本机默认地址：识别服务 `http://127.0.0.1:8000`，朗读服务 `http://127.0.0.1:9880`。

> 只列本插件实际依赖的部分；服务端自身的启动、权重清单、实测记录等不在本文范围。

---

## 识别服务

| 项 | 说明 |
|---|---|
| 协议 | HTTP/1.1 + JSON / multipart |
| 鉴权 | 所有业务接口都要 `X-API-Key`（服务端留空则关闭鉴权）；**轮询任务同样要带** |
| 提交方式 | 上传文件（multipart）或提交音频 URL（JSON，本插件不用） |
| 返回方式 | 同步（阻塞拿结果）或异步（拿 `task_id` 再轮询） |
| 音频上限 | 同步接口 ≤ 60s（`ASR_SYNC_MAX_SECONDS`）；文件上限默认 500MB |

本插件两种都实现了，由 `asr.mode` 选：`sync`（默认，交互式短音频）/ `async`。

### 同步转写

```
POST /api/v1/transcriptions/sync?language=&beam_size=&vad_filter=&word_timestamps=&initial_prompt=
Content-Type: multipart/form-data   （只有 file 是表单字段，其余全是查询参数）
```

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `file` | 表单 | — | 音频文件；文件名 `speech.wav`，`Content-Type: audio/wav` |
| `language` | 查询 | `zh` | 语言代码；**留空 = 交给服务端检测**（插件在 `auto` 时直接不下发） |
| `beam_size` | 查询 | `5` | 束搜索宽度 |
| `vad_filter` | 查询 | `true` | 静音过滤 |
| `word_timestamps` | 查询 | `true` | 插件只在开启时才下发，默认不下发 |
| `initial_prompt` | 查询 | 无 | 专有名词提示；配了才下发 |

`200` 返回任务对象（见下节），文本在 `result.text`。超过 60s 返回 `422`，服务端处理不过来返回 `504`。

### 异步转写

```
POST /api/v1/transcriptions/upload?language=&beam_size=&vad_filter=&priority=&initial_prompt=
→ 202 {"task_id": "...", "status": "pending", "priority": "normal"}

GET /api/v1/transcriptions/{task_id}
→ {"task_id": "...", "status": "pending|processing|completed|failed", "result": {...}, "error": null}
```

- 状态机：`pending → processing → completed`，失败转 `failed`（可 retry）。
- 插件按 `asr.pollIntervalMs`（默认 1000ms）轮询，只在 `completed` / `failed` 停止。
- 没返回 `task_id` 视为契约违约，插件直接报「无法轮询」。
- 任务结果有保留期，过期查询返回 `404`——所以 `404` 既可能是路径写错，也可能是任务已过期。

### 识别结果的形状

```json
{
  "task_id": "8f3c...",
  "status": "completed",
  "result": { "text": "今天天气很好。", "language": "zh", "duration": 5.0, "segments": [...] }
}
```

插件只读 `result.text`（`segments` / `words` 带了也不解析）：

- `status=failed` → 取 `error` 报错；
- `status` 非 `completed` → 报「任务未完成」；
- `completed` 但 `text` 为空 → 报「没识别出文字（可能是录音太短或全是噪音）」，不当作空消息注入。

### 状态码映射

| 状态 | 插件给出的意思 |
|---|---|
| `401` / `403` | 鉴权失败，检查 `asr.apiKey` 与服务端 `ASR_API_KEYS` 是否一致 |
| `404` | 没有这个接口（或任务过期），确认 `asr.endpoint` 指向服务根地址 |
| `413` | 录音超出服务端大小上限，调小 `asr.maxUtteranceMs` |
| `422` | 服务端拒绝了这次参数（也有可能是同步接口的 60s 上限） |
| `504` | 服务端处理超时，录音太长或机器太忙 |

---

## 朗读服务

| 端点 | 用途 | 插件是否使用 |
|---|---|---|
| `POST /tts` | 合成，JSON 请求体 | ✅ 唯一合成入口 |
| `GET /set_gpt_weights` | 切换 T2S 权重 | ✅ 首次合成前 |
| `GET /set_sovits_weights` | 切换声码器权重 | ✅ 首次合成前 |
| `GET /openapi.json` | FastAPI 自描述 | ✅ 自检里当连通性探测 |
| `GET /docs`、`GET /tts`（查询串版）、`GET /control` 等 | 人工排错 | ✖ |

**没有「列出音色」的端点**：服务端只认识「权重 + 参考音频 + 参考文本」，音色清单只能靠扫盘，见[音色目录](#音色目录)。

### 合成请求

```
POST /tts
Content-Type: application/json
```

| 字段 | 插件下发 | 说明 |
|---|---|---|
| `text` | 片段文本 | 必填；调用方已切成短句（见[退化成片](#退化成片)） |
| `text_lang` | `tts.textLang`（默认 `zh`） | 必填 |
| `ref_audio_path` | 音色的参考音频绝对路径 | 必填；**时长必须 3~10 秒**（服务端按 16kHz 折算成 48000~160000 样本硬校验） |
| `prompt_text` | 该音频的逐字文本 | 必须一字不差，否则音色漂移 |
| `prompt_lang` | `tts.promptLang`（默认 `zh`） | 必填 |
| `top_k` / `top_p` / `temperature` / `repetition_penalty` | `10` / `0.6` / `0.5` / `1.5` | 可配；这套值是压住退化的关键，见[退化成片](#退化成片) |
| `text_split_method` | `cut3` | `cut0` 不切 / `cut1` 四句一合 / `cut2` 50 字一合 / `cut3` 中文句号 / `cut4` 英文句号 / `cut5` 标点 |
| `media_type` | `wav` | 固定 wav，因为要做成片校验 |
| `streaming_mode` | `false` | **固定整段合成**：流式返回的是「WAV 头 + 裸 PCM」，没法做静音裁剪与校验 |
| `speed_factor` | 仅当语速 ≠ 1.0 | 收窄到 0.5~2.0；语速 1.0 时**不下发**，请求体与没有这个功能时逐字节一致 |

响应：`200` + `Content-Type: audio/wav` + 整段 WAV（本机实测 32kHz 单声道 16bit）。
插件收到后先校验 `RIFF` 头：不足 44 字节或头不对，当作「返回的不是 WAV（很可能是 JSON 错误体）」。

### 错误

| 场景 | 状态 | 响应体 |
|---|---|---|
| `text` 为空 / `ref_audio_path` 为空 | 400 | `{"message": "text is required"}` |
| 语言或 `text_split_method` 不支持 | 400 | `{"message": "text_lang: xx is not supported ..."}` |
| 参考音频不在 3~10 秒 / 文件不存在 | 400 | `{"message": "tts failed", "Exception": "<真实原因>"}` |
| 字段类型错（如 `top_k` 传字符串） | 422 | FastAPI 的 `{"detail": [...]}` |
| 服务没启动 | — | 连接被拒 |

⚠️ **推理异常也是 400，不是 500**：服务端把推理过程中的异常统一包成
`400 {"message": "tts failed", "Exception": "<真实原因>"}`。所以**不能把 400 一律当成「参数写错了」**，
要看 `Exception` 内容区分——否则「参考音频长度不对」会被误报成「请求参数不合法」。

### 权重切换

```
GET /set_gpt_weights?weights_path=<.ckpt>
GET /set_sovits_weights?weights_path=<.pth>
→ 200 {"message": "success"}    失败 400 {"message": "...", "Exception": "<原因>"}
```

调用约定（踩过的坑，插件逐条照做）：

1. **两个都要切，顺序先 T2S 后声码器**。只切一个会出现底模与声码器版本不匹配。
2. **幂等但每次都是真加载**（各约 1.4s），服务端不记得你切过；插件用进程内标记保证一轮只切一次。
3. **失败不阻断合成**：只记 warning、不置「已切换」标记，下次再试——服务端可能本来就配好了权重，
   或者换了个没有这个端点的实现，这些都不该让朗读彻底不可用。
4. **服务重启后要重新切**：重启会回到服务端配置里的权重。插件遇到连接错误就清掉标记。
5. **相对路径按服务端工作目录解析**，所以从别处启动服务时要写绝对路径。

超时：权重切换 180s，合成 600s。

### 成片校验

服务端「返回 200 且有声」不等于这份成片能用，所以每片都要过一遍门槛：

| 指标 | 门槛 | 含义 |
|---|---|---|
| 有声时长 | ≥ 估算时长 × `0.45` | 估算 = `字数 / 4.5 字每秒 / 语速`，下限 0.4s |
| 句内最长静音 | ≤ `2.5s` | 话说到一半没声了 |
| 片尾静音 | ≤ `1.5s` | 尾巴拖一长段空白 |

不达标就换参数重试，最多 `tts.maxRetries` 档（默认 3，可配到 6）：

| 档 | 切分方式 | 采样参数 |
|---|---|---|
| 1 | 配置值（`cut3`） | 配置值 |
| 2 | `cut0` | 救命档位 |
| 3 | `cut5` | 救命档位 |
| 4 | `cut0` | 救命档位 |
| 5 | `cut3` | 救命档位 |
| 6 | `cut5` | 救命档位 |

- 每一档都是一次新的 HTTP 请求 = 服务端新的随机种子（`seed=-1`）。退化与种子强相关，换种子比换切分方式更有效，所以两者一起用。
- **救命档位**：温度 −0.15（下限 0.30）、重复惩罚 +0.15（上限 2.00）。只动采样，不动权重与参考音频，所以**音色不变**。
- 全都不达标时取**打分最高**的一份（以有声占比为主，静音扣分），而**不是取最短**——见下一节。

### 退化成片

这是最需要防御的服务端行为，属于接口的**现实语义**，不是调用方 bug：

- 现象：偶发不吐 EOS，一路生成到长度上限。WAV 头里写着 20 多秒，其实只有前 2~3 秒是人声，其余全是静音。
- 诱因：与随机种子强相关（同文本同参数，有时正常有时退化）；**文本越长越容易触发**；`top_p` 偏高时更明显。
- 后果：按 WAV 头时长判断会得到「念了 26 秒」的错觉；而**取最短**恰好会挑中「只说了半句」的那次——退化片头长、真人有声短。

所以插件做两件事：**只按有声时长判断成片是否可用**；分句时把片段压到不超过 `tts.maxCharsPerChunk`（默认 40 字），长文本不整段送。

## 音色目录

音色 = 权重（见[权重切换](#权重切换)）+ 参考音频 + 该音频的文本。三项任一不匹配都会漂移，
所以插件把「音频 + 文本」当**一整对**处理：设置页只让用户选一条 `ref_info.json`，
选中哪条，那一对就整对生效，不提供只改一半的入口。

> 手写 YAML 时仍可直接指定 `tts.refAudioPath` + `tts.promptText`（两项必须成对，
> 且优先于音色目录）；这两项不在设置页上，页面保存时原样保留、不会覆盖或删除。
> 一旦检测到手写 `refAudioPath`，设置页会在音色下拉下方提示「下拉不生效」并指出
> 该删掉哪两行——这是隐式优先，不写清楚就会被误当成 bug。

下拉里的音色来自扫描 `tts.voiceDir` 下的 `ref_info.json`：

```json
{
  "voice_id": "00012",
  "voice_name": "小李",
  "text": "今天天气挺好的，我们出去走一走吧。",
  "wav": "…/voices/tencent/00012_小李/refs/r1.wav",
  "dur": 5.0
}
```

| 字段 | 扫描时是否必需 | 用途 |
|---|---|---|
| `wav` | ✅（缺失回退到同目录 `refs/r1.wav`） | 参考音频，直接作 `ref_audio_path` |
| `text` | ✅（缺失则整条跳过） | 参考文本，直接作 `prompt_text` |
| `voice_id` + `voice_name` | ✖ | 显示名 `<id> <name>`，都缺则用目录名 |
| `dur` | ✖ | 追加到显示名，如 `00012 小李（5.00s）`，方便挑 3~10s 的 |
| 其余（`sr` / `ab_text` / `ab_wav` / `provider` / `model`） | ✖ | 生成流程自己用，插件忽略 |

扫描规则：

- 只看深度 ≤3 层的 `ref_info.json`；跳过隐藏目录与 `node_modules`。
- JSON 解析失败 → 跳过这一条，不拖垮整个列表。
- **只有 wav、没有 `ref_info.json` 的目录会被跳过**——缺参考文本，硬猜一个只会让音色漂移。

---

## 健康检查

| 服务 | 探测 | 判定 |
|---|---|---|
| 识别服务 | `GET /healthz` | `200` 通；`401` 说明 Key 不对；其他状态按「版本较老」继续验契约 |
| 朗读服务 | `GET /openapi.json` | 能连上即认为服务在跑（它没有专门的存活探针） |

`/voice doctor` 用这两条做连通性检查，不看响应内容。

---

## 插件自身路由

宿主半把下面这些挂在 Web 服务上，前缀是 `transport.base`（默认 `/voice`）。浏览器半只跟它们打交道。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/voice/asr?sessionId=&language=` | 请求体是 WAV；返回 `{text, chars, inferenceSeconds, audioSeconds, ...注入结果}`；`409` 会话不在、`502` 识别失败；`asr.enabled=false` 时 **403 且不读请求体** |
| POST | `/voice/next` | 长轮询下一片，`200 {id, index, total, chars}`，没有则 `204` |
| GET | `/voice/audio?sessionId=&id=` | 取这一片的 WAV 字节；`404` 表示已过期或被取走 |
| POST | `/voice/skip` | `{sessionId, reason}`，打断当前朗读 |
| POST | `/voice/state` | `{sessionId, listening}` 两档模式：`true` = 持续监听（加入朗读名单），`false` = 空闲（移出朗读名单并丢弃剩余音频）；只带 `error` 时是客户端错误上报，**不改模式** |
| GET | `/voice/status` | 状态总览，含 `enabledSessions`、队列、`lastClientError`；**不含任何文本内容** |
| GET / POST | `/voice/config` | 设置页读取 / 写回 patch；**`enabled=false` 时只有这一条路由还在** |

启动时还会通过 index 注入一个全局 `__DSH_VOICE__`（`base` + 客户端阈值 + `asr.enabled` + 语言），浏览器半不用额外请求取配置。
路由只在 Web 服务监听回环地址时启用；监听在别的地址且没开 `transport.allowRemote` 时插件拒绝启动——语音路由会把麦克风音频暴露给整个局域网。
总开关关掉时同理：配置页路由也只在回环（或显式允许远程）时才留，免得把本机路径暴露出去。

---

## 换服务端时的验收清单

一个替代实现只要满足下面这些，插件不改一行就能跑：

- [ ] `POST /api/v1/transcriptions/sync` 收 multipart `file`，查询参数认 `language` / `beam_size` / `vad_filter` / `word_timestamps` / `initial_prompt`，返回 `{status, result: {text}}`
- [ ] （`asr.mode=async` 时）`POST /api/v1/transcriptions/upload` 返回 `task_id`，`GET /api/v1/transcriptions/{task_id}` 轮询到 `completed` / `failed`
- [ ] 鉴权头是 `X-API-Key`，且轮询也要校验
- [ ] `GET /healthz` 存在
- [ ] `POST /tts` 认 `text` / `text_lang` / `ref_audio_path` / `prompt_text` / `prompt_lang` / `top_k` / `top_p` / `temperature` / `repetition_penalty` / `text_split_method` / `media_type=wav` / `streaming_mode=false`，回整段 WAV
- [ ] 两个切权重端点存在（没有也行，见下条）；`weights_path` 走查询参数
- [ ] 切权重失败、端点不存在、400 里带 `Exception` 这些情况**不能让朗读彻底不可用**
- [ ] 参考音频落在这个长度区间内（3~10s）——这是服务端的硬校验，插件只负责传路径
