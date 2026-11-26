import type { DiffRefs, Person, Thread } from './provider'

/** A draft saved in comments.json (file 00 section 4.3). Drafts come from Claude; a typed comment goes to the forge at once. */
export interface PendingComment {
  id: string
  /** MR key `<repo>!<iid>`. */
  mr: string
  diffRefs: DiffRefs
  /** A null path is a comment on the whole MR. A path with both lines null is a comment on the whole file. */
  path: string | null
  oldPath: string | null
  oldLine: number | null
  newLine: number | null
  body: string
  view?: 'mr' | 'combined'
  combinedPath?: string | null
  lineText?: string
  claude?: { skill: string | null; lens: string; severity: 'blocking' | 'suggestion'; ac?: string }
}

export const COMMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A new id: the time in base 36, then 8 random base 36 characters. */
export function newCommentId(): string {
  let rand = ''
  for (let i = 0; i < 8; i++) rand += Math.floor(Math.random() * 36).toString(36)
  return Date.now().toString(36) + rand
}

/** The threads of one change after a write, so the window shows the new state at once. */
export interface ThreadsAnswer {
  threads: Thread[]
  people: Record<string, Person>
  /** False when the write worked but the threads could not be read back (the window tells the user to refresh). */
  readBack: boolean
}

/** One submit request (file 03 section 10.3). All lists hold MR keys. */
export interface SubmitInput {
  slug: string
  approve: string[]
  unapprove: string[]
  requestChanges: string[]
  summaries: Record<string, string>
  ready: string[]
  draft: string[]
  /** The closed MRs to open again. A request that leaves it out reopens nothing. */
  reopen?: string[]
}

/** One submit request by url, from the home lists. The lists and the keys of summaries hold change urls, not review keys. */
export type UrlSubmitInput = Omit<SubmitInput, 'slug'>

/** Remove every leading draft prefix, then add `Draft: ` when the result must be a draft (file 03 section 10.4). */
export function draftTitle(title: string, draft: boolean): string {
  const stripped = title.replace(/^(?:(?:\[draft\]|\(draft\)|draft:)\s*)+/i, '')
  return draft ? `Draft: ${stripped}` : stripped
}

/** The text of a comment that has a path but no line, or that GitLab cannot place (file 03 section 10.2). */
export function fileCommentBody(path: string | null, body: string): string {
  return path ? `\`${path}\`: ${body}` : body
}
export function fallbackBody(path: string | null, line: number | null, body: string): string {
  return `\`${path ?? ''}\`, line ${line ?? ''}: ${body}`
}

/** Short Markdown subset of file 02 section 8.3, as a list of blocks the renderer turns into elements. */
export type Inline =
  { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'bold'; text: string } | { kind: 'link'; text: string; href: string }
export type Block = { kind: 'heading'; level: number; inline: Inline[] } | { kind: 'list'; items: Inline[][] } | { kind: 'para'; lines: Inline[][] }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] })
    else out.push({ kind: 'link', text: m[3], href: m[4] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  for (const chunk of src.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) continue
    const heading = lines.length === 1 ? /^(#{1,4}) (.*)$/.exec(lines[0]) : null
    if (heading)
      blocks.push({ kind: 'heading', level: heading[1].length + 2, inline: parseInline(heading[2]) }) // shown two levels down
    else if (lines.every((l) => /^[-*] /.test(l))) blocks.push({ kind: 'list', items: lines.map((l) => parseInline(l.slice(2))) })
    else blocks.push({ kind: 'para', lines: lines.map(parseInline) })
  }
  return blocks
}
