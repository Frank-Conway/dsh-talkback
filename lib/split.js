/**
 * 把「给眼睛看的 Markdown」变成「给耳朵听的句子」。
 *
 * 朗读链路里，文本要先过两道处理：
 * 1. 清理 —— 代码块、表格、链接地址、列表符号这些念出来只会是噪音；
 * 2. 分句 —— 朗读服务单次请求太长容易退化（见 docs/API.md 的「退化成片」），所以按标点切成
 *    不超过 maxChars 的片段，逐片合成。
 */

/** 句末标点：中文全角与英文半角都算。 */
const SENTENCE_END = /[。！？!?；;…\n]/
/** 句内可切分标点，用于超长句的二次切分。 */
const CLAUSE_END = /[，、,：:]/

/**
 * 清理 Markdown，只留适合朗读的文字。
 * @param {string} text 原始 Markdown / 纯文本。
 * @param {{ codeBlocks?: boolean, markdown?: boolean }} [options] 是否丢弃代码块（默认丢弃）、是否清理 Markdown 记法（默认清理）。
 * @returns {string} 适合朗读的纯文本。
 */
export function stripForSpeech(text, options = {}) {
  const dropCode = options.codeBlocks ?? true
  const tidyMarkdown = options.markdown ?? true
  let out = String(text ?? '')

  if (dropCode) {
    // 围栏代码块整段丢弃，并在原位置留一个停顿标记，避免上下句黏在一起。
    out = out.replace(/```[\s\S]*?```/g, '\n')
    out = out.replace(/~~~[\s\S]*?~~~/g, '\n')
  }

  if (!tidyMarkdown) return out.replace(/[ \t]+/g, ' ').trim()

  out = out
    .replace(/<!--[\s\S]*?-->/g, '') // HTML 注释
    // 图片整段丢弃，链接只保留文字部分
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 表格：整行丢弃（表头与分隔线念出来无意义）
    .replace(/^\s*\|.*\|\s*$/gm, '')
    // 行首标题、引用、列表符号
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,4}\d+[.)]\s+/gm, '')
    // 分隔线
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    // 行内代码与强调
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)([^*_]+)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 裸链接与 HTML 标签
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    // 零宽字符
    .replace(/[\u200b-\u200f\ufeff]/g, '')

  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 按句读把文本切成若干朗读片段。
 * @param {string} text 已清理的纯文本。
 * @param {number} [maxChars] 单片段最大字数（含标点）。
 * @returns {string[]} 片段列表，已去掉空白项。
 */
export function splitForSpeech(text, maxChars = 40) {
  const limit = Math.max(8, Math.floor(maxChars))
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  /** @type {string[]} */
  const sentences = []
  let current = ''
  for (const char of normalized) {
    current += char
    if (SENTENCE_END.test(char)) {
      sentences.push(current)
      current = ''
    }
  }
  if (current.trim()) sentences.push(current)

  /** @type {string[]} */
  const chunks = []
  let buffer = ''
  const flush = () => {
    const value = buffer.trim()
    if (value) chunks.push(value)
    buffer = ''
  }

  for (const sentence of sentences) {
    const piece = sentence.trim()
    if (!piece) continue
    if (piece.length <= limit && buffer.length + piece.length <= limit) {
      buffer += piece
      continue
    }
    flush()
    if (piece.length <= limit) {
      buffer = piece
      continue
    }
    // 超长句：先按逗号顿号切，再对仍然超长的片段硬切。
    for (const clause of splitBy(piece, CLAUSE_END)) {
      const value = clause.trim()
      if (!value) continue
      if (value.length <= limit) {
        chunks.push(value)
        continue
      }
      for (let start = 0; start < value.length; start += limit) {
        const slice = value.slice(start, start + limit).trim()
        if (slice) chunks.push(slice)
      }
    }
  }
  flush()
  return chunks
}

/**
 * 把首片再切短：TTS 单次请求有约 3 秒的固定开销（与字数关系不大），
 * 所以「第一声」主要由首片字数决定。首片压到十几个字，出声能早两秒多；
 * 后面各片仍按 maxChars 切，总请求数不会变多。
 *
 * 优先在逗号/顿号/冒号处断开；没有标点就找最近的空格（英文）；都没有才硬切。
 * @param {string} text 一整片文本。
 * @param {number} limit 首片字数上限；<=0 表示不额外切。
 * @returns {string[]} 切分结果：1 段表示没切，2 段表示 [首片段, 剩下的]。
 */
export function splitFirstChunk(text, limit) {
  const value = String(text ?? '').trim()
  const cap = Math.floor(Number(limit) || 0)
  if (!value || cap <= 0 || value.length <= cap) return value ? [value] : []

  // 切得太碎（只剩一两个字）不如不切，让 TTS 多念半句。
  const shortest = Math.max(2, Math.floor(cap * 0.4))
  let cut = -1
  for (let index = 0; index < Math.min(cap, value.length); index += 1) {
    if (CLAUSE_END.test(value[index])) cut = index + 1
  }
  if (cut < shortest) {
    const space = value.lastIndexOf(' ', Math.min(cap, value.length - 1))
    cut = space >= shortest ? space + 1 : -1
  }
  if (cut < 0) cut = Math.min(cap, value.length)

  const head = value.slice(0, cut).trim()
  const tail = value.slice(cut).trim()
  if (!head) return [value]
  return tail ? [head, tail] : [head]
}

/**
 * 按给定标点集合切分，标点留在前一段末尾。
 * @param {string} text 待切分文本。
 * @param {RegExp} pattern 单字符标点集合。
 * @returns {string[]} 切分结果。
 */
function splitBy(text, pattern) {
  /** @type {string[]} */
  const parts = []
  let current = ''
  for (const char of text) {
    current += char
    if (pattern.test(char)) {
      parts.push(current)
      current = ''
    }
  }
  if (current) parts.push(current)
  return parts
}

/**
 * 限制一段朗读的字符总量：超长回复只念开头部分，避免一次朗读几分钟。
 * @param {string} text 已清理的纯文本。
 * @param {number} maxChars 总上限；<=0 表示不限制。
 * @param {string} [tail] 截断时补的一句提示。
 * @returns {string} 处理后的文本。
 */
export function limitSpeech(text, maxChars, tail = '后面还有内容，这里就先念到这里。') {
  if (!maxChars || maxChars <= 0) return text
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  const cut = value.slice(0, maxChars)
  const boundary = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('\n'),
  )
  const head = boundary > maxChars * 0.4 ? cut.slice(0, boundary + 1) : cut
  return `${head}${tail}`
}
