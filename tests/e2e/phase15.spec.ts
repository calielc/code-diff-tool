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

const thread = (id: string, noteId: number, path: string, body: string, resolved: boolean): object => ({
  id: id.repeat(40),
  notes: [
    {
      id: noteId,
      body,
      resolvable: true,
      resolved,
      author: { username: 'ann', name: 'Ann' },
      created_at: '2026-01-03T10:00:00Z',
      position: { new_path: path, old_path: path, new_line: 2 }
    }
  ]
})

test('the Comments filter shows the files and the threads that are open, resolved, or both (acceptance check 1)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e15-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'svc')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/svc.git')
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'head')
  const head = git('rev-parse', 'HEAD')

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
        title: 'Threads',
        description: '',
        author: { username: 'ann' },
        source_branch: 'b',
        target_branch: 'main',
        diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head }
      }
    },
    [`GET projects/${P}/merge_requests/5/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET projects/${P}/merge_requests/5/discussions`]: {
      json: [thread('a', 11, 'a.txt', 'Open note on a', false), thread('b', 12, 'b.txt', 'Resolved note on b', true)]
    },
    [`GET projects/${P}/merge_requests/5/reviewers`]: { json: [] }
  })
  const rdir = join(root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(rdir, { recursive: true })
  writeFileSync(
    join(rdir, 'review.json'),
    JSON.stringify({ title: 'Threads', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/svc', iid: 5 }], skipped: [], issues: [] })
  )
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await page.getByTestId('tab-diff').click()
  const files = (): Promise<string[]> =>
    page.locator('.trow.file[data-testid^="file-"]').evaluateAll((rows) => rows.map((r) => (r.getAttribute('data-testid') as string).slice(5)))

  // no filter: every file, and the counts of threads in the buttons
  await expect(page.getByTestId('file-a.txt')).toBeVisible()
  expect(await files()).toEqual(['a.txt', 'b.txt', 'c.txt'])
  await expect(page.getByTestId('comments-open')).toContainText('1')
  await expect(page.getByTestId('comments-resolved')).toContainText('1')

  // open: only the file with an open thread, and only the open thread in it
  await page.getByTestId('comments-open').click()
  await expect.poll(files).toEqual(['a.txt'])
  await expect(page.locator('.thread', { hasText: 'Open note on a' })).toBeVisible()
  await expect(page.locator('.thread', { hasText: 'Resolved note on b' })).toHaveCount(0)

  // resolved: only the file with a resolved thread
  await page.getByTestId('comments-open').click()
  await page.getByTestId('comments-resolved').click()
  await expect.poll(files).toEqual(['b.txt'])
  await expect(page.locator('.thread', { hasText: 'Resolved note on b' })).toBeVisible()

  // both: the two files with comments, and not c.txt
  await page.getByTestId('comments-open').click()
  await expect.poll(files).toEqual(['a.txt', 'b.txt'])

  // none again: no filter
  await page.getByTestId('comments-open').click()
  await page.getByTestId('comments-resolved').click()
  await expect.poll(files).toEqual(['a.txt', 'b.txt', 'c.txt'])
  // Files and Types: with no button on, every file shows; a button on narrows, and off again shows all
  for (const id of ['status-A', 'status-M', 'status-D', 'kind-code', 'kind-docs']) await expect(page.getByTestId(id)).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('status-M').click()
  await expect.poll(files).toEqual(['a.txt', 'b.txt', 'c.txt']) // all three are modified
  await page.getByTestId('status-M').click()
  await page.getByTestId('status-D').click()
  await expect.poll(files).toEqual([]) // none is deleted
  await page.getByTestId('status-D').click()
  await expect.poll(files).toEqual(['a.txt', 'b.txt', 'c.txt'])
  await page.getByTestId('kind-code').click()
  await expect.poll(files).toEqual([]) // none is code: .txt files are docs
  await page.getByTestId('kind-code').click()
  await expect.poll(files).toEqual(['a.txt', 'b.txt', 'c.txt'])
  await app.close()
})
