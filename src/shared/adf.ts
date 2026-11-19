// Atlassian Document Format to plain text, and the acceptance criteria rules (file 05 section 3.5, file 01 sections 3.4 and 3.5).

export interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

const kids = (n: AdfNode): AdfNode[] => (Array.isArray(n.content) ? n.content : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isList = (n: AdfNode): boolean => n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList'
const isContainer = (n: AdfNode): boolean => n.type === 'panel' || n.type === 'expand' || n.type === 'nestedExpand'

/** `yyyy-MM-dd` in UTC from milliseconds since 1970. Jira sends the number as a number or as a string of digits. */
function dateText(ts: unknown): string {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' && ts.trim() !== '' ? Number(ts) : NaN
  return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : ''
}

/** The raw text of a node, before white space is collapsed. */
function raw(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return str(n.text)
    case 'hardBreak':
      return '\n'
    case 'mention':
    case 'emoji':
    case 'status':
      return str(n.attrs?.text) || str(n.attrs?.shortName)
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return str(n.attrs?.url)
    case 'date':
      return dateText(n.attrs?.timestamp)
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return ' ' + kids(n).map(raw).join('; ')
    case 'paragraph':
    case 'heading':
    case 'taskItem':
    case 'codeBlock':
      return kids(n).map(raw).join('')
    default:
      return kids(n).map(raw).join(' ')
  }
}

/** Inline text: raw text, then every run of white space becomes one space, then trimmed. */
export const inline = (n: AdfNode): string => raw(n).replace(/\s+/g, ' ').trim()

function listLines(list: AdfNode, indent: string, out: string[]): void {
  let order = typeof list.attrs?.order === 'number' ? (list.attrs.order as number) : 1
  for (const item of kids(list)) {
    const marker = list.type === 'orderedList' ? `${order++}. ` : list.type === 'taskList' ? (item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ') : '- '
    const text =
      item.type === 'taskItem'
        ? inline(item)
        : kids(item)
            .filter((c) => !isList(c))
            .map(inline)
            .join(' ')
    out.push(`${indent}${marker}${text}`)
    for (const child of kids(item)) if (isList(child)) listLines(child, indent + '  ', out) // a nested list adds no blank line
  }
}

function writeBlocks(nodes: AdfNode[], indent: string, out: string[]): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'heading': {
        const level = typeof n.attrs?.level === 'number' ? (n.attrs.level as number) : 1
        out.push(`${indent}${'#'.repeat(level)} ${inline(n)}`, '')
        break
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        listLines(n, indent, out)
        if (indent === '') out.push('')
        break
      case 'codeBlock':
        out.push(`${indent}\`\`\``, kids(n).map(raw).join(''), `${indent}\`\`\``, '')
        break
      case 'blockquote':
        for (const c of kids(n)) out.push(`${indent}> ${inline(c)}`)
        out.push('')
        break
      case 'rule':
        out.push(`${indent}---`, '')
        break
      case 'panel':
      case 'expand':
      case 'nestedExpand': {
        const title = str(n.attrs?.title)
        if (title) out.push(title, '')
        writeBlocks(kids(n), indent, out)
        break
      }
      case 'table':
        for (const row of kids(n)) out.push(`${indent}| ${kids(row).map(inline).join(' | ')} |`)
        out.push('')
        break
      case 'mediaSingle':
      case 'mediaGroup':
        out.push(`${indent}[attachment]`, '')
        break
      default: {
        const t = inline(n)
        if (t) out.push(`${indent}${t}`, '')
      }
    }
  }
}

/** The plain text of a description or comment. A value that is not an ADF document gives an empty text. */
export function adfToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || (doc as AdfNode).type !== 'doc') return ''
  const out: string[] = []
  writeBlocks(kids(doc as AdfNode), '', out)
  return out.join('\n').trim()
}

/** Top-level blocks with every panel and expand replaced by its own children, all the way down. */
function flatten(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((n) => (isContainer(n) ? flatten(kids(n)) : [n]))
}

const wordCount = (s: string): number => s.split(' ').filter(Boolean).length
const isShortParagraph = (n: AdfNode): boolean => n.type === 'paragraph' && wordCount(inline(n)) >= 1 && wordCount(inline(n)) <= 12
const START = /^(acceptance\b|acs?\b|done when\b|definition of done\b)/i
const levelOf = (n: AdfNode): number => (typeof n.attrs?.level === 'number' ? (n.attrs.level as number) : 1)

/** The acceptance criteria of a Jira description (file 01 section 3.5). */
export function criteriaOf(doc: unknown): string[] {
  if (!doc || typeof doc !== 'object' || (doc as AdfNode).type !== 'doc') return []
  const blocks = flatten(kids(doc as AdfNode))
  const start = blocks.findIndex((b) => (b.type === 'heading' || isShortParagraph(b)) && START.test(inline(b)))
  if (start < 0) return []
  const opener = blocks[start]
  const isLabel = (i: number): boolean =>
    isShortParagraph(blocks[i]) && (inline(blocks[i]).endsWith(':') || (blocks[i + 1] !== undefined && isList(blocks[i + 1])))
  let end = blocks.length
  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i]
    const stop = opener.type === 'heading' ? b.type === 'heading' && levelOf(b) <= levelOf(opener) : b.type === 'heading' || isLabel(i)
    if (stop) {
      end = i
      break
    }
  }
  const section = blocks.slice(start + 1, end)
  const lists = section.filter(isList)
  const items = lists.length > 0 ? lists.flatMap((l) => kids(l).map(inline)) : section.filter((b) => b.type === 'paragraph').map(inline)
  return items.map((t) => t.replace(/^(\d+[.)]\s+)?(\[[ xX]?\]\s*)?/, '')).filter((t) => t !== '')
}
