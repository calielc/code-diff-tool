import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

const CONTROLLERS = 'src/ExampleOrg.Recommendation.Service.Web/Controllers'
const NESTED = `${CONTROLLERS}/Nested/AnotherVeryLongFolderNameForTheTree`

interface MrPlan {
  repo: 'x' | 'y'
  iid: number
  /** The branch the MR starts from: `base`, or the source branch of another MR (a stacked MR). */
  from: string
  source: string
  files: Record<string, string>
}

const LONG_PLANS: MrPlan[] = [
  {
    repo: 'x',
    iid: 11,
    from: 'base',
    source: 'mr11',
    files: {
      'src/a.txt': 'one\nTWO\nthree\n',
      [`${CONTROLLERS}/VeryLongControllerNameForTheRecommendations.cs`]: 'class A {}\n',
      [`${NESTED}/SomeExtremelyLongFileNameForTheTreeRowTest.cs`]: 'class B {}\n',
      [`${NESTED}/Short.cs`]: 'class C {}\n'
    }
  },
  { repo: 'x', iid: 12, from: 'base', source: 'mr12', files: { 'src/a.txt': 'one\nDeux\nthree\n', 'docs/guide.md': 'guide\n' } },
  { repo: 'x', iid: 13, from: 'mr12', source: 'mr13', files: { [`${CONTROLLERS}/StackedOnTopOfTheSecondMergeRequest.cs`]: 'class D {}\n' } },
  { repo: 'y', iid: 21, from: 'base', source: 'mr21', files: { 'lib/Parser.ts': 'export {}\n', 'lib/Deeper/Folder/Name/Leaf.ts': 'export {}\n' } },
  { repo: 'y', iid: 22, from: 'base', source: 'mr22', files: { 'README.md': 'hello\n' } }
]

const SHORT_PLANS: MrPlan[] = [{ repo: 'x', iid: 11, from: 'base', source: 'mr11', files: { 'src/a.txt': 'one\nTWO\nthree\n' } }]

interface Setup {
  root: string
  ud: string
  heads: Map<number, { base: string; head: string }>
}

function setup(plans: MrPlan[]): Setup {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-treerows-'))
  const root = join(tmp, 'ws')
  const heads = new Map<number, { base: string; head: string }>()
  for (const repo of new Set(plans.map((p) => p.repo))) {
    const dir = join(root, 'backend', repo)
    mkdirSync(join(dir, 'src'), { recursive: true })
    const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('checkout', '-q', '-B', 'main')
    git('config', 'user.name', 'T')
    git('config', 'user.email', 't@example.com')
    git('remote', 'add', 'origin', `git@gitlab.com:team/backend/${repo}.git`)
    writeFileSync(join(dir, 'src/a.txt'), 'one\ntwo\nthree\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('branch', 'base')
    git('update-ref', 'refs/remotes/origin/main', base)
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    for (const plan of plans.filter((p) => p.repo === repo)) {
      git('checkout', '-q', '-B', plan.source, plan.from)
      const from = git('rev-parse', 'HEAD')
      for (const [path, text] of Object.entries(plan.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
      git('add', '-A')
      git('commit', '-q', '-m', `mr${plan.iid}`)
      heads.set(plan.iid, { base: from, head: git('rev-parse', 'HEAD') })
    }
  }
  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, heads }
}

function fixture(s: Setup, plans: MrPlan[]): Fixture {
  const out: Fixture = { 'GET user': { json: { username: 'me' } } }
  for (const plan of plans) {
    const project = encodeURIComponent(`team/backend/${plan.repo}`)
    const ep = `projects/${project}/merge_requests/${plan.iid}`
    const refs = s.heads.get(plan.iid)!
    out[`GET ${ep}`] = {
      json: {
        web_url: `https://gitlab.com/team/backend/${plan.repo}/-/merge_requests/${plan.iid}`,
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

async function launch(plans: MrPlan[]): Promise<{ app: ElectronApplication; page: Page }> {
  const s = setup(plans)
  forge = await startFakeForge(fixture(s, plans))
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const mrs = plans.map((p) => ({ projectPath: `team/backend/${p.repo}`, iid: p.iid }))
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

const separator = (page: Page): Locator => page.getByRole('separator', { name: 'Resize the file tree' })
const tree = (page: Page): Locator => page.locator('aside.filetree')

const SHOTS = '/private/tmp/claude-501/-Users-caliellimadacosta-code/79ea3011-c30a-4f35-a0e8-a60882f116b6/scratchpad'

async function openAll(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const closed = tree(page).locator('button.chev[aria-label="Open"]')
    if ((await closed.count()) === 0) {
      return
    }
    await closed.first().click()
  }
}

async function narrowest(page: Page): Promise<void> {
  await separator(page).focus()
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('ArrowLeft')
  }
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '200')
}

async function setTheme(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, name) => {
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Theme')
      ?.submenu?.items.find((i) => i.label === name)
      ?.click()
  }, label)
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
}

interface Geometry {
  asideBottom: number
  asideTop: number
  asideHeight: number
  separatorHeight: number
  rightHeight: number
  pageBottom: number
  innerHeight: number
  pageScrollHeight: number
  treeScrollHeight: number
  treeClientHeight: number
  asideScrolls: boolean
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const aside = document.querySelector('aside.filetree')!.getBoundingClientRect()
    const asideEl = document.querySelector('aside.filetree')!
    const sep = document.querySelector('.difflayout > .splitter')!.getBoundingClientRect()
    const right = document.querySelector('.difflayout > .rightcard')!.getBoundingClientRect()
    const pageEl = document.querySelector('.page.wide')!
    const pageBox = pageEl.getBoundingClientRect()
    const treeEl = document.querySelector('ul.tree')!
    return {
      asideBottom: aside.bottom,
      asideTop: aside.top,
      asideHeight: aside.height,
      separatorHeight: sep.height,
      rightHeight: right.height,
      pageBottom: pageBox.bottom - parseFloat(getComputedStyle(pageEl).paddingBottom),
      innerHeight: window.innerHeight,
      pageScrollHeight: document.scrollingElement!.scrollHeight,
      treeScrollHeight: treeEl.scrollHeight,
      treeClientHeight: treeEl.clientHeight,
      asideScrolls: asideEl.scrollHeight > asideEl.clientHeight
    }
  })
}

function expectAnchored(g: Geometry, label: string): void {
  expect(Math.abs(g.asideBottom - g.pageBottom), `${label}: the tree bottom is ${g.asideBottom}, the page bottom is ${g.pageBottom}`).toBeLessThanOrEqual(1)
  expect(Math.abs(g.separatorHeight - g.asideHeight), `${label}: the separator height differs from the tree`).toBeLessThanOrEqual(1)
  expect(Math.abs(g.rightHeight - g.asideHeight), `${label}: the right panel height differs from the tree`).toBeLessThanOrEqual(1)
  expect(g.pageScrollHeight, `${label}: the page scrolls`).toBeLessThanOrEqual(g.innerHeight + 1)
}

for (const size of ['short', 'long'] as const) {
  for (const width of ['default', 'narrowest']) {
    test(`the ${size} tree at the ${width} width reaches the bottom of the page and follows a resize`, async () => {
      // Arrange
      const { app, page } = await launch(size === 'short' ? SHORT_PLANS : LONG_PLANS)
      if (size === 'long') {
        await openAll(page)
        await resize(app, 1100, 560)
        await expect.poll(async () => (await geometry(page)).innerHeight).toBeLessThan(700)
      }
      if (width === 'narrowest') {
        await narrowest(page)
      }
      await page.screenshot({ path: `${SHOTS}/tree-bottom-${size}-${width}-light.png` })
      const filterTop = await page.getByLabel('Filter files').evaluate((e) => e.getBoundingClientRect().top)
      await page.locator('ul.tree').evaluate((e) => e.scrollTo(0, e.scrollHeight))

      // Act
      const start = await geometry(page)
      await resize(app, 1100, 1000)
      await expect.poll(async () => (await geometry(page)).innerHeight).toBeGreaterThan(start.innerHeight)
      const taller = await geometry(page)
      await resize(app, 1100, 560)
      await expect.poll(async () => (await geometry(page)).innerHeight).toBeLessThan(taller.innerHeight)
      const shorter = await geometry(page)
      await setTheme(app, 'Dracula')
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dracula')
      await resize(app, 1100, 1000)
      await expect.poll(async () => (await geometry(page)).innerHeight).toBeGreaterThan(shorter.innerHeight)
      await page.screenshot({ path: `${SHOTS}/tree-bottom-${size}-${width}-dark.png` })

      // Assert
      expectAnchored(start, 'at the start')
      expectAnchored(taller, 'after growing the window')
      expectAnchored(shorter, 'after shrinking the window')
      expect(taller.asideBottom).toBeGreaterThan(start.asideBottom)
      expect(shorter.asideBottom).toBeLessThan(taller.asideBottom)
      expect(await page.getByLabel('Filter files').evaluate((e) => e.getBoundingClientRect().top), 'the filter box moved').toBe(filterTop)
      if (size === 'long') {
        expect(start.treeScrollHeight, 'the tree is not long enough to scroll').toBeGreaterThan(start.treeClientHeight)
        expect(start.asideScrolls, 'the whole panel scrolls instead of the tree list').toBe(false)
      }
      await app.close()
    })
  }
}
