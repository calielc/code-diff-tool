/**
 * Chooses the version of the next release from the commits since the last release tag.
 *
 *   node scripts/release-version.ts                      reads git and writes the result to GITHUB_OUTPUT
 *   node scripts/release-version.ts --check-title "..."  exits with 1 if the title is not `type: description`
 *
 * The workflow `.github/workflows/release.yml` runs the first form on each push to `main`.
 * The workflow `.github/workflows/pr-title.yml` runs the second form on each pull request.
 * Node 22.18 or later runs this file directly. No install is needed.
 */
import { appendFileSync } from 'node:fs'
import { nextRelease } from './git-version.ts'
import { isConventionalTitle, TYPES } from './next-version.ts'

function output(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }
}

function checkTitle(title: string): void {
  if (isConventionalTitle(title)) {
    console.log(`The title is fine: ${title}`)
    return
  }
  console.error(
    `The title must have the form "type: description". The types are ${TYPES.join(', ')}.\n` +
      `A "!" before the colon, as in "feat!: ...", marks a breaking change.\nThe title is: ${title}`
  )
  process.exit(1)
}

function chooseVersion(): void {
  const next = nextRelease()
  console.log(`${next.commits} commits since ${next.previous || 'the start'}. The biggest change is: ${next.bump}.`)
  output({
    release: next.bump === 'none' ? 'false' : 'true',
    bump: next.bump,
    previous: next.previous,
    version: next.version
  })
}

const titleAt = process.argv.indexOf('--check-title')
if (titleAt >= 0) {
  checkTitle(process.argv[titleAt + 1] ?? '')
} else {
  chooseVersion()
}
