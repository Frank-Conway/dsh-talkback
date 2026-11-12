/**
 * 找到「装了这个插件的 profile」以及它的 patch 文件。
 *
 * 只为了让提示能指向真实路径（别人第一次装完，最常问的就是「配置写在哪」）。
 * 解析规则与 `@deepseek-ai/dsh-home-paths` 一致：`$DSH_HOME` 优先，否则 `~/.dsh`；
 * 但本插件不依赖那个包（它是库不是插件，第三方 profile 里通常取不到）。
 */

import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_NAME } from './name.js'

/**
 * 解析 DSH 主目录。
 * @param {Record<string, string | undefined>} [env] 环境变量（测试注入）。
 * @returns {string} 主目录绝对路径。
 */
export function dshHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim()
  return configured || path.join(os.homedir(), '.dsh')
}

/**
 * 把绝对路径缩成 `~` 开头的显示形式，提示里不泄露完整用户名。
 * @param {string} target 绝对路径。
 * @param {string} [home] 用户主目录。
 * @returns {string} 可显示路径。
 */
export function tildePath(target, home = os.homedir()) {
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`
  return target.startsWith(prefix) ? `~${path.sep}${target.slice(prefix.length)}` : target
}

/**
 * 扫出所有声明了本插件的 profile。
 * @param {{ home?: string }} [options] 主目录覆盖。
 * @returns {Promise<Array<{ name: string, dir: string, patchFile: string, patched: boolean }>>} profile 列表。
 */
export async function findVoiceProfiles(options = {}) {
  const root = path.join(options.home ?? dshHome(), 'profiles')
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    const dependencies = manifest?.dependencies ?? {}
    if (!bundles.includes(PACKAGE_NAME) && !Object.hasOwn(dependencies, PACKAGE_NAME)) continue
    const patchFile = path.join(dir, 'cordis.patch.yml')
    found.push({ name: entry.name, dir, patchFile, patched: await hasVoiceEntry(patchFile) })
  }
  return found
}

/**
 * patch 文件里是否已经有 `- id: voice` 这一条。
 * @param {string} patchFile patch 文件路径。
 * @returns {Promise<boolean>} 有没有。
 */
export async function hasVoiceEntry(patchFile) {
  try {
    return /^-\s*id:\s*voice\b/m.test(await readFile(patchFile, 'utf8'))
  } catch {
    return false
  }
}