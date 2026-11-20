import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

const FILES: Record<string, [string | null, string | null]> = {
  '.config/tools.json': [
    '{\n  "tools": {\n    "ef": {\n      "version": "8.0.1",\n      "rollForward": false\n    }\n  }\n}\n',
    '{\n  "tools": {\n    "ef": {\n      "version": "8.0.1",\n      "rollForward": false\n    },\n    "kiota": {\n      "version": "1.34.1",\n      "commands": [\n        "kiota"\n      ],\n      "rollForward": false\n    }\n  }\n}\n'
  ],
  'docs/api-clients.md': [
    null,
    '# API clients\n\nThis service generates an API client for C# and for TypeScript.\n\n## Why a generated client\n\nA hand-written client drifts from the contract.\n'
  ],
  'ci/build-client.sh': [null, '#!/bin/sh\nset -e\nkiota generate\n'],
  'src/Api/Program.cs': [
    'using System;\n\nnamespace Api;\n\npublic class Program\n{\n    public static void Main() => Console.WriteLine("old");\n}\n',
    'using System;\n\nnamespace Api;\n\npublic class Program\n{\n    public static void Main() => Console.WriteLine("new");\n}\n'
  ],
  'src/Api/Old.cs': ['class Old {}\n', null],
  'test/Api.Tests/ProgramTests.cs': ['class T { }\n', 'class T\n{\n    void A() { }\n}\n'],
  'README.md': ['# Service\n', '# Service\n\nGenerated clients are published from CI.\n']
}

test('the arrow keys walk the file tree: up and down move the focus and open files, left and right fold and unfold, star opens everything below (acceptance check 1)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e13-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'svc')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const put = (p: string, text: string | null): void => {
    const full = join(dir, p)
    mkdirSync(dirname(full), { recursive: true })
    if (text === null) execFileSync('git', ['rm', '-q', '-f', p], { cwd: dir })
    else writeFileSync(full, text)
  }
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/svc.git')
  for (const [p, [before]] of Object.entries(FILES)) if (before !== null) put(p, before)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  for (const [p, [, after]] of Object.entries(FILES)) put(p, after)
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
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
        title: 'Tree',
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
    JSON.stringify({ title: 'Tree', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/svc', iid: 5 }], skipped: [], issues: [] })
  )
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await page.getByTestId('review-R-1').dblclick()
  await page.getByTestId('tab-diff').click()
  const title = (): Promise<string> => page.locator('.fpath').innerText()
  const key = (k: string): Promise<void> => page.keyboard.press(k)

  await page.getByTestId('file-.config/tools.json').click()
  await expect(page.locator('.fpath')).toContainText('tools.json')
  // down: the next row is the folder ci, which only takes the focus; the next one is a file and opens
  await key('ArrowDown')
  await expect(page.locator('.trow.focused')).toContainText('ci')
  expect(await title()).toContain('tools.json')
  await key('ArrowDown')
  await expect(page.locator('.fpath')).toContainText('build-client.sh')
  // up goes back
  await key('ArrowUp')
  await expect(page.locator('.trow.focused')).toContainText('ci')
  await key('ArrowUp')
  await expect(page.locator('.fpath')).toContainText('tools.json')

  // left on a file goes to its folder, left again folds it, right unfolds it, right again goes to the first file
  await key('ArrowDown')
  await key('ArrowDown')
  await key('ArrowLeft')
  await expect(page.locator('.trow.focused')).toContainText('ci')
  await key('ArrowLeft')
  await expect(page.getByTestId('file-ci/build-client.sh')).toHaveCount(0)
  await key('ArrowRight')
  await expect(page.getByTestId('file-ci/build-client.sh')).toHaveCount(1)
  await key('ArrowRight')
  await expect(page.locator('.fpath')).toContainText('build-client.sh')

  // star opens everything below the focused node: fold docs, then fold the whole repo, then star
  for (let i = 0; i < 20; i++) await key('ArrowUp') // to the first row, the repo
  for (let i = 0; i < 6; i++) await key('ArrowDown')
  await expect(page.locator('.trow.focused')).toContainText('docs')
  await key('ArrowLeft')
  await expect(page.getByTestId('file-docs/api-clients.md')).toHaveCount(0)
  for (let i = 0; i < 20; i++) await key('ArrowUp')
  await key('ArrowLeft')
  await expect(page.getByTestId('file-src/Api/Program.cs')).toHaveCount(0)
  await key('*')
  await expect(page.getByTestId('file-docs/api-clients.md')).toHaveCount(1)
  await expect(page.getByTestId('file-src/Api/Program.cs')).toHaveCount(1)
  await expect(page.getByTestId('file-test/Api.Tests/ProgramTests.cs')).toHaveCount(1)

  // n and p move to the next and the prior file, v marks the file and moves on, shift+v unmarks and stays
  const box = (path: string): ReturnType<typeof page.locator> => page.getByTestId('file-' + path).locator('input[type=checkbox]')
  await page.getByTestId('file-.config/tools.json').click()
  await key('n')
  await expect(page.locator('.fpath')).toContainText('build-client.sh')
  await key('p')
  await expect(page.locator('.fpath')).toContainText('tools.json')
  await key('v')
  await expect(box('.config/tools.json')).toBeChecked()
  await expect(page.locator('.fpath')).toContainText('build-client.sh') // moved on by itself
  await key('p')
  await expect(page.locator('.fpath')).toContainText('tools.json')
  await key('V')
  await expect(box('.config/tools.json')).not.toBeChecked()
  await expect(page.locator('.fpath')).toContainText('tools.json') // stays
  // the keys also work right after a click on a button
  await page.getByTestId('next-file').click()
  await key('n')
  await expect(page.locator('.fpath')).not.toContainText('tools.json')

  // typing in the filter box is not taken as navigation
  await page.getByLabel('Filter files').click()
  await key('ArrowDown')
  await expect(page.getByLabel('Filter files')).toBeFocused()
  // Ctrl+Tab and Ctrl+Shift+Tab walk the tabs in order: Issues, Code changes, Diff, Acceptance criteria
  const on = async (id: string): Promise<void> => {
    await expect(page.getByTestId(id)).toHaveAttribute('aria-selected', 'true')
  }
  await page.getByTestId('tab-issues').click()
  await key('Control+Tab')
  await on('tab-mrs')
  await key('Control+Tab')
  await on('tab-diff')
  await key('Control+Tab')
  await on('tab-ac')
  await key('Control+Tab')
  await on('tab-issues') // around
  await key('Control+Shift+Tab')
  await on('tab-ac')
  await key('Control+Shift+Tab')
  await on('tab-diff')
  await app.close()
})
