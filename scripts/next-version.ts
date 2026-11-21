/**
 * The rules for the version of a release. They follow Conventional Commits and Semantic Versioning.
 * The release workflow runs `scripts/release-version.ts`, which uses this file.
 */

export type Bump = 'major' | 'minor' | 'patch' | 'none'

export interface Commit {
  /** The first line of the message. */
  subject: string
  /** The rest of the message. */
  body: string
}

/** The commit types that this repository accepts. The type chooses the size of the version step. */
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'ci', 'build', 'style', 'revert'] as const

const SUBJECT = /^(\w+)(?:\([^)]*\))?(!)?:\s+\S/

/** The type of a commit and whether the `!` mark says that it breaks something. */
export function parseSubject(subject: string): { type: string; breaking: boolean } | undefined {
  const match = subject.match(SUBJECT)
  if (!match?.[1]) {
    return undefined
  }
  return { type: match[1], breaking: match[2] === '!' }
}

/** True if a title, for example of a pull request, has the form `type: description` with a known type. */
export function isConventionalTitle(title: string): boolean {
  const parsed = parseSubject(title.trim())
  return parsed !== undefined && (TYPES as readonly string[]).includes(parsed.type)
}

function rank(bump: Bump): number {
  return ['none', 'patch', 'minor', 'major'].indexOf(bump)
}

/**
 * The biggest change in a list of commits.
 * A `!` or a `BREAKING CHANGE:` line gives major, `feat` gives minor, and `fix` or `perf` gives patch.
 * Every other change (docs, test, chore, ci and so on) gives patch, because each merge makes a release.
 * Only an empty list gives none.
 */
export function bumpFor(commits: Commit[]): Bump {
  let result: Bump = 'none'
  for (const commit of commits) {
    const parsed = parseSubject(commit.subject)
    let bump: Bump = 'patch'
    if (parsed?.breaking || /^BREAKING[ -]CHANGE:/m.test(commit.body)) {
      bump = 'major'
    } else if (parsed?.type === 'feat') {
      bump = 'minor'
    }
    if (rank(bump) > rank(result)) {
      result = bump
    }
  }
  return result
}

/** Adds one step to a version. A major step resets minor and patch, and a minor step resets patch. */
export function bumpVersion(version: string, bump: Bump): string {
  const match = version
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Not a version: ${version}`)
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (bump === 'major') {
    return `${major + 1}.0.0`
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`
  }
  if (bump === 'patch') {
    return `${major}.${minor}.${patch + 1}`
  }
  return `${major}.${minor}.${patch}`
}

/** The highest release tag (`v1.2.3`) of a list. Tags of pre-releases and other names do not count. */
export function highestTag(tags: string[]): string | undefined {
  const versions = tags
    .map((tag) => ({ tag, match: tag.match(/^v(\d+)\.(\d+)\.(\d+)$/) }))
    .flatMap((item) =>
      item.match
        ? [
            {
              tag: item.tag,
              parts: [Number(item.match[1]), Number(item.match[2]), Number(item.match[3])] as const
            }
          ]
        : []
    )
  versions.sort((left, right) => right.parts[0] - left.parts[0] || right.parts[1] - left.parts[1] || right.parts[2] - left.parts[2])
  return versions[0]?.tag
}

/** The version of a local build: the next version with a draft mark and the number of commits since the last release. */
export function draftVersion(version: string, commits: number): string {
  return `${version.trim().replace(/^v/i, '')}-draft.${commits}`
}
