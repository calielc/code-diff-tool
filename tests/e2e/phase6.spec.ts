import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  shas: { base: string; head: string }
}

/** A workspace with one clone and one change (MR 12), like the other specs. */
function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e6-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  git('commit', '-qam', 'head')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, shas: { base: b, head: git('rev-parse', 'HEAD') } }
}

const P = encodeURIComponent('team/backend/x')
const mrFixture = (s: Setup): Fixture => ({
  'GET user': { json: { username: 'me' } },
  [`GET projects/${P}/merge_requests/12`]: {
    json: {
      web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
      state: 'opened',
      title: 'Change',
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

const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content })
const para = (text: string): unknown => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const crit = (n: number): unknown =>
  doc(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: Array.from({ length: n }, (_, i) => ({ type: 'listItem', content: [para(`Criterion ${i + 1}`)] })) }
  )

const jiraIssue = (key: string, o: { title: string; type?: string; status?: string; assignee?: string | null; criteria?: number }): Fixture => ({
  [`GET rest/api/3/issue/${key}`]: {
    json: {
      key,
      fields: {
        summary: o.title,
        issuetype: { name: o.type ?? 'Story' },
        status: { name: o.status ?? 'To Do' },
        assignee: o.assignee === null ? null : { displayName: o.assignee ?? 'Ann Lee' },
        updated: '2026-11-10T10:00:00.000+0100',
        description: crit(o.criteria ?? 2),
        attachment: []
      }
    }
  },
  [`GET rest/api/3/issue/${key}/comment`]: { json: { total: 0, comments: [] } }
})

async function openReview(
  s: Setup,
  issues: string[],
  fixture: Fixture,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  forge = await startFakeForge({ ...mrFixture(s), ...fixture })
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  return { app, page }
}

test('the Issues tab shows the rows, criteria counts, a failed row and the detail panel (checks 1, 2, 4, 5)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, ['LX-1', 'LX-2', 'LX-99'], {
    ...jiraIssue('LX-1', { title: 'Show the card', status: 'In Review', criteria: 2 }),
    ...jiraIssue('LX-2', { title: 'Hide the card', assignee: null, type: 'Bug', criteria: 3 }),
    'GET rest/api/3/issue/LX-99': { fail: 'HTTP 404 Issue does not exist' }
  })
  await expect(page.getByTestId('count-issues')).toHaveText('3')
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('issues-summary')).toHaveText('3 issues · 5 acceptance criteria, 1 Jira did not give')
  // rows keep the order of the review file, and the first one is selected with its file shown
  const keys = (): Promise<string[]> => page.locator('tbody tr td:first-child').allTextContents()
  expect(await keys()).toEqual(['LX-1', 'LX-2', 'LX-99'])
  await expect(page.getByTestId('issue-LX-1')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('issue-detail')).toContainText('Show the card')
  await expect(page.getByTestId('issue-detail')).toContainText('Fake summary.')
  // the failed row keeps its key and shows the error; its panel says so too
  await expect(page.getByTestId('issue-LX-99')).toContainText('Jira did not give this issue: HTTP 404 Not Found: Issue does not exist')
  await page.getByTestId('issue-LX-99').click()
  await expect(page.getByTestId('issue-detail')).toContainText('Jira did not give this issue: HTTP 404 Not Found: Issue does not exist')
  // sorting: ascending, then descending, with the arrow; the unassigned issue stays last by assignee in both directions
  await page.getByRole('button', { name: /^Issue/ }).click()
  await expect(page.getByRole('button', { name: 'Issue ▲' })).toBeVisible()
  await page.getByRole('button', { name: 'Issue ▲' }).click()
  expect(await keys()).toEqual(['LX-99', 'LX-2', 'LX-1'])
  await page.getByRole('button', { name: /^Assignee/ }).click()
  expect((await keys()).at(-1)).toBe('LX-99') // no assignee and no row data: empty values go last
  await expect(page.getByTestId('issue-LX-2')).toContainText('Unassigned')
  await app.close()
})

test('adding issues: the statuses, the refused values, and the limits (checks 8, 9 and 10)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, ['LX-1'], { ...jiraIssue('LX-1', { title: 'One' }), ...jiraIssue('LX-3', { title: 'Three' }) })
  await page.getByTestId('tab-issues').click()
  const input = page.getByLabel('Jira issues to add')
  const add = page.getByRole('button', { name: 'Add issues' })
  await add.click()
  await expect(page.getByTestId('add-status')).toHaveText('Paste one or more Jira issue keys or URLs first.')
  await input.fill(Array.from({ length: 21 }, (_, i) => `LX-${i + 1}`).join(' '))
  await add.click()
  await expect(page.getByTestId('add-status')).toHaveText('Send 1 to 20 Jira issue keys or URLs.')
  await input.fill('lx3 abc LX-1')
  await add.click()
  await expect(page.getByTestId('add-status')).toContainText('Added LX-3.')
  await expect(page.getByTestId('add-problem').nth(0)).toHaveText('abc: Not a Jira issue key or URL.')
  await expect(page.getByTestId('add-problem').nth(1)).toHaveText('LX-1: Already in this review.')
  await expect(input).toHaveValue('abc LX-1') // the input now holds the refused values
  expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'review.json'), 'utf8')).issues).toEqual(['LX-1', 'LX-3'])
  await page.getByRole('button', { name: 'Reload to see them' }).click()
  await expect(page.getByTestId('count-issues')).toHaveText('2', { timeout: 15_000 })
  await app.close()
})

test('Prerequisites: a token is checked before it is saved, then kept encrypted and never shown again', async () => {
  const s = setup()
  forge = await startFakeForge({
    'GET rest/api/3/myself': [{ fail: 'HTTP 401 Unauthorized' }, { json: { displayName: 'Me' } }],
    'GET user': { json: { username: 'me' } }
  })
  // no CODEDIFF_TEST_CREDENTIALS, so the real encrypted store is used
  const { CODEDIFF_TEST_CREDENTIALS: _drop, ...env } = forgeEnv(forge.url)
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...env } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByTestId('row-jira')).toContainText('Not set up')
  await page.getByTestId('add-jira').click()
  await page.getByLabel('Jira site').fill('acme.atlassian.net')
  await page.getByLabel('Jira account email').fill('me@example.com')
  await page.getByLabel('Jira token').fill('secret-token-123')
  await page.getByRole('button', { name: 'Check and save' }).click()
  await expect(page.getByTestId('access-error-jira')).toContainText('That token did not work: HTTP 401 Unauthorized')
  expect(existsSync(join(s.ud, 'credentials.json'))).toBe(false) // a token that does not work is not saved
  await page.getByRole('button', { name: 'Check and save' }).click()
  await expect(page.getByTestId('row-jira')).toContainText('Access to acme.atlassian.net')
  await expect(page.getByTestId('row-jira')).toContainText('Ready')
  // the token left the page, and the file holds it only encrypted
  expect(await page.content()).not.toContain('secret-token-123')
  const stored = readFileSync(join(s.ud, 'credentials.json'), 'utf8')
  expect(stored).not.toContain('secret-token-123')
  expect(stored).toContain('jira:acme.atlassian.net')
  // GitLab access makes the required checks pass, so Done opens
  await expect(page.getByTestId('done')).toBeDisabled()
  await page.getByTestId('add-gitlab').click()
  await page.getByLabel('GitLab token').fill('glpat-secret-456')
  await page.getByRole('button', { name: 'Check and save' }).click()
  await expect(page.getByTestId('row-gitlab')).toContainText('Access to gitlab.com')
  await expect(page.getByTestId('done')).toBeEnabled()
  expect(readFileSync(join(s.ud, 'credentials.json'), 'utf8')).not.toContain('glpat-secret-456')
  // removing it again
  await page.getByTestId('access-gitlab').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('row-gitlab')).toContainText('Not set up')
  await app.close()
})

function specFiles(): { dir: string; md: string; txt: string; pdf: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codediff-specs-'))
  const md = join(dir, 'Checkout.md')
  const txt = join(dir, 'notes.txt')
  const pdf = join(dir, 'doc.pdf')
  writeFileSync(md, ['# Checkout flow', '', '## Acceptance criteria', '', '- Pays by card', '- Shows a receipt', ''].join('\n'))
  writeFileSync(txt, ['Plain notes', 'no criteria here', ''].join('\n'))
  writeFileSync(pdf, 'not a spec')
  return { dir, md, txt, pdf }
}

test('spec files become issues next to Jira issues, with their own detail and refused files named', async () => {
  const s = setup()
  const f = specFiles()
  const { app, page } = await openReview(s, ['LX-1'], jiraIssue('LX-1', { title: 'Show the card', criteria: 1 }), {
    CODEDIFF_TEST_PICK_FILES: JSON.stringify([f.md, f.txt, f.pdf])
  })
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('issues-summary')).toHaveText('1 issue · 1 acceptance criteria')
  await page.getByTestId('add-spec-files').click()
  await expect(page.getByTestId('add-status')).toContainText('Added Checkout.md, notes.txt.')
  await expect(page.getByTestId('add-problem')).toHaveText('doc.pdf: Only .md, .txt and .html files can be added.')
  await page.getByRole('button', { name: 'Reload to see them' }).click()
  await expect(page.getByTestId('count-issues')).toHaveText('3', { timeout: 15_000 })
  // the spec file row: its name is the key, the type is Spec, and its criteria are counted
  const row = page.getByTestId('issue-Checkout.md')
  await expect(row).toContainText('Spec')
  await expect(row).toContainText('Checkout flow')
  await expect(page.getByTestId('issues-summary')).toHaveText('3 issues · 3 acceptance criteria')
  await row.click()
  await expect(page.getByTestId('issue-detail')).toContainText('Source: spec file')
  await expect(page.getByTestId('issue-detail')).toContainText('Fake summary.')
  // the review keeps its own copy of the file
  expect(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'specs', 'Checkout.md'), 'utf8')).toContain('Pays by card')
  expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'review.json'), 'utf8')).issues).toEqual(['LX-1', 'Checkout.md', 'notes.txt'])
  await app.close()
})

test('a new review can start with spec files, and a refused file is shown before the review opens', async () => {
  const s = setup()
  const f = specFiles()
  forge = await startFakeForge(mrFixture(s))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), CODEDIFF_TEST_PICK_FILES: JSON.stringify([f.md, f.pdf]) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('new-review').click()
  await page.getByTestId('urls').fill('https://gitlab.com/team/backend/x/-/merge_requests/12')
  await page.getByTestId('slug').fill('S-1')
  await page.getByTestId('pick-specs').click()
  await expect(page.getByTestId('spec-names')).toContainText('Checkout.md, doc.pdf')
  await page.getByTestId('check').click()
  await page.getByTestId('create').click()
  await expect(page.getByTestId('file-problems')).toContainText('doc.pdf: Only .md, .txt and .html files can be added.')
  expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'S-1', 'review.json'), 'utf8')).issues).toEqual(['Checkout.md'])
  await page.getByRole('button', { name: 'Open the review' }).click()
  await expect(page.getByTestId('count-issues')).toHaveText('1')
  await app.close()
})

test('a spec file whose copy was removed shows as a failed row and the others still work', async () => {
  const s = setup()
  const { app, page } = await openReview(s, ['gone.md'], {})
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('issue-gone.md')).toContainText('This spec file cannot be read: The file is missing from the review folder.')
  await expect(page.getByTestId('issues-summary')).toContainText('1 Jira did not give')
  await app.close()
})
