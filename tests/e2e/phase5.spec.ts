import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

// The fake GitLab, GitHub and Jira of the current test. It is closed after each test.
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})
const P = encodeURIComponent('team/backend/x')
const EP = (iid: number): string => `projects/${P}/merge_requests/${iid}`

interface Setup {
  root: string
  ud: string
  fixture: string
  bodies: string
  calls: string
  shas: { base: string; head: string }
}

function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e5-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-B', 'mr1', b)
  writeFileSync(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'mr1')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return {
    root,
    ud,
    fixture: join(base, 'fixture.json'),
    bodies: join(base, 'bodies.log'),
    calls: join(base, 'calls.log'),
    shas: { base: b, head: git('rev-parse', 'HEAD') }
  }
}

/** MR 12 by `ann`, with the viewer `me`. Extra fixture entries override these. */
function fixtures(s: Setup, over: Record<string, unknown> = {}, state = 'opened'): Record<string, unknown> {
  const mr = {
    web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
    state,
    title: 'Change 12',
    author: { username: 'ann', name: 'Ann Lee' },
    source_branch: 'mr1',
    target_branch: 'main',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    user_notes_count: 0,
    diff_refs: { base_sha: s.shas.base, start_sha: s.shas.base, head_sha: s.shas.head }
  }
  return {
    'GET user': { json: { username: 'me' } },
    [`GET ${EP(12)}`]: { json: mr },
    [`GET ${EP(12)}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET ${EP(12)}/discussions`]: { json: [] },
    [`GET ${EP(12)}/reviewers`]: { json: [] },
    ...over
  }
}

const thread = (id: string, noteId: number, author: string, body: string, extra: object = {}): object => ({
  id: id.repeat(40),
  notes: [
    {
      id: noteId,
      body,
      resolvable: true,
      resolved: false,
      author: { username: author, name: author },
      created_at: '2026-01-03T10:00:00Z',
      position: { new_path: 'src/a.txt', old_path: 'src/a.txt', new_line: 2 },
      ...extra
    }
  ]
})

async function open(
  s: Setup,
  fixture: Record<string, unknown>,
  env: Record<string, string> = {},
  comments?: object
): Promise<{ app: ElectronApplication; page: Page }> {
  forge = await startFakeForge(fixture as Record<string, any>)
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: [{ projectPath: 'team/backend/x', iid: 12 }], issues: [] }))
  if (comments) writeFileSync(join(dir, 'comments.json'), JSON.stringify(comments))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), ...env } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  return { app, page }
}

async function toDiff(page: Page): Promise<void> {
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('file-src/a.txt').click()
  await expect(page.locator('table.diff tr.add')).toBeVisible()
}

// The writes the app sent, in order, as the fake server saw them.
const bodies = (_s?: Setup): { method: string; endpoint: string; body: any }[] =>
  (forge?.bodies ?? []).map((c) => ({ method: c.method, endpoint: c.endpoint, body: c.body }))

/** Hover the added line and press its + button. */
async function plusOnAdded(page: Page): Promise<void> {
  const row = page.locator('table.diff tr.add').first()
  await row.hover()
  await row.getByRole('button', { name: 'Comment on this line' }).click()
}

test('posts a line comment, shows the new thread at once and keeps the position (checks 1)', async () => {
  const s = setup()
  const { app, page } = await open(
    s,
    fixtures(s, {
      [`GET ${EP(12)}/discussions`]: [{ json: [] }, { json: [thread('a', 51, 'me', 'Please rename.')] }],
      [`POST ${EP(12)}/discussions`]: { empty: true }
    })
  )
  await toDiff(page)
  await plusOnAdded(page)
  await expect(page.getByText('Goes to !12, line 2')).toBeVisible()
  await page.getByLabel('Comment', { exact: true }).fill('Please rename.')
  await page.getByLabel('Comment', { exact: true }).press('Control+Enter')
  await expect(page.getByText('Posted on !12.')).toBeVisible()
  await expect(page.getByTestId('thread')).toContainText('Please rename.')
  const post = bodies(s).find((b) => b.method === 'POST')!
  expect(post.body.position).toMatchObject({ new_path: 'src/a.txt', old_path: 'src/a.txt', old_line: null, new_line: 2, head_sha: s.shas.head })
  await app.close()
})

test('a refused position becomes a plain discussion that starts with the path and line (check 1)', async () => {
  const s = setup()
  const { app, page } = await open(s, fixtures(s, { [`POST ${EP(12)}/discussions`]: [{ fail: 'HTTP 400 Bad Request' }, { empty: true }] }))
  await toDiff(page)
  await plusOnAdded(page)
  await page.getByLabel('Comment', { exact: true }).fill('Why?')
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByText('Posted on !12.')).toBeVisible()
  const posts = bodies(s).filter((b) => b.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[1].body).toEqual({ body: '`src/a.txt`, line 2: Why?' })
  await app.close()
})

test('a failed post keeps the text and shows the error', async () => {
  const s = setup()
  const { app, page } = await open(s, fixtures(s, { [`POST ${EP(12)}/discussions`]: { fail: 'HTTP 403 Forbidden' } }))
  await toDiff(page)
  await plusOnAdded(page)
  await page.getByLabel('Comment', { exact: true }).fill('Keep me')
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByTestId('post-error')).toContainText('HTTP 403 Forbidden')
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep me')
  await app.close()
})

test('a merged change takes no comment (check 3)', async () => {
  const s = setup()
  const { app, page } = await open(s, fixtures(s, {}, 'merged'))
  await toDiff(page)
  await expect(page.getByRole('button', { name: 'Comment on this line' })).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Read-only: merged change request' }).first()).toBeVisible()
  await app.close()
})

test('resolves a thread, folds it and updates the chip; deletes the viewer’s last note after a confirm', async () => {
  const s = setup()
  const { app, page } = await open(
    s,
    fixtures(s, {
      [`GET ${EP(12)}/discussions`]: [{ json: [thread('b', 61, 'me', 'my note')] }, { json: [] }], // the build, then the read-back after the delete
      [`PUT ${EP(12)}/discussions/${'b'.repeat(40)}`]: { empty: true },
      [`DELETE ${EP(12)}/notes/61`]: { empty: true }
    })
  )
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('thread-chip')).toContainText('0/1'.replace('0', '1')) // 1 open of 1
  await page.getByTestId('file-src/a.txt').click()
  await page.getByRole('button', { name: 'Resolve thread' }).click()
  await expect(page.getByTestId('thread')).toHaveAttribute('data-resolved', 'true')
  await expect(page.getByTestId('thread-chip')).toContainText('0/1')
  expect(bodies(s).find((b) => b.method === 'PUT')!.body).toEqual({ resolved: true })
  // the resolved thread starts folded, so open it, then delete with a confirm
  await page
    .getByTestId('thread')
    .getByRole('button', { name: /my note/ })
    .click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(page.getByTestId('thread')).toHaveCount(0)
  await app.close()
})

test('the Open filter of the comments shows only the open threads, and another person’s note has no Delete', async () => {
  const s = setup()
  const resolved = thread('c', 71, 'bob', 'old', { resolved: true })
  const { app, page } = await open(s, fixtures(s, { [`GET ${EP(12)}/discussions`]: { json: [resolved, thread('d', 72, 'bob', 'new one')] } }))
  await toDiff(page)
  await expect(page.getByTestId('thread')).toHaveCount(2)
  await page.getByTestId('comments-open').click()
  await expect(page.getByTestId('thread')).toHaveCount(1)
  await page
    .getByTestId('thread')
    .getByRole('button', { name: /new one/ })
    .click({ trial: true })
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await app.close()
})

test('drafts: shown with the review-bar text, edited, persisted, posted once and deleted', async () => {
  const s = setup()
  const h = s.shas
  const draft = (id: string, body: string): object => ({
    id,
    mr: 'backend/x!12',
    diffRefs: { base: h.base, start: h.base, head: h.head },
    path: 'src/a.txt',
    oldPath: 'src/a.txt',
    oldLine: null,
    newLine: 2,
    body,
    claude: { skill: 'review-code', lens: 'Correctness', severity: 'blocking' }
  })
  const { app, page } = await open(
    s,
    fixtures(s, { [`POST ${EP(12)}/discussions`]: { empty: true } }),
    {},
    { d1: draft('d1', 'First draft'), d2: draft('d2', 'Second draft') }
  )
  await toDiff(page)
  await expect(page.getByTestId('review-bar-text')).toHaveText('2 drafts not posted yet. Post or delete each one.')
  const cards = page.getByTestId('draft')
  await expect(cards.first()).toContainText('Claude')
  await expect(cards.first()).toContainText('Draft, not posted')
  await expect(cards.first()).toContainText('review-code · Correctness · blocking')
  // edit and save, and it survives on disk
  await cards.first().getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Comment', { exact: true }).fill('First draft, edited')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('First draft, edited')).toBeVisible()
  const file = join(s.root, '.code-diff', 'reviews', 'R-1', 'comments.json')
  await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).d1.body).toBe('First draft, edited')
  // delete one: gone from the screen and from the disk
  await cards.nth(1).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('review-bar-text')).toHaveText('1 draft not posted yet. Post or delete each one.')
  await expect.poll(() => Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['d1'])
  // post the other: it leaves the drafts and is posted once
  await page.getByRole('button', { name: 'Post comment' }).click()
  await expect(page.getByText('Posted on !12.')).toBeVisible()
  await expect(page.getByTestId('draft')).toHaveCount(0)
  expect(bodies(s).filter((b) => b.method === 'POST')).toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  await app.close()
})

test('submit review: validation, sequence, partial failure and the no-op close', async () => {
  const s = setup()
  const { app, page } = await open(
    s,
    fixtures(s, {
      [`GET ${EP(12)}/draft_notes`]: { json: [] },
      [`POST ${EP(12)}/draft_notes`]: { empty: true },
      [`POST ${EP(12)}/draft_notes/bulk_publish`]: { empty: true },
      [`POST ${EP(12)}/approve`]: { fail: 'HTTP 403 Forbidden' }
    })
  )
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('open-submit').click()
  const dlg = page.getByRole('dialog', { name: 'Submit review' })
  await expect(dlg.getByLabel('Overall comment for !12')).toBeVisible()
  // request changes without a text: the red line, nothing sent
  await dlg.getByLabel('Request changes').check()
  await dlg.getByTestId('submit-review').click()
  await expect(dlg.getByText('Requesting changes needs an overall comment.')).toBeVisible()
  expect(bodies(s)).toEqual([])
  // approve with a text: the text goes out, then the approve fails, so the banner says so
  await dlg.getByLabel('Approve').check()
  await dlg.getByLabel('Overall comment for !12').fill('LGTM')
  await dlg.getByTestId('submit-review').click()
  await expect(page.getByTestId('submit-banner')).toContainText('!12: The overall comment went out, then:')
  await expect(page.getByTestId('submit-banner')).toContainText('The other changes were posted.')
  expect(bodies(s).find((b) => b.endpoint.endsWith('/draft_notes'))!.body).toEqual({ note: 'LGTM' })
  // nothing chosen and no text: the dialog just closes
  await dlg.getByLabel('Overall comment for !12').fill('')
  await dlg.getByLabel('Comment', { exact: true }).check()
  const before = bodies(s).length
  await dlg.getByTestId('submit-review').click()
  await expect(dlg).toHaveCount(0)
  expect(bodies(s)).toHaveLength(before)
  await app.close()
})

test('Submit is disabled for the viewer’s own change', async () => {
  const s = setup()
  const own = fixtures(s)
  ;(own[`GET ${EP(12)}`] as { json: { author: { username: string } } }).json.author.username = 'me'
  const { app, page } = await open(s, own)
  await expect(page.getByTestId('submit-backend/x!12')).toHaveCount(0) // the author sees Mark as draft, not Submit review
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('open-submit')).toBeDisabled()
  await app.close()
})

test('the watcher shows another person’s approval and offers a refresh for new commits (checks 6 and 7)', async () => {
  const s = setup()
  const mr = (fixtures(s)[`GET ${EP(12)}`] as { json: object }).json
  const moved = { ...mr, diff_refs: { base_sha: s.shas.base, start_sha: s.shas.base, head_sha: 'f'.repeat(40) }, user_notes_count: 1 }
  const { app, page } = await open(
    s,
    fixtures(s, {
      [`GET ${EP(12)}`]: [{ json: mr }, { json: mr }, { json: moved }],
      [`GET ${EP(12)}/approvals`]: [
        { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
        { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
        { json: { approved_by: [{ user: { username: 'bob', name: 'Bob' } }], user_can_approve: true, user_has_approved: false } }
      ]
    }),
    { CODEDIFF_WATCH_MS: '700' }
  )
  await expect(page.getByTestId(`approvals-backend/x!12`).locator('[data-user="bob"]')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId('refresh-banner')).toContainText('New commits on !12.', { timeout: 15_000 })
  await app.close()
})
