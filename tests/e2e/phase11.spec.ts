import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import electronPath from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

interface Setup {
  root: string
  ud: string
  log: string
  shas: { base: string; head: string }
}

function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e11-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'head')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const log = join(base, 'claude.log')
  writeFileSync(log, '')
  return { root, ud, log, shas: { base: b, head: git('rev-parse', 'HEAD') } }
}

const P = encodeURIComponent('team/backend/x')
const mrFixture = (s: Setup): Fixture => ({
  'GET user': { json: { username: 'me' } },
  [`GET projects/${P}/merge_requests/12`]: {
    json: {
      web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
      state: 'opened',
      title: 'Change',
      description: 'Why two.',
      author: { username: 'ann' },
      source_branch: 'b',
      target_branch: 'main',
      diff_refs: { base_sha: s.shas.base, start_sha: s.shas.base, head_sha: s.shas.head }
    }
  },
  [`GET projects/${P}/merge_requests/12/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
  [`GET projects/${P}/merge_requests/12/discussions`]: { json: [] },
  [`GET projects/${P}/merge_requests/12/reviewers`]: { json: [] }
})

// The second start of the app: a plain process, as a shell or a link would start it. It hands over and exits.
const startSecond = (args: string[], env: Record<string, string>): void => {
  spawn(electronPath as unknown as string, [main, ...args], { env, stdio: 'ignore' })
}

const MR_URL = 'https://gitlab.com/team/backend/x/-/merge_requests/12'

async function openHome(s: Setup, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; env: Record<string, string> }> {
  forge = await startFakeForge(mrFixture(s))
  const env = { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), FAKE_CLAUDE_LOG: s.log, ...extra } as Record<string, string>
  const app = await electron.launch({ args: [main], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  return { app, page, env }
}

test('a second start with --mr and --issue hands over to the open app, which fills in the New review form (acceptance check 1)', async () => {
  const s = setup()
  const { app, page, env } = await openHome(s)
  startSecond([`--mr=${MR_URL}`, '--issue=LX-7', '--title=From outside'], env)
  // the check ran by itself, and Create is left to the reviewer
  await expect(page.getByTestId('check-list')).toContainText('backend/x!12', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Create and open' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('urls')).toHaveValue(MR_URL)
  await expect(page.getByTestId('issues')).toHaveValue('LX-7')
  await expect(page.getByTestId('slug')).toHaveValue('LX-7')
  await expect(page.getByTestId('title')).toHaveValue('From outside')
  // nothing was created
  await expect(page.getByTestId('review-count')).toContainText('0')
  await app.close()
})

test('a codediff:// link does the same, and a request with no issue names the review after the change (acceptance check 2)', async () => {
  const s = setup()
  const { app, page, env } = await openHome(s)
  startSecond([`codediff://new?mr=${encodeURIComponent(MR_URL)}`], env)
  await expect(page.getByTestId('check-list')).toContainText('backend/x!12', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('urls')).toHaveValue(MR_URL)
  await expect(page.getByTestId('slug')).toHaveValue('x-12')
  await app.close()
})

test('the first start with a request opens the form filled in (acceptance check 3)', async () => {
  const s = setup()
  forge = await startFakeForge(mrFixture(s))
  const env = { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  const app = await electron.launch({ args: [main, '--mr', MR_URL], env })
  const page = await app.firstWindow()
  await expect(page.getByTestId('urls')).toHaveValue(MR_URL, { timeout: 30_000 })
  await app.close()
})

const MR13_URL = 'https://gitlab.com/team/backend/x/-/merge_requests/13'
const mr13 = (s: Setup): Fixture => {
  const fx = mrFixture(s)
  const out: Fixture = {}
  for (const [k, v] of Object.entries(fx)) if (k.includes('/merge_requests/12')) out[k.replace('/merge_requests/12', '/merge_requests/13')] = v
  return out
}
const writeReview = (s: Setup, slug: string, file: object): string => {
  const dir = join(s.root, '.code-diff', 'reviews', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify(file))
  return join(dir, 'review.json')
}
const OLD = { title: 'Old review', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: ['LX-1'] }

test('a request that names an existing review adds the new change and issue to it, keeping what it holds (acceptance check 4)', async () => {
  const s = setup()
  const file = writeReview(s, 'R-1', OLD)
  forge = await startFakeForge({ ...mrFixture(s), ...mr13(s) })
  const env = { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  const app = await electron.launch({ args: [main], env })
  const page = await app.firstWindow()
  await expect(page.getByTestId('review-R-1')).toBeVisible()
  startSecond(['--review=R-1', `--mr=${MR13_URL}`, '--mr=' + MR_URL, '--issue=LX-5'], env)
  await expect(page.getByRole('dialog', { name: 'Add to review' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('add-changes')).toContainText('merge_requests/13')
  await expect(page.getByTestId('add-issues')).toContainText('LX-5')
  expect(JSON.parse(readFileSync(file, 'utf8')).mrs).toHaveLength(1) // nothing changes until the reviewer agrees
  await page.getByTestId('add-confirm').click()
  await expect(page.getByTestId('mrs-tab')).toBeVisible({ timeout: 30_000 })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  expect(saved.title).toBe('Old review')
  expect(saved.mrs.map((m: { iid: number }) => m.iid)).toEqual([12, 13]) // 12 was there already: not added twice
  expect(saved.issues).toEqual(['LX-1', 'LX-5'])
  await app.close()
})

test('adding what the review holds already says so and changes nothing (acceptance check 5)', async () => {
  const s = setup()
  const file = writeReview(s, 'R-1', OLD)
  forge = await startFakeForge(mrFixture(s))
  const env = { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  const app = await electron.launch({ args: [main], env })
  const page = await app.firstWindow()
  await expect(page.getByTestId('review-R-1')).toBeVisible()
  startSecond(['--review=R-1', '--mr=' + MR_URL, '--issue=LX-1'], env)
  await page.getByTestId('add-confirm').click({ timeout: 30_000 })
  await expect(page.getByTestId('add-error')).toHaveText('Everything you gave is in the review already.')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(OLD)
  await app.close()
})

test('a request that names a review that does not exist starts a new review with that name (acceptance check 6)', async () => {
  const s = setup()
  const { app, page, env } = await openHome(s)
  startSecond(['--review=LX-77', '--mr=' + MR_URL], env)
  await expect(page.getByTestId('check-list')).toContainText('backend/x!12', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('slug')).toHaveValue('LX-77')
  await app.close()
})

test('changes and issues are added from inside the open review, which is built again with them (acceptance check 7)', async () => {
  const s = setup()
  const file = writeReview(s, 'R-1', { ...OLD, issues: [] })
  forge = await startFakeForge({ ...mrFixture(s), ...mr13(s) })
  const env = { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  const app = await electron.launch({ args: [main], env })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await expect(page.getByTestId('mr-backend/x!12')).toBeVisible()
  await expect(page.getByTestId('mr-backend/x!13')).toHaveCount(0)

  await page.getByTestId('add-changes').click()
  await expect(page.getByTestId('add-changes-confirm')).toBeDisabled() // nothing typed yet
  await page.getByTestId('add-urls').fill('not a url')
  await expect(page.getByTestId('add-problem').first()).toBeVisible()
  await expect(page.getByTestId('add-changes-confirm')).toBeDisabled()
  await page.getByTestId('add-urls').fill(MR13_URL)
  await page.getByTestId('add-changes-confirm').click()

  await expect(page.getByTestId('mr-backend/x!13')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mr-backend/x!12')).toBeVisible()
  expect(JSON.parse(readFileSync(file, 'utf8')).mrs.map((m: { iid: number }) => m.iid)).toEqual([12, 13])
  await app.close()
})
