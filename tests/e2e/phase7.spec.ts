import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const fakeCodex = resolve(__dirname, '../fakes/fake-codex.mjs')

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
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e7-'))
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

const calls = (s: Setup): { args: string[]; cwd: string }[] =>
  readFileSync(s.log, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args)
const arg = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]

async function toDiff(page: Page): Promise<void> {
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('file-a.txt').click()
  await expect(page.locator('table.diff tr.add')).toBeVisible()
}

async function askOnAddedLine(page: Page): Promise<void> {
  const row = page.locator('table.diff tr.add').first()
  await row.hover()
  await row.getByRole('button', { name: 'Ask the AI about this line' }).click()
  await expect(page.getByTestId('line-chat')).toBeVisible()
}

test('an issue gets a summary from the AI, and a second build does not run it again (acceptance check 2)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, ['LX-1'], jiraIssue('LX-1'))
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('issue-detail')).toContainText('What it does')
  await expect(page.getByTestId('issue-detail')).toContainText('Fake summary.')
  expect(calls(s)).toHaveLength(1)
  const c = calls(s)[0].args
  expect(arg(c, '--model')).toBe('haiku')
  expect(arg(c, '--effort')).toBe('low')
  // reload the review: the issue is unchanged, so no new run
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByTestId('tab-issues')).toBeVisible()
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('issue-detail')).toContainText('Fake summary.')
  expect(calls(s)).toHaveLength(1)
  expect(existsSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'issue-briefs.json'))).toBe(true)
  await app.close()
})

test('the line chat opens under a line, answers, resumes for a follow-up, and closes with Escape', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {})
  await toDiff(page)
  await askOnAddedLine(page)
  await expect(page.getByTestId('line-chat')).toContainText('✦ line 2')
  await expect(page.getByTestId('line-chat')).toContainText('a.txt · !12')
  await expect(page.getByTestId('chat-messages')).toContainText('No questions yet.')
  await page.getByLabel('Question').fill('Why was this changed?')
  await page.getByTestId('chat-ask').click()
  await expect(page.getByTestId('chat-answer')).toContainText('Hello from fake')
  await expect(page.getByTestId('chat-footer')).toHaveText('Sonnet · 1 s')
  const first = calls(s)[0]
  expect(first.cwd.toLowerCase()).toContain(`heads${process.platform === 'win32' ? '\\' : '/'}${s.shas.head}`)
  expect(arg(first.args, '--max-turns')).toBe('20')
  expect(first.args).toContain('--session-id')
  expect(first.args.at(-1)).toContain('## My question\n\nWhy was this changed?')
  expect(first.args.at(-1)).toContain('## The whole diff of the file')
  // a follow-up resumes the same session and sends only the question
  await page.getByLabel('Question').fill('And the next line?')
  await page.getByTestId('chat-ask').click()
  await expect(page.getByTestId('chat-answer')).toHaveCount(2)
  await expect.poll(() => calls(s).length).toBe(2)
  const second = calls(s)[1].args
  expect(arg(second, '--resume')).toBe(arg(first.args, '--session-id'))
  expect(second.at(-1)).toBe('And the next line?')
  // Escape closes the chat
  await page.getByLabel('Question').press('Escape')
  await expect(page.getByTestId('line-chat')).toHaveCount(0)
  await app.close()
})

test('Stop ends a running answer, keeps the text so far and shows Stopped (acceptance check 4)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {}, { FAKE_CLAUDE_MODE: 'long' })
  await toDiff(page)
  await askOnAddedLine(page)
  await page.getByLabel('Question').fill('Slow one')
  await page.getByTestId('chat-ask').click()
  await expect(page.getByTestId('chat-stop')).toBeVisible()
  await page.getByTestId('chat-stop').click()
  await expect(page.getByTestId('chat-answer')).toContainText('Stopped')
  await expect(page.getByTestId('chat-ask')).toBeVisible()
  await app.close()
})

test('a failed start shows its reason in the answer: the missing-tool message (acceptance check 7)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {}, { CODEDIFF_FAKE_CLAUDE: JSON.stringify(['definitely-not-a-real-program-xyz']) })
  await toDiff(page)
  await askOnAddedLine(page)
  await page.getByLabel('Question').fill('Hello?')
  await page.getByTestId('chat-ask').click()
  await expect(page.getByTestId('chat-error')).toContainText("'claude' not found — install it first")
  await app.close()
})

test('the review chat answers with action cards: valid ones apply, an invalid one shows why (acceptance checks 6 to 10)', async () => {
  const s = setup()
  const actions = JSON.stringify([
    { type: 'comment', mr: 'backend/x!12', path: 'a.txt', line: 2, body: 'Check the **null** case.' },
    { type: 'viewed', mr: 'backend/x!12', paths: ['a.txt'] },
    { type: 'comment', mr: 'backend/x!12', path: 'nope.txt', line: 1, body: 'x' }
  ])
  const { app, page } = await openReview(s, [], {}, { FAKE_CLAUDE_ACTIONS: actions })
  await page.getByTestId('review-chat-button').click()
  const chat = page.getByTestId('review-chat')
  await expect(chat).toContainText('Ask anything about this change')
  await chat.getByLabel('Question').fill('Review the tests')
  await chat.getByTestId('chat-ask').click()
  await expect(chat.getByTestId('chat-answer')).toContainText('Fine.')
  // the actions block is never shown as text
  await expect(chat.getByTestId('chat-answer')).not.toContainText('code-diff-actions')
  const cards = chat.getByTestId('action-card')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('Comment · !12 a.txt:2')
  await expect(cards.nth(1)).toContainText('Mark viewed · !12 1 file')
  await expect(cards.nth(2)).toContainText('!12 does not change nope.txt.')
  await expect(cards.nth(2).getByRole('button', { name: 'Apply' })).toHaveCount(0) // an invalid card has no buttons
  // the first turn runs in the context folder with the repo folders and 40 turns
  const c = calls(s).find((x) => x.args.includes('--add-dir'))!
  expect(arg(c.args, '--max-turns')).toBe('40')
  expect(c.cwd.replace(/\\/g, '/')).toMatch(/context\/\d{8}-\d{6}-\d{3}$/)
  expect(c.args.at(-1)).toContain('Read `index.md` first.')
  // Apply all: a draft appears (not posted), and the file is marked viewed
  await chat.getByRole('button', { name: 'Apply all 2' }).click()
  await expect(cards.nth(0)).toContainText('Applied')
  await expect(cards.nth(1)).toContainText('Applied')
  const file = join(s.root, '.code-diff', 'reviews', 'R-1', 'comments.json')
  await expect.poll(() => (existsSync(file) ? Object.values(JSON.parse(readFileSync(file, 'utf8'))).length : 0)).toBe(1)
  const draft = Object.values(JSON.parse(readFileSync(file, 'utf8')))[0] as {
    body: string
    path: string
    newLine: number
    oldLine: number | null
    claude?: unknown
  }
  expect(draft).toMatchObject({ body: 'Check the **null** case.', path: 'a.txt', newLine: 2, oldLine: null })
  expect(draft.claude).toBeUndefined() // a draft from a card is the reviewer's own once applied
  expect(forge!.bodies.filter((b) => b.method === 'POST')).toHaveLength(0) // nothing was posted
  // minimise with Escape, and the button shows the dot because the chat holds messages
  await chat.getByLabel('Question').press('Escape')
  await expect(page.getByTestId('review-chat')).toHaveCount(0)
  await expect(page.getByTestId('chat-dot')).toBeVisible()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByText('1 of 1 viewed')).toBeVisible()
  await app.close()
})

test('Prerequisites: choose Codex or a custom command, and the choice is saved', async () => {
  const s = setup()
  forge = await startFakeForge({})
  // no forge token, so the Prerequisites screen opens first
  const { CODEDIFF_TEST_CREDENTIALS: _drop, ...env } = forgeEnv(forge.url)
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...env, CODEDIFF_FAKE_CODEX: JSON.stringify(['node', fakeCodex]) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('row-ai')).toContainText('Claude Code')
  await page.getByLabel('AI tool', { exact: true }).selectOption('codex')
  await page.getByTestId('save-ai').click()
  await expect(page.getByTestId('row-ai')).toContainText('codex 0.0.0')
  await expect(page.getByTestId('row-ai')).toContainText('Ready')
  expect(JSON.parse(readFileSync(join(s.ud, 'app-state.json'), 'utf8')).llm).toEqual({ tool: 'codex' })
  // a custom tool needs a command
  await page.getByLabel('AI tool', { exact: true }).selectOption('custom')
  await page.getByTestId('save-ai').click()
  await expect(page.getByTestId('ai-error')).toHaveText('Enter the command of the tool.')
  await page.getByLabel('Tool name').fill('mytool')
  await page.getByLabel('Tool command').fill('node')
  await page.getByLabel('Tool arguments').fill('-e\nconsole.log(1)')
  await page.getByTestId('save-ai').click()
  await expect(page.getByTestId('row-ai')).toContainText('mytool')
  expect(JSON.parse(readFileSync(join(s.ud, 'app-state.json'), 'utf8')).llm).toEqual({
    tool: 'custom',
    custom: { name: 'mytool', command: 'node', args: ['-e', 'console.log(1)'] }
  })
  await app.close()
})
