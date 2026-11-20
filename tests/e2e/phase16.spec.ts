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

test('Mark as ready and Mark as draft have their own icons (acceptance check 1)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e16-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'svc')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/svc.git')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
  git('commit', '-qam', 'head')
  const head = git('rev-parse', 'HEAD')

  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const P = encodeURIComponent('team/backend/svc')
  const fixture: Record<string, unknown> = { 'GET user': { json: { username: 'me' } } }
  // 5 is a draft and 6 is ready, both written by the viewer, so each offers the other state
  for (const [iid, draft] of [
    [5, true],
    [6, false]
  ] as const) {
    fixture[`GET projects/${P}/merge_requests/${iid}`] = {
      json: {
        web_url: `https://gitlab.com/team/backend/svc/-/merge_requests/${iid}`,
        state: 'opened',
        title: draft ? 'Draft: Wip' : 'Ready',
        draft,
        description: '',
        author: { username: 'me' },
        source_branch: `b${iid}`,
        target_branch: 'main',
        diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head }
      }
    }
    fixture[`GET projects/${P}/merge_requests/${iid}/approvals`] = { json: { approved_by: [], user_can_approve: true, user_has_approved: false } }
    fixture[`GET projects/${P}/merge_requests/${iid}/discussions`] = { json: [] }
    fixture[`GET projects/${P}/merge_requests/${iid}/reviewers`] = { json: [] }
  }
  forge = await startFakeForge(fixture as never)
  const rdir = join(root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(rdir, { recursive: true })
  writeFileSync(
    join(rdir, 'review.json'),
    JSON.stringify({
      title: 'Icons',
      mrs: [5, 6].map((iid) => ({ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/svc', iid })),
      skipped: [],
      issues: []
    })
  )
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mr-backend/svc!5')).toBeVisible()

  const ready = page.getByTestId('mr-backend/svc!5')
  const toDraft = page.getByTestId('mr-backend/svc!6')
  await expect(ready.getByRole('button', { name: 'Mark as ready' })).toBeVisible()
  await expect(ready.getByTestId('icon-mark-ready')).toHaveCount(1)
  await expect(ready.getByTestId('icon-mark-draft')).toHaveCount(0)
  await expect(toDraft.getByRole('button', { name: 'Mark as draft' })).toBeVisible()
  await expect(toDraft.getByTestId('icon-mark-draft')).toHaveCount(1)
  await expect(toDraft.getByTestId('icon-mark-ready')).toHaveCount(0)
  await app.close()
})

test('a modified line marks only the characters that changed, inline and side by side (acceptance check 2)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e16-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'svc')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/svc.git')
  writeFileSync(join(dir, 'calc.ts'), 'export const total = items.length;\nif (count == 0) return;\nconst a = 1;\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'calc.ts'), 'export const total = items.length + 1;\nif (count != 0) return;\nconst a = 1;\n')
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
        title: 'Marks',
        draft: false,
        description: '',
        author: { username: 'ann' },
        source_branch: 'b',
        target_branch: 'main',
        diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head }
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
    JSON.stringify({ title: 'Marks', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/svc', iid: 5 }], skipped: [], issues: [] })
  )
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await page.getByTestId('tab-diff').click()
  await expect(page.locator('table.diff')).toBeVisible()
  const marks = (sel: string): Promise<string[]> => page.locator(`${sel} .chg`).allTextContents()

  // inline: the removed lines mark the old characters and the added lines the new ones
  expect(await marks('table.diff tr.del td.code')).toEqual(['=']) // the first pair adds only text, so it marks nothing on the old side
  expect(await marks('table.diff tr.add td.code')).toEqual([' + 1', '!'])
  // a line that did not change has no marks
  expect(await marks('table.diff tr.ctx td.code')).toEqual([])

  // side by side: the same marks
  await page.getByTestId('layout-side').click()
  expect(await marks('table.diff.side td.code.del')).toEqual(['='])
  expect(await marks('table.diff.side td.code.add')).toEqual([' + 1', '!'])
  await app.close()
})
