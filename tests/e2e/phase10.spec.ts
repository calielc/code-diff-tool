import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The packaged app (`npm run pack:dir`) starts, shows the app and holds its icon. Skipped when it has not been packaged.
const exe = join(__dirname, '../../release/win-unpacked/Code Diff Tool.exe')

test('the packaged app starts and carries its icon (acceptance check 1)', async () => {
  test.skip(!existsSync(exe), 'run npm run pack:dir first')
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e10-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const app = await electron.launch({ executablePath: exe, env: { ...process.env, CODEDIFF_USER_DATA: ud } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
  expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true)
  expect(existsSync(join(__dirname, '../../release/win-unpacked/resources/icon.png'))).toBe(true)
  expect(await page.title()).toBe('Code Diff Tool')
  await app.close()
})
