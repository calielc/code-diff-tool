import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const P = encodeURIComponent('team/backend/x')
const GET = { timeout: 3_000 }

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

interface Setup {
  root: string
  ud: string
  shas: { base: string; head: string }
}

function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e-splitter-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
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
  return { root, ud, shas: { base: b, head: git('rev-parse', 'HEAD') } }
}

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

const FLOW = {
  summary: 'A user sees the change.',
  lanes: ['backend/x'],
  steps: [{ id: 's1', mr: 'backend/x!12', path: 'a.txt', lines: [[2, 2]], title: 'The change', kind: 'changed', text: 'It changes line two.' }],
  review: [{ mr: 'backend/x!12', path: 'a.txt', line: 2, why: 'Check the new value.' }],
  skip: []
}

async function openDiff(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await page.getByTestId('tab-diff').click()
  await expect(page.locator('aside.filetree')).toBeVisible()
}

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const s = setup()
  forge = await startFakeForge(mrFixture(s))
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await openDiff(page)
  return { app, page }
}

const separator = (page: Page): Locator => page.getByRole('separator', { name: 'Resize the file tree' })
const layout = (page: Page): Locator => page.locator('.difflayout')

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox()
  expect(b).not.toBeNull()
  return b!
}

const treeWidth = async (page: Page): Promise<number> => (await box(page.locator('aside.filetree'))).width

async function expectTreeWidth(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs((await treeWidth(page)) - expected), { timeout: 3_000 }).toBeLessThanOrEqual(1)
}

async function drag(page: Page, x: number): Promise<void> {
  const b = await box(separator(page))
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}

const stored = async (page: Page): Promise<string | null> => await page.evaluate(() => window.localStorage.getItem('codediff:side'))

test('the separator has its role, label, orientation and the default width of 320 px', async () => {
  const { app, page } = await launch()

  await expect(separator(page)).toBeVisible(GET)
  await expect(separator(page)).toHaveAttribute('aria-orientation', 'vertical')
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '320')
  await expect(separator(page)).toHaveAttribute('aria-valuemin', '200')
  const area = (await box(layout(page))).width
  await expect(separator(page)).toHaveAttribute('aria-valuemax', String(Math.floor(area * 0.6)))
  expect((await box(separator(page))).width).toBeCloseTo(10, 0)
  await expectTreeWidth(page, 320)
  await app.close()
})

test('the arrow keys move the tree by 24 px, stop at the limits and save the width at once', async () => {
  const { app, page } = await launch()
  await expect(separator(page)).toBeVisible(GET)
  await separator(page).focus()
  const max = Math.floor((await box(layout(page))).width * 0.6)

  await page.keyboard.press('ArrowRight')
  await expectTreeWidth(page, 344)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '344')
  expect(await stored(page)).toBe('344')

  await page.keyboard.press('ArrowLeft')
  await expectTreeWidth(page, 320)
  expect(await stored(page)).toBe('320')

  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft')
  await expectTreeWidth(page, 200)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '200')

  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight')
  await expectTreeWidth(page, max)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', String(max))
  expect(await stored(page)).toBe(String(max))
  await app.close()
})

test('a drag sets the tree width to the pointer position, clamps it and saves it when the drag ends', async () => {
  const { app, page } = await launch()
  await expect(separator(page)).toBeVisible(GET)
  const area = await box(layout(page))

  await drag(page, area.x + 437 + 5)
  await expectTreeWidth(page, 437)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '437')
  expect(await stored(page)).toBe('437')

  await drag(page, area.x - 100)
  await expectTreeWidth(page, 200)
  expect(await stored(page)).toBe('200')

  await drag(page, area.x + area.width + 100)
  const max = Math.floor(area.width * 0.6)
  await expectTreeWidth(page, max)
  expect(await stored(page)).toBe(String(max))
  await app.close()
})

test('the saved width comes back when the review is opened again', async () => {
  const { app, page } = await launch()
  await expect(separator(page)).toBeVisible(GET)
  await separator(page).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expectTreeWidth(page, 368)
  expect(await stored(page)).toBe('368')

  await page.reload()
  await openDiff(page)

  await expect(separator(page)).toHaveAttribute('aria-valuenow', '368', GET)
  await expectTreeWidth(page, 368)
  await app.close()
})

test('the separator is hidden in the Critical thinking view', async () => {
  const { app, page } = await launch({ CODEDIFF_TEST_FLOW: '1', FAKE_CLAUDE_ANSWER: JSON.stringify(FLOW) })
  await expect(separator(page)).toBeVisible(GET)
  const button = page.getByTestId('view-flow')
  await expect(button).toBeEnabled({ timeout: 20_000 })

  await button.click()

  await expect(page.getByTestId('flow-summary')).toBeVisible()
  await expect(separator(page)).toBeHidden(GET)
  await app.close()
})

test('the separator is hidden when the window is narrower than 800 px', async () => {
  const { app, page } = await launch()
  await expect(separator(page)).toBeVisible(GET)

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(300, 300)
    win.setSize(760, 700)
  })
  await expect.poll(async () => await page.evaluate(() => window.innerWidth)).toBeLessThan(800)

  await expect(separator(page)).toBeHidden(GET)
  await app.close()
})
