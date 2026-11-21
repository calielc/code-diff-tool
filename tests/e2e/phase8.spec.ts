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

const GOOD = {
  summary: 'A user sees the change.',
  lanes: ['backend/x'],
  steps: [
    {
      id: 's1',
      mr: 'backend/x!12',
      path: 'a.txt',
      lines: [[2, 2]],
      title: 'The change',
      kind: 'changed',
      text: 'It changes line two.',
      next: [{ to: 's2', label: 'calls' }]
    },
    { id: 's2', repo: 'backend/x', title: 'The base', kind: 'existing', text: 'Unchanged code.' }
  ],
  review: [{ mr: 'backend/x!12', path: 'a.txt', line: 2, why: 'Check the new value.' }],
  skip: [{ why: 'Documentation', items: [] }]
}
const FLOW_ENV = { CODEDIFF_TEST_FLOW: '1', FAKE_CLAUDE_ANSWER: JSON.stringify(GOOD) }

test('the flow arrives without a reload and shows the chain, the reading order and the skip groups (acceptance check 1)', async () => {
  const s = setup()
  const { app, page } = await openReview(s, [], {}, FLOW_ENV)
  await page.getByTestId('tab-diff').click()
  const button = page.getByTestId('view-flow')
  await expect(button).toBeEnabled({ timeout: 20_000 }) // pending first, then ready
  await button.click()
  await expect(page.getByTestId('flow-summary')).toHaveText('A user sees the change.')
  await expect(page.getByTestId('lane-backend/x')).toBeVisible()
  await expect(page.getByTestId('step-s1')).toContainText('The change')
  await expect(page.getByTestId('step-s1')).toContainText('CHANGED')
  await expect(page.getByTestId('step-s2')).toContainText('EXISTING')
  // the second step sits one row below its caller
  const y1 = (await page.getByTestId('step-s1').boundingBox())!.y
  const y2 = (await page.getByTestId('step-s2').boundingBox())!.y
  expect(y2).toBeGreaterThan(y1)
  await expect(page.getByTestId('flow-review')).toContainText('!12 a.txt:2')
  await expect(page.getByTestId('flow-review')).toContainText('Check the new value.')
  await expect(page.getByTestId('flow-skip')).toContainText('Documentation')
  // a box opens its file at the first line, in the Linear view
  await page
    .getByTestId('step-s1')
    .getByRole('button', { name: /a\.txt:2/ })
    .click()
  await expect(page.getByTestId('file-scope')).toContainText('!12 · backend/x')
  await expect(page.locator('table.diff tr.add')).toBeVisible()
  expect(JSON.parse(readFileSync(join(s.root, '.code-diff', 'reviews', 'R-1', 'flow.json'), 'utf8')).summary).toBe('A user sees the change.')
  await app.close()
})

test('a flow that no longer matches is hidden, shown as out of date, and replaced (acceptance check 2)', async () => {
  const s = setup()
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  const stale = { ...GOOD, summary: 'The OLD flow.', steps: [{ ...GOOD.steps[0], lines: [[99, 99]] }, GOOD.steps[1]] }
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(stale))
  writeFileSync(join(dir, 'flow-issues.json'), JSON.stringify([]))
  const { app, page } = await openReview(s, [], {}, { ...FLOW_ENV, FAKE_CLAUDE_SLEEP_MS: '2500' })
  await expect(page.getByTestId('flow-banner')).toContainText(
    'Critical thinking is out of date: the MRs changed since it was written (1 problem(s)). The AI is writing it again.'
  )
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('view-flow')).toBeDisabled() // the old flow is never shown while the run goes
  await expect(page.getByText('The OLD flow.')).toHaveCount(0)
  await expect(page.getByTestId('view-flow')).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByTestId('flow-banner')).toHaveCount(0)
  await page.getByTestId('view-flow').click()
  await expect(page.getByTestId('flow-summary')).toHaveText('A user sees the change.')
  await app.close()
})
