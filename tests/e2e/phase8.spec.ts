import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

interface Setup {
  root: string
  ud: string
  log: string
  shas: { base: string; head: string }
}

/** One change that edits line 2 of a.txt and adds b.txt. */
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
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
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

const K = 'backend/x!12'
/** Two sections that both show a.txt. The second one also shows the new file b.txt. */
const GOOD = {
  summary: 'A user sees the change.',
  sections: [
    {
      id: 's1',
      title: 'The first idea',
      text: 'It changes line two.',
      snippets: [{ mr: K, path: 'a.txt', lines: [2, 2] }],
      files: []
    },
    {
      id: 's2',
      title: 'The second idea',
      text: 'It also needs line two, and adds a file.',
      snippets: [
        { mr: K, path: 'a.txt', lines: [2, 2] },
        { mr: K, path: 'b.txt', lines: [1, 1] }
      ],
      files: []
    }
  ]
}
const ENV = { CODEDIFF_TEST_SECTIONS: '1', FAKE_CLAUDE_ANSWER: JSON.stringify(GOOD) }

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
    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('view-summarised')).toBeEnabled({ timeout: 20_000 }) // pending first, then ready
    await page.getByTestId('view-summarised').click()
  })
  test.afterAll(async () => {
    await app.close()
    await forge.close()
  })

  test('arrives without a reload as a page of sections in order, with code, files and coverage', async () => {
    await expect(page.getByTestId('sections-summary')).toHaveText('A user sees the change.')
    await expect(page.locator('article.section h3')).toHaveText(['The first idea', 'The second idea'])
    await expect(page.getByTestId('section-s1')).toContainText('It changes line two.')
    await expect(page.getByTestId('section-s1').locator('table.diff tr.add')).toContainText('TWO')
    await expect(page.getByTestId('section-s1').locator('table.diff tr.del')).toContainText('two')
    await expect(page.getByTestId('section-s2').locator('.snippet')).toHaveCount(2)
    await expect(page.getByTestId('section-files-s2')).toContainText('a.txt')
    await expect(page.getByTestId('section-files-s2')).toContainText('b.txt')
    await expect(page.getByTestId('sections-coverage')).toHaveText('All 2 changed files are in a section.')
    await expect(page.getByTestId('sections-progress')).toContainText('0 of 2 sections accepted · 0 of 2 files viewed')
    await expect(page.getByTestId('sections-banner')).toHaveCount(0)
    expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'sections.json'), 'utf8')).summary).toBe('A user sees the change.')
    await expect(page.getByTestId('file-a.txt')).toBeHidden() // the Summarised view shows no tree
  })

  test('Accept marks the files viewed, and a file of two sections waits for both', async () => {
    await page.getByTestId('accept-s1').click()
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-accepted', 'true')
    await expect(page.getByTestId('section-progress-s1')).toHaveText('0 of 1 file viewed') // a.txt waits for the second idea
    await expect(page.getByTestId('section-files-s1').getByTestId('sfile-a.txt')).toHaveAttribute('title', /Not viewed until you accept: The second idea/)
    await page.getByTestId('accept-s2').click()
    await expect(page.getByTestId('section-progress-s1')).toHaveText('1 of 1 file viewed')
    await expect(page.getByTestId('section-progress-s2')).toHaveText('2 of 2 files viewed')
    await expect(page.getByTestId('sections-progress')).toContainText('2 of 2 sections accepted · 2 of 2 files viewed')
    // the Linear view shows the same marks, with its own counter
    await page.getByRole('button', { name: 'Linear', exact: true }).click()
    await expect(page.getByTestId('file-a.txt')).toHaveClass(/viewed/)
    await expect(page.getByTestId('file-b.txt')).toHaveClass(/viewed/)
    await expect(page.locator('.filetree .progress')).toContainText('2 of 2 viewed')
    await page.getByTestId('view-summarised').click()
  })

  test('un-accepting a section takes the viewed mark from its files, and a file marked in the tree takes the section out', async () => {
    await page.getByTestId('accept-s1').click() // un-accept the first
    await expect(page.getByTestId('section-s1')).toHaveAttribute('data-accepted', 'false')
    await expect(page.getByTestId('section-s2')).toHaveAttribute('data-accepted', 'true') // a.txt waits for the first idea
    await expect(page.getByTestId('section-progress-s2')).toHaveText('1 of 2 files viewed')
    await page.getByRole('button', { name: 'Linear', exact: true }).click()
    await expect(page.getByTestId('file-a.txt')).not.toHaveClass(/viewed/)
    await expect(page.getByTestId('file-b.txt')).toHaveClass(/viewed/)
    await page.getByTestId('file-b.txt').getByTitle('Viewed').uncheck() // un-view the file that only the second idea shows
    await page.getByTestId('view-summarised').click()
    await expect(page.getByTestId('section-s2')).toHaveAttribute('data-accepted', 'false')
    await page.getByTestId('accept-s1').click() // accept the first again: a.txt waits for the second
    await page.getByTestId('accept-s2').click()
    await expect(page.getByTestId('sections-progress')).toContainText('2 of 2 sections accepted · 2 of 2 files viewed')
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

  test('a section can keep its comment as a draft, which stays on the section until it is posted', async () => {
    await page.getByTestId('section-comment-s2').click()
    await page.getByLabel('Comment', { exact: true }).fill('Draft thought')
    await page.getByTestId('save-draft').click()
    const drafts = page.getByTestId('section-thread-s2').getByTestId('draft')
    await expect(drafts).toContainText('Draft thought')
    await expect(drafts).toContainText('Draft, not posted')
    const saved = JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'comments.json'), 'utf8'))
    expect(Object.values<{ path: unknown; body: string }>(saved).map((d) => [d.path, d.body])).toEqual([
      [null, '**Section: The second idea**\n\nDraft thought']
    ])
  })

  test('a file in the footer opens in the Linear view', async () => {
    await page.getByTestId('section-files-s2').getByTestId('sfile-b.txt').click()
    await expect(page.getByTestId('file-scope')).toContainText('!12 · backend/x')
    await expect(page.getByTestId('file-header')).toContainText('b.txt')
  })
})

test('a page that no longer matches is hidden, shown as out of date, and replaced', async () => {
  const s = setup()
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const stale = {
    ...GOOD,
    summary: 'The OLD page.',
    sections: [{ ...GOOD.sections[0], snippets: [{ mr: K, path: 'a.txt', lines: [99, 99] }] }, GOOD.sections[1]]
  }
  writeFileSync(join(dir, 'sections.json'), JSON.stringify(stale))
  writeFileSync(join(dir, 'sections-basis.json'), JSON.stringify({ issues: [], heads: { [K]: s.shas.head } }))
  const { app, page, forge } = await openReview(s, {}, { ...ENV, FAKE_CLAUDE_SLEEP_MS: '2500' })
  await expect(page.getByTestId('sections-banner')).toContainText(
    'The Summarised page is out of date: the changes moved since it was written (1 problem(s)). The AI is writing it again.'
  )
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('view-summarised')).toBeDisabled() // the old page is never shown while the run goes
  await expect(page.getByText('The OLD page.')).toHaveCount(0)
  await expect(page.getByTestId('view-summarised')).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByTestId('sections-banner')).toHaveCount(0)
  await page.getByTestId('view-summarised').click()
  await expect(page.getByTestId('sections-summary')).toHaveText('A user sees the change.')
  await app.close()
  await forge.close()
})
