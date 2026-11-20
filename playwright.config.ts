import { defineConfig } from '@playwright/test'

// Test windows stay hidden. Set CODEDIFF_SHOW_WINDOW=1 to watch a test run.
if (!process.env['CODEDIFF_SHOW_WINDOW']) process.env['CODEDIFF_HIDE_WINDOW'] = '1'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: 'list'
})
