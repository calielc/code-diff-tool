import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, lstat, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { z } from 'zod'
import type { ChangeRef } from '@shared/provider'
import { changeKey } from '@shared/provider'
import {
  MAX_ISSUES,
  MAX_URLS,
  NO_CLONE_REASON,
  SLUG_RE,
  parseIssueBox,
  parseUrlBox,
  reviewTitle,
  slugProblem,
  type CheckResult,
  type CheckedMr,
  type ReviewFile,
  type ReviewFlowState,
  type ReviewSummary
} from '@shared/review'
import type { Result } from '@shared/types'
import { readInfo } from '../clients/forge'
import { locateClone, scanClones } from './workspace'

/** All state lives in the workspace root under `.code-diff/`, which git can ignore. */
export const stateDir = (root: string): string => join(root, '.code-diff')
export const reviewsDir = (root: string): string => join(stateDir(root), 'reviews')
export const reviewDir = (root: string, slug: string): string => join(reviewsDir(root), slug)

/** Temporary file then rename (file 05 section 6.6). */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

const reviewSchema = z.object({
  title: z.string().optional(),
  mrs: z.array(
    z.object({
      provider: z.enum(['gitlab', 'github']).default('gitlab'),
      host: z.string().default('gitlab.com'),
      projectPath: z.string(),
      iid: z.number().int().positive()
    })
  ),
  skipped: z.array(z.object({ key: z.string(), url: z.string(), title: z.string(), reason: z.string() })).default([]),
  issues: z.array(z.string()).default([])
})

export async function readReviewFile(root: string, slug: string): Promise<Result<ReviewFile>> {
  if (!SLUG_RE.test(slug)) return { ok: false, error: `'${slug}' is not a slug.` }
  try {
    const raw = await readFile(join(reviewDir(root, slug), 'review.json'), 'utf8')
    return { ok: true, value: reviewSchema.parse(JSON.parse(raw)) as ReviewFile }
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return { ok: false, error: missing ? 'No such review.' : 'review.json cannot be read' }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function flowState(dir: string): Promise<ReviewFlowState> {
  if (await exists(join(dir, 'flow-error.txt'))) return 'failed'
  try {
    JSON.parse(await readFile(join(dir, 'flow.json'), 'utf8'))
    return 'ready'
  } catch {
    return 'not-written'
  }
}

/** The folders of reviews/ that hold a readable or unreadable review.json. Files and links are not reviews. */
export async function listReviews(root: string, recent: { slug: string; openedAt: string }[]): Promise<ReviewSummary[]> {
  let entries
  try {
    entries = await readdir(reviewsDir(root), { withFileTypes: true })
  } catch {
    return []
  }
  const out: ReviewSummary[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue
    const dir = reviewDir(root, e.name)
    const file = join(dir, 'review.json')
    if (!(await exists(file))) continue
    const modifiedAt = (await stat(file)).mtime.toISOString()
    const openedAt = recent.find((r) => r.slug === e.name)?.openedAt ?? null
    const parsed = await readReviewFile(root, e.name)
    if (!parsed.ok) {
      out.push({ slug: e.name, title: null, mrCount: null, issueCount: null, modifiedAt, openedAt, flow: 'not-written', unreadable: true })
      continue
    }
    out.push({
      slug: e.name,
      title: parsed.value.title?.trim() || null,
      mrCount: parsed.value.mrs.length, // a skipped MR does not count
      issueCount: parsed.value.issues.length,
      modifiedAt,
      openedAt,
      flow: await flowState(dir),
      unreadable: false
    })
  }
  return out
}

export interface CheckInput {
  urls: string
  issues: string
  slug: string
}

/**
 * Step 1 of creation: read each change in order, find its clone, and run the checks (file 00 section 3.3.5).
 * A failed read stops the check with `<url>: <message>`.
 */
export async function checkReview(root: string, input: CheckInput, onProgress?: (done: number, total: number) => void): Promise<Result<CheckResult>> {
  const urls = parseUrlBox(input.urls)
  const issues = parseIssueBox(input.issues)
  if (urls.refs.length === 0 && urls.errors.length === 0) return { ok: false, error: 'Enter at least one merge request or pull request URL.' }
  if (urls.errors.length > 0) return { ok: false, error: urls.errors[0].message }
  if (urls.refs.length > MAX_URLS) return { ok: false, error: `Send 1 to ${MAX_URLS} URLs.` }
  if (issues.errors.length > 0) return { ok: false, error: issues.errors[0] }
  if (issues.keys.length > MAX_ISSUES) return { ok: false, error: `Send 1 to ${MAX_ISSUES} issue keys or URLs.` }
  const problem = slugProblem(input.slug)
  if (problem) return { ok: false, error: problem }

  const clones = await scanClones(root)
  const mrs: CheckedMr[] = []
  for (const ref of urls.refs) {
    onProgress?.(mrs.length, urls.refs.length)
    let info
    try {
      info = await readInfo(ref)
    } catch (e) {
      return { ok: false, error: `${urlOf(ref)}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const clone = await locateClone(root, clones, ref)
    mrs.push({
      key: `${clone?.name ?? ref.project}!${ref.iid}`,
      url: info.url,
      title: info.title,
      state: info.state,
      draft: info.draft,
      clone: clone?.name ?? null,
      skipped: clone ? null : NO_CLONE_REASON,
      ref
    })
  }
  onProgress?.(mrs.length, urls.refs.length)

  // A merged change counts as live. Closed ones get no diff.
  if (!mrs.some((m) => !m.skipped && m.state !== 'closed')) {
    return { ok: false, error: 'No change to review: every merge or pull request is closed or has no clone in the workspace.' }
  }
  return { ok: true, value: { mrs, slugExists: await exists(join(reviewDir(root, input.slug), 'review.json')) } }
}

const urlOf = (r: ChangeRef): string => `https://${r.host}/${r.project}${r.provider === 'gitlab' ? '/-/merge_requests/' : '/pull/'}${r.iid}`

export interface CreateInput extends CheckInput {
  title: string
  overwrite: boolean
}

/** Step 2: write review.json and nothing else (file 00 section 3.3.6). Comments, flow and Claude results of an old review stay. */
export async function createReview(root: string, input: CreateInput): Promise<Result<{ slug: string }>> {
  const checked = await checkReview(root, input)
  if (!checked.ok) return checked
  if (checked.value.slugExists && !input.overwrite) return { ok: false, error: `A review named "${input.slug}" exists.` }
  const issues = parseIssueBox(input.issues).keys
  const file: ReviewFile = {
    title: input.title.trim() || input.slug,
    mrs: checked.value.mrs.filter((m) => !m.skipped).map((m) => ({ provider: m.ref.provider, host: m.ref.host, projectPath: m.ref.project, iid: m.ref.iid })),
    skipped: checked.value.mrs.filter((m) => m.skipped).map((m) => ({ key: m.key, url: m.url, title: m.title, reason: m.skipped as string })),
    issues
  }
  await atomicWrite(join(reviewDir(root, input.slug), 'review.json'), JSON.stringify(file)) // one line, no indentation
  return { ok: true, value: { slug: input.slug } }
}

export interface AddToInput {
  slug: string
  urls: string
  issues: string
}

/** Add changes and issues to an existing review. What the review holds already is kept, and nothing is added twice. */
export async function addToReview(root: string, input: AddToInput): Promise<Result<{ slug: string; addedChanges: number; addedIssues: number }>> {
  const existing = await readReviewFile(root, input.slug)
  if (!existing.ok) return existing
  const urls = parseUrlBox(input.urls)
  const issues = parseIssueBox(input.issues)
  if (urls.errors.length > 0) return { ok: false, error: urls.errors[0].message }
  if (issues.errors.length > 0) return { ok: false, error: issues.errors[0] }
  if (urls.refs.length === 0 && issues.keys.length === 0) return { ok: false, error: 'Nothing to add: give a merge or pull request URL or an issue key.' }
  const file: ReviewFile = { ...existing.value, mrs: [...existing.value.mrs], skipped: [...existing.value.skipped], issues: [...existing.value.issues] }
  const same = (a: { host: string; projectPath: string; iid: number }, b: ChangeRef): boolean =>
    a.host === b.host && a.projectPath === b.project && a.iid === b.iid
  const fresh = urls.refs.filter((r) => !file.mrs.some((m) => same(m, r)))
  let addedChanges = 0
  if (fresh.length > 0) {
    const checked = await checkReview(root, { urls: fresh.map(urlOf).join('\n'), issues: '', slug: input.slug })
    if (!checked.ok) return checked
    for (const m of checked.value.mrs) {
      if (m.skipped) file.skipped.push({ key: m.key, url: m.url, title: m.title, reason: m.skipped })
      else {
        file.mrs.push({ provider: m.ref.provider, host: m.ref.host, projectPath: m.ref.project, iid: m.ref.iid })
        addedChanges++
      }
    }
  }
  const newIssues = issues.keys.filter((k) => !file.issues.includes(k))
  file.issues.push(...newIssues)
  if (addedChanges === 0 && newIssues.length === 0 && fresh.length === 0) return { ok: false, error: 'Everything you gave is in the review already.' }
  await atomicWrite(join(reviewDir(root, input.slug), 'review.json'), JSON.stringify(file))
  return { ok: true, value: { slug: input.slug, addedChanges, addedIssues: newIssues.length } }
}

/** The number of pending comments of a review (Phase 5 writes comments.json). */
export async function pendingCommentCount(root: string, slug: string): Promise<number> {
  try {
    const data = JSON.parse(await readFile(join(reviewDir(root, slug), 'comments.json'), 'utf8')) as Record<string, unknown>
    return Object.keys(data).length
  } catch {
    return 0
  }
}

/**
 * The checks before a delete, in the spec's order (file 07 section 5.6 rule 4). Returns the folder to move
 * to the trash, or the message for the first failing check.
 */
export async function checkDeletable(root: string, slug: string, isBuilding: (slug: string) => boolean): Promise<Result<string>> {
  if (!SLUG_RE.test(slug)) return { ok: false, error: `'${slug}' is not a slug.` }
  const dir = reviewDir(root, slug)
  try {
    // A link is refused first, because its real path would point somewhere else and hide the cause.
    if ((await lstat(dir)).isSymbolicLink()) return { ok: false, error: `${slug} is a link, so the app will not delete it.` }
    const real = await realpath(dir)
    const parent = await realpath(reviewsDir(root))
    if (dirname(real) !== parent || !real.startsWith(parent + sep)) {
      return { ok: false, error: 'The folder is not inside the reviews folder, so the app will not delete it.' }
    }
  } catch {
    return { ok: false, error: 'No such review.' }
  }
  if (isBuilding(slug)) return { ok: false, error: 'The review is building. Cancel the build first.' }
  return { ok: true, value: dir }
}

export { reviewTitle, changeKey, rm }
