import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
let forge: FakeForge | undefined

const BEFORE: Record<string, string> = {
  'src/calc.ts':
    '/* Adds two numbers. */\nexport const help = `Usage:\n  add <a> <b>\n  done`\nexport function add(a: number, b: number): number {\n  return a + b\n}\n',
  'notes.txt': 'plain notes\n'
}
const AFTER: Record<string, string> = {
  'src/calc.ts':
    '/* Adds two numbers. */\nexport const help = `Usage:\n  add <a> <c>\n  done`\nexport function add(a: number, b: number): number {\n  return a + b + 1\n}\n',
  'notes.txt': 'plain notes, changed\n'
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-highlight-'))
  const root = join(tmp, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const put = (files: Record<string, string>): void => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), text)
    }
  }
  git('init', '-q')
  git('checkout', '-q', '-B', 'main')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  put(BEFORE)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-B', 'feature')
  put(AFTER)
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  const head = git('rev-parse', 'HEAD')

  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const ep = `projects/${encodeURIComponent('team/backend/x')}/merge_requests/11`
  const fixture: Fixture = {
    'GET user': { json: { username: 'me' } },
    [`GET ${ep}`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/11',
        state: 'opened',
        title: 'Change 11',
        author: { username: 'ann' },
        source_branch: 'feature',
        target_branch: 'main',
        created_at: '2026-01-11T00:00:00Z',
        diff_refs: { base_sha: base, start_sha: base, head_sha: head }
      }
    },
    [`GET ${ep}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET ${ep}/discussions`]: { json: [] },
    [`GET ${ep}/reviewers`]: { json: [] }
  }
  forge = await startFakeForge(fixture)
  const review = join(root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(review, { recursive: true })
  writeFileSync(review + '/review.json', JSON.stringify({ title: 'Review', mrs: [{ projectPath: 'team/backend/x', iid: 11 }], skipped: [], issues: [] }))
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await page.getByTestId('tab-diff').click()
  return { app, page }
}

// One app for all the tests of this file. They only read the diff and flip the colours, so a start for each test is a waste.
test.describe.serial('syntax colours in the diff', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    ;({ app, page } = await launch())
  })
  test.afterAll(async () => {
    await app?.close()
    await forge?.close()
    forge = undefined
  })

  test('a keyword has a token class and a real colour, in the inline, the side by side and the full file layouts', async () => {
    await page.getByTestId('file-src/calc.ts').click()
    const table = page.getByTestId('diff-table')
    for (const layout of ['layout-inline', 'layout-side', 'layout-full']) {
      await page.getByTestId(layout).click()
      const keyword = table.locator('.tk-kw', { hasText: 'export' }).first()
      await expect(keyword, layout).toBeVisible()
      const colors = await keyword.evaluate((el) => ({ token: getComputedStyle(el).color, plain: getComputedStyle(el.closest('td')!).color }))
      expect(colors.token, `${layout}: the keyword has the colour of plain text`).not.toBe(colors.plain)
    }
  })

  test('a line inside a multi-line string is a string, and the changed characters stay marked over the colour', async () => {
    await page.getByTestId('layout-inline').click()
    const table = page.getByTestId('diff-table')
    const added = table.locator('tr.add', { hasText: '<c>' })
    // The changed character keeps the strong mark and the string colour together
    const changed = added.locator('.chg.tk-str')
    await expect(changed).toHaveText('c')
    const colors = await changed.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)')
    const row = await added.locator('td.code').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(colors.background, 'the mark has its own background').not.toBe(row)
    // The last line of the string has not changed, and its colour comes from the whole file
    await expect(table.locator('tr.ctx .tk-str', { hasText: 'done' })).toBeVisible()
  })

  test('an unknown file stays plain text', async () => {
    await page.getByTestId('file-notes.txt').click()
    const table = page.getByTestId('diff-table')
    await expect(table).toContainText('plain notes')
    await expect(table.locator('[class*="tk-"]')).toHaveCount(0)
    await page.getByTestId('file-src/calc.ts').click()
  })

  test('the switch turns the colours off and on, and the choice stays after the page loads again', async () => {
    const table = page.getByTestId('diff-table')
    await expect(table.locator('.tk-kw').first()).toBeVisible()
    await page.getByTestId('syntax-toggle').uncheck()
    await expect(table.locator('[class*="tk-"]')).toHaveCount(0)
    // the marks of the changed characters stay without colours
    await expect(table.locator('.chg').first()).toBeVisible()
    await page.reload()
    await page.getByTestId('review-R-1').dblclick()
    await page.getByTestId('tab-diff').click()
    await page.getByTestId('file-src/calc.ts').click()
    await expect(page.getByTestId('diff-table')).toContainText('export function')
    await expect(page.getByTestId('syntax-toggle')).not.toBeChecked()
    await page.getByTestId('syntax-toggle').check()
    await expect(page.getByTestId('diff-table').locator('.tk-kw').first()).toBeVisible()
  })
})
