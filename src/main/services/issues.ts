import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_ISSUES, parseIssueKey } from '@shared/review'
import { issueFile, type IssueData, type IssueRow } from '@shared/issues'
import { MAX_SPEC_BYTES, isJiraKey, isSpecFileName, specCriteria, specKey, specTitle, specToText } from '@shared/spec-files'
import type { Result } from '@shared/types'
import { readIssue, type JiraAccess } from '../clients/jira'
import { withLock } from './lock'
import { setSummaryJiraAccess, summariesOf } from './summaries'
import { atomicWrite, readReviewFile, reviewDir } from './reviews'

let accessProvider: () => JiraAccess | null = () => null

/** The main process registers the saved Jira access. Tests register their own. */
export function setJiraAccessProvider(fn: () => JiraAccess | null): void {
  accessProvider = fn
  setSummaryJiraAccess(fn) // attachment downloads use the same access
}

/** The part of an issue the window shows. The comments and attachments stay in the main process. */
export const toRow = (t: IssueData): IssueRow => ({
  source: t.source,
  key: t.key,
  url: t.url,
  type: t.type,
  title: t.title,
  status: t.status,
  assignee: t.assignee,
  description: t.description,
  criteria: t.criteria,
  error: t.error
})

/** The copy of every spec file of a review. A review keeps its own copy, so it still opens when the original moves. */
export const specsDir = (root: string, slug: string): string => join(reviewDir(root, slug), 'specs')

/** Read one spec file of a review as an issue. */
export async function readSpecIssue(root: string, slug: string, key: string): Promise<IssueData> {
  const base: IssueData = {
    source: 'file',
    key,
    url: null,
    type: 'Spec',
    title: key,
    status: null,
    assignee: null,
    description: '',
    criteria: [],
    error: null,
    updated: null,
    comments: [],
    attachments: []
  }
  try {
    const path = join(specsDir(root, slug), key)
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const text = specToText(key, raw)
    return { ...base, title: specTitle(key, text), description: text, criteria: specCriteria(text), updated: info.mtime.toISOString() }
  } catch (e) {
    return {
      ...base,
      error:
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'The file is missing from the review folder.'
          : `The file cannot be read: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** Read every issue at the same time, Jira issues over the web and spec files from disk. The order follows the keys. */
export function readIssues(root: string, slug: string, keys: string[]): Promise<IssueData[]> {
  const access = accessProvider()
  return Promise.all(keys.map((k) => (isJiraKey(k) ? readIssue(access, k) : readSpecIssue(root, slug, k))))
}

// What the last build read, so the detail panel does not ask Jira again for every click.
const memory = new Map<string, Map<string, IssueData>>()
export function rememberIssues(slug: string, list: IssueData[]): void {
  memory.set(slug, new Map(list.map((t) => [t.key, t])))
}

/** The Markdown file of one issue (file 01 section 3.6). */
export async function getIssueFile(root: string, slug: string, key: string): Promise<Result<string>> {
  const review = await readReviewFile(root, slug)
  if (!review.ok) return { ok: false, error: 'The review is not loaded: open it again.' }
  if (!review.value.issues.includes(key)) return { ok: false, error: `${key} is not an issue of this review.` }
  let data = memory.get(slug)?.get(key)
  if (!data) {
    ;[data] = await readIssues(root, slug, [key])
    memory.set(slug, (memory.get(slug) ?? new Map()).set(key, data))
  }
  // The file waits for the summary step of the review, which can take minutes (file 01 section 3.3).
  const found = (await summariesOf(slug)).get(key)
  return { ok: true, value: issueFile(data, found?.summary ?? null, found?.reason ?? 'no summary has been written yet') }
}

export interface AddIssuesResult {
  added: string[]
  problems: Record<string, string>
}

/**
 * Add Jira issues to a review (file 01 section 3.9). 1 to 20 values. A value that is not a key is a problem. Every key is read
 * at the same time, then, under the lock, a key already in the review is a problem, a failed read is a problem with its
 * error, and the rest are appended. The review file is written once.
 */
export async function addIssues(root: string, slug: string, values: string[]): Promise<Result<AddIssuesResult>> {
  const trimmed = values.map((v) => v.trim()).filter(Boolean)
  if (trimmed.length === 0 || trimmed.length > MAX_ISSUES) return { ok: false, error: `Send 1 to ${MAX_ISSUES} Jira issue keys or URLs.` }
  const problems: Record<string, string> = {}
  const keys: string[] = []
  for (const v of trimmed) {
    const key = parseIssueKey(v)
    if (!key) problems[v] = 'Not a Jira issue key or URL.'
    else if (!keys.includes(key)) keys.push(key) // one key counts once however many forms it came in
  }
  const read = await readIssues(root, slug, keys)
  return withLock(async () => {
    const review = await readReviewFile(root, slug)
    if (!review.ok) return review
    const added: string[] = []
    read.forEach((t, i) => {
      const key = keys[i]
      if (review.value.issues.includes(key)) problems[key] = 'Already in this review.'
      else if (t.error) problems[key] = t.error
      else {
        review.value.issues.push(key)
        added.push(key)
      }
    })
    if (added.length > 0) await atomicWrite(join(reviewDir(root, slug), 'review.json'), JSON.stringify(review.value))
    return { ok: true as const, value: { added, problems } }
  })
}

/**
 * Add spec files to a review as issues. A file must be .md, .txt or .html, at most 1 MB, and text. The review keeps its
 * own copy under `specs/`, and the file name is the issue key. The paths come from the file dialog of the main process.
 */
export async function addSpecFiles(root: string, slug: string, paths: string[]): Promise<Result<AddIssuesResult>> {
  if (paths.length === 0 || paths.length > MAX_ISSUES) return { ok: false, error: `Send 1 to ${MAX_ISSUES} spec files.` }
  return withLock(async () => {
    const review = await readReviewFile(root, slug)
    if (!review.ok) return review
    const added: string[] = []
    const problems: Record<string, string> = {}
    for (const path of paths) {
      const key = specKey(path)
      if (!isSpecFileName(key)) {
        problems[key || path] = 'Only .md, .txt and .html files can be added.'
        continue
      }
      if (review.value.issues.some((k) => k.toLowerCase() === key.toLowerCase())) {
        problems[key] = 'Already in this review.'
        continue
      }
      try {
        const info = await stat(path)
        if (!info.isFile()) throw new Error('This is not a file.')
        if (info.size > MAX_SPEC_BYTES) {
          problems[key] = 'The file is larger than 1 MB.'
          continue
        }
        const bytes = await readFile(path)
        if (bytes.subarray(0, 8000).includes(0)) {
          problems[key] = 'This is not a text file.'
          continue
        }
        await atomicWrite(join(specsDir(root, slug), key), bytes.toString('utf8'))
        review.value.issues.push(key)
        added.push(key)
      } catch (e) {
        problems[key] = `The file cannot be read: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    if (added.length > 0) await atomicWrite(join(reviewDir(root, slug), 'review.json'), JSON.stringify(review.value))
    return { ok: true as const, value: { added, problems } }
  })
}
