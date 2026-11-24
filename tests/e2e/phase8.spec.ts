import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECTIONS_PROMPT_VERSION } from '../../src/shared/sections'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

interface Setup {
  root: string
  ud: string
  log: string
  shas: { base: string; head: string }
}

const lines = (edit: Record<number, string> = {}): string =>
  Array.from({ length: 14 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`)
    .join('\n')
    .concat('\n')

/** One change that edits line 2 and line 12 of a.txt, which are far apart, and adds b.txt. */
function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e8-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'a.txt'), lines())
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), lines({ 2: 'TWO', 12: 'TWELVE' }))
  writeFileSync(join(dir, 'b.txt'), 'brand new\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const log = join(base, 'claude.log')
  writeFileSync(log, '')
  return { root, ud, log, shas: { base: b, head: git('rev-parse', 'HEAD') } }
}

const P = encodeURIComponent('team/backend/x')
const EP = `projects/${P}/merge_requests/12`
const mrFixture = (s: Setup): Fixture => ({
  'GET user': { json: { username: 'me' } },
  [`GET ${EP}`]: {
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
  [`GET ${EP}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
  [`GET ${EP}/discussions`]: { json: [] },
  [`GET ${EP}/reviewers`]: { json: [] }
})

async function openReview(
  s: Setup,
  fixture: Fixture,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page; forge: FakeForge }> {
  const forge = await startFakeForge({ ...mrFixture(s), ...fixture })
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), FAKE_CLAUDE_LOG: s.log, ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  return { app, page, forge }
}

/** How many times the fake AI tool was started. */
const runs = (s: Setup): number =>
  readFileSync(s.log, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"args"')).length

const K = 'backend/x!12'
/**
 * The tool picks two ideas. Both show line 2 of a.txt. Nothing shows line 12 of a.txt or the file b.txt, so the app puts them in
 * "Everything else", where a.txt is also a file that two sections show.
 */
const GOOD = {
  summary: 'A user sees the change.',
  sections: [
    { id: 's1', title: 'The first idea', text: 'It changes line two.', snippets: [{ mr: K, path: 'a.txt', lines: [2, 2] }] },
    { id: 's2', title: 'The second idea', text: 'It also needs line two.', snippets: [{ mr: K, path: 'a.txt', lines: [2, 2] }] }
  ],
  restText: 'The change to line twelve and the new file.'
}
const ENV = { FAKE_CLAUDE_ANSWER: JSON.stringify(GOOD), FAKE_CLAUDE_SLEEP_MS: '1200' }

const thread = (body: string): object => ({
  id: 'a'.repeat(40),
  notes: [{ id: 51, body, resolvable: true, resolved: false, author: { username: 'me', name: 'Me' }, created_at: '2026-01-03T10:00:00Z' }]
})

// One app for all the tests of the page. The tests go in order and share its state, and the page is written once.
test.describe.serial('the Summarised page', () => {
  let s: Setup
  let app: ElectronApplication
  let page: Page
  let forge: FakeForge
  const commentBody = '**Section: The first idea**\n\nWhy two?'
  const tree = (name: string): ReturnType<Page['getByTestId']> => page.getByTestId(`file-${name}`)

  test.beforeAll(async () => {
    s = setup()
    const opened = await openReview(
      s,
      {
        // the build, then the read-back after the post, and the answer to the resolve
        [`GET ${EP}/discussions`]: [{ json: [] }, { json: [thread(commentBody)] }],
        [`POST ${EP}/discussions`]: { empty: true },
        [`PUT ${EP}/discussions/${'a'.repeat(40)}`]: { empty: true }
      },
      ENV
    )
    app = opened.app
    page = opened.page
    forge = opened.forge
    await page.setViewportSize({ width: 1280, height: 600 }) // small, so that the page scrolls
  })
  test.afterAll(async () => {
    await app.close()
    await forge.close()
  })

  test('a build does not write the page. Opening the Summarised tab does, with the running state in between', async () => {
    await expect(page.getByTestId('tab-summarised')).toBeVisible()
    expect(runs(s)).toBe(0) // the build started no AI tool
    expect(existsSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'sections.json'))).toBe(false)
    await expect(page.getByTestId('sections-banner')).toHaveCount(0)
    await page.getByTestId('tab-summarised').click()
    await expect(page.getByTestId('sections-status')).toContainText('The AI is writing the Summarised page')
    await expect(page.getByTestId('sections-banner')).toContainText('The AI is writing the Summarised page')
    await expect(page.getByTestId('sections-view')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('sections-banner')).toHaveCount(0)
    expect(runs(s)).toBe(1)
    expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'sections.json'), 'utf8')).summary).toBe('A user sees the change.')
  })

  test('the page has the written sections, then Everything else, computed from the diffs, with the coverage line and the code', async () => {
    await expect(page.getByTestId('sections-summary')).toHaveText('A user sees the change.')
    await expect(page.locator('article.section h3')).toHaveText(['The first idea', 'The second idea', 'Everything else'])
    await expect(page.getByTestId('section-s1').locator('table.diff tr.add')).toContainText('TWO')
    await expect(page.getByTestId('section-s1').locator('table.diff tr.del')).toContainText('line 2')
    await expect(page.getByTestId('section-everything-else')).toContainText('The change to line twelve and the new file.') // the text of the tool
    await expect(page.getByTestId('sections-coverage')).toHaveText(
      '1 of 2 changed files are in the sections. Everything else holds 2 files, 1 of them with changes that a section also shows.'
    )
    await expect(page.getByTestId('rest-file-a.txt')).toContainText('1 change that no section shows')
    await expect(page.getByTestId('rest-file-b.txt')).toContainText('the whole file')
    await expect(page.getByTestId('sections-progress')).toContainText('0 of 3 sections accepted · 0 of 2 files viewed')
    await expect(tree('a.txt')).toBeHidden() // the Summarised tab shows no tree
  })

  test('Everything else shows its code when a file opens', async () => {
    await expect(page.getByTestId('rest-file-b.txt').locator('table.diff')).toHaveCount(0) // nothing is drawn until the file opens
    await page.getByTestId('rest-file-b.txt').locator('summary').click()
    await expect(page.getByTestId('rest-file-b.txt').locator('table.diff tr.add')).toContainText('brand new')
    await page.getByTestId('rest-file-a.txt').locator('summary').click()
    const rows = page.getByTestId('rest-file-a.txt').locator('table.diff tr.add')
    await expect(rows).toContainText('TWELVE') // only the change that no section shows
    await expect(rows).not.toContainText('TWO')
  })

  /** How far below the top of the page a section starts. A header that is stuck at the top is at 0. */
  const topOf = (testid: string): Promise<number> =>
    page.evaluate((id) => {
      const root = document.querySelector('.rightscroll')!.getBoundingClientRect().top
      return document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top - root
    }, testid)

  test('Accept collapses the section, marks its files viewed, and moves on to the next section. A file in several sections waits for all of them', async () => {
    await expect(page.getByTestId('section-s2')).toContainText('These changes are shown in section 1.') // a changed line is drawn once on the page
    await expect(page.getByTestId('section-files-s1').getByTestId('sfile-a.txt')).toHaveAttribute(
      'title',
      /Not viewed until you accept: The second idea, Everything else\./
    )
    await page.getByTestId('accept-s1').click()
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-accepted', 'true')
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-collapsed', 'true') // Accept collapses the section
    await expect(page.getByTestId('section-files-s1')).toHaveCount(0) // its footer is hidden, and its header stays
    await expect(page.getByTestId('section-progress-s1')).toHaveText('0 of 1 file viewed') // a.txt waits for the second idea
    // the next section that is not accepted is at the top of the page, and the index follows
    await expect.poll(() => topOf('section-s2')).toBeLessThan(40)
    expect(await topOf('section-s2')).toBeGreaterThan(-4)
    await expect(page.getByTestId('index-s2')).toHaveAttribute('aria-current', 'true')
    await page.getByTestId('accept-s2').click()
    await expect(page.getByTestId('section-progress-s2')).toHaveText('0 of 1 file viewed') // Everything else is not accepted yet
    await page.getByTestId('accept-everything-else').click()
    await expect(page.getByTestId('section-progress-s1')).toHaveText('1 of 1 file viewed')
    await expect(page.getByTestId('section-progress-everything-else')).toHaveText('2 of 2 files viewed')
    await expect(page.getByTestId('sections-progress')).toContainText('3 of 3 sections accepted · 2 of 2 files viewed')
    // the Linear view shows the same marks, with its own counter
    await page.getByTestId('tab-diff').click()
    await page.getByRole('button', { name: 'Linear', exact: true }).click()
    await expect(tree('a.txt')).toHaveClass(/viewed/)
    await expect(tree('b.txt')).toHaveClass(/viewed/)
    await expect(page.locator('.filetree .progress')).toContainText('2 of 2 viewed')
    await page.getByTestId('tab-summarised').click()
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-collapsed', 'true') // the collapsed state stays when the view opens again
  })

  test('un-accepting opens the section again and keeps its header where it is, and the other accepted sections stay accepted', async () => {
    const before = await topOf('section-everything-else')
    await page.getByTestId('accept-everything-else').click()
    await expect(page.getByTestId('section-everything-else')).toHaveAttribute('data-accepted', 'false')
    await expect(page.getByTestId('section-everything-else')).toHaveAttribute('data-collapsed', 'false')
    await expect.poll(async () => Math.abs((await topOf('section-everything-else')) - before)).toBeLessThan(3) // no jump
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-accepted', 'true') // a.txt waits for Everything else
    await expect(page.getByTestId('section-s2')).toHaveAttribute('data-accepted', 'true')
    await expect(page.getByTestId('sections-progress')).toContainText('2 of 3 sections accepted · 0 of 2 files viewed')
    await page.getByTestId('tab-diff').click()
    await page.getByRole('button', { name: 'Linear', exact: true }).click()
    await expect(tree('a.txt')).not.toHaveClass(/viewed/)
    await expect(tree('b.txt')).not.toHaveClass(/viewed/)
    await page.getByTestId('tab-summarised').click()
    await page.getByTestId('accept-everything-else').click() // accept it again, which marks both files
    await expect(page.getByTestId('sections-progress')).toContainText('3 of 3 sections accepted · 2 of 2 files viewed')
  })

  test('a file that the reviewer un-marks in the tree takes the section that holds only that file out of the accepted state, and opens it', async () => {
    await page.getByTestId('tab-diff').click()
    await page.getByRole('button', { name: 'Linear', exact: true }).click()
    await tree('b.txt').getByTitle('Viewed').uncheck()
    await page.getByTestId('tab-summarised').click()
    await expect(page.getByTestId('section-everything-else')).toHaveAttribute('data-accepted', 'false')
    await expect(page.getByTestId('section-everything-else')).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-accepted', 'true') // b.txt is not a file of s1
    await page.getByTestId('accept-everything-else').click()
    await expect(page.getByTestId('sections-progress')).toContainText('3 of 3 sections accepted · 2 of 2 files viewed')
  })

  test('the index shows the progress, and a click goes to a section, opens it when it is collapsed, and marks it as the one in view', async () => {
    await expect(page.getByTestId('index-progress')).toContainText('3 of 3 accepted')
    await expect(page.getByTestId('index-s1')).toHaveAttribute('data-state', 'accepted')
    await page.getByTestId('collapse-all').click()
    for (const id of ['s1', 's2', 'everything-else']) await expect(page.getByTestId(`section-${id}`)).toHaveAttribute('data-collapsed', 'true')
    await page.getByTestId('index-s1').click()
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-collapsed', 'false') // a click on the index opens the section
    await expect.poll(() => topOf('section-s1')).toBeLessThan(40)
    await expect(page.getByTestId('index-s1')).toHaveAttribute('aria-current', 'true')
    await page.getByTestId('expand-all').click() // the sections are open for the tests that follow
    await expect(page.getByTestId('section-everything-else')).toHaveAttribute('data-collapsed', 'false')
  })

  test('a comment on a section is posted on the change with the name of the section, shows on the section, and resolves', async () => {
    await page.getByTestId('section-comment-s1').click()
    await page.getByLabel('Comment', { exact: true }).fill('Why two?')
    await page.getByLabel('Comment', { exact: true }).press('Control+Enter')
    await expect(page.getByText('Posted on !12.')).toBeVisible()
    const post = forge.bodies.find((c) => c.method === 'POST')!
    expect(post.endpoint).toBe(`${EP}/discussions`)
    expect(post.body).toEqual({ body: commentBody })
    const box = page.getByTestId('section-thread-s1')
    await expect(box.getByTestId('thread')).toContainText('Why two?')
    await expect(page.getByTestId('section-thread-s2').getByTestId('thread')).toHaveCount(0) // only its own section
    await box.getByRole('button', { name: 'Resolve thread' }).click()
    await expect(box.getByTestId('thread')).toHaveAttribute('data-resolved', 'true')
    expect(forge.bodies.find((c) => c.method === 'PUT')!.body).toEqual({ resolved: true })
  })

  test('Everything else has a thread of its own, and a draft stays on its section until it is posted', async () => {
    await page.getByTestId('section-comment-everything-else').click()
    await page.getByLabel('Comment', { exact: true }).fill('Draft thought')
    await page.getByTestId('save-draft').click()
    const drafts = page.getByTestId('section-thread-everything-else').getByTestId('draft')
    await expect(drafts).toContainText('Draft thought')
    await expect(drafts).toContainText('Draft, not posted')
    const saved = JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'comments.json'), 'utf8'))
    expect(Object.values<{ path: unknown; body: string }>(saved).map((d) => [d.path, d.body])).toEqual([
      [null, '**Section: Everything else**\n\nDraft thought']
    ])
  })

  test('a file in the footer opens in the Linear view', async () => {
    await page.getByTestId('section-files-s2').getByTestId('sfile-a.txt').click()
    await expect(page.getByTestId('file-scope')).toContainText('!12 · backend/x')
    await expect(page.getByTestId('file-header')).toContainText('a.txt')
  })
})

test('a page that no longer matches is held back at the build, and written again when the Summarised tab opens', async () => {
  const s = setup()
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const stale = {
    ...GOOD,
    summary: 'The OLD page.',
    sections: [{ ...GOOD.sections[0], snippets: [{ mr: K, path: 'a.txt', lines: [99, 99] }] }, GOOD.sections[1]]
  }
  writeFileSync(join(dir, 'sections.json'), JSON.stringify(stale))
  writeFileSync(join(dir, 'sections-basis.json'), JSON.stringify({ issues: [], heads: { [K]: s.shas.head }, version: SECTIONS_PROMPT_VERSION }))
  const { app, page, forge } = await openReview(s, {}, ENV)
  // the build checked the saved page, held it back, and started nothing
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await expect(page.getByTestId('sections-banner')).toHaveCount(0)
  expect(runs(s)).toBe(0)
  // opening the Summarised tab writes the page
  await page.getByTestId('tab-summarised').click()
  await expect(page.getByTestId('sections-status')).toContainText('The AI is writing the Summarised page')
  await expect(page.getByTestId('sections-banner')).toContainText(
    'The Summarised page is out of date: the changes moved since it was written (1 problem(s)). The AI is writing it again.'
  )
  await expect(page.getByText('The OLD page.')).toHaveCount(0) // the old page is never shown while the run goes
  await expect(page.getByTestId('sections-summary')).toHaveText('A user sees the change.', { timeout: 20_000 })
  expect(runs(s)).toBe(1)
  await app.close()
  await forge.close()
})

test('a failed run shows the reason with a way to try again, and the banner', async () => {
  const s = setup()
  const { app, page, forge } = await openReview(s, {}, { FAKE_CLAUDE_ANSWER: 'no json here' })
  await page.getByTestId('tab-summarised').click()
  await expect(page.getByTestId('sections-error')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('sections-status')).toContainText('The answer still had 1 problem(s) after 3 answers')
  await expect(page.getByTestId('sections-banner')).toContainText('press Try again')
  expect(runs(s)).toBe(3) // three tries, and no fourth by itself
  await page.getByTestId('sections-retry').click()
  await expect.poll(() => runs(s), { timeout: 20_000 }).toBe(6)
  await expect(page.getByTestId('sections-error')).toBeVisible()
  await app.close()
  await forge.close()
})
