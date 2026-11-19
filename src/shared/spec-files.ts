// Spec files: an issue can come from a file the user adds (.md, .txt or .html) instead of from Jira.

export const SPEC_EXTENSIONS = ['md', 'txt', 'html', 'htm'] as const
export const MAX_SPEC_BYTES = 1024 * 1024

/** The pattern of a Jira issue key. A spec file key always has an extension, so the two never clash. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/
export const isJiraKey = (key: string): boolean => JIRA_KEY_RE.test(key)

export function specExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export const isSpecFileName = (name: string): boolean => (SPEC_EXTENSIONS as readonly string[]).includes(specExtension(name))

/** The key of a spec file: its file name, with anything but letters, digits, dot, underscore, hyphen and space replaced. */
export function specKey(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .slice(0, 100)
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * HTML to Markdown-like text. Scripts, styles and comments are dropped. Headings, list items, paragraphs and table
 * rows keep their shape. Everything else becomes plain text. The result is shown as text, never as HTML.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_m, l: string, t: string) =>
        `\n\n${'#'.repeat(Number(l))} ${t
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()}\n\n`
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|ul|ol|table|blockquote|pre|header|footer|main)\s*>/gi, '\n\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text of a spec file: Markdown and plain text as they are, HTML converted. */
export function specToText(name: string, raw: string): string {
  // eslint-disable-next-line no-irregular-whitespace -- a literal byte order mark
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const ext = specExtension(name)
  return (ext === 'html' || ext === 'htm' ? htmlToText(text) : text).trim()
}

/** The title: the first Markdown heading, else the first non-empty line, else the file name. */
export function specTitle(name: string, text: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1]
  const first = text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim()
  const title = (heading ?? first ?? name).replace(/[*_`]/g, '').trim()
  return title.length > 120 ? `${title.slice(0, 120)}…` : title || name
}

const START = /^(acceptance\b|acs?\b|done when\b|definition of done\b)/i
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

/**
 * The acceptance criteria of a spec text. The rules mirror the Jira ones: the section opens at a heading or a short
 * line such as `Acceptance criteria:`, ends at the next heading of the same or a higher level (or, for a label, at the next
 * heading or label), and its list items are the criteria. With no list, each paragraph is one criterion.
 */
export function specCriteria(text: string): string[] {
  const lines = text.split('\n')
  const isLabel = (i: number): boolean => {
    const t = lines[i].trim()
    if (!t || HEADING.test(t) || ITEM.test(t) || words(t) > 12) return false
    const next = lines.slice(i + 1).find((l) => l.trim() !== '')
    return t.endsWith(':') || (next !== undefined && ITEM.test(next))
  }
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const h = HEADING.exec(t)
    if (h && START.test(h[2])) {
      start = i
      level = h[1].length
      break
    }
    if (!h && !ITEM.test(t) && t && words(t) <= 12 && START.test(t.replace(/[:：]\s*$/, ''))) {
      start = i
      break
    }
  }
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i].trim())
    if (level > 0 ? !!h && h[1].length <= level : !!h || isLabel(i)) {
      end = i
      break
    }
  }
  const section = lines.slice(start + 1, end)
  const items = section.map((l) => ITEM.exec(l)?.[1]).filter((x): x is string => x !== undefined)
  const raw =
    items.length > 0
      ? items
      : section
          .join('\n')
          .split(/\n{2,}/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
  return raw.map((t) => t.replace(/^(\d+[.)]\s+)?(\[[ xX]?\]\s*)?/, '').trim()).filter(Boolean)
}
