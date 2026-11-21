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

const PLANS: MrPlan[] = [
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

interface Setup {
  root: string
  ud: string
  heads: Map<number, { base: string; head: string }>
}

function setup(): Setup {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-treerows-'))
  const root = join(tmp, 'ws')
  const heads = new Map<number, { base: string; head: string }>()
  for (const repo of ['x', 'y'] as const) {
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
    for (const plan of PLANS.filter((p) => p.repo === repo)) {
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

function fixture(s: Setup): Fixture {
  const out: Fixture = { 'GET user': { json: { username: 'me' } } }
  for (const plan of PLANS) {
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

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const s = setup()
  forge = await startFakeForge(fixture(s))
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const mrs = PLANS.map((p) => ({ projectPath: `team/backend/${p.repo}`, iid: p.iid }))
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

interface RowReport {
  kind: string
  name: string
  overflow: number
  gap: number
  toRight: number
  titled: boolean
  spanLeft: number
  spanRight: number
}

async function report(page: Page): Promise<{ rows: RowReport[]; asideOverflow: number }> {
  return page.evaluate(() => {
    const aside = document.querySelector('aside.filetree')!
    const list = aside.querySelector('ul.tree')!
    const ul = list.getBoundingClientRect()
    const listRight = ul.left + list.clientWidth
    const rows = [...aside.querySelectorAll('.trow')].map((e) => {
      const row = e.getBoundingClientRect()
      const name = e.querySelector('.tname')!
      const counts = e.querySelector('.counts')!.getBoundingClientRect()
      const last = e.lastElementChild!.getBoundingClientRect()
      return {
        kind: e.className.split(' ')[1],
        name: name.textContent ?? '',
        overflow: e.scrollWidth - e.clientWidth,
        gap: Math.round(counts.left - name.getBoundingClientRect().right),
        toRight: Math.round(row.right - last.right),
        titled: (name.getAttribute('title') ?? '').includes(name.textContent ?? '?'),
        spanLeft: Math.round(row.left - ul.left),
        spanRight: Math.round(listRight - row.right)
      }
    })
    return { rows, asideOverflow: aside.scrollWidth - aside.clientWidth }
  })
}

for (const view of ['By MR', 'Combined per repo']) {
  for (const width of ['default', 'narrowest']) {
    test(`${view} view at the ${width} width: every row has its name left, its numbers at the right edge, and fits its box`, async () => {
      // Arrange
      const { app, page } = await launch()
      await page.getByRole('button', { name: view }).click()
      await openAll(page)
      if (width === 'narrowest') {
        await narrowest(page)
      }

      // Act
      const { rows, asideOverflow } = await report(page)

      // Assert
      expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['repo', 'group', 'folder', 'file']))
      expect(asideOverflow, 'the tree area scrolls sideways').toBeLessThanOrEqual(0)
      for (const r of rows) {
        expect(r.overflow, `row ${r.kind} ${r.name} sticks out`).toBeLessThanOrEqual(0)
        expect(r.toRight, `row ${r.kind} ${r.name}: numbers not at the right edge`).toBeLessThanOrEqual(8)
        expect(r.gap, `row ${r.kind} ${r.name}: numbers glued to the name`).toBeGreaterThanOrEqual(6)
        expect(r.titled, `row ${r.kind} ${r.name} has no tooltip with its full name`).toBe(true)
        expect(Math.abs(r.spanLeft), `row ${r.kind} ${r.name} does not start at the left of the tree`).toBe(0)
        expect(Math.abs(r.spanRight), `row ${r.kind} ${r.name} does not reach the right of the tree`).toBe(0)
      }
      await app.close()
    })
  }
}

test('the MR name is not cut at a wide pane, and shrinks with an ellipsis before the numbers at the narrowest', async () => {
  // Arrange
  const { app, page } = await launch()
  await page.getByRole('button', { name: 'Combined per repo' }).click()
  await openAll(page)
  const group = tree(page).locator('.trow.group', { hasText: '!12' })

  // Act
  const wide = await group.locator('.tname').evaluate((e) => e.scrollWidth - e.clientWidth)
  await narrowest(page)
  const tight = await group.locator('.tname').evaluate((e) => e.clientWidth)

  // Assert
  expect(wide, 'the label is cut at a wide pane').toBeLessThanOrEqual(0)
  expect(tight, 'the label has no room at all').toBeGreaterThan(20)
  await app.close()
})

test('a double click on a row folds or opens it, and a double click on the arrow or the checkbox does not toggle twice', async () => {
  // Arrange
  const { app, page } = await launch()
  await openAll(page)

  for (const kind of ['repo', 'group', 'folder']) {
    const row = tree(page).locator(`.trow.${kind}`).first()
    const chev = row.locator('button.chev')
    await expect(chev).toHaveAttribute('aria-label', 'Fold')

    // Act
    await row.locator('.tname').dblclick()

    // Assert
    await expect(chev).toHaveAttribute('aria-label', 'Open')
    await row.locator('.tname').dblclick()
    await expect(chev).toHaveAttribute('aria-label', 'Fold')
    await chev.dblclick()
    await expect(chev).toHaveAttribute('aria-label', 'Fold')
    await row.locator('input[type="checkbox"]').dblclick()
    await expect(chev).toHaveAttribute('aria-label', 'Fold')
  }
  await app.close()
})

test('a double click on a file row does not fold anything', async () => {
  // Arrange
  const { app, page } = await launch()
  await openAll(page)
  const before = await tree(page).locator('.trow').count()

  // Act
  await tree(page).locator('.trow.file').first().locator('.tname').dblclick()

  // Assert
  await expect(tree(page).locator('.trow')).toHaveCount(before)
  await app.close()
})

test('the arrow always shows what the row does: an open row has the down arrow and the Fold label', async () => {
  // Arrange
  const { app, page } = await launch()

  // Act
  const arrows = await tree(page)
    .locator('button.chev')
    .evaluateAll((els) => els.map((e) => ({ label: e.getAttribute('aria-label'), text: e.textContent })))

  // Assert
  expect(arrows.length).toBeGreaterThan(0)
  for (const a of arrows) {
    expect(a.text).toBe(a.label === 'Fold' ? '▾' : '▸')
  }
  await app.close()
})
