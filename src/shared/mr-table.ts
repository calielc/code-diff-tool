// Pure helpers of the Code changes tab (the MR table). Rules: section 4 of the reference spec.
import type { ChangeState, PipelineJob, ReviewerState, Thread } from './provider'

/** What the stack rule needs from one MR. The array order is the review order. */
export interface StackMr {
  key: string
  iid: number
  title: string
  repo: string
  sourceBranch: string
  targetBranch: string
  state: ChangeState
  /** The default branch of the repo from the local clone, null when it cannot be read. */
  defaultBranch: string | null
}

export interface StackInfo {
  /** Steps from the base of the stack. 0 for the base. */
  depth: number
  /** The longest depth in the stack plus 1. */
  size: number
  /** The pill text "{depth+1} of {size}", null when the MR is not in a stack (size below 2). */
  pill: string | null
  tooltip: string | null
  /** Review-order index of the base times 1000 plus the depth. Null when not in a stack. */
  rank: number | null
}

/** The stack of every MR, keyed by MR key. */
export function stackInfo(mrs: StackMr[]): Record<string, StackInfo> {
  const stackedOn = (m: StackMr): StackMr | null => {
    if (m.targetBranch === m.defaultBranch) return null
    const sources = mrs.filter((x) => x !== m && x.repo === m.repo && x.sourceBranch === m.targetBranch)
    return sources.find((x) => x.state !== 'closed') ?? sources[0] ?? null
  }
  const parents = new Map(mrs.map((m) => [m, stackedOn(m)]))
  const placed = mrs.map((m) => {
    const seen = new Set<StackMr>([m])
    let base = m
    for (let next = parents.get(base); next && !seen.has(next); next = parents.get(base)) {
      seen.add(next)
      base = next
    }
    return { m, base, depth: seen.size - 1 }
  })
  const out: Record<string, StackInfo> = {}
  for (const { m, base, depth } of placed) {
    const size = Math.max(...placed.filter((p) => p.base === base).map((p) => p.depth)) + 1
    if (size < 2) {
      out[m.key] = { depth, size, pill: null, tooltip: null, rank: null }
      continue
    }
    const parent = parents.get(m)
    const above = depth === 0 || !parent ? 'The base of the stack' : `Stacked on !${parent.iid}: ${parent.title}`
    const children = mrs.filter((c) => parents.get(c) === m)
    const below = children.length === 0 ? '' : `. ${children.map((c) => `!${c.iid}`).join(', ')} ${children.length === 1 ? 'stacks' : 'stack'} on it`
    out[m.key] = { depth, size, pill: `${depth + 1} of ${size}`, tooltip: above + below, rank: mrs.indexOf(base) * 1000 + depth }
  }
  return out
}

export type ReviewStatusId = 'approved' | 'changes' | 'author' | 'merged' | 'closed' | 'ineligible' | 'pending'
export type ReviewAction = 'mark-ready' | 'mark-draft' | 'reopen' | 'submit' | 'revoke' | 'approve'

export interface YourReviewInput {
  state: ChangeState
  draft: boolean
  author: string
  viewer: string
  viewerState: ReviewerState | null
  userCanApprove: boolean
  userHasApproved: boolean
}

export interface YourReview {
  /** The order of the status in the table of 4.3, lowest first. It is the sort value. */
  order: number
  id: ReviewStatusId
  text: string
  tone: 'ok' | 'bad' | 'muted'
  tooltip: string | null
  /** The buttons, left to right. Empty unless the MR is open and the viewer is not the author. Mark as ready and Mark as draft are in `stateActions`. */
  actions: ReviewAction[]
}

/** The buttons of the State cell: the author of an open MR gets mark-ready or mark-draft, and the author of a closed MR gets reopen. A merged or locked MR gets none. */
export function stateActions(i: YourReviewInput): ReviewAction[] {
  if (i.author !== i.viewer) return []
  if (i.state === 'closed') return ['reopen']
  if (i.state !== 'opened') return []
  return [i.draft ? 'mark-ready' : 'mark-draft']
}

export function yourReview(i: YourReviewInput): YourReview {
  const isAuthor = i.author === i.viewer
  let actions: ReviewAction[] = []
  if (i.state === 'opened') {
    if (isAuthor) actions = []
    else if (i.userHasApproved) actions = ['submit', 'revoke']
    else actions = i.userCanApprove ? ['submit', 'approve'] : ['submit']
  }
  const status = (order: number, id: ReviewStatusId, text: string, tone: YourReview['tone'], tooltip: string | null = null): YourReview => ({
    order,
    id,
    text,
    tone,
    tooltip,
    actions
  })
  if (i.userHasApproved) return status(0, 'approved', '✓ Approved by you', 'ok')
  if (i.viewerState === 'requested_changes') return status(1, 'changes', 'Changes requested by you', 'bad')
  if (isAuthor) return status(2, 'author', 'You are the author', 'muted')
  if (i.state === 'merged') return status(3, 'merged', 'Merged, no approval', 'muted')
  if (i.state !== 'opened') {
    return status(
      4,
      'closed',
      'Closed, not in the diff',
      'muted',
      'A closed change request is listed here only: its files are not in the tree, the diffs or the Summarised page.'
    )
  }
  if (!i.userCanApprove) return status(5, 'ineligible', 'Not an eligible approver', 'muted')
  return status(6, 'pending', 'Not reviewed by you yet', 'muted')
}

export interface ApproveCandidateInput {
  key: string
  iid: number
  /** The repo text of the table, without the group. */
  repo: string
  state: ChangeState
  author: string
  userCanApprove: boolean
  userHasApproved: boolean
}

export interface ApproveAll {
  /** The MR keys, in review order. The button shows keys.length and is hidden when it is 0. */
  keys: string[]
  /** "Approves !{iid} {repo}, !{iid} {repo}", empty when there is no candidate. */
  tooltip: string
}

export function approveAllCandidates(mrs: ApproveCandidateInput[], viewer: string): ApproveAll {
  const list = mrs.filter((m) => m.state === 'opened' && m.author !== viewer && m.userCanApprove && !m.userHasApproved)
  return { keys: list.map((m) => m.key), tooltip: list.length === 0 ? '' : `Approves ${list.map((m) => `!${m.iid} ${m.repo}`).join(', ')}` }
}

export type MrStateKey = 'draft' | 'opened' | 'merged' | 'closed'

export interface MrFilters {
  states: Record<MrStateKey, boolean>
  approvals: { approved: boolean; notApproved: boolean }
}

/** Draft, Open and Merged on, Closed off, both approval buttons on. */
export const DEFAULT_MR_FILTERS: MrFilters = {
  states: { draft: true, opened: true, merged: true, closed: false },
  approvals: { approved: true, notApproved: true }
}

/** An open draft is draft. A draft that is merged or closed is merged or closed. */
export function mrStateKey(mr: { state: ChangeState; draft: boolean }): MrStateKey {
  if (mr.state === 'opened') return mr.draft ? 'draft' : 'opened'
  return mr.state === 'merged' ? 'merged' : 'closed'
}

/** A group with every button off filters nothing. */
export function mrVisible(mr: { state: ChangeState; draft: boolean; approverCount: number }, filters: MrFilters): boolean {
  const states = Object.values(filters.states)
  const stateOk = !states.some(Boolean) || filters.states[mrStateKey(mr)]
  const { approved, notApproved } = filters.approvals
  const approvalOk = !approved && !notApproved ? true : mr.approverCount > 0 ? approved : notApproved
  return stateOk && approvalOk
}

/** The date cell. `now` and `timeZone` are seams: they default to the current time and the time zone of the computer. */
export function formatMrDate(iso: string | null, now: Date = new Date(), timeZone?: string): { text: string; title: string } {
  const date = iso ? new Date(iso) : null
  if (!iso || !date) return { text: '–', title: '' }
  if (Number.isNaN(date.getTime())) return { text: iso, title: iso }
  const parts = (d: Date): Record<string, string> =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d)
        .map((p) => [p.type, p.value])
    )
  const p = parts(date)
  const year = p.year === parts(now).year ? '' : `, ${p.year}`
  return {
    text: `${p.month} ${p.day}${year}, ${p.hour}:${p.minute}`,
    title: date.toLocaleString('en-US', { timeZone, dateStyle: 'full', timeStyle: 'short' })
  }
}

export interface CommentsCell {
  /** "{open}/{total}", null when there is no resolvable thread. */
  chip: string | null
  chipTitle: string | null
  /** Amber while open threads exist, blue when none are open. Null without a chip. */
  tone: 'amber' | 'blue' | null
  /** The muted text after the chip. "No threads" when there is no resolvable thread. */
  detail: string
  drafts: { count: number; label: 'draft' | 'drafts'; title: string } | null
  /** Open threads times 10000 plus all threads. Null when there is no resolvable thread. */
  sort: number | null
}

export function commentsCell(threads: Pick<Thread, 'resolvable' | 'resolved' | 'position'>[], draftCount: number): CommentsCell {
  const drafts: CommentsCell['drafts'] =
    draftCount > 0 ? { count: draftCount, label: draftCount === 1 ? 'draft' : 'drafts', title: 'Your drafts, not posted yet' } : null
  const list = threads.filter((t) => t.resolvable)
  if (list.length === 0) return { chip: null, chipTitle: null, tone: null, detail: 'No threads', drafts, sort: null }
  const open = list.filter((t) => !t.resolved).length
  const offFile = list.filter((t) => t.position === null).length
  const detail = `${open > 0 ? `${open} open, ${list.length - open} resolved` : 'all resolved'}${offFile > 0 ? `, ${offFile} on the change request, not on a file` : ''}`
  return {
    chip: `${open}/${list.length}`,
    chipTitle: `${open} open of ${list.length} thread${list.length === 1 ? '' : 's'} on GitLab`,
    tone: open > 0 ? 'amber' : 'blue',
    detail,
    drafts,
    sort: open * 10000 + list.length
  }
}

/** The position of a pipeline status in the sort, failed first. Null when there is no pipeline. A status that is not listed ranks after success. */
const PIPELINE_ORDER = ['failed', 'canceled', 'running', 'pending', 'created', 'manual', 'scheduled', 'skipped', 'success']

export function pipelineRank(status: string | null): number | null {
  if (status === null) return null
  const i = PIPELINE_ORDER.indexOf(status)
  return i < 0 ? PIPELINE_ORDER.length : i
}

export interface PipelineStage {
  stage: string
  status: string
  /** The status with underscores as spaces, and "not started" for created. */
  label: string
  /** "{stage}: {label}" and one line "{job}: {label}" per job. */
  tooltip: string
  ariaLabel: string
  /** The url of the job that decided the stage status. */
  url: string | null
}

/** One entry per stage, in the order the stages first appear among the jobs. */
const STAGE_ORDER = [
  'failed',
  'running',
  'pending',
  'preparing',
  'waiting_for_resource',
  'canceled',
  'warning',
  'success',
  'scheduled',
  'manual',
  'created',
  'skipped'
]
const statusLabel = (status: string): string => (status === 'created' ? 'not started' : status.replace(/_/g, ' '))
const jobStatus = (j: PipelineJob): string => (j.status === 'failed' && j.allowFailure ? 'warning' : j.status)

export function pipelineStages(jobs: PipelineJob[]): PipelineStage[] {
  const byStage = new Map<string, PipelineJob[]>()
  for (const j of jobs) byStage.set(j.stage, [...(byStage.get(j.stage) ?? []), j])
  return [...byStage].map(([stage, list]) => {
    const known = list.map((j) => STAGE_ORDER.indexOf(jobStatus(j))).filter((n) => n >= 0)
    const status = known.length > 0 ? STAGE_ORDER[Math.min(...known)] : jobStatus(list[0])
    const label = statusLabel(status)
    return {
      stage,
      status,
      label,
      tooltip: [`${stage}: ${label}`, ...list.map((j) => `${j.name}: ${statusLabel(j.status)}`)].join('\n'),
      ariaLabel: `Stage ${stage}: ${label}`,
      url: list.find((j) => jobStatus(j) === status)?.url ?? null
    }
  })
}

export type MrSortKey =
  'mr' | 'stack' | 'title' | 'repo' | 'pipeline' | 'author' | 'reviewers' | 'approved' | 'review' | 'comments' | 'created' | 'updated' | 'merged' | 'state'

export interface MrSortRow {
  iid: number
  stackRank: number | null
  title: string
  repo: string
  /** The display name, or the user name when no name is known. */
  authorName: string
  approverCount: number
  /** Null when the reviewers are not known. */
  reviewerCount: number | null
  pipelineStatus: string | null
  /** YourReview.order */
  reviewOrder: number
  /** CommentsCell.sort */
  commentsSort: number | null
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  state: ChangeState
  draft: boolean
}

export function mrSortValue(row: MrSortRow, key: MrSortKey): string | number | null {
  switch (key) {
    case 'mr':
      return row.iid
    case 'stack':
      return row.stackRank
    case 'title':
      return row.title.toLowerCase()
    case 'repo':
      return row.repo
    case 'pipeline':
      return pipelineRank(row.pipelineStatus)
    case 'author':
      return row.authorName.toLowerCase()
    case 'reviewers':
      return row.reviewerCount
    case 'approved':
      return row.approverCount
    case 'review':
      return row.reviewOrder
    case 'comments':
      return row.commentsSort
    case 'created':
      return row.createdAt || null
    case 'updated':
      return row.updatedAt
    case 'merged':
      return row.mergedAt
    case 'state':
      return ['draft', 'opened', 'merged', 'closed'].indexOf(mrStateKey(row))
  }
}

/** An empty value sorts first. Text sorts without regard to case, numbers and dates as numbers. */
export function compareValues(x: string | number | null, y: string | number | null): number {
  if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
}

export const DEFAULT_MR_SORT: { key: MrSortKey; dir: 'asc' | 'desc' } = { key: 'created', dir: 'asc' }

/** Reads the stored sort. Nothing, bad JSON, an unknown key (an old one such as "branch") or a bad direction gives the default. The stored text "null" gives null: the order of the review. */
export const SORT_KEYS: MrSortKey[] = [
  'mr',
  'stack',
  'title',
  'repo',
  'pipeline',
  'author',
  'reviewers',
  'approved',
  'review',
  'comments',
  'created',
  'updated',
  'merged',
  'state'
]

export function parseStoredMrSort(raw: string | null): { key: MrSortKey; dir: 'asc' | 'desc' } | null {
  if (raw === 'null') return null
  try {
    const v = JSON.parse(raw ?? 'null') as { key?: unknown; dir?: unknown } | null
    return v && SORT_KEYS.includes(v.key as MrSortKey) && (v.dir === 'asc' || v.dir === 'desc') ? { key: v.key as MrSortKey, dir: v.dir } : DEFAULT_MR_SORT
  } catch {
    return DEFAULT_MR_SORT
  }
}
