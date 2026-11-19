/** An issue row of the Issues tab (file 03 section 1.1). */
export interface IssueRow {
  /** Where the issue comes from: a Jira issue, or a spec file the user added. */
  source: 'jira' | 'file'
  key: string
  /** The Jira page, or null when the Jira site is not known yet. */
  url: string | null
  type: string | null
  title: string
  status: string | null
  assignee: string | null
  /** The description as plain text. */
  description: string
  /** Acceptance criteria found in the description. */
  criteria: string[]
  /** The reason the issue could not be read, or null. */
  error: string | null
}

export interface IssueComment {
  author: string
  created: string
  body: string
}

export interface IssueAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

/** Everything read from Jira for one issue. The window gets the row. The main process keeps the rest. */
export interface IssueData extends IssueRow {
  updated: string | null
  comments: IssueComment[]
  attachments: IssueAttachment[]
}

/** The Markdown the tool builds from an item, called the issue body (file 05 section 3.3). */
export function issueBody(t: Pick<IssueData, 'description' | 'comments'>): string {
  const parts = ['## Description', '', t.description || 'No description.', '', '## Comments', '']
  if (t.comments.length === 0) parts.push('No comments.')
  else for (const c of t.comments) parts.push(`### ${c.author || 'Someone'}, ${c.created}`, '', c.body, '')
  return parts.join('\n').trimEnd()
}

/** The first letters of the first two parts of a name, split at spaces, dots, underscores and hyphens. */
export function initialsOf(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('')
}

/** The preview of a description in the table (file 01 section 3.2). */
export function descriptionPreview(text: string): string {
  const cleaned = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^(#+|[-*]|\d+\.)\s+/, '').replace(/^\[[ xX]\]\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

/** `LX-99` sorts before `LX-100`: the trailing number is left-padded with zeros to 10 digits. */
export function keySortValue(key: string): string {
  const m = /^(.*?)(\d+)$/.exec(key)
  return m ? `${m[1]}${m[2].padStart(10, '0')}` : key
}

export type IssueSortKey = 'key' | 'type' | 'title' | 'status' | 'assignee' | 'acs' | 'description'

/** A null sort value goes last in both directions (file 01 section 3.2). */
export function issueSortValue(t: IssueRow, key: IssueSortKey): string | number | null {
  const text = (s: string | null): string | null => (s ? s.toLowerCase() : null)
  switch (key) {
    case 'key':
      return keySortValue(t.key)
    case 'type':
      return text(t.type)
    case 'title':
      return text(t.title)
    case 'status':
      return text(t.status)
    case 'assignee':
      return text(t.assignee)
    case 'acs':
      return t.error ? null : t.criteria.length
    case 'description':
      return text(descriptionPreview(t.description)) || null
  }
}

/** A stable sort by one column. Text compares by code unit. */
export function sortIssues(rows: IssueRow[], key: IssueSortKey | null, dir: 'asc' | 'desc'): IssueRow[] {
  if (!key) return rows
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((r, i) => ({ r, i, v: issueSortValue(r, key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0
      return c * sign || a.i - b.i
    })
    .map((x) => x.r)
}

/** The Markdown file of an issue (file 01 section 3.6). `summary` is the Claude text, `reason` explains a missing one. */
export function issueFile(t: IssueData, summary: string | null, reason: string | null): string {
  const open = t.url ? `[Open in Jira](${t.url})` : ''
  if (t.error) {
    const why = t.source === 'file' ? `This spec file cannot be read: ${t.error}` : `Jira did not give this issue: ${t.error}`
    return ['# ' + t.key, '', ...(open ? [open, ''] : []), why].join('\n')
  }
  const line =
    t.source === 'file'
      ? `**Source:** spec file \`${t.key}\``
      : `**Type:** ${t.type ?? '–'} · **Status:** ${t.status ?? '–'} · **Assignee:** ${t.assignee ?? 'unassigned'}${open ? ` · ${open}` : ''}`
  const head = [`# ${t.key}: ${t.title}`, '', line, '']
  if (summary) return [...head, summary].join('\n')
  const lines = [...head, `No summary: ${reason || 'claude did not write one'}.`, '']
  if (t.criteria.length === 0) lines.push('No acceptance criteria.')
  else t.criteria.forEach((c, i) => lines.push(`## AC${i + 1}`, '', c, ''))
  return lines.join('\n').trimEnd()
}

/** The criteria of an issue file: each `## AC<n>` heading gives one, named `<KEY> AC<n>` (file 01 section 3.6). */
export function criteriaFromFile(key: string, file: string): { name: string; text: string }[] {
  const lines = file.split(/\r?\n/)
  const out: { name: string; text: string }[] = []
  lines.forEach((l, i) => {
    const m = /^##\s+AC(\d+)\b:?\s*(.*)$/.exec(l)
    if (!m) return
    let text = m[2].trim()
    if (!text) {
      const para: string[] = []
      for (let j = i + 1; j < lines.length && lines[j].trim() !== '' && !lines[j].startsWith('#'); j++) para.push(lines[j].trim())
      if (para.length === 0)
        for (let j = i + 1; j < lines.length && lines[j].trim() === ''; j++)
          if (lines[j + 1] && lines[j + 1].trim() !== '' && !lines[j + 1].startsWith('#')) {
            for (let k = j + 1; k < lines.length && lines[k].trim() !== '' && !lines[k].startsWith('#'); k++) para.push(lines[k].trim())
            break
          }
      text = para.join(' ')
    }
    const name = `${key} AC${m[1]}`
    if (!out.some((o) => o.name === name)) out.push({ name, text })
  })
  return out
}
