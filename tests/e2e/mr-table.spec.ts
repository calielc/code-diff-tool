import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const P = encodeURIComponent('team/backend/x')
const EP = (iid: number): string => `projects/${P}/merge_requests/${iid}`
const key = (iid: number): string => `backend/x!${iid}`

let forge: FakeForge | undefined
let avatars: Server | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
  avatars?.closeAllConnections()
  await new Promise<void>((r) => (avatars ? avatars.close(() => r()) : r()))
  avatars = undefined
})

/** Pictures for ann and carol. Every other user gets a 404. */
async function startAvatarServer(): Promise<string> {
  avatars = createServer((req, res) => {
    if (req.url === '/ann.png' || req.url === '/carol.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(PNG)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('none')
    }
  })
  await new Promise<void>((r) => avatars!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(avatars.address() as AddressInfo).port}`
}

function setupRepo(): { root: string; ud: string; base: string; head: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-mrtable-'))
  const root = join(tmp, 'ws')
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
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-B', 'mr1', base)
  writeFileSync(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'mr1')
  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, base, head: git('rev-parse', 'HEAD') }
}

const user = (username: string, name: string, pic: string, avatar: string): object => ({ username, name, avatar_url: `${pic}/${avatar}.png` })

test('the MR table shows avatars and the branch status badge', async () => {
  const pic = await startAvatarServer()
  const s = setupRepo()
  const ann = user('ann', 'Ann Lee', pic, 'ann')
  const bob = user('bob', 'Bob Moss', pic, 'bob')
  const carol = user('carol', 'Carol Diaz', pic, 'carol')
  const dave = user('dave', 'Dave Kim', pic, 'dave')
  const mr = (iid: number, author: object, state: string, extra: object): object => ({
    web_url: `https://gitlab.com/team/backend/x/-/merge_requests/${iid}`,
    state,
    title: `Change ${iid}`,
    author,
    source_branch: 'mr1',
    target_branch: 'main',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    user_notes_count: 0,
    diff_refs: { base_sha: s.base, start_sha: s.base, head_sha: s.head },
    ...extra
  })
  const approvals = (by: object[]): object => ({ json: { approved_by: by.map((u) => ({ user: u })), user_can_approve: true, user_has_approved: false } })
  const fixture: Record<string, object> = { 'GET user': { json: { username: 'me' } } }
  const mrs: [number, object, string, object, object[]][] = [
    [11, ann, 'opened', { diverged_commits_count: 0 }, [carol, dave]],
    [12, bob, 'opened', { diverged_commits_count: 3 }, []],
    [13, ann, 'opened', {}, []],
    [14, bob, 'merged', { diverged_commits_count: 5, merged_at: '2026-01-03T00:00:00Z' }, []]
  ]
  for (const [iid, author, state, extra, by] of mrs) {
    fixture[`GET ${EP(iid)}`] = { json: mr(iid, author, state, extra) }
    fixture[`GET ${EP(iid)}/approvals`] = approvals(by)
    fixture[`GET ${EP(iid)}/discussions`] = { json: [] }
    fixture[`GET ${EP(iid)}/reviewers`] = { json: [] }
  }
  forge = await startFakeForge(fixture as Record<string, any>)
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: mrs.map(([iid]) => ({ projectPath: 'team/backend/x', iid })), issues: [] }))
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page: Page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  const wait = { timeout: 15_000 }

  // The branch status is a badge in the Title cell. There is no Branch column.
  const headers = (await page.locator('[data-testid="mrs-tab"] table thead th').allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())
  expect(headers).not.toContain('Branch')
  await expect(page.getByTestId('sort-branch')).toHaveCount(0)
  const branch = (iid: number) => page.getByTestId(`branch-${key(iid)}`)
  const titleCell = (iid: number) =>
    page
      .getByTestId(`mr-${key(iid)}`)
      .locator('td')
      .nth(headers.indexOf('Title'))
  await expect(branch(11)).toHaveText('Up to date', wait)
  await expect(branch(11)).toHaveAttribute('data-kind', 'level')
  await expect(branch(11)).toHaveAttribute('title', 'Level with main')
  await expect(titleCell(11).getByTestId(`branch-${key(11)}`)).toHaveCount(1)
  await expect(branch(12)).toHaveText('3 behind')
  await expect(branch(12)).toHaveAttribute('data-kind', 'behind')
  await expect(branch(12)).toHaveAttribute('title', '3 commits behind main. Rebase or merge to catch up.')
  await expect(branch(13)).toHaveCount(0)
  await expect(branch(14)).toHaveCount(0)

  // The Author cell holds an avatar only: a picture for ann, initials for bob, the full name in the tooltip.
  const authorCol = headers.indexOf('Author')
  expect(authorCol).toBeGreaterThan(-1)
  expect(headers.indexOf('Approved by')).toBeGreaterThan(-1)
  const authorCell = (iid: number) =>
    page
      .getByTestId(`mr-${key(iid)}`)
      .locator('td')
      .nth(authorCol)
  await expect(authorCell(11).locator('img')).toHaveCount(1, wait)
  await expect(authorCell(11).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(authorCell(11).locator('[title="Ann Lee (@ann)"]')).toHaveCount(1)
  await expect(authorCell(12).locator('img')).toHaveCount(0)
  await expect(authorCell(12)).toHaveText('BM')
  await expect(authorCell(12).locator('[title="Bob Moss (@bob)"]')).toHaveCount(1)

  // Approved by: one avatar per approver, or a dash.
  const approvedCol = headers.indexOf('Approved by')
  const approved = (iid: number) =>
    page
      .getByTestId(`mr-${key(iid)}`)
      .locator('td')
      .nth(approvedCol)
  await expect(page.getByTestId(`approvals-${key(11)}`)).toHaveCount(1)
  await expect(approved(11).locator('[data-user]')).toHaveCount(2)
  await expect(approved(11).locator('[data-user="carol"] img')).toHaveCount(1, wait)
  await expect(approved(11).locator('[data-user="carol"]')).toHaveAttribute('title', 'Carol Diaz (@carol)')
  await expect(approved(11).locator('[data-user="dave"] img')).toHaveCount(0)
  await expect(approved(11).locator('[data-user="dave"]')).toHaveText('DK')
  await expect(approved(12)).toHaveText('–')

  await app.close()
})
