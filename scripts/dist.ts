/**
 * Builds the installer on this machine, with the next version and a draft mark, for example `0.3.0-draft.3`.
 * The mark says that the file is a local build and not a release.
 * `package.json` does not change. The workflow of the release does not use this file. It uses `npm run dist:release`.
 *
 *   npm run dist                  the installer for this system
 *   npm run dist -- --win --dir   other arguments go to electron-builder
 *
 * Node 22.18 or later runs this file directly.
 */
import { spawnSync } from 'node:child_process'
import { nextRelease } from './git-version.ts'
import { draftVersion } from './next-version.ts'

function run(command: string): void {
  console.log(`> ${command}`)
  // One string, because Windows starts `npx` through a shell.
  const result = spawnSync(command, { stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const next = nextRelease()
const version = draftVersion(next.version || next.base, next.commits)
console.log(`Draft version ${version} (${next.commits} commits since ${next.previous || 'the start'}, next release ${next.version || 'none yet'}).`)
console.log(`To test the packaged app with this build, set CODEDIFF_EXPECT_VERSION=${version}.`)

run('npx electron-vite build')
const args = process.argv.slice(2).join(' ')
run(`npx electron-builder -c.extraMetadata.version=${version} ${args}`.trim())
