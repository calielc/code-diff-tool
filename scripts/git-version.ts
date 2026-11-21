/**
 * Reads git and chooses the next version. The release workflow and the local build (`npm run dist`) both use it.
 * Node 22.18 or later runs this file directly.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { type Bump, bumpFor, bumpVersion, type Commit, highestTag } from './next-version.ts'

export interface NextRelease {
  /** The last release tag, for example `v2.0.0`. Empty if there is none. */
  previous: string
  /** The version of the last release, without the `v`. Without a tag, it is the version in package.json. */
  base: string
  bump: Bump
  /** The next version. Empty when there is no commit since the last release. */
  version: string
  /** The number of commits since the last release. */
  commits: number
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

export function nextRelease(): NextRelease {
  const tag = highestTag(git('tag', '--list', 'v*').split('\n'))
  const base = tag ? tag.replace(/^v/, '') : (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  const range = tag ? `${tag}..HEAD` : 'HEAD'
  const commits: Commit[] = git('log', '--no-merges', '--format=%B%x1e', range)
    .split('\x1e')
    .map((message) => message.trim())
    .filter(Boolean)
    .map((message) => {
      const [subject = '', ...rest] = message.split('\n')
      return { subject, body: rest.join('\n') }
    })
  const bump = bumpFor(commits)
  return {
    previous: tag ?? '',
    base,
    bump,
    version: bump === 'none' ? '' : bumpVersion(base, bump),
    commits: commits.length
  }
}
