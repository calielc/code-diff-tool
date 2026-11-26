import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

// The fake GitLab, GitHub and Jira of the current test. It is closed after each test.
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

interface Setup {
  root: string
  ud: string
  fixture: string
  shas: Record<string, string>
}

/** A clone with a base commit and one branch per MR, like a developer's checkout after a fetch. */
function setup(mrFiles: Record<string, Record<string, string | null | Buffer>>, baseFiles: Record<string, string | Buffer>): Setup {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e4-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  const put = (p: string, c: string | Buffer): void => {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
  for (const [p, c] of Object.entries(baseFiles)) put(p, c)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const b = git('rev-parse', 'HEAD')
  const shas: Record<string, string> = { base: b }
  for (const [name, files] of Object.entries(mrFiles)) {
    git('checkout', '-q', '-B', name, b)
    for (const [p, c] of Object.entries(files)) {
      if (c === null) rmSync(join(dir, p))
      else put(p, c)
    }
    git('add', '-A')
    git('commit', '-q', '-m', name)
    shas[name] = git('rev-parse', 'HEAD')
  }
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, fixture: join(base, 'fixture.json'), shas }
}

function mr(iid: number, base: string, head: string, created: string): Record<string, unknown> {
  const k = `projects/${encodeURIComponent('team/backend/x')}/merge_requests/${iid}`
  return {
    [`GET ${k}`]: {
      json: {
        web_url: `https://gitlab.com/team/backend/x/-/merge_requests/${iid}`,
        state: 'opened',
        title: `Change ${iid}`,
        author: { username: 'ann' },
        source_branch: `b${iid}`,
        target_branch: 'main',
        created_at: created,
        diff_refs: { base_sha: base, start_sha: base, head_sha: head }
      }
    },
    [`GET ${k}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET ${k}/discussions`]: { json: [] },
    [`GET ${k}/reviewers`]: { json: [] }
  }
}

async function open(s: Setup, iids: number[], fixture: Record<string, unknown>): Promise<{ app: ElectronApplication; page: Page }> {
  forge = await startFakeForge({ 'GET user': { json: { username: 'me' } }, ...(fixture as Record<string, any>) })
  const dir = join(s.root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(dir + '/review.json', JSON.stringify({ title: 'Diff review', mrs: iids.map((iid) => ({ projectPath: 'team/backend/x', iid })), issues: [] }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, CODEDIFF_USER_DATA: s.ud, ...forgeEnv(forge.url) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  return { app, page }
}

const base = { 'src/a.txt': 'one\ntwo\nthree\n', 'ws.txt': 'x\n  y\nz\n', 'img.bin': Buffer.from([0, 1, 2]), 'docs/other.txt': 'keep\n' }

test('shows files with git line numbers, binary and spaced paths, and the noise levels', async () => {
  const s = setup(
    {
      mr1: {
        'src/a.txt': 'one\nTWO\nthree\nfour\n',
        'with space/new file.txt': 'hello\n',
        'img.bin': Buffer.from([0, 9, 9]),
        'ws.txt': 'x\ny\nz\n',
        'assets/logo.png': Buffer.from([137, 80, 78, 71, 0, 1]),
        'assets/icon.svg': '<svg>\n</svg>\n'
      }
    },
    base
  )
  const { app, page } = await open(s, [12], mr(12, s.shas.base, s.shas.mr1, '2026-01-01T00:00:00Z'))
  // the default noise level is "Code only", so the whitespace-only file is hidden and listed as noise
  await expect(page.getByTestId('file-src/a.txt')).toBeVisible()
  await expect(page.getByTestId('file-ws.txt')).toHaveCount(0)
  await expect(page.getByText('1 file hidden: noise only at this level')).toBeVisible()
  // changed text file: git's numbers, a hunk header, and the +/- counts
  await page.getByTestId('file-src/a.txt').click()
  const rows = page.locator('table.diff tbody tr')
  await expect(rows.nth(0)).toHaveText('@@ old 1 · new 1 @@')
  await expect(page.locator('table.diff tr.del')).toContainText('two')
  await expect(page.locator('table.diff tr.del td.ln').first()).toHaveText(/2$/) // the cell also holds the + comment button
  await expect(page.locator('table.diff tr.add td.ln').nth(1)).toHaveText('2')
  await expect(page.locator('table.diff tr.add td.ln').nth(3)).toHaveText('4')
  // a path with a space opens and is a new file
  await page.getByTestId('file-with space/new file.txt').click()
  await expect(page.getByTestId('file-scope')).toContainText('New')
  await expect(page.locator('table.diff tr.add td.code')).toHaveText('hello')
  // binary: no lines
  await page.getByTestId('file-img.bin').click()
  await expect(page.getByText('Binary file, no text diff.')).toBeVisible()
  // an image that git flags as binary shows the same note, and an SVG is text, so it shows its lines
  await page.getByTestId('file-assets/logo.png').click()
  await expect(page.getByText('Binary file, no text diff.')).toBeVisible()
  await page.getByTestId('file-assets/icon.svg').click()
  await expect(page.locator('table.diff tr.add td.code').first()).toHaveText('<svg>')
  // the Types filter shows only the types that have files: Code, Tests and Config have none here
  await expect(page.getByTestId('kind-images')).toContainText('2')
  await expect(page.getByTestId('kind-binary')).toContainText('1')
  await expect(page.getByTestId('kind-docs')).toContainText('2')
  for (const none of ['code', 'tests', 'config']) await expect(page.getByTestId('kind-' + none)).toHaveCount(0)
  await page.getByTestId('kind-images').click()
  await expect(page.getByTestId('file-assets/logo.png')).toBeVisible()
  await expect(page.getByTestId('file-assets/icon.svg')).toBeVisible()
  await expect(page.getByTestId('file-img.bin')).toHaveCount(0)
  await expect(page.getByTestId('file-src/a.txt')).toHaveCount(0)
  await page.getByTestId('kind-images').click()
  await page.getByTestId('kind-binary').click()
  await expect(page.getByTestId('file-img.bin')).toBeVisible()
  await expect(page.getByTestId('file-assets/logo.png')).toHaveCount(0)
  await page.getByTestId('kind-binary').click()
  await expect(page.getByTestId('file-src/a.txt')).toBeVisible()
  await page.getByTestId('file-img.bin').click()
  // "Everything" shows the whitespace-only file
  await page.getByRole('button', { name: 'Everything' }).click()
  await expect(page.getByTestId('file-ws.txt')).toBeVisible()
  await page.getByTestId('file-ws.txt').click()
  await expect(page.locator('table.diff tr.del td.code')).toHaveText('y')
  // viewed marks and the progress text
  await page.getByTestId('file-ws.txt').getByRole('checkbox').check()
  await expect(page.getByText(/1 of \d+ viewed/)).toBeVisible()
  await app.close()
})

test('combines changes to different files, and splits parts when two changes conflict', async () => {
  const s = setup(
    {
      mr1: { 'src/a.txt': 'one\nTWO\nthree\n' },
      mr2: { 'docs/other.txt': 'keep\nmore\n' },
      mr3: { 'src/a.txt': 'one\nzwei\nthree\n' } // edits the same line as mr1
    },
    base
  )
  const fx = {
    ...mr(12, s.shas.base, s.shas.mr1, '2026-01-01T00:00:00Z'),
    ...mr(13, s.shas.base, s.shas.mr2, '2026-01-02T00:00:00Z'),
    ...mr(14, s.shas.base, s.shas.mr3, '2026-01-03T00:00:00Z')
  }
  const { app, page } = await open(s, [12, 13, 14], fx)
  const combined = page.getByRole('button', { name: /^Stacked/ })
  await expect(combined).toBeEnabled()
  await expect(combined).toContainText('2 parts')
  await expect(combined).toHaveAttribute('title', /team\/backend\/x|backend\/x: a part starts at !14, which conflicts with the part before it \(!12, !13\)/)
  await combined.click()
  await page.getByTestId('file-docs/other.txt').click()
  await expect(page.getByTestId('file-scope')).toContainText('stacked · backend/x · !12, !13')
  // the second part is the conflicting change on its own
  await expect(page.getByText('Part 2 · !14')).toBeVisible()
  await expect(page.getByText('Part 1 · !12, !13')).toBeVisible()
  // by MR again: the same path stays open when it exists
  await page.getByRole('button', { name: 'Linear', exact: true }).click()
  await expect(page.getByTestId('file-scope')).toContainText('!13 · backend/x')
  await app.close()
})

test('Stacked is disabled with one change in the repo', async () => {
  const s = setup({ mr1: { 'src/a.txt': 'one\nTWO\nthree\n' } }, base)
  const { app, page } = await open(s, [12], mr(12, s.shas.base, s.shas.mr1, '2026-01-01T00:00:00Z'))
  const combined = page.getByRole('button', { name: /^Stacked/ })
  await expect(combined).toBeDisabled()
  await expect(combined).toHaveAttribute('title', 'Stacked needs 2+ change requests in the same repository')
  await app.close()
})
