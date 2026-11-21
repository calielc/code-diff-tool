// Takes the pictures of the documentation into docs/images. The data in them is made up.
// It builds nothing: run `npm run screenshots`, which builds first.
const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const out = join(__dirname, '..', 'docs', 'images')
mkdirSync(out, { recursive: true })
const result = spawnSync('npx playwright test tests/e2e/screenshots.spec.ts', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SHOTS: out }
})
process.exit(result.status ?? 1)
