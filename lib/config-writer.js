/**
 * 读写 profile 的 `cordis.patch.yml` 里属于本插件的那一段。
 *
 * 为什么不用 YAML 库整体反序列化再写回：patch 文件是用户的配置文件，里面全是
 * 注释和别的插件的条目，round-trip 一次就全没了。这里只做**行级外科手术**：
 * 找到 `- id: voice` 这一段，只改我们管的那几个键，其余每一行（别人的条目、
 * 用户的注释、我们不认识的字段）原样保留。
 *
 * 只认扁平的 `section.key: value` 标量与直接挂在 `config:` 下的顶层键
 * （如 `enabled: false`）；嵌套更深的写法当作「不认识的字段」保留。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { PACKAGE_NAME } from './name.js'

/**
 * 本页能读写的字段：点分路径 → 类型。其余字段一律原样保留。
 *
 * `tts.refAudioPath` / `tts.promptText` 不在其中：音色由「音色目录 + 音色」
 * 选中的 `ref_info.json` 成对给出，页面不再提供手填入口；这两项若手写在
 * patch 里会被原样保留（页面上标成「本页不管」），保存动作不会碰它们。
 *
 * `enabled` 是顶层键（不挂在 `config` 下的二级节里），写入时直接落在 `config:`
 * 这一层——总开关必须能在设置页里点回来，否则关掉之后页面自己也跟着下线了。
 */
export const MANAGED_FIELDS = {
  enabled: 'boolean',
  'asr.enabled': 'boolean',
  'asr.endpoint': 'string',
  'tts.enabled': 'boolean',
  'tts.endpoint': 'string',
  'tts.warmup': 'boolean',
  'tts.voiceDir': 'string',
  'tts.voice': 'string',
  'client.silenceMs': 'number',
}

/** 段落（`- id: voice`）出现的位置。 */
const SECTION_RE = /^-\s*id:\s*voice\s*(?:#.*)?$/
/** 下一个段落的起点（顶格的 `- `）。 */
const NEXT_ENTRY_RE = /^-\s/

/**
 * 把字符串包成 YAML 单引号标量（路径里的反斜杠不用转义，单引号要双写）。
 * @param {string} value 原值。
 * @returns {string} YAML 里的写法。
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 按类型把值渲染成 YAML 标量。
 * @param {'string' | 'number' | 'boolean'} type 类型。
 * @param {unknown} value 值。
 * @returns {string} 标量。
 */
function formatValue(type, value) {
  if (type === 'number') return String(Number(value))
  if (type === 'boolean') return value ? 'true' : 'false'
  return quote(String(value))
}

/**
 * 去掉行尾注释（只处理不在引号里的 `#`）。
 * @param {string} value 值部分。
 * @returns {{ value: string, comment: string }} 值本身与原始注释（含 `#`）。
 */
function splitComment(value) {
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === "'") quoted = !quoted
    else if (char === '#' && !quoted) {
      return { value: value.slice(0, index).trim(), comment: value.slice(index) }
    }
  }
  return { value: value.trim(), comment: '' }
}

/**
 * 去掉 YAML 标量的引号。
 * @param {string} raw 原始标量。
 * @returns {string} 去引号后的值。
 */
function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 找到 `- id: voice` 段落的行区间。
 * @param {string[]} lines 全文按行。
 * @returns {{ start: number, end: number } | null} 行区间（左闭右开）。
 */
function findSection(lines) {
  const start = lines.findIndex((line) => SECTION_RE.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (NEXT_ENTRY_RE.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/**
 * 解析段落里已显式写出的字段。
 * @param {string[]} block 段落各行。
 * @returns {Map<string, string>} 点分路径 → 原始标量（未去引号）。
 */
function parseSection(block) {
  /** @type {Map<string, string>} */
  const found = new Map()
  /** @type {{ name: string, indent: number } | null} */
  let section = null
  for (const line of block) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const [, , key, rest] = match
    const { value } = splitComment(rest)
    // 缩进回退说明已经离开上一个二级节：`enabled:` 这类顶层键不带 `config.` 前缀。
    if (section && indent <= section.indent) section = null
    if (!value) {
      // `config:` 本身不算一层；`asr:` / `tts:` 这种才是下一层的开始。
      if (key !== 'config') section = { name: key, indent }
      continue
    }
    found.set(section ? `${section.name}.${key}` : key, value)
  }
  return found
}

/**
 * 读 patch 文件里本插件那一段。
 * @param {string} file patch 文件路径。
 * @returns {Promise<{ exists: boolean, values: Record<string, string>, others: string[] }>} 是否已配置、显式值、被原样保留的字段名。
 */
export async function readVoiceSection(file) {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { exists: false, values: {}, others: [] }
  }
  const lines = text.split(/\r?\n/)
  const range = findSection(lines)
  if (!range) return { exists: false, values: {}, others: [] }
  const parsed = parseSection(lines.slice(range.start, range.end))
  /** @type {Record<string, string>} */
  const values = {}
  /** @type {string[]} */
  const others = []
  for (const [path, raw] of parsed) {
    if (Object.hasOwn(MANAGED_FIELDS, path)) values[path] = unquote(raw)
    else if (path.includes('.')) others.push(path)
  }
  return { exists: true, values, others }
}

/**
 * 把一组字段写进段落，返回新的行数组。只增删改我们管的键。
 * @param {string[]} block 段落各行。
 * @param {Record<string, string | number | undefined | null>} values 要写的字段。
 * @returns {string[]} 更新后的段落各行。
 */
/**
 * 行首缩进宽度。
 * @param {string} line 一行。
 * @returns {number} 空格数。
 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * `config:` 区块的结束下标（右开）：最后一个子行的下一行，插入新键时用。
 * @param {string[]} lines 段落各行。
 * @param {number} configIndex `config:` 行下标。
 * @param {number} configIndent `config:` 的缩进。
 * @returns {number} 插入位置。
 */
function configEnd(lines, configIndex, configIndent) {
  let end = configIndex + 1
  for (let index = configIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (indentOf(line) <= configIndent) break
    end = index + 1
  }
  return end
}

/**
 * 写一个键：有就改（保留行尾注释），没有就插到所属层级末尾，空值表示删掉。
 *
 * `path` 带点（`asr.endpoint`）表示二级节下的键；不带点（`enabled`）表示
 * 直接挂在 `config:` 下——设置页的总开关就属于后者。
 * @param {string[]} lines 段落各行（就地修改）。
 * @param {string} path 点分路径。
 * @param {'string' | 'number' | 'boolean'} type 类型。
 * @param {unknown} raw 值。
 * @param {number} configIndex `config:` 行下标。
 * @param {number} configIndent `config:` 缩进。
 * @returns {void}
 */
function writeKey(lines, path, type, raw, configIndex, configIndent) {
  const dot = path.indexOf('.')
  const sectionName = dot === -1 ? '' : path.slice(0, dot)
  const key = dot === -1 ? path : path.slice(dot + 1)
  const empty = raw === undefined || raw === null || raw === ''

  let sectionIndex = -1
  let sectionIndent = configIndent
  if (sectionName) {
    sectionIndex = lines.findIndex((line, index) => {
      if (index <= configIndex) return false
      const match = /^(\s*)([A-Za-z_][\w-]*):\s*$/.exec(line)
      return Boolean(match) && match[2] === sectionName && indentOf(line) > configIndent
    })
    if (sectionIndex === -1) {
      if (empty) return
      // 段落里还没有这一节：插在 config 区块的末尾。
      lines.splice(configEnd(lines, configIndex, configIndent), 0,
        `${' '.repeat(configIndent + 2)}${sectionName}:`,
        `${' '.repeat(configIndent + 4)}${key}: ${formatValue(type, raw)}`)
      return
    }
    sectionIndent = indentOf(lines[sectionIndex])
  }

  const keyIndent = sectionIndent + 2
  const rangeStart = sectionName ? sectionIndex : configIndex
  let keyIndex = -1
  let lastChild = rangeStart
  for (let index = rangeStart + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent <= sectionIndent) break
    lastChild = index
    const match = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (match && match[2] === key && indent === keyIndent) keyIndex = index
  }
  if (keyIndex !== -1) {
    if (empty) {
      lines.splice(keyIndex, 1)
      return
    }
    const { comment } = splitComment(/^(\s*)[\w-]+:\s*(.*)$/.exec(lines[keyIndex])?.[2] ?? '')
    lines[keyIndex] = `${' '.repeat(keyIndent)}${key}: ${formatValue(type, raw)}${comment ? ` ${comment}` : ''}`
    return
  }
  if (empty) return
  lines.splice(lastChild + 1, 0, `${' '.repeat(keyIndent)}${key}: ${formatValue(type, raw)}`)
}

/**
 * 把一组字段写进段落，返回新的行数组。只增删改我们管的键。
 * @param {string[]} block 段落各行。
 * @param {Record<string, string | number | boolean | undefined | null>} values 要写的字段。
 * @returns {string[]} 更新后的段落各行。
 */
function patchSection(block, values) {
  const lines = [...block]
  // 段落里没有 name 行时补一个，否则这条 patch 指不到插件。
  if (!lines.some((line) => /^\s*name:\s*\S/.test(line))) {
    lines.splice(1, 0, `  name: ${PACKAGE_NAME}`)
  }
  if (!lines.some((line) => /^\s*config:\s*$/.test(line))) {
    lines.push('  config:')
  }
  const configIndex = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
  const configIndent = indentOf(lines[configIndex])

  for (const [path, type] of Object.entries(MANAGED_FIELDS)) {
    if (!Object.hasOwn(values, path)) continue
    writeKey(lines, path, type, values[path], configIndex, configIndent)
  }
  return lines
}

/**
 * 写入字段：段落不存在就追加一段，存在就只改我们管的那几个键。
 * @param {string} file patch 文件路径。
 * @param {Record<string, string | number | boolean | undefined | null>} values 字段（空字符串 = 移除该键）。
 * @returns {Promise<{ file: string, created: boolean, values: Record<string, string> }>} 写入结果与最终显式值。
 */
export async function writeVoiceValues(file, values) {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const hadNewline = text.endsWith('\n')
  const lines = text === '' ? [] : text.replace(/\n$/, '').split(/\r?\n/)
  const range = findSection(lines)

  if (!range) {
    const block = patchSection([
      '- id: voice',
      `  name: ${PACKAGE_NAME}`,
      '  config:',
    ], values)
    const next = lines.length > 0 ? [...lines, '', ...block] : block
    await writeFile(file, `${next.join('\n')}\n`, 'utf8')
    return { file, created: true, values: (await readVoiceSection(file)).values }
  }

  const block = patchSection(lines.slice(range.start, range.end), values)
  const next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)]
  await writeFile(file, `${next.join('\n')}${hadNewline || next.length > 0 ? '\n' : ''}`, 'utf8')
  return { file, created: false, values: (await readVoiceSection(file)).values }
}