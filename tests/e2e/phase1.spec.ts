import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase 1 acceptance checks (file 05 section 10). Run `npm run build` first.
const main = join(__dirname, '../../out/main/index.js')

function launch(env: Record<string, string> = {}): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'codediff-ud-'))
  return electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: userData, ...env } as Record<string, string> })
}

test('shows the Prerequisites screen with one row per tool', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
  for (const id of ['git', 'gitlab', 'github', 'jira', 'ai', 'root']) {
    await expect(page.getByTestId(`row-${id}`)).toBeVisible()
  }
  await app.close()
})

test('a missing git shows the exact text and blocks Done (check 2)', async () => {
  const app = await launch({ PATH: '' })
  const page = await app.firstWindow()
  const row = page.getByTestId('row-git')
  await expect(row).toContainText('Missing')
  await expect(row).toContainText(`'git' not found — install it first`)
  await expect(page.getByTestId('done')).toBeDisabled()
  await app.close()
})

test('a folder with no git repos is refused as the root, one with a clone is accepted (check 4)', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'codediff-root-'))
  const app = await launch()
  const page = await app.firstWindow()
  const r = await page.evaluate((p) => window.codeDiff.app.setRoot(p), empty)
  expect(r.ok).toBe(false)
  expect((r as { error: string }).error).toContain('No git repositories with an origin remote were found')
  const ok = mkdtempSync(join(tmpdir(), 'codediff-root-'))
  mkdirSync(join(ok, 'a'))
  execFileSync('git', ['init', '-q'], { cwd: join(ok, 'a') })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/a.git'], { cwd: join(ok, 'a') })
  const good = await page.evaluate((p) => window.codeDiff.app.setRoot(p), ok)
  expect(good.ok).toBe(true)
  await app.close()
})

test('the renderer has no require and no ipcRenderer (check 6)', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    ipc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
    api: Object.keys(window.codeDiff).sort()
  }))
  expect(exposed).toEqual({
    require: 'undefined',
    process: 'undefined',
    ipc: 'undefined',
    api: [
      'access',
      'ai',
      'app',
      'chat',
      'comments',
      'commits',
      'dev',
      'events',
      'flow',
      'issues',
      'launch',
      'llm',
      'notes',
      'review',
      'reviews',
      'system',
      'theme',
      'threads',
      'watch'
    ]
  })
  await app.close()
})

test('starting the app twice leaves one window (check 5)', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'codediff-ud-'))
  const env = { ...process.env, CODEDIFF_USER_DATA: ud } as Record<string, string>
  const first = await electron.launch({ args: [main], env })
  await first.firstWindow()
  // The second copy must quit by itself because the first holds the lock.
  const electronBin = (await import('electron')).default as unknown as string
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(electronBin, [main], { env })
    child.once('exit', resolve)
  })
  expect(code).toBe(0)
  expect(first.windows().length).toBe(1)
  await first.close()
})
