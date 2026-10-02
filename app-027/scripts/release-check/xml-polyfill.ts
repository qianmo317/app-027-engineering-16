/**
 * 最小 SVG/DOM polyfill —— 仅为在 Node 里跑应用自身的 importer 服务，不随生产产物打包。
 *
 * importer 实际用到的 DOM 面：
 *   new DOMParser().parseFromString(text, 'image/svg+xml')
 *   doc.getElementsByTagName(name)   → Element[]（带 .length、可下标）
 *   doc.documentElement
 *   el.tagName / el.children(Array) / el.getAttribute(name)
 *
 * 这是一个克制的 XML 分词器：支持元素/自闭合/属性/注释/CDATA/XML 声明/DOCTYPE，
 * 不支持实体以外的任何 XML 高级特性（命名空间、DTD 校验等）——纹样 SVG 也用不到。
 * 解析失败时按浏览器行为产出一个 <parsererror> 元素（importer 据此抛错）。
 */

class MiniElement {
  tagName: string
  attributes: Record<string, string> = {}
  children: MiniElement[] = []
  parent: MiniElement | null = null
  text = ''

  constructor(tagName: string) {
    this.tagName = tagName
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  getElementsByTagName(name: string): MiniElement[] & { length: number } {
    const out: MiniElement[] = []
    const lname = name.toLowerCase()
    const visit = (el: MiniElement): void => {
      for (const ch of el.children) {
        if (ch.tagName.toLowerCase() === lname) out.push(ch)
        visit(ch)
      }
    }
    visit(this)
    return attachArrayLike(out)
  }
}

function attachArrayLike<T>(arr: T[]): T[] & { length: number } {
  // Node 的数组本身就有 length 和下标访问，保持数组类型即可
  return arr
}

class MiniDocument {
  documentElement: MiniElement | null = null

  getElementsByTagName(name: string): MiniElement[] {
    if (!this.documentElement) return []
    // documentElement 自身也在搜索范围内（浏览器语义）
    const out: MiniElement[] = []
    if (this.documentElement.tagName.toLowerCase() === name.toLowerCase()) out.push(this.documentElement)
    out.push(...this.documentElement.getElementsByTagName(name))
    return out
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

class DOMParser {
  parseFromString(text: string, _mime: string): MiniDocument {
    const doc = new MiniDocument()
    try {
      doc.documentElement = parseXml(text)
    } catch (e) {
      const err = new MiniElement('parsererror')
      err.text = (e as Error).message
      doc.documentElement = err
    }
    return doc
  }
}

function parseXml(text: string): MiniElement {
  let i = 0
  const root: MiniElement[] = []
  const stack: MiniElement[] = []

  const current = (): MiniElement | null => (stack.length ? stack[stack.length - 1] : null)

  while (i < text.length) {
    if (text[i] === '<') {
      // 注释
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        if (end === -1) throw new Error('XML 注释未闭合')
        i = end + 3
        continue
      }
      // CDATA
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9)
        if (end === -1) throw new Error('CDATA 未闭合')
        i = end + 3
        continue
      }
      // 声明 / 处理指令 / DOCTYPE：跳过
      if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
        const end = text.indexOf('>', i + 2)
        if (end === -1) throw new Error('XML 声明/指令未闭合')
        i = end + 1
        continue
      }
      // 闭合标签
      if (text[i + 1] === '/') {
        const end = text.indexOf('>', i + 2)
        if (end === -1) throw new Error('闭合标签缺少 >')
        const name = text.slice(i + 2, end).trim()
        const el = stack.pop()
        if (!el || el.tagName !== name) throw new Error(`闭合标签不匹配：${name}`)
        i = end + 1
        continue
      }
      // 开始标签
      const end = findTagEnd(text, i + 1)
      if (end === -1) throw new Error('标签缺少 >')
      let raw = text.slice(i + 1, end)
      const selfClose = raw.endsWith('/')
      if (selfClose) raw = raw.slice(0, -1).trimEnd()
      const sp = raw.search(/\s/)
      const name = (sp === -1 ? raw : raw.slice(0, sp)).trim()
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) throw new Error(`非法标签名：${name}`)
      const el = new MiniElement(name)
      el.attributes = sp === -1 ? {} : parseAttrs(raw.slice(sp + 1))
      const parent = current()
      if (parent) parent.children.push(el)
      else root.push(el)
      el.parent = parent
      if (!selfClose) stack.push(el)
      i = end + 1
    } else {
      // 文本节点：importer 不读文本，直接跳过
      const next = text.indexOf('<', i)
      i = next === -1 ? text.length : next
    }
  }
  if (stack.length) throw new Error(`标签未闭合：${stack.map((e) => e.tagName).join(',')}`)
  if (root.length === 0) throw new Error('XML 没有根元素')
  if (root.length > 1) throw new Error('XML 有多个根元素')
  return root[0]
}

/** 属性值里可能含 > （如 d="...a>b..."），找标签结束位置时要跳过引号 */
function findTagEnd(text: string, from: number): number {
  let q: string | null = null
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === q) q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
    } else if (ch === '>') {
      return i
    }
  }
  return -1
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '')
  }
  return attrs
}

export function installDomPolyfill(): void {
  const g = globalThis as unknown as { DOMParser?: unknown }
  if (!g.DOMParser) g.DOMParser = DOMParser
}
