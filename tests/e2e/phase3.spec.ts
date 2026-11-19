import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

// The fake GitLab, GitHub and Jira of the current test. It is closed after each test.
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

interface Env {
  root: string
  ud: string
  fixture: string
}

/** A workspace with one real clone (two commits, origin on gitlab.com) and a fake forge. */
function makeEnv(): { env: Env; shas: { a: string; b: string } } {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e3-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'f.txt'), '1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'one')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'f.txt'), '2\n')
  git(dir, 'commit', '-qam', 'two')
  const b = git(dir, 'rev-parse', 'HEAD')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { env: { root, ud, fixture: join(base, 'fixture.json') }, shas: { a, b } }
}

function mr(project: string, iid: number, state: string, base: string, head: string, sleepMs = 0): Record<string, unknown> {
  const k = `projects/${encodeURIComponent(project)}/merge_requests/${iid}`
  return {
    [`GET ${k}`]: {
      json: {
        web_url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
        state,
        title: `Title ${iid}`,
        author: { username: 'ann' },
        source_branch: 'feat',
        target_branch: 'main',
        diff_refs: { base_sha: base, start_sha: base, head_sha: head }
      },
      ...(sleepMs ? { sleepMs } : {})
    },
    [`GET ${k}/approvals`]: { json: { approved_by: [{ user: { username: 'bob' } }], user_can_approve: true, user_has_approved: false } },
    [`GET ${k}/discussions`]: { json: [{ id: 'd'.repeat(40), notes: [{ id: 1, resolvable: true, resolved: false, body: 'x', author: { username: 'bob' } }] }] },
    [`GET ${k}/reviewers`]: { json: [] }
  }
}

async function launch(e: Env, fixture: Record<string, unknown>): Promise<ElectronApplication> {
  forge = await startFakeForge({ 'GET user': { json: { username: 'me' } }, ...(fixture as Record<string, any>) })
  return electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: e.ud, ...forgeEnv(forge.url) } as Record<string, string> })
}

const seed = (e: Env, slug: string, content: unknown | string, extra: Record<string, string> = {}): void => {
  const dir = join(e.root, '.code-diff', 'reviews', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), typeof content === 'string' ? content : JSON.stringify(content))
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text)
}

async function home(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  return page
}

test('an empty workspace shows the empty state', async () => {
  const { env } = makeEnv()
  const app = await launch(env, {})
  const page = await home(app)
  await expect(page.getByText('No reviews yet.')).toBeVisible()
  await expect(page.getByTestId('review-count')).toHaveText('0 reviews')
  await app.close()
})

test('the form shows its field messages before anything is read', async () => {
  const { env } = makeEnv()
  const app = await launch(env, {})
  const page = await home(app)
  await page.getByTestId('new-review').click()
  await page.getByTestId('check').click()
  await expect(page.getByTestId('url-error')).toHaveText('Enter at least one merge request or pull request URL.')
  await expect(page.getByTestId('slug-error')).toHaveText('Enter a slug, for example the issue key.')
  await page.getByTestId('urls').fill('https://example.com/nope')
  await expect(page.getByTestId('url-error').first()).toContainText("Line 1: 'https://example.com/nope' is not a merge request or pull request URL.")
  await page.getByTestId('slug').fill('-bad')
  await expect(page.getByTestId('slug-error')).toContainText("'-bad' is not a slug")
  await page.getByTestId('issues').fill('lx2813 LX-2813')
  await expect(page.getByText('1 merged into the same key.')).toBeVisible()
  await app.close()
})

test('creates a review from a merge request, builds it and shows the table', async () => {
  const { env, shas } = makeEnv()
  const app = await launch(env, { ...mr('team/backend/x', 12, 'opened', shas.a, shas.b), ...mr('team/other', 7, 'opened', shas.a, shas.b) })
  const page = await home(app)
  await page.getByTestId('new-review').click()
  await page.getByTestId('urls').fill('https://gitlab.com/team/backend/x/-/merge_requests/12/diffs?tab=1\nhttps://gitlab.com/team/other/-/merge_requests/7')
  await page.getByTestId('issues').fill('lx2813')
  await page.getByRole('button', { name: 'Use LX-2813' }).click()
  await page.getByTestId('check').click()
  const list = page.getByTestId('check-list')
  await expect(list).toContainText('backend/x!12 (opened) Title 12')
  await expect(list).toContainText('team/other!7 (skipped: no local clone in the workspace) Title 7')
  await expect(page.getByTestId('check-summary')).toHaveText('1 change will be in the review, 1 skipped.')
  await page.getByTestId('create').click()
  // the build finishes fast against the fake, so wait for the table
  const row = page.getByTestId('mr-backend/x!12')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Title 12')
  await expect(row).toContainText('feat → main')
  await expect(page.getByText('team/other!7 (no local clone in the workspace)')).toBeVisible()
  expect(existsSync(join(env.root, '.code-diff', 'reviews', 'LX-2813', 'review.json'))).toBe(true)
  // back home, the review is listed with one change and one issue
  await page.getByRole('button', { name: '← Reviews' }).click()
  const listed = page.getByTestId('review-LX-2813')
  await expect(listed).toContainText('LX-2813')
  await expect(listed.locator('td.num').first()).toHaveText('1')
  await app.close()
})

test('asks before replacing a review that exists', async () => {
  const { env, shas } = makeEnv()
  seed(env, 'LX-1', { title: 'Old', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], issues: [] }, { 'comments.json': '{}' })
  const app = await launch(env, mr('team/backend/x', 12, 'merged', shas.a, shas.b)) // a merged change counts as live
  const page = await home(app)
  await page.getByTestId('new-review').click()
  await page.getByTestId('urls').fill('https://gitlab.com/team/backend/x/-/merge_requests/12')
  await page.getByTestId('slug').fill('LX-1')
  await page.getByTestId('check').click()
  await expect(page.getByText('A review with this slug exists.')).toBeVisible()
  await page.getByTestId('create').click()
  await expect(page.getByRole('heading', { name: 'Replace review LX-1?' })).toBeVisible()
  await page.getByTestId('replace').click()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  expect(existsSync(join(env.root, '.code-diff', 'reviews', 'LX-1', 'comments.json'))).toBe(true) // the old files stay
  await app.close()
})

test('the Home list sorts, filters, counts and marks an unreadable review', async () => {
  const { env } = makeEnv()
  seed(env, 'LX-10', {
    title: 'Ten',
    mrs: [
      { projectPath: 'a/b', iid: 1 },
      { projectPath: 'a/b', iid: 2 }
    ],
    issues: []
  })
  seed(env, 'LX-2', { title: 'Two', mrs: [{ projectPath: 'a/b', iid: 3 }], issues: ['LX-2'] })
  seed(env, 'broken', '{ nope')
  seed(env, 'zz', { mrs: [], issues: [] }, { 'flow-error.txt': 'x' })
  const app = await launch(env, {})
  const page = await home(app)
  await expect(page.getByTestId('review-count')).toHaveText('4 reviews')
  await expect(page.getByTestId('showing')).toHaveText('Showing 4 of 4 reviews')
  await page.getByRole('button', { name: /^Slug/ }).click()
  const slugs = (): Promise<string[]> => page.locator('tbody tr td.strong').allTextContents()
  expect(await slugs()).toEqual(['broken', 'LX-2', 'LX-10', 'zz']) // LX-2 before LX-10
  await page.getByRole('button', { name: /^Changes/ }).click()
  await expect(page.getByRole('button', { name: 'Changes ▲' })).toBeVisible()
  await page.getByRole('button', { name: 'Changes ▲' }).click()
  await expect(page.getByRole('button', { name: 'Changes ▼' })).toBeVisible()
  expect((await slugs())[0]).toBe('LX-10')
  await expect(page.getByTestId('review-broken')).toContainText('Unreadable review.json')
  await page.getByTestId('review-broken').hover() // the row buttons show on hover or selection
  await expect(page.getByTestId('review-broken').getByRole('button', { name: 'Open' })).toBeDisabled()
  await expect(page.getByTestId('review-zz')).toContainText('Failed')
  await page.getByLabel('Filter reviews').fill('lx-1')
  await expect(page.getByTestId('showing')).toHaveText('Showing 1 of 4 reviews')
  await page.getByLabel('Flow state').selectOption('ready')
  await page.getByLabel('Filter reviews').fill('zzz')
  await expect(page.getByText('No review matches "zzz".')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(page.getByTestId('showing')).toHaveText('Showing 4 of 4 reviews')
  await app.close()
})

test('deleting needs a confirmation for pending comments and moves the folder away', async () => {
  const { env } = makeEnv()
  seed(env, 'LX-5', { title: 'Five', mrs: [], issues: [] }, { 'comments.json': JSON.stringify({ a: {}, b: {} }) })
  const app = await launch(env, {})
  const page = await home(app)
  await page.getByRole('button', { name: 'Delete review LX-5' }).click({ force: true })
  await expect(page.getByText('2 pending comments will be lost.')).toBeVisible()
  const del = page.getByRole('button', { name: 'Delete review', exact: true })
  await expect(del).toBeDisabled()
  await page.getByLabel('I understand that these comments are lost.').check()
  await del.click()
  await expect(page.getByText('Moved LX-5 to the trash.')).toBeVisible()
  expect(existsSync(join(env.root, '.code-diff', 'reviews', 'LX-5'))).toBe(false)
  await app.close()
})

test('a review whose repo is not in the workspace fails with the clone message and can retry', async () => {
  const { env } = makeEnv()
  seed(env, 'gone', { title: 'Gone', mrs: [{ projectPath: 'team/gone', iid: 1 }], issues: [] })
  const app = await launch(env, {})
  const page = await home(app)
  await page.getByTestId('review-gone').dblclick()
  const panel = page.getByTestId('build-error')
  await expect(panel).toContainText('The review cannot be built')
  await expect(panel).toContainText(`team/gone has no local clone in ${env.root}. Clone it there, then retry.`)
  await expect(page.getByTestId('stage-clones')).toHaveAttribute('data-state', 'failed')
  await page.getByRole('button', { name: 'Back to Home' }).click()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await app.close()
})

test('Cancel stops a slow build and returns to Home', async () => {
  const { env, shas } = makeEnv()
  seed(env, 'slow', { title: 'Slow', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], issues: [] })
  const app = await launch(env, mr('team/backend/x', 12, 'opened', shas.a, shas.b, 30_000))
  const page = await home(app)
  await page.getByTestId('review-slow').dblclick()
  await expect(page.getByTestId('stage-reading')).toHaveAttribute('data-state', 'running')
  await expect(page.getByText('Reading and diffing the changes. This takes a few seconds.')).toBeVisible()
  const t0 = Date.now()
  await page.getByTestId('cancel-build').click()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible({ timeout: 10_000 })
  expect(Date.now() - t0).toBeLessThan(10_000)
  await app.close()
})

test('the Home screen stays blocked while no GitLab or GitHub token is saved', async () => {
  const { env } = makeEnv()
  // no CODEDIFF_TEST_CREDENTIALS, so the fresh data folder holds no token
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: env.ud, CODEDIFF_TEST: '1' } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByTestId('row-gitlab')).toContainText('Not set up')
  await expect(page.getByTestId('row-github')).toContainText('Not set up')
  await page.getByTestId('continue-anyway').click()
  await expect(page.getByTestId('blocked-strip')).toBeVisible()
  await expect(page.getByTestId('new-review')).toBeDisabled()
  await app.close()
})
