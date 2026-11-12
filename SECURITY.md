# 安全策略

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的私密漏洞报告（仓库 → Security → Report a vulnerability），
或在 issue 里只写「需要私下沟通」并留下联系方式，维护者会私信你。

请附上：DSH 版本、插件版本、复现步骤、影响范围（能否读到音频/文本/配置）。
72 小时内会收到确认；修复发布后会在 CHANGELOG 里致谢（除非你要求匿名）。

## 安全边界（本插件的设计前提）

- **只监听回环地址**：`transport.allowRemote=false`（默认）时，若 `dsh web` 绑到非回环地址，
  插件拒绝注册语音路由，避免麦克风音频进局域网。打开这个开关等于接受该风险。
- **音频不落盘**：音频只作为内存 Buffer 存在于队列里，客户端取走即释放。
- **日志默认不含内容**：`privacy.logText` / `logAudio` 默认关闭，只记长度与字节数。
- **无鉴权**：DSH 是单人本机工具，`/voice/*` 没有 token 校验；不要把它暴露到公网。
- **配置写回**：设置页只会改 profile `cordis.patch.yml` 里 `- id: voice` 这一段，并保持
  其它行原样——但请仍然把它当作敏感文件（里面可能有 `asr.apiKey`）。

## 依赖面

运行时依赖只有一个：DSH 自带的 `@deepseek-ai/schemastery`（配置 schema），没有第三方 SDK。
插件不发遥测、不加载远程脚本、不访问除你配置的 `asr.endpoint` / `tts.endpoint` 之外的网络地址。