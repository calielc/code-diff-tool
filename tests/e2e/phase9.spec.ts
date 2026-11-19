import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  log: string
  shas: { base: string; head: string }
}

function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e9-'))
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
  git('commit', '-qam', 'head')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const log = join(base, 'claude.log')
  writeFileSync(log, '')
  return { root, ud, log, shas: { base: b, head: git('rev-parse', 'HEAD') } }
}

const P = encodeURIComponent('team/backend/x')
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
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url), FAKE_CLAUDE_LOG: s.log, ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  return { app, page }
}

const jiraIssue = (key: string): Fixture => ({
  [`GET rest/api/3/issue/${key}`]: {
    json: {
      key,
      fields: {
        summary: 'Show the card',
        issuetype: { name: 'Story' },
        status: { name: 'To Do' },
        assignee: null,
        updated: '2026-11-10T10:00:00.000+0100',
        description: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card shows' }] }] }] }
          ]
        },
        attachment: []
      }
    }
  },
  [`GET rest/api/3/issue/${key}/comment`]: { json: { total: 0, comments: [] } }
})

const calls = (s: Setup): { args: string[] }[] =>
  readFileSync(s.log, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args)
const arg = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]
const record = (s: Setup, file: string): Record<string, unknown> => JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', file), 'utf8'))

const FINDINGS = {
  findings: [
    { mr: 'backend/x!12', path: 'a.txt', newLine: 2, lens: 'Correctness', severity: 'blocking', body: 'Check the value.' },
    { mr: 'backend/x!12', lens: 'Tests', severity: 'suggestion', body: 'Add a test.' }
  ],
  checklist: []
}

async function startReview(page: Page): Promise<void> {
  await page.getByTestId('ai-pill').click()
  await expect(page.getByTestId('ai-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('ai-start').click()
}

test('the AI review runs, saves its record and turns findings into drafts (acceptance check 1)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {}, { FAKE_CLAUDE_ANSWER: JSON.stringify(FINDINGS) })
  await startReview(page)
  await expect(page.getByTestId('ai-title')).toHaveText('AI review done', { timeout: 20_000 })
  await expect(page.getByTestId('ai-box')).toContainText('1 blocking')
  await expect(page.getByTestId('ai-box')).toContainText('1 suggestion(s)')
  await expect(page.getByText(/2 AI draft\(s\) arrived, not posted yet/)).toBeVisible()
  await expect(page.getByTestId('tab-diff')).toContainText('(2)')
  const rec = record(s, 'review-run.json') as { state: string; skill: string; model: string; drafts: string[]; commits: Record<string, string> }
  expect(rec).toMatchObject({ state: 'done', skill: 'general-review', model: 'opus' })
  expect(rec.drafts).toHaveLength(2)
  expect(rec.commits['backend/x!12']).toBe(s.shas.head)
  const saved = record(s, 'comments.json') as Record<string, { body: string; newLine: number | null; claude: { skill: string } }>
  expect(
    Object.values(saved)
      .map((d) => d.body)
      .sort()
  ).toEqual(['🤖 Correctness, blocking: Check the value.', '🤖 Tests, suggestion: Add a test.'])
  const call = calls(s)
    .filter((c) => c.args.includes('--max-turns') && arg(c.args, '--max-turns') === '150')
    .at(-1)!
  expect(arg(call.args, '--model')).toBe('opus')
  expect(call.args.join(' ')).toContain('Read,Grep,Glob,Agent')
  // the first blocking draft opens in the Diff tab
  await page.getByTestId('ai-first').click()
  await expect(page.locator('table.diff tr.add')).toBeVisible()
  await app.close()
})

test('Stop kills the run and the box says so (acceptance check 2)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {}, { FAKE_CLAUDE_MODE: 'long' })
  await startReview(page)
  await expect(page.getByTestId('ai-title')).toContainText('AI review runs')
  await page.getByTestId('ai-stop').click()
  await expect(page.getByTestId('ai-title')).toContainText('You stopped the AI review at')
  await expect(page.getByTestId('ai-detail')).toHaveText('Nothing arrived. Start it again when you want.')
  expect(record(s, 'review-run.json').state).toBe('stopped')
  await expect(page.getByTestId('ai-start')).toHaveText('Start again')
  await app.close()
})

test('an answer that stays wrong three times fails with the problems (acceptance check 3)', async () => {
  const s = setup()
  const { app, page } = await openReview(
    s,
    [],
    {},
    { FAKE_CLAUDE_ANSWER: JSON.stringify({ findings: [{ mr: 'x!9', lens: 'A', severity: 'blocking', body: 'b' }] }) }
  )
  await startReview(page)
  await expect(page.getByTestId('ai-title')).toHaveText('The AI review failed', { timeout: 30_000 })
  await expect(page.getByTestId('ai-detail')).toContainText('The answer still had 1 problem(s) after 3 answers:')
  await expect(page.getByTestId('ai-detail')).toContainText('finding 1: `x!9` is not the key of an MR in `index.md`')
  expect(calls(s).filter((c) => c.args.includes('--max-turns') && arg(c.args, '--max-turns') === '150')).toHaveLength(3)
  await app.close()
})

test('the AC validation shows each criterion and adds a suggested comment as a draft (acceptance check 4)', async () => {
  const s = setup()
  const answer = {
    checklist: [
      {
        ac: 'LX-1 AC1',
        state: 'missing',
        why: 'Nothing shows the card.',
        evidence: [{ mr: 'backend/x!12', path: 'a.txt', newLine: 2 }],
        comment: { mr: 'backend/x!12', path: 'a.txt', newLine: 2, body: 'Show the card here.' }
      }
    ]
  }
  const { app, page } = await openReview(s, ['LX-1'], jiraIssue('LX-1'), { FAKE_CLAUDE_ANSWER: JSON.stringify(answer) })
  await page.getByTestId('tab-ac').click()
  const row = page.getByTestId('ac-LX-1-AC1')
  await expect(row).toContainText('not validated yet')
  await expect(page.getByTestId('ac-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('ac-start').click()
  await expect(page.getByTestId('ac-title')).toHaveText('ACs validated', { timeout: 20_000 })
  await expect(row).toContainText('not met')
  await expect(row).toContainText('Nothing shows the card.')
  await expect(page.getByTestId('ac-box')).toContainText('1 not met')
  await page.getByTestId('ac-add-draft').click()
  await expect(page.getByTestId('ac-suggestion-LX-1-AC1')).toContainText('Draft added')
  await expect(page.getByTestId('tab-diff')).toContainText('(1)')
  const saved = record(s, 'comments.json') as Record<string, { body: string; claude: { ac: string } }>
  expect(Object.values(saved)[0]).toMatchObject({ body: '🤖 Spec, blocking: Show the card here.', claude: { ac: 'LX-1 AC1' } })
  expect((record(s, 'ac-run.json') as { drafts: unknown }).drafts).toBeNull()
  const call = calls(s)
    .filter((c) => c.args.includes('--max-turns') && arg(c.args, '--max-turns') === '150')
    .at(-1)!
  expect(arg(call.args, '--effort')).toBe('medium')
  await app.close()
})

test('with no criteria the AC tab says there is nothing to validate (acceptance check 5)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {})
  await page.getByTestId('tab-ac').click()
  await expect(page.getByTestId('ac-title')).toHaveText('No acceptance criteria', { timeout: 20_000 })
  await expect(page.getByTestId('ac-detail')).toContainText('nothing to validate')
  await app.close()
})

test('a record that says running is stopped by the restart at app start (acceptance check 6)', async () => {
  const s = setup()
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'review-run.json'),
    JSON.stringify({
      skill: 'general-review',
      plugin: 'builtin',
      model: 'opus',
      effort: null,
      startedAt: '2026-11-19T10:00:00.000+01:00',
      commits: {},
      state: 'running',
      lastStepAt: '2026-11-19T10:01:00.000+01:00',
      endedAt: null,
      stoppedByRestart: null,
      error: null,
      withoutIssues: null,
      drafts: null,
      checklist: null,
      report: null
    })
  )
  const { app, page } = await openReview(s, [], {})
  await page.getByTestId('ai-pill').click()
  await expect(page.getByTestId('ai-title')).toContainText('The AI review stopped with the app at')
  expect(record(s, 'review-run.json')).toMatchObject({ state: 'stopped', stoppedByRestart: true, endedAt: '2026-11-19T10:01:00.000+01:00' })
  await app.close()
})
