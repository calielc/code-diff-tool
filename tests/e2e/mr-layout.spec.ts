import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const P = encodeURIComponent('team/backend/x')
const EP = (iid: number): string => `projects/${P}/merge_requests/${iid}`
const key = (iid: number): string => `backend/x!${iid}`
const HEADERS = [
  'Repository',
  'Change request',
  'Stack',
  'Title',
  'Pipeline',
  'Author',
  'Reviewers',
  'Approved by',
  'Your review',
  'Comments',
  'Created',
  'Updated',
  'Merged',
  'State'
]

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

function setupRepo(): { root: string; ud: string; base: string; head: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-mrlayout-'))
  const root = join(tmp, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('checkout', '-q', '-B', 'main')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  // The default branch of the repo is read from origin/HEAD of the clone.
  git('update-ref', 'refs/remotes/origin/main', base)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-B', 'mr1', base)
  writeFileSync(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'mr1')
  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, base, head: git('rev-parse', 'HEAD') }
}

interface MrSpec {
  iid: number
  author: string
  state: 'opened' | 'merged' | 'closed'
  created: string
  source?: string
  target?: string
  draft?: boolean
  canApprove?: boolean
  approvedBy?: string[]
  extra?: object
}

// Dates are in 2025 so the year always shows. The app runs with TZ=UTC.
const SPECS: MrSpec[] = [
  { iid: 21, author: 'ann', state: 'opened', created: '2025-01-06T12:00:00Z', source: 'feat-a', canApprove: true },
  { iid: 22, author: 'ann', state: 'opened', created: '2025-01-02T12:00:00Z', draft: true, canApprove: false },
  {
    iid: 23,
    author: 'bob',
    state: 'merged',
    created: '2025-01-03T12:00:00Z',
    approvedBy: ['bob'],
    extra: { merged_at: '2025-01-09T08:00:00Z', updated_at: '2025-01-09T08:00:00Z' }
  },
  { iid: 24, author: 'bob', state: 'closed', created: '2025-01-04T12:00:00Z' },
  { iid: 25, author: 'me', state: 'opened', created: '2025-01-05T12:00:00Z', canApprove: true },
  { iid: 26, author: 'carol', state: 'opened', created: '2025-01-07T12:00:00Z', approvedBy: ['me'] },
  { iid: 27, author: 'ann', state: 'opened', created: '2025-01-08T12:00:00Z', source: 'stack-1', canApprove: true },
  { iid: 28, author: 'ann', state: 'opened', created: '2025-01-01T12:00:00Z', source: 'stack-2', target: 'stack-1', canApprove: false }
]

const person = (username: string): object => ({ username, name: username.toUpperCase() })

function buildFixture(s: { base: string; head: string }, over: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture: Record<string, unknown> = { 'GET user': { json: { username: 'me' } } }
  for (const m of SPECS) {
    const open = m.state === 'opened'
    fixture[`GET ${EP(m.iid)}`] = {
      json: {
        web_url: `https://gitlab.com/team/backend/x/-/merge_requests/${m.iid}`,
        state: m.state,
        title: m.draft ? 'Draft: Wip' : `Change ${m.iid}`,
        draft: m.draft === true,
        author: person(m.author),
        source_branch: m.source ?? `branch-${m.iid}`,
        target_branch: m.target ?? 'main',
        created_at: m.created,
        updated_at: '2025-02-01T09:05:00Z',
        user_notes_count: 0,
        diff_refs: { base_sha: s.base, start_sha: s.base, head_sha: s.head },
        ...(m.iid === 21
          ? {
              merge_when_pipeline_succeeds: true,
              merge_user: { username: 'zed' },
              head_pipeline: { id: 100, project_id: 7, status: 'success', web_url: 'https://gitlab.com/team/backend/x/-/pipelines/100' }
            }
          : {}),
        ...m.extra
      }
    }
    const by = (m.approvedBy ?? []).map((u) => ({ user: person(u) }))
    fixture[`GET ${EP(m.iid)}/approvals`] = {
      json: { approved_by: by, user_can_approve: open && m.canApprove === true, user_has_approved: (m.approvedBy ?? []).includes('me') }
    }
    fixture[`GET ${EP(m.iid)}/discussions`] = {
      json:
        m.iid === 21
          ? [
              {
                id: 'a'.repeat(40),
                notes: [
                  {
                    id: 71,
                    body: 'SECRET-THREAD-BODY',
                    resolvable: true,
                    resolved: false,
                    author: person('bob'),
                    created_at: '2025-01-03T10:00:00Z',
                    position: { new_path: 'src/a.txt', old_path: 'src/a.txt', new_line: 2 }
                  }
                ]
              }
            ]
          : []
    }
    fixture[`GET ${EP(m.iid)}/reviewers`] = { json: [] }
  }
  fixture['GET projects/7/pipelines/100/jobs'] = {
    json: [
      { id: 1, name: 'compile', stage: 'build', status: 'success', allow_failure: false, web_url: 'https://gitlab.com/j/1' },
      { id: 2, name: 'unit', stage: 'test', status: 'failed', allow_failure: true, web_url: 'https://gitlab.com/j/2' }
    ]
  }
  fixture['GET projects/7/pipelines/100/bridges'] = { json: [] }
  return { ...fixture, ...over }
}

async function launch(over: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const s = setupRepo()
  forge = await startFakeForge(buildFixture(s, over) as Record<string, any>)
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({ title: 'Review', mrs: SPECS.map((m) => ({ projectPath: 'team/backend/x', iid: m.iid })), issues: [] })
  )
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, TZ: 'UTC', CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home-tab-reviews')).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  return { app, page }
}

const headers = async (page: Page): Promise<string[]> =>
  (await page.locator('[data-testid="mrs-tab"] table thead th').allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())

async function cell(page: Page, iid: number, header: string): Promise<Locator> {
  // The column order is asserted in the first test. A fixed index lets the locator wait through the moment a rebuild takes the table away.
  const col = HEADERS.indexOf(header)
  expect(col, `column ${header}`).toBeGreaterThan(-1)
  return page
    .getByTestId(`mr-${key(iid)}`)
    .locator('td')
    .nth(col)
}

const rowOrder = async (page: Page): Promise<number[]> =>
  (await page.locator('tr[data-testid^="mr-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid') ?? ''))).map((id) =>
    Number(id.slice(id.lastIndexOf('!') + 1))
  )

test('the table has the columns, summary, stack pills, your review cells and the Created default sort of the reference', async () => {
  const { app, page } = await launch()
  const wait = { timeout: 15_000 }

  // Columns, in order, and the default sort.
  await expect(page.getByTestId('mrs-summary')).toBeVisible(wait)
  expect(await headers(page)).toEqual(HEADERS)
  await expect(page.locator('[data-testid="mrs-tab"] table thead th').nth(HEADERS.indexOf('Created'))).toHaveAttribute('aria-sort', 'ascending')
  expect(await rowOrder(page)).toEqual([28, 22, 23, 25, 21, 26, 27])

  // The summary counts every MR, the filters hide only the closed one, and 3 open MRs can be approved (one is the viewer's own).
  const summary = page.getByTestId('mrs-summary')
  await expect(summary).toContainText('Change requests')
  await expect(summary).toContainText('1 draft · 5 open · 1 merged · 1 closed, 1 hidden')
  await expect(summary).toContainText('3 you can approve')

  // Stack pills: a stacked pair, a dash for the rest.
  await expect(await cell(page, 27, 'Stack')).toHaveText('1 of 2')
  await expect(await cell(page, 28, 'Stack')).toHaveText('2 of 2')
  await expect((await cell(page, 28, 'Stack')).locator('[title]')).toHaveAttribute('title', 'Stacked on !27: Change 27')
  await expect((await cell(page, 27, 'Stack')).locator('[title]')).toHaveAttribute('title', 'The base of the stack. !28 stacks on it')
  await expect(await cell(page, 21, 'Stack')).toHaveText('–')

  // Title with the branch line, repo without a group, dates in 24-hour time with the year.
  await expect(await cell(page, 21, 'Title')).toContainText('feat-a → main')
  await expect(await cell(page, 21, 'Repository')).toHaveText('backend/x')
  await expect(await cell(page, 21, 'Reviewers')).toHaveText('–')
  await expect(await cell(page, 21, 'Created')).toHaveText('Jan 6, 2025, 12:00')
  await expect(await cell(page, 21, 'Updated')).toHaveText('Feb 1, 2025, 09:05')
  await expect(await cell(page, 21, 'Merged')).toHaveText('–')
  await expect(await cell(page, 23, 'Merged')).toHaveText('Jan 9, 2025, 08:00')

  // Pipeline: the status pill and one circle per stage. No pipeline gives a dash.
  const pipe = await cell(page, 21, 'Pipeline')
  await expect(pipe).toContainText('success')
  await expect(pipe.locator('[aria-label="Stage build: success"]')).toHaveCount(1)
  await expect(pipe.locator('[aria-label="Stage test: warning"]')).toHaveCount(1)
  await expect(await cell(page, 22, 'Pipeline')).toHaveText('–')

  // State pills and the Auto-merge pill (only an open MR that has it on).
  await expect(await cell(page, 21, 'State')).toContainText('Open')
  await expect((await cell(page, 21, 'State')).getByText('Auto-merge')).toHaveAttribute(
    'title',
    'Auto-merge is on, set by zed. GitLab merges this change request when the pipeline succeeds.'
  )
  await expect(await cell(page, 22, 'State')).toContainText('Draft')
  await expect(await cell(page, 23, 'State')).toContainText('Merged')
  await expect((await cell(page, 27, 'State')).getByText('Auto-merge')).toHaveCount(0)

  // Mark as ready and Mark as draft are in the State cell, only for the viewer's own open MRs.
  const stateButtons = async (iid: number): Promise<string[]> => await (await cell(page, iid, 'State')).getByRole('button').allTextContents()
  expect(await stateButtons(25)).toEqual(['Mark as draft'])
  await expect((await cell(page, 25, 'State')).getByTestId('icon-mark-draft')).toHaveCount(1)
  for (const iid of [21, 22, 23, 26, 27]) expect(await stateButtons(iid), `!${iid}`).toEqual([])

  // Your review: the status text and the buttons.
  const review = async (iid: number): Promise<Locator> => await cell(page, iid, 'Your review')
  const buttons = async (iid: number): Promise<string[]> => await (await review(iid)).getByRole('button').allTextContents()
  await expect(await review(21)).toContainText('Not reviewed by you yet')
  expect(await buttons(21)).toEqual(['Submit review', 'Approve'])
  await expect(await review(22)).toContainText('Not an eligible approver')
  expect(await buttons(22)).toEqual(['Submit review'])
  await expect(await review(23)).toContainText('Merged, no approval')
  expect(await buttons(23)).toEqual([])
  await expect(await review(25)).toContainText('You are the author')
  expect(await buttons(25)).toEqual([]) // Mark as draft moved to the State column
  await expect(await review(26)).toContainText('✓ Approved by you')
  expect(await buttons(26)).toEqual(['Submit review', 'Revoke approval'])

  // Comments: the short text only, and No threads when there is none.
  const open21 = await cell(page, 21, 'Comments')
  await expect(open21).toContainText('1/1')
  await expect(open21).toContainText('1 open, 0 resolved')
  await expect(await cell(page, 22, 'Comments')).toHaveText('No threads')

  // A click on a header sorts by it.
  await page.locator('[data-testid="mrs-tab"] table thead th').nth(HEADERS.indexOf('Change request')).getByRole('button').click()
  expect(await rowOrder(page)).toEqual([21, 22, 23, 25, 26, 27, 28])
  await app.close()
})

test('Approve all shows its count and tooltip, and Approve updates the row after the rebuild', async () => {
  const noOne = { json: { approved_by: [], user_can_approve: true, user_has_approved: false } }
  const done = { json: { approved_by: [{ user: person('me') }], user_can_approve: false, user_has_approved: true } }
  const { app, page } = await launch({
    // The build reads the first entry, the rebuild after the click reads the second.
    [`GET ${EP(21)}/approvals`]: [noOne, done],
    [`POST ${EP(21)}/approve`]: { empty: true }
  })
  const all = page.getByRole('button', { name: /^Approve all/ })
  await expect(all).toHaveText('Approve all (2)', { timeout: 15_000 })
  await expect(all).toHaveAttribute('title', 'Approves !21 backend/x, !27 backend/x')

  await (await cell(page, 21, 'Your review')).getByRole('button', { name: 'Approve', exact: true }).click()

  await expect(await cell(page, 21, 'Your review')).toContainText('✓ Approved by you', { timeout: 15_000 })
  expect(forge!.bodies.filter((b) => b.endpoint === `${EP(21)}/approve`)).toHaveLength(1)
  await expect(page.getByRole('button', { name: /^Approve all/ })).toHaveText('Approve all (1)')
  await expect(page.getByTestId('mrs-summary')).toContainText('2 you can approve')
  await app.close()
})
