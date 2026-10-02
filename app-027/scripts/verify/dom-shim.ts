/**
 * 极简 XML / SVG DOM 垫片：仅实现 src/logic/importer.ts 在 Node 下运行所需的子集。
 * 目的：让「页面里的验收自检内核」能在构建机（无浏览器）上原样运行，
 * 而不是用另一套解析器去重新实现一遍。
 */

type Attrs = Record<string, string>

class ShimElement {
  tagName: string
  attributes: Attrs
  children: ShimElement[] = []
  parentNode: ShimElement | null = null
  nodeName: string

  constructor(tag: string, attributes: Attrs) {
    this.tagName = tag
    this.nodeName = tag
    this.attributes = attributes
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }
}

class ShimDocument {
  documentElement: ShimElement | null = null
  private errorEls: ShimElement[] = []

  getElementsByTagName(name: string): ShimElement[] {
    const target = name.toLowerCase()
    if (target === 'parsererror') return this.errorEls
    const out: ShimElement[] = []
    if (this.documentElement) walk(this.documentElement, (el) => el.tagName === target && out.push(el))
    return out
  }

  _setRoot(el: ShimElement): void {
    this.documentElement = el
  }
  _addParserError(msg: string): void {
    this.errorEls.push(new ShimElement('parsererror', { message: msg }))
  }
}

function walk(el: ShimElement, fn: (el: ShimElement) => void): void {
  fn(el)
  for (const c of el.children) walk(c, fn)
}

/** 去掉注释与处理指令，切成节点 token（'tag' / 'text'） */
type Token = { type: 'tag'; text: string } | { type: 'text'; text: string }

function tokenize(xml: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let textStart = 0
  const pushText = (end: number): void => {
    const t = xml.slice(textStart, end)
    if (t.trim()) tokens.push({ type: 'text', text: t })
  }
  while (i < xml.length) {
    const ch = xml[i]
    if (ch !== '<') {
      i++
      continue
    }
    const next = xml[i + 1]
    if (next === '!') {
      // <!-- 注释 --> / <!DOCTYPE ...>
      pushText(i)
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i + 4)
        if (end === -1) throw new Error('XML 解析失败：注释未闭合')
        i = end + 3
      } else {
        const end = xml.indexOf('>', i + 2)
        if (end === -1) throw new Error('XML 解析失败：声明未闭合')
        i = end + 1
      }
      textStart = i
      continue
    }
    if (next === '?') {
      // <?xml ?> 处理指令
      pushText(i)
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) throw new Error('XML 解析失败：处理指令未闭合')
      i = end + 2
      textStart = i
      continue
    }
    // 普通标签：找到不在引号内的 '>'
    pushText(i)
    let j = i + 1
    let quote: string | null = null
    while (j < xml.length) {
      const c = xml[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      j++
    }
    if (j >= xml.length) throw new Error('XML 解析失败：标签未闭合')
    tokens.push({ type: 'tag', text: xml.slice(i + 1, j) })
    i = j + 1
    textStart = i
  }
  pushText(xml.length)
  return tokens
}

function parseTagText(text: string): { name: string; attrs: Attrs; closing: boolean; selfClosing: boolean } {
  let body = text.trim()
  const closing = body.startsWith('/')
  if (closing) body = body.slice(1).trim()
  const selfClosing = body.endsWith('/')
  if (selfClosing) body = body.slice(0, -1).trim()

  const attrs: Attrs = {}
  // 标签名
  const nameMatch = /^([^\s/>]+)/.exec(body)
  if (!nameMatch) throw new Error('XML 解析失败：无法识别标签名')
  const name = nameMatch[1].toLowerCase()

  // 属性：name="v" / name='v' / name=v
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  let m: RegExpExecArray | null
  const rest = body.slice(nameMatch[0].length)
  while ((m = attrRe.exec(rest)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  // 无值属性（本项目纹样里没有，保险起见支持一下）
  const stripped = rest.replace(attrRe, ' ')
  const bare = stripped.match(/[^\s=/>]+/g)
  if (bare) for (const b of bare) attrs[b] = ''

  return { name, attrs, closing, selfClosing }
}

export class ShimDOMParser {
  parseFromString(text: string, _mime: string): ShimDocument {
    const doc = new ShimDocument()
    let root: ShimElement | null = null
    const stack: ShimElement[] = []
    try {
      for (const tok of tokenize(text)) {
        if (tok.type === 'text') continue
        const { name, attrs, closing, selfClosing } = parseTagText(tok.text)
        if (closing) {
          const top = stack.pop()
          if (!top || top.tagName !== name) {
            throw new Error(`XML 解析失败：</${name}> 与开标签不匹配`)
          }
          continue
        }
        const el = new ShimElement(name, attrs)
        if (stack.length > 0) {
          el.parentNode = stack[stack.length - 1]
          stack[stack.length - 1].children.push(el)
        } else if (!root) {
          root = el
        } else {
          throw new Error('XML 解析失败：存在多个根节点')
        }
        if (!selfClosing) stack.push(el)
      }
      if (stack.length > 0) throw new Error(`XML 解析失败：<${stack[stack.length - 1].tagName}> 未闭合`)
    } catch (e) {
      doc._addParserError((e as Error).message)
    }
    if (!root) doc._addParserError('XML 解析失败：文档没有根节点')
    doc._setRoot(root as ShimElement)
    return doc
  }
}

// importer 依赖 document-less 的全局 DOMParser
;(globalThis as unknown as { DOMParser: typeof ShimDOMParser }).DOMParser = ShimDOMParser
