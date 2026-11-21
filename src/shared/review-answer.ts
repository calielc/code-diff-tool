import type { PendingComment } from './comments'
import type { LineObj } from './diff'
import { relaxJson } from './sections'
import type { DiffRefs } from './provider'

// Checking the answer of an AI review or an acceptance criteria check, and making drafts of it (file 04 sections 7.10 and 8.4).

export interface AnswerFile {
  path: string
  oldPath: string
  levels: { raw: { hunks: LineObj[][] } }
  /** The whole new file, or null for a binary, generated or deleted file. */
  lines: string[] | null
}

export interface AnswerMr {
  key: string
  state: string
  diffRefs: DiffRefs
  files: AnswerFile[]
}

export interface ChecklistEntry {
  ac: string
  state: 'covered' | 'partial' | 'missing'
  why: string
  evidence: { mr: string; path: string; newLine: number | null }[]
  /** A suggested comment of an acceptance criteria check. Always null in a review. */
  draft: PendingComment | null
}

export interface Checked {
  problems: string[]
  drafts: PendingComment[]
  checklist: ChecklistEntry[]
  report: string | null
}

const SEVERITIES = ['blocking', 'suggestion']
const STATES = ['covered', 'partial', 'missing']

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `cr` and the first 20 hex characters of a random UUID without hyphens. */
export const draftId = (): string => `cr${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

interface DraftResult {
  draft: PendingComment | null
  problems: string[]
}

/** Turn one finding, or one suggested comment, into a pending comment (file 04 section 7.10). */
export function makeDraft(where: string, raw: unknown, mrs: AnswerMr[], skill: string | null, lens: string, severity: string, ac?: string): DraftResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { draft: null, problems: [`${where} is not an object`] }
  const o = raw as Record<string, unknown>
  const problems: string[] = []
  const mrKey = asString(o.mr)
  const path = asString(o.path)
  const body = asString(o.body).trim()
  const num = (name: string): number | null => {
    const v = o[name]
    if (v === undefined || v === null) return null
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
    problems.push(`${where}: \`${name}\` is ${typeof v === 'string' ? v : JSON.stringify(v)}, not a line number`)
    return null
  }
  const newLine = num('newLine')
  const oldLine = num('oldLine')
  const mr = mrs.find((m) => m.key === mrKey)
  if (!mr) problems.push(`${where}: \`${mrKey}\` is not the key of an MR in \`index.md\``)
  if (!lens.trim()) problems.push(`${where}: \`lens\` is empty`)
  if (!SEVERITIES.includes(severity)) problems.push(`${where}: \`severity\` is \`${severity}\`, not \`blocking\` or \`suggestion\``)
  if (!body) problems.push(`${where}: \`body\` is empty`)
  if (problems.length > 0 || !mr) return { draft: null, problems }

  const file = path ? mr.files.find((f) => f.path === path || f.oldPath === path) : undefined
  const hunks = file ? file.levels.raw.hunks.flat() : []
  let found: LineObj | undefined
  if (newLine !== null) found = hunks.find((l) => l.n === newLine && l.t !== '-')
  else if (oldLine !== null) found = hunks.find((l) => l.o === oldLine && l.t !== '+')
  const name = newLine !== null ? `Line ${newLine}` : oldLine !== null ? `Old line ${oldLine}` : null
  if (file && !found && newLine !== null && file.lines && newLine > file.lines.length) {
    return { draft: null, problems: [`${where}: \`${path}\` has ${file.lines.length} lines, so it has no new line ${newLine}`] }
  }
  let text: string
  if (path && !file) text = `\`${path}\`${name ? `, ${name.toLowerCase()}` : ''}: ${body}`
  else if (file && !found && name) text = `${name}: ${body}`
  else text = body
  const draft: PendingComment = {
    id: draftId(),
    mr: mr.key,
    view: 'mr',
    diffRefs: mr.diffRefs,
    path: file ? file.path : null,
    oldPath: file ? file.oldPath : null,
    oldLine: found && found.t !== '+' ? found.o : null,
    newLine: found && found.t !== '-' ? found.n : null,
    combinedPath: null,
    lineText: found ? found.x : '',
    body: `🤖 ${lens}, ${severity}: ${text}`,
    claude: { skill, lens, severity: severity as 'blocking' | 'suggestion', ...(ac ? { ac } : {}) }
  }
  return { draft, problems: [] }
}

/**
 * Check an answer. With a skill it is a review: `findings` become drafts. With no skill it is an acceptance criteria
 * check: each checklist entry may carry a suggested comment. The answer is accepted only when `problems` is empty.
 */
export function checkReviewAnswer(input: { mrs: AnswerMr[]; criteria: string[]; skill: string | null; text: string }): Checked {
  const empty: Checked = { problems: [], drafts: [], checklist: [], report: null }
  const a = input.text.indexOf('{')
  const b = input.text.lastIndexOf('}')
  if (a < 0 || b < a) return { ...empty, problems: ['The answer holds no JSON object.'] }
  let root: Record<string, unknown>
  try {
    root = JSON.parse(relaxJson(input.text.slice(a, b + 1))) as Record<string, unknown>
  } catch (e) {
    return { ...empty, problems: [`The answer is not valid JSON: ${e instanceof Error ? e.message : String(e)}.`] }
  }
  const problems: string[] = []
  const drafts: PendingComment[] = []

  if (input.skill !== null) {
    if (!Array.isArray(root.findings)) problems.push('`findings` is missing or not a list. Give `[]` when there is no finding.')
    else {
      root.findings.forEach((f, i) => {
        const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
        const r = makeDraft(`finding ${i + 1}`, f, input.mrs, input.skill, asString(o.lens), asString(o.severity))
        problems.push(...r.problems)
        if (r.draft) drafts.push(r.draft)
      })
    }
  }

  // The checklist
  const checklist: ChecklistEntry[] = []
  if (!Array.isArray(root.checklist)) {
    if (input.criteria.length > 0) problems.push('`checklist` is missing or not a list: give one entry per criterion of the issue files.')
  } else {
    const seen = new Set<string>()
    root.checklist.forEach((e, idx) => {
      const label = `checklist entry ${idx + 1}`
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      const ac = asString(o.ac).trim()
      const state = asString(o.state).trim()
      const why = asString(o.why).trim()
      if (!input.criteria.includes(ac)) return void problems.push(`${label}: no issue file has the criterion \`${ac}\``)
      if (seen.has(ac)) return void problems.push(`${label}: ${ac} is in the checklist twice`)
      seen.add(ac)
      if (!STATES.includes(state)) problems.push(`${label}: the state of ${ac} is \`${state}\`, not \`covered\`, \`partial\` or \`missing\``)
      if (!why) problems.push(`${label}: the \`why\` of ${ac} is empty`)
      // Evidence keeps only links to a changed file. A link to a file the MR does not change drops out with no problem.
      const evidence: ChecklistEntry['evidence'] = []
      for (const ev of Array.isArray(o.evidence) ? o.evidence : []) {
        const x = (ev && typeof ev === 'object' ? ev : {}) as Record<string, unknown>
        const file = input.mrs.find((m) => m.key === asString(x.mr))?.files.find((f) => f.path === asString(x.path) || f.oldPath === asString(x.path))
        if (file)
          evidence.push({ mr: asString(x.mr), path: file.path, newLine: typeof x.newLine === 'number' && Number.isInteger(x.newLine) ? x.newLine : null })
      }
      // A suggested comment of an acceptance criteria check: optional, for a partial or missing criterion of an open MR.
      let draft: PendingComment | null = null
      if (input.skill === null && (state === 'partial' || state === 'missing') && o.comment && typeof o.comment === 'object') {
        const target = input.mrs.find((m) => m.key === asString((o.comment as Record<string, unknown>).mr))
        if (target?.state === 'opened') {
          // An invalid suggestion drops out with no problem and no resend: it is optional.
          draft = makeDraft(label, o.comment, input.mrs, ac, 'Spec', state === 'missing' ? 'blocking' : 'suggestion', ac).draft
        }
      }
      checklist.push({ ac, state: state as ChecklistEntry['state'], why, evidence, draft })
    })
    for (const name of input.criteria) if (!seen.has(name)) problems.push(`the checklist misses ${name}: give every criterion of the issue files exactly once`)
  }
  return { problems, drafts, checklist, report: typeof root.report === 'string' ? root.report : null }
}
