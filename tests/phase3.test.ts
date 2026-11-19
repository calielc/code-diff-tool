import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelBuild, isBuilding, startBuild } from '../src/main/services/build'
import { checkDeletable, checkReview, createReview, listReviews, reviewDir } from '../src/main/services/reviews'
import { resetWorkspaceCache } from '../src/main/services/workspace'
import { resetViewerCache } from '../src/main/clients/gitlab'
import { parseIssueBox, parseUrlBox, slugProblem } from '../src/shared/review'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

let root: string
let forge: FakeForge
let fixtureNow: Record<string, any> = {}
let shas: { a: string; b: string }

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A clone with two real commits and an origin remote, like a developer's checkout. */
function makeClone(rel: string, remote: string): { a: string; b: string } {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'remote', 'add', 'origin', remote)
  writeFileSync(join(dir, 'f.txt'), '1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'one')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'f.txt'), '2\n')
  git(dir, 'commit', '-qam', 'two')
  return { a, b: git(dir, 'rev-parse', 'HEAD') }
}

function mrFixture(project: string, iid: number, state: string, base: string, head: string, extra: object = {}): Record<string, unknown> {
  const p = encodeURIComponent(project)
  const k = `projects/${p}/merge_requests/${iid}`
  return {
    [`GET ${k}`]: {
      json: {
        web_url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
        state,
        title: `T${iid}`,
        draft: false,
        author: { username: 'ann' },
        source_branch: 's',
        target_branch: 'main',
        diff_refs: { base_sha: base, start_sha: base, head_sha: head }
      },
      ...extra
    },
    [`GET ${k}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET ${k}/discussions`]: { json: [] },
    [`GET ${k}/reviewers`]: { json: [] }
  }
}

function setFixture(f: Record<string, unknown>): void {
  fixtureNow = { 'GET user': { json: { username: 'me' } }, ...f }
  forge.setFixture(fixtureNow)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codediff-p3-'))
  shas = makeClone('backend/x', 'git@gitlab.com:team/backend/x.git')
  forge = await useFakeForge()
  resetWorkspaceCache()
  resetViewerCache()
})
afterEach(async () => {
  await stopFakeForge(forge)
})

const URL_X = 'https://gitlab.com/team/backend/x/-/merge_requests/12'
const URL_OTHER = 'https://gitlab.com/team/other/-/merge_requests/7'

describe('form parsing (file 07 section 6)', () => {
  it('accepts URL suffixes, merges duplicates and reports bad lines with their number', () => {
    const r = parseUrlBox(`${URL_X}/diffs?tab=1\n${URL_X} https://example.com/x\n`)
    expect(r.refs).toHaveLength(1)
    expect(r.refs[0]).toMatchObject({ project: 'team/backend/x', iid: 12 })
    expect(r.duplicates).toBe(1)
    expect(r.errors[0].message).toBe("Line 2: 'https://example.com/x' is not a merge request or pull request URL.")
  })
  it('reads GitHub pull request URLs in the same box', () => {
    expect(parseUrlBox('https://github.com/o/r/pull/3').refs[0]).toMatchObject({ provider: 'github', project: 'o/r', iid: 3 })
  })
  it('turns lx2813, LX-2813 and a Jira URL into one key', () => {
    const r = parseIssueBox('lx2813, LX-2813 https://acme.atlassian.net/browse/LX-2813')
    expect(r.keys).toEqual(['LX-2813'])
    expect(r.merged).toBe(2)
    expect(parseIssueBox('issue').errors).toEqual(["'issue' is not an issue key or URL, such as LX-2813."])
  })
  it('validates slugs', () => {
    expect(slugProblem('LX-2720.v2')).toBeNull()
    expect(slugProblem('-bad')).toContain('is not a slug')
    expect(slugProblem('a b')).toContain('is not a slug')
    expect(slugProblem('')).toBe('Enter a slug, for example the issue key.')
  })
})

describe('check and create', () => {
  it('lists a change with no clone as skipped and a merged one as included', async () => {
    setFixture({ ...mrFixture('team/backend/x', 12, 'merged', shas.a, shas.b), ...mrFixture('team/other', 7, 'opened', shas.a, shas.b) })
    const r = await checkReview(root, { urls: `${URL_X}\n${URL_OTHER}`, issues: '', slug: 'LX-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.mrs.map((m) => [m.key, m.state, m.skipped])).toEqual([
      ['backend/x!12', 'merged', null],
      ['team/other!7', 'opened', 'no local clone in the workspace']
    ])
  })
  it('refuses when every change is closed', async () => {
    setFixture(mrFixture('team/backend/x', 12, 'closed', shas.a, shas.b))
    const r = await checkReview(root, { urls: URL_X, issues: '', slug: 'LX-1' })
    expect(r).toEqual({ ok: false, error: 'No change to review: every merge or pull request is closed or has no clone in the workspace.' })
  })
  it('shows a failed read as <url>: <message>', async () => {
    setFixture({ [`GET projects/team%2Fbackend%2Fx/merge_requests/12`]: { fail: 'HTTP 404 Not Found' } })
    const r = await checkReview(root, { urls: URL_X, issues: '', slug: 'LX-1' })
    expect(r).toEqual({ ok: false, error: `${URL_X}: HTTP 404 Not Found` })
  })
  it('writes review.json on one line, asks before replacing, and keeps the old files', async () => {
    setFixture({ ...mrFixture('team/backend/x', 12, 'opened', shas.a, shas.b), ...mrFixture('team/other', 7, 'opened', shas.a, shas.b) })
    const input = { urls: `${URL_X}\n${URL_OTHER}`, issues: 'lx2813', slug: 'LX-1', title: '  ', overwrite: false }
    expect(await createReview(root, input)).toEqual({ ok: true, value: { slug: 'LX-1' } })
    const text = readFileSync(join(reviewDir(root, 'LX-1'), 'review.json'), 'utf8')
    expect(text.includes('\n')).toBe(false)
    const file = JSON.parse(text)
    expect(file.title).toBe('LX-1') // an empty title means the slug
    expect(file.mrs).toEqual([{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }])
    expect(file.skipped[0]).toMatchObject({ key: 'team/other!7', reason: 'no local clone in the workspace' })
    expect(file.issues).toEqual(['LX-2813'])
    writeFileSync(join(reviewDir(root, 'LX-1'), 'comments.json'), '{"a":{}}')
    const again = await createReview(root, input)
    expect(again.ok).toBe(false)
    expect((await createReview(root, { ...input, overwrite: true })).ok).toBe(true)
    expect(existsSync(join(reviewDir(root, 'LX-1'), 'comments.json'))).toBe(true)
  })
})

describe('list and delete checks', () => {
  it('lists reviews, marks an unreadable one, and ignores files', async () => {
    mkdirSync(reviewDir(root, 'good'), { recursive: true })
    writeFileSync(join(reviewDir(root, 'good'), 'review.json'), JSON.stringify({ title: 'Good', mrs: [{ projectPath: 'a/b', iid: 1 }], issues: ['LX-1'] }))
    mkdirSync(reviewDir(root, 'bad'), { recursive: true })
    writeFileSync(join(reviewDir(root, 'bad'), 'review.json'), '{ nope')
    writeFileSync(join(reviewDir(root, '..'), 'settings.json'), '{}')
    const list = await listReviews(root, [{ slug: 'good', openedAt: '2026-11-19T09:41:00.000Z' }])
    const by = Object.fromEntries(list.map((r) => [r.slug, r]))
    expect(Object.keys(by).sort()).toEqual(['bad', 'good'])
    expect(by.good).toMatchObject({ title: 'Good', mrCount: 1, issueCount: 1, openedAt: '2026-11-19T09:41:00.000Z', unreadable: false })
    expect(by.bad).toMatchObject({ unreadable: true, mrCount: null })
  })
  it('refuses a link, a bad slug and a building review', async () => {
    mkdirSync(reviewDir(root, 'real'), { recursive: true })
    writeFileSync(join(reviewDir(root, 'real'), 'review.json'), '{"mrs":[]}')
    expect((await checkDeletable(root, 'real', () => false)).ok).toBe(true)
    expect(await checkDeletable(root, 'real', () => true)).toEqual({ ok: false, error: 'The review is building. Cancel the build first.' })
    expect(await checkDeletable(root, '../x', () => false)).toEqual({ ok: false, error: "'../x' is not a slug." })
    const target = mkdtempSync(join(tmpdir(), 'codediff-link-'))
    symlinkSync(target, reviewDir(root, 'linked'), 'junction')
    expect(await checkDeletable(root, 'linked', () => false)).toEqual({ ok: false, error: 'linked is a link, so the app will not delete it.' })
  })
})

describe('build', () => {
  async function review(slug: string, mrs: unknown[]): Promise<void> {
    mkdirSync(reviewDir(root, slug), { recursive: true })
    writeFileSync(join(reviewDir(root, slug), 'review.json'), JSON.stringify({ title: 'Rev', mrs, skipped: [], issues: [] }))
  }
  const mr = { provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }

  it('reads the change and skips the fetch when the commits are present', async () => {
    setFixture(mrFixture('team/backend/x', 12, 'opened', shas.a, shas.b))
    await review('r1', [mr])
    const events: { fraction: number; stages: { id: string; state: string }[] }[] = []
    const r = await startBuild(root, 'r1', (p) => events.push(p))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.mrs[0]).toMatchObject({ key: 'backend/x!12', repo: 'backend/x', noDiff: false })
    expect(r.value.viewer).toBe('me')
    const last = events.at(-1)!
    expect(last.fraction).toBe(1)
    expect(last.stages.find((s) => s.id === 'fetching')!.state).toBe('skipped')
    expect(isBuilding('r1')).toBe(false)
  })
  it('names the commit when it is missing even after a fetch', async () => {
    const missing = 'f'.repeat(40)
    setFixture(mrFixture('team/backend/x', 12, 'opened', shas.a, missing))
    await review('r2', [mr])
    const r = await startBuild(root, 'r2', () => undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/fetch|Commit f{40}/) // there is no reachable origin in the test
  })
  it('fails with the not-cloned message when the clone is gone', async () => {
    await review('r3', [{ ...mr, projectPath: 'team/gone' }])
    const r = await startBuild(root, 'r3', () => undefined)
    expect(r).toEqual({ ok: false, error: `team/gone has no local clone in ${root}. Clone it there, then retry.` })
  })
  it('runs one build at a time and cancels a running one fast', async () => {
    setFixture(mrFixture('team/backend/x', 12, 'opened', shas.a, shas.b))
    // make the MR read slow so the build is still running when it is canceled
    const slow = { ...fixtureNow }
    slow[`GET projects/team%2Fbackend%2Fx/merge_requests/12`] = { ...slow[`GET projects/team%2Fbackend%2Fx/merge_requests/12`], sleepMs: 30_000 }
    forge.setFixture(slow)
    await review('slow', [mr])
    await review('queued', [mr])
    const t0 = Date.now()
    const first = startBuild(root, 'slow', () => undefined)
    const positions: number[] = []
    const second = startBuild(root, 'queued', (p) => positions.push(p.queued))
    expect(isBuilding('queued')).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    expect(cancelBuild('slow')).toBe(true)
    expect(await first).toEqual({ ok: false, error: 'Canceled.' })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(positions[0]).toBe(1) // the second build waited in the queue
    cancelBuild('queued')
    expect(await second).toEqual({ ok: false, error: 'Canceled.' })
  }, 40_000)
})
