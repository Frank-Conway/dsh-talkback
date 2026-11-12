# 变更记录

本文件记录面向使用者的变化。提交粒度见 `git log`。

## 0.3.0 — 2026-11-12

首次公开发布（npm 包名 `dsh-talkback`）。

- **发布元数据**：补 `license`（MIT）、`repository` / `homepage` / `bugs`、`keywords`、
  `engines.dsh`（`>=0.2.1-0 <0.3.0`）、`publishConfig`，去掉 `private`，加 `prepublishOnly` 自测。
- **测试**：新增「清单一致性」断言——包名 / 版本 / bundle patch / 客户端回落字面量四处必须一致，
  改包名漏改会直接失败。断言总数 318 → 328。
- **文档**：README 重写安装章节（`dsh plugin add` 优先，源码 link 次之），补隐私与数据流、
  开发与贡献、发布流程；新增本文件、CONTRIBUTING、SECURITY、CI 与发布工作流。
- 行为无变化：路由、配置字段、两档模式、打断逻辑与 0.2.0 一致。

## 0.2.0

- 保留单个麦克风按钮，点一下在「空闲 / 持续监听」两档之间切换。
- 设置页补齐四个开关；音色只走「目录 + 下拉」成对选择。
- 补 `docs/API.md`，把散在注释里的接口契约收成一处。

## 0.1.0

- 本地语音交互的第一版：麦克风采集、能量 VAD 断句、ASR 注入、TTS 朗读、打断、`/voice` 命令、
  `/voice doctor` 自检、配置写回。