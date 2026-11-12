/**
 * 插件自己的名字，只有一个来源：随包一起发布的 package.json。
 *
 * 宿主侧要按包名去 profile 里找自己（bundles / dependencies），
 * 写回 patch 时要补 `name:` 行，日志里也要能看出是谁在说话——
 * 这些以前各写各的字面量，包名一改就漏。这里统一读一次。
 *
 * 浏览器半边读不到这个文件（`lib/client.js` 是手写模块，没有构建步骤），
 * 所以宿主会把自己的包名塞进 `globalThis.__DSH_VOICE__.packageName` 带过去。
 */

import { readFileSync } from 'node:fs'

/** npm 一定随包发布 package.json，所以从它读是最可靠的。 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 包名，也是客户端模块 id 与设置分区 id。 */
export const PACKAGE_NAME = manifest.name

/** 包版本，用于日志与 `/voice status`。 */
export const PACKAGE_VERSION = manifest.version
