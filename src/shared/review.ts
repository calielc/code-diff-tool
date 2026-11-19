import type { CombinedPart, FileObject } from './diff'
import type { IssueRow } from './issues'
import { parseChangeUrl, changeKey, type ChangeInfo, type ChangeRef, type ChangeSnapshot, type Provider } from './provider'

export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
export const MAX_URLS = 20
export const MAX_ISSUES = 20

/** One MR or PR of a review, as saved in review.json. */
export interface ReviewMr {
  provider: Provider
  host: string
  projectPath: string
  iid: number
}

export interface SkippedMr {
  key: string
  url: string
  title: string
  reason: string
}

/** review.json (file 00 section 4.2). `provider` and `host` are new, and absent means GitLab at gitlab.com. */
export interface ReviewFile {
  title?: string
  mrs: ReviewMr[]
  skipped: SkippedMr[]
  /** The issue keys, in the order they joined the review. */
  issues: string[]
}

export const NO_CLONE_REASON = 'no local clone in the workspace'

/** The message for a slug, or null when it is valid (file 07 section 6.4). */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'Enter a slug, for example the issue key.'
  if (!SLUG_RE.test(slug)) return `'${slug}' is not a slug: use letters, digits, '.', '_' and '-' only, starting with a letter or digit.`
  return null
}

export interface LineError {
  line: number
  text: string
  message: string
}

export interface ParsedUrls {
  refs: ChangeRef[]
  errors: LineError[]
  duplicates: number
}

/** Split the MR box into URLs (new lines or spaces) and parse each. The same project and number count once. */
export function parseUrlBox(text: string): ParsedUrls {
  const refs: ChangeRef[] = []
  const errors: LineError[] = []
  const seen = new Set<string>()
  let duplicates = 0
  text.split(/\r?\n/).forEach((lineText, i) => {
    for (const item of lineText.split(/\s+/).filter(Boolean)) {
      const ref = parseChangeUrl(item)
      if (!ref) {
        errors.push({ line: i + 1, text: item, message: `Line ${i + 1}: '${item}' is not a merge request or pull request URL.` })
        continue
      }
      const id = `${ref.host}|${changeKey(ref).toLowerCase()}`
      if (seen.has(id)) duplicates++
      else {
        seen.add(id)
        refs.push(ref)
      }
    }
  })
  return { refs, errors, duplicates }
}

const KEY_RE = /^(?<project>[A-Za-z][A-Za-z0-9_]*?)-?(?<number>\d+)$/
const JIRA_URL_RE = /^https:\/\/[^/]+\.atlassian\.net(?:\/.*?)?(?:\/browse\/|\/issues\/|[?&]selectedIssue=)(?<key>[A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#&].*)?$/

/** "lx2813" and "LX-2813" give "LX-2813". A Jira URL that names a key gives that key. */
export function parseIssueKey(value: string): string | null {
  const url = JIRA_URL_RE.exec(value)
  const raw = url?.groups?.key ?? value
  const m = KEY_RE.exec(raw)
  return m?.groups ? `${m.groups.project.toUpperCase()}-${m.groups.number}` : null
}

export interface ParsedIssues {
  keys: string[]
  errors: string[]
  merged: number
}

/** The issue box takes values separated by new lines, spaces or commas (file 07 section 6.3). */
export function parseIssueBox(text: string): ParsedIssues {
  const keys: string[] = []
  const errors: string[] = []
  let merged = 0
  for (const value of text.split(/[\s,]+/).filter(Boolean)) {
    const key = parseIssueKey(value)
    if (!key) errors.push(`'${value}' is not an issue key or URL, such as LX-2813.`)
    else if (keys.includes(key)) merged++
    else keys.push(key)
  }
  return { keys, errors, merged }
}

/** A line of the check list: `<repo>!<iid> (<state>[, draft]) <title>` (file 07 section 6.5 rule 4). */
export interface CheckedMr {
  key: string
  url: string
  title: string
  state: ChangeInfo['state']
  draft: boolean
  /** Folder name of the clone in the workspace, or null when there is none. */
  clone: string | null
  skipped: string | null
  ref: ChangeRef
}

export interface CheckResult {
  mrs: CheckedMr[]
  /** The slug already has a review. */
  slugExists: boolean
}

export type ReviewFlowState = 'writing' | 'failed' | 'ready' | 'not-written'

export interface ReviewSummary {
  slug: string
  title: string | null
  mrCount: number | null
  issueCount: number | null
  /** Modification time of review.json, ISO 8601. */
  modifiedAt: string
  openedAt: string | null
  flow: ReviewFlowState
  /** Set when review.json cannot be read. */
  unreadable: boolean
}

/** Stages of the build progress screen (file 07 section 7.2). */
export type StageId = 'clones' | 'login' | 'issues' | 'reading' | 'fetching' | 'diffing' | 'preparing'
export type StageState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed'
export interface BuildStage {
  id: StageId
  label: string
  state: StageState
  detail: string | null
}
export interface BuildProgress {
  slug: string
  /** Position in the queue, 0 when the build runs. */
  queued: number
  stages: BuildStage[]
  /** 0 to 1, including the fraction of items inside the running stage. */
  fraction: number
  startedAt: number
}

export interface BuiltMr {
  key: string
  /** Folder name of the clone. */
  repo: string
  snapshot: ChangeSnapshot
  /** True for a closed change, which gets no diff. */
  noDiff: boolean
  /** The changed files with their three levels. Empty for a closed change. */
  files: FileObject[]
}

export interface BuildResult {
  generatedAt: string
  title: string
  viewer: string
  mrs: BuiltMr[]
  /** The combined diff of repos with two or more live changes. */
  combined: CombinedPart[]
  skipped: SkippedMr[]
  /** One row per issue, in the order they joined the review. An issue Jira did not give has an error. */
  issues: IssueRow[]
}

export const STAGE_LABELS: Record<StageId, string> = {
  clones: 'Finding the local clones',
  login: 'Checking your login',
  issues: 'Reading Jira issues',
  reading: 'Reading code changes',
  fetching: 'Fetching missing commits',
  diffing: 'Diffing the files',
  preparing: 'Preparing the review'
}

/** The title of a review: the saved title, or the slug. */
export const reviewTitle = (slug: string, file: { title?: string } | null): string => file?.title?.trim() || slug
