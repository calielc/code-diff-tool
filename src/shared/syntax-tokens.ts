// The model of coloured code. A grammar turns a text into a tree of scopes. These helpers cut that tree into lines of
// tokens, join the tokens with the marks of the characters that changed, and say when a text is too big to colour.
// The code has no dependency on a grammar library, so the unit tests can run it on plain data.

import type { Seg } from './intraline'

/** The kinds of token that get a colour. Each one has a CSS variable `--tok-<kind>` and a class `tk-<kind>`. */
export const TOKEN_KINDS = ['kw', 'str', 'num', 'cm', 'fn', 'ty', 'va', 'at', 'tg', 'mt', 'sy', 'lt'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

/** A run of characters of one line. A null kind is plain text. */
export interface Token {
  text: string
  kind: TokenKind | null
}

/** The tokens of one line. They join to the text of the line. */
export type TokenLine = Token[]

/** The part of a hast node that the cutting needs. A grammar library gives nodes of this shape. */
export interface TreeNode {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: TreeNode[]
}

/** The scopes of the grammars, grouped into the kinds above. A scope of highlight.js that is not here has the kind 'mt', which holds directives, annotations and other special code. */
const KIND_OF_SCOPE: Record<string, TokenKind | 'none'> = {
  keyword: 'kw',
  'selector-tag': 'kw',
  doctag: 'kw',
  string: 'str',
  code: 'str',
  regexp: 'str',
  number: 'num',
  comment: 'cm',
  quote: 'cm',
  title: 'fn',
  function: 'fn',
  section: 'fn',
  type: 'ty',
  class: 'ty',
  built_in: 'ty',
  variable: 'va',
  'template-variable': 'va',
  attr: 'at',
  attribute: 'at',
  property: 'at',
  'selector-attr': 'at',
  'selector-class': 'at',
  'selector-pseudo': 'at',
  link: 'at',
  tag: 'tg',
  name: 'tg',
  'selector-id': 'tg',
  symbol: 'sy',
  bullet: 'sy',
  literal: 'lt',
  // Text inside a string or a comment that is code again, and the marks that stay plain
  subst: 'none',
  params: 'none',
  operator: 'none',
  punctuation: 'none',
  emphasis: 'none',
  strong: 'none'
}

/** The compound scopes of highlight.js 11 come as `hljs-title` with the class `class_` or `function_`. The second part decides. */
const KIND_OF_PART: Record<string, TokenKind> = { class_: 'ty', function_: 'fn', constant_: 'lt', language_: 'kw', invoke__: 'fn' }

/** The kind of a span from its class names, 'none' for a scope that resets to plain text, or undefined when there is no scope of highlight.js in the names. */
export function kindOfClasses(names: readonly string[]): TokenKind | 'none' | undefined {
  let base: TokenKind | 'none' | undefined
  let part: TokenKind | undefined
  for (const name of names) {
    if (name.startsWith('hljs-')) base = KIND_OF_SCOPE[name.slice(5)] ?? 'mt'
    else part = KIND_OF_PART[name] ?? part
  }
  return part ?? base
}

const classNames = (node: TreeNode): string[] => {
  const c = node.properties?.className
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === 'string')
  return typeof c === 'string' ? c.split(/\s+/) : []
}

/**
 * Cut a tree of scopes into lines. A scope that spans several lines, such as a block comment, gives each line its own
 * token of the same kind. The inner scope wins over the outer one. Neighbouring tokens of one kind join.
 */
export function linesFromTree(root: TreeNode): TokenLine[] {
  const lines: TokenLine[] = [[]]
  const push = (text: string, kind: TokenKind | null): void => {
    if (text === '') return
    const line = lines[lines.length - 1]
    const last = line[line.length - 1]
    if (last && last.kind === kind) last.text += text
    else line.push({ text, kind })
  }
  const walk = (node: TreeNode, inherited: TokenKind | null): void => {
    if (node.type === 'text') {
      const parts = (node.value ?? '').split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        push(part, inherited)
      })
      return
    }
    let kind = inherited
    if (node.type === 'element') {
      const own = kindOfClasses(classNames(node))
      if (own === 'none') kind = null
      else if (own) kind = own
    }
    for (const child of node.children ?? []) walk(child, kind)
  }
  walk(root, null)
  return lines
}

/** The tokens of a line as plain text again. */
export const textOfTokens = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join('')

/** A piece of a line that is drawn as one element: one kind of token and one state of the intra-line mark. */
export interface Piece {
  text: string
  kind: TokenKind | null
  /** True for a character that differs from the line it is compared with. */
  changed: boolean
}

/**
 * The pieces of a line, from its tokens and the marks of the changed characters. Both split the line, and a piece
 * keeps the kind of its token and the mark of its characters, so a changed character stays marked over any colour.
 * Tokens that do not join to the text, such as the tokens of another line, are ignored and the line stays plain.
 */
export function piecesOf(text: string, tokens: readonly Token[] | null, segs: readonly Seg[] | null | undefined): Piece[] {
  const runs: Token[] = tokens && textOfTokens(tokens) === text ? [...tokens] : [{ text, kind: null }]
  const marks: Seg[] = segs && segs.map((s) => s.text).join('') === text ? [...segs] : [{ text, changed: false }]
  const out: Piece[] = []
  let ti = 0
  let si = 0
  let tOff = 0
  let sOff = 0
  while (ti < runs.length && si < marks.length) {
    const t = runs[ti]
    const s = marks[si]
    const take = Math.min(t.text.length - tOff, s.text.length - sOff)
    if (take > 0) {
      const piece = { text: t.text.slice(tOff, tOff + take), kind: t.kind, changed: s.changed }
      const last = out[out.length - 1]
      if (last && last.kind === piece.kind && last.changed === piece.changed) last.text += piece.text
      else out.push(piece)
    }
    tOff += take
    sOff += take
    if (tOff >= t.text.length) {
      ti++
      tOff = 0
    }
    if (sOff >= s.text.length) {
      si++
      sOff = 0
    }
  }
  return out
}

// The limits. A text over one of them shows as plain text, and the file panel says so.

/** The most lines of one text that the app colours. */
export const MAX_LINES = 8000
/** The most characters of one text that the app colours. */
export const MAX_CHARS = 600_000
/** The longest line that the app colours. A longer line is minified or generated code, and a grammar is slow on it. */
export const MAX_LINE_LENGTH = 1500

/** Why a text is too big to colour, in words for the reader, or null when it is not. */
export function limitReason(lines: readonly string[]): string | null {
  if (lines.length > MAX_LINES) return `it has more than ${MAX_LINES.toLocaleString('en-US')} lines`
  let chars = 0
  for (const line of lines) {
    if (line.length > MAX_LINE_LENGTH) return `it has a line longer than ${MAX_LINE_LENGTH.toLocaleString('en-US')} characters`
    chars += line.length + 1
    if (chars > MAX_CHARS) return `it has more than ${MAX_CHARS.toLocaleString('en-US')} characters`
  }
  return null
}
