import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

let forge: FakeForge | undefined

interface MrPlan {
  iid: number
  from: string
  source: string
  files: Record<string, string>
}

// Three stacked MRs of one repo. !11 and !12 both change shared.txt, in different lines, so they merge cleanly in order.
const PLANS: MrPlan[] = [
  { iid: 11, from: 'base', source: 'mr11', files: { 'shared.txt': 'ONE\ntwo\nthree\n', 'only11.txt': 'a\n' } },
  { iid: 12, from: 'mr11', source: 'mr12', files: { 'shared.txt': 'ONE\ntwo\nTHREE\n', 'only12.txt': 'b\n' } },
  { iid: 13, from: 'mr12', source: 'mr13', files: { 'only13.txt': 'c\n' } }
]

interface Setup {
  root: string
  ud: string
  heads: Map<number, { base: string; head: string }>
}

function setup(): Setup {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-viewed-stacked-'))
  const root = join(tmp, 'ws')
  const heads = new Map<number, { base: string; head: string }>()
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('checkout', '-q', '-B', 'main')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'shared.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('branch', 'base')
  git('update-ref', 'refs/remotes/origin/main', base)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  for (const plan of PLANS) {
    git('checkout', '-q', '-B', plan.source, plan.from)
    const from = git('rev-parse', 'HEAD')
    for (const [path, text] of Object.entries(plan.files)) {
      writeFileSync(join(dir, path), text)
    }
    git('add', '-A')
    git('commit', '-q', '-m', `mr${plan.iid}`)
    heads.set(plan.iid, { base: from, head: git('rev-parse', 'HEAD') })
  }
  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, heads }
}

function fixture(s: Setup): Fixture {
  const out: Fixture = { 'GET user': { json: { username: 'me' } } }
  for (const plan of PLANS) {
    const ep = `projects/${encodeURIComponent('team/backend/x')}/merge_requests/${plan.iid}`
    const refs = s.heads.get(plan.iid)!
    out[`GET ${ep}`] = {
      json: {
        web_url: `https://gitlab.com/team/backend/x/-/merge_requests/${plan.iid}`,
        state: 'opened',
        title: `Change ${plan.iid}`,
        author: { username: 'ann' },
        source_branch: plan.source,
        target_branch: plan.from === 'base' ? 'main' : plan.from,
        created_at: `2026-01-${String(plan.iid).padStart(2, '0')}T00:00:00Z`,
        diff_refs: { base_sha: refs.base, start_sha: refs.base, head_sha: refs.head }
      }
    }
    out[`GET ${ep}/approvals`] = { json: { approved_by: [], user_can_approve: true, user_has_approved: false } }
    out[`GET ${ep}/discussions`] = { json: [] }
    out[`GET ${ep}/reviewers`] = { json: [] }
  }
  return out
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const s = setup()
  forge = await startFakeForge(fixture(s))
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const mrs = PLANS.map((p) => ({ projectPath: 'team/backend/x', iid: p.iid }))
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs, skipped: [], issues: [] }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await page.getByTestId('tab-diff').click()
  await expect(page.locator('aside.filetree')).toBeVisible()
  return { app, page }
}

const tree = (page: Page): Locator => page.locator('aside.filetree')
const rows = (page: Page, path: string): Locator => tree(page).getByTestId(`file-${path}`)
const box = (page: Page, path: string, nth: number): Locator => rows(page, path).nth(nth).getByRole('checkbox', { name: 'Viewed' })

async function openAll(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const closed = tree(page).locator('button.chev[aria-label="Open"]')
    if ((await closed.count()) === 0) {
      return
    }
    await closed.first().click()
  }
}

async function show(page: Page, view: 'Linear' | 'Stacked'): Promise<void> {
  await page.getByRole('button', { name: view, exact: true }).click()
  await openAll(page)
}

const progress = (page: Page): Locator => page.locator('.progress')

test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

test.describe('viewed marks of the Stacked view', () => {
  test('a mark in Stacked shows under every MR in Linear, and an unmark under one MR clears Stacked', async () => {
    const { app, page } = await launch()
    try {
      // Arrange: Stacked has 4 files, Linear has 5 (shared.txt is in two MRs)
      await show(page, 'Stacked')
      await expect(rows(page, 'shared.txt')).toHaveCount(1)
      await expect(progress(page)).toContainText('0 of 4 viewed')

      // Act: mark the shared file in Stacked
      await box(page, 'shared.txt', 0).check()
      await expect(progress(page)).toContainText('1 of 4 viewed')

      // Assert: Linear shows the mark under each MR that changes the file
      await show(page, 'Linear')
      await expect(rows(page, 'shared.txt')).toHaveCount(2)
      await expect(box(page, 'shared.txt', 0)).toBeChecked()
      await expect(box(page, 'shared.txt', 1)).toBeChecked()
      await expect(box(page, 'only11.txt', 0)).not.toBeChecked()
      await expect(progress(page)).toContainText('2 of 5 viewed')

      // Act: unmark under one MR in Linear
      await box(page, 'shared.txt', 1).uncheck()
      await expect(progress(page)).toContainText('1 of 5 viewed')

      // Assert: Stacked is no longer checked, and the other MR keeps its mark
      await expect(box(page, 'shared.txt', 0)).toBeChecked()
      await show(page, 'Stacked')
      await expect(box(page, 'shared.txt', 0)).not.toBeChecked()
      await expect(progress(page)).toContainText('0 of 4 viewed')
    } finally {
      await app.close()
    }
  })

  test('a mark under one MR in Linear does not mark the other MR or the stacked file', async () => {
    const { app, page } = await launch()
    try {
      await show(page, 'Linear')

      await box(page, 'shared.txt', 0).check()

      await expect(box(page, 'shared.txt', 0)).toBeChecked()
      await expect(box(page, 'shared.txt', 1)).not.toBeChecked()
      await expect(progress(page)).toContainText('1 of 5 viewed')
      await show(page, 'Stacked')
      await expect(box(page, 'shared.txt', 0)).not.toBeChecked()
      await expect(progress(page)).toContainText('0 of 4 viewed')
    } finally {
      await app.close()
    }
  })

  test('an unmark in Stacked clears the file under every MR in Linear', async () => {
    const { app, page } = await launch()
    try {
      await show(page, 'Stacked')
      await box(page, 'shared.txt', 0).check()

      await box(page, 'shared.txt', 0).uncheck()

      await show(page, 'Linear')
      await expect(box(page, 'shared.txt', 0)).not.toBeChecked()
      await expect(box(page, 'shared.txt', 1)).not.toBeChecked()
      await expect(progress(page)).toContainText('0 of 5 viewed')
    } finally {
      await app.close()
    }
  })
})
