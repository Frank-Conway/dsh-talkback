# 贡献指南

欢迎 issue 和 PR。这个插件的目标是「把 DSH 与本机语音服务之间的那一层做扎实」，
所以最有价值的贡献通常是**让某个失败场景变得可诊断**，而不是加更多开关。

## 开发环境

- Node `^22.19.0 || >=24.9.0`（与 DSH 运行时一致）
- 一个能跑 `dsh web` 的 DSH（`0.2.1-0 <0.3.0`）
- 不需要模型、不需要 GPU、不需要网络：`node test/run.mjs` 全部用替身服务

```powershell
git clone https://github.com/Frank-Conway/dsh-talkback.git
cd dsh-talkback
node test/run.mjs                                  # 全量自测
node test/mock-services.mjs --amplitude 0.25       # 假 ASR/TTS，端到端干跑
```

把源码装进 profile（改完刷新页面，宿主代码改动要重启 `dsh web`）：

```powershell
dsh plugin add link:$PWD --profile web
```

## 提交前

1. `node test/run.mjs` 必须全绿。
2. 行为改动要补断言。测试是这次重构的安全网：包名、契约字段、VAD 状态机、配置写回都有断言。
3. 一个 PR 一件事。重构与行为改动分开提，review 会快很多。
4. 提交信息写「为什么」，不要只写「改了什么」。

## 改包名

包名只有一个来源：`lib/name.js` 读 `package.json` 的 `name`。仍然需要手改的只有：

- `package.json` 的 `name`
- `lib/client.js` 里 `PACKAGE_NAME` 的回落字面量（浏览器读不到 `package.json`）

漏改会被 `test/run.mjs` 的「清单一致性」断言抓住（bundle patch、客户端回落、name.js 三处比对）。

## 代码风格

- 纯 ESM，无构建步骤；浏览器半边是手写的 CJS 风格模块，只 `require('react')`。
- 注释解释**为什么**（尤其是反直觉的阈值与退化处理），不复述代码。
- 不引第三方运行时依赖：`dependencies` 里只有 DSH 自带的 `@deepseek-ai/schemastery`
  （配置 schema），其余只用 Node 内置模块。新增依赖请在 PR 里说明理由。
- 涉及隐私的改动（日志、落盘、外发请求）请在 PR 里单独说明。

## 报告问题

用 issue 模板填「现象 / 复现 / 期望 / `/voice doctor` 输出 / 相关日志」。
日志里默认不含文本原文与音频内容，可以直接贴；如果你打开过 `privacy.logText`，贴之前先脱敏。