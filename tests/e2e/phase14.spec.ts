import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

test('a commit of the change can be chosen to see what changed there, and marked as viewed on its own (acceptance check 1)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e14-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'svc')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/svc.git')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'make two loud')
  const first = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nTHREE\n')
  git('commit', '-qam', 'make three loud')
  const second = git('rev-parse', 'HEAD')

  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const P = encodeURIComponent('team/backend/svc')
  forge = await startFakeForge({
    'GET user': { json: { username: 'me' } },
    [`GET projects/${P}/merge_requests/5`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/svc/-/merge_requests/5',
        state: 'opened',
        title: 'Loud',
        description: '',
        author: { username: 'ann' },
        source_branch: 'b',
        target_branch: 'main',
        diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: second }
      }
    },
    [`GET projects/${P}/merge_requests/5/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET projects/${P}/merge_requests/5/discussions`]: { json: [] },
    [`GET projects/${P}/merge_requests/5/reviewers`]: { json: [] }
  })
  const rdir = join(root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(rdir, { recursive: true })
  writeFileSync(
    join(rdir, 'review.json'),
    JSON.stringify({ title: 'Loud', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/svc', iid: 5 }], skipped: [], issues: [] })
  )
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('file-a.txt')).toBeVisible()
  const key = (k: string): Promise<void> => page.keyboard.press(k)
  const c1 = first.slice(0, 7)
  const c2 = second.slice(0, 7)
  const box = (sha7: string): ReturnType<typeof page.locator> => page.getByTestId('commit-' + sha7).locator('input[type=checkbox]')
  const treeBox = page.getByTestId('file-a.txt').locator('input[type=checkbox]')

  // HEAD shows the whole change: both lines, and the two commits are listed as chips
  await expect(page.getByTestId('commit-chips')).toContainText('HEAD')
  await expect(page.getByTestId('commit-' + c1)).toBeVisible()
  await expect(page.getByTestId('commit-' + c2)).toBeVisible()
  await expect(page.locator('table.diff td.code', { hasText: /TWO/ })).toHaveCount(1)
  await expect(page.locator('table.diff td.code', { hasText: /THREE/ })).toHaveCount(1)
  await expect(page.locator('.plusbtn').first()).toBeAttached() // an open change takes comments at HEAD

  // the first commit: only its own change, with a banner, and no comment buttons
  await page
    .getByTestId('commit-' + c1)
    .getByRole('button', { name: c1 })
    .click()
  await expect(page.getByTestId('commit-banner')).toContainText('Only the change of commit ' + c1)
  await expect(page.locator('table.diff td.code', { hasText: /TWO/ })).toHaveCount(1)
  await expect(page.locator('table.diff td.code', { hasText: /THREE/ })).toHaveCount(0)
  await expect(page.locator('.plusbtn')).toHaveCount(0)
  await expect(page.locator('.statechip.commitonly')).toHaveText('commit ' + c1 + ' only')

  // the second commit changes line three only
  await page
    .getByTestId('commit-' + c2)
    .getByRole('button', { name: c2 })
    .click()
  await expect(page.locator('table.diff td.code', { hasText: /THREE/ })).toHaveCount(1)
  await expect(page.locator('table.diff td.code', { hasText: /TWO/ })).toHaveCount(1) // as context only
  await expect(page.locator('table.diff tr.add')).toHaveCount(1)

  // v marks only the chosen commit, and stays on it; shift+v takes that mark away
  await page
    .getByTestId('commit-' + c1)
    .getByRole('button', { name: c1 })
    .click()
  await key('v')
  await expect(box(c1)).toBeChecked()
  await expect(box(c2)).not.toBeChecked()
  await expect(treeBox).not.toBeChecked() // HEAD is not marked
  await expect(page.getByTestId('commit-banner')).toContainText(c1) // still on the commit
  await key('V')
  await expect(box(c1)).not.toBeChecked()

  // HEAD marked as viewed flags every commit before it
  await page.getByTestId('head-chip').click()
  await expect(page.getByTestId('commit-banner')).toHaveCount(0)
  await page.getByTestId('viewed-now').check()
  await expect(box(c1)).toBeChecked()
  await expect(box(c2)).toBeChecked()
  await page.getByTestId('viewed-now').uncheck()
  await expect(box(c1)).not.toBeChecked()
  await expect(box(c2)).not.toBeChecked()
  await app.close()
})
