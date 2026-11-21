import { cpus } from 'node:os'
import { defineConfig } from '@playwright/test'

// Test windows stay hidden. Set CODEDIFF_SHOW_WINDOW=1 to watch a test run.
if (!process.env['CODEDIFF_SHOW_WINDOW']) process.env['CODEDIFF_HIDE_WINDOW'] = '1'

// Each test has its own temporary folders, its own app data folder and its own fake forge on a free port, so tests can run
// side by side. Each worker starts real Electron apps, so keep the number below the number of processor cores.
// Set CODEDIFF_WORKERS to choose another number, and 1 to run the tests one after another.
const workers = Number(process.env['CODEDIFF_WORKERS']) || Math.max(1, Math.min(3, Math.floor(cpus().length / 4)))

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // A page check waits longer than the default 5 seconds, because a busy machine draws the screen slowly.
  expect: { timeout: 10_000 },
  workers,
  // On a CI runner a slow start can fail a test that passes on a second try. A test that needs a retry is shown as flaky.
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'list'
})
