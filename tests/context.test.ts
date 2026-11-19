import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PendingComment } from '../src/shared/comments'
import type { BuildResult } from '../src/shared/review'
import { startBuild } from '../src/main/services/build'
import { moment, quote, reviewStateMarkdown, writeContext } from '../src/main/services/context'
import { reviewDir } from '../src/main/services/reviews'
import { findClone, resetWorkspaceCache, scanClones } from '../src/main/services/workspace'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

let root: string
let forge: FakeForge
let shas: { a: string; b: string }

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const P = encodeURIComponent('team/backend/x')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codediff-ctx-'))
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base commit')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  git(dir, 'commit', '-qam', 'change two\n\nBecause two was wrong.')
  shas = { a, b: git(dir, 'rev-parse', 'HEAD') }
  // another clone that is not part of the review
  const other = join(root, 'tools', 'y')
  mkdirSync(other, { recursive: true })
  git(other, 'init', '-q')
  git(other, 'remote', 'add', 'origin', 'git@gitlab.com:team/tools/y.git')
  forge = await useFakeForge({
    'GET user': { json: { username: 'me' } },
    [`GET projects/${P}/merge_requests/12`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
        state: 'merged',
        merged_at: '2026-11-03T09:14:00Z',
        title: 'Fix two',
        description: 'Line one\nLine two',
        author: { username: 'ann', name: 'Ann Lee' },
        source_branch: 'fix',
        target_branch: 'main',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-02T00:00:00Z',
        diff_refs: { base_sha: shas.a, start_sha: shas.a, head_sha: shas.b }
      }
    },
    [`GET projects/${P}/merge_requests/12/approvals`]: {
      json: { approved_by: [{ user: { username: 'bob', name: 'Bob Ray' } }], user_can_approve: true, user_has_approved: false }
    },
    [`GET projects/${P}/merge_requests/12/discussions`]: {
      json: [
        {
          id: 'd'.repeat(40),
          notes: [
            {
              id: 5,
              body: 'Why two?\nPlease explain.',
              resolvable: true,
              resolved: false,
              author: { username: 'bob', name: 'Bob Ray' },
              created_at: '2026-11-03T10:00:00Z',
              position: { new_path: 'a.txt', new_line: 2 }
            }
          ]
        }
      ]
    },
    [`GET projects/${P}/merge_requests/12/reviewers`]: { json: [] }
  })
  resetWorkspaceCache()
})
afterEach(async () => stopFakeForge(forge))

const draft = (id: string, body: string, claude = false): PendingComment => ({
  id,
  mr: 'backend/x!12',
  diffRefs: { base: shas.a, start: shas.a, head: shas.b },
  path: 'a.txt',
  oldPath: 'a.txt',
  oldLine: null,
  newLine: 2,
  body,
  ...(claude ? { claude: { skill: 'review-code', lens: 'Correctness', severity: 'blocking' as const } } : {})
})

async function build(): Promise<BuildResult> {
  mkdirSync(reviewDir(root, 'R-1'), { recursive: true })
  writeFileSync(
    join(reviewDir(root, 'R-1'), 'review.json'),
    JSON.stringify({ title: 'Review', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] })
  )
  const r = await startBuild(root, 'R-1', () => undefined)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('small formatters', () => {
  it('writes moments in UTC and quotes bodies', () => {
    expect(moment('2026-11-05T12:10:16.561+0100')).toBe('2026-11-05 11:10 UTC')
    expect(moment('nonsense')).toBe('an unknown date')
    expect(quote('  a  \nb ')).toBe('  > a\n  > b')
  })
})

describe('the review context folder (file 04 section 4)', () => {
  it('writes index.md, the MR files, the threads, the history, the files before the MR and the exports', async () => {
    const result = await build()
    const clones = await scanClones(root, true)
    const clone = findClone(clones, { host: 'gitlab.com', project: 'team/backend/x' })!
    const ctx = await writeContext({
      root,
      reviewDir: reviewDir(root, 'R-1'),
      result,
      cloneOf: new Map([['backend/x!12', clone]]),
      issueFiles: new Map([['LX-1', '# LX-1: Title\n\nSummary']]),
      drafts: [draft('mine', 'my own point'), draft('cl', 'claude point', true)],
      allClones: clones,
      includeOtherRepos: true
    })
    expect(ctx.dir).toMatch(/context[\\/]\d{8}-\d{6}-\d{3}$/)
    const read = (p: string): string => readFileSync(join(ctx.dir, p), 'utf8')

    const index = read('index.md')
    expect(index).toContain('# The review context')
    expect(index).toContain(
      '- `mr1.md`: MR key `backend/x!12`, Fix two. Merged into `main` on 2026-11-03 09:14 UTC. Threads and pending comments: `mr1/threads.md`. History: `mr1/history.md`. Files before the MR: `mr1/base/`.'
    )
    expect(index).toContain('## The MR repos')
    expect(index).toMatch(/- `backend\/x`, the head of backend\/x!12: `.+heads[\\/][0-9a-f]{40}`/)
    expect(index).toContain('- `tools/y`: no folder: the clone has no origin/main.') // the other repo has no fetched commit
    expect(existsSync(join(reviewDir(root, 'R-1'), 'heads', shas.b, 'a.txt'))).toBe(true)

    const mr = read('mr1.md')
    expect(mr).toContain('# MR key `backend/x!12`: Fix two')
    expect(mr).toContain('- Branches: `fix` → `main`')
    expect(mr).toContain('> Line one\n> Line two')
    expect(mr).toContain('### `a.txt` (M, +2 −1)')
    expect(mr).toContain('-     2     - | two')
    expect(mr).toContain('+     -     2 | TWO')
    expect(read('mr1/a.txt.diff')).toContain('+     -     4 | four')

    const threads = read('mr1/threads.md')
    expect(threads).toContain('## Open thread on `a.txt`, new line 2')
    expect(threads).toContain('  > Why two?\n  > Please explain.')
    expect(threads).toContain('my own point')
    expect(threads).not.toContain('claude point') // a Claude review must not read Claude's own drafts as the reviewer's points
    expect(read('mr1/claude-drafts.md')).toContain('claude point')

    const history = read('mr1/history.md')
    expect(history).toMatch(/- `[0-9a-f]+` \d{4}-\d{2}-\d{2} T: change two\n {2}> Because two was wrong\./)
    expect(history).toContain('The last 10 commits on `main` that changed `a.txt`, before the MR:')
    expect(read('mr1/base/a.txt')).toBe('one\ntwo\nthree\n')
    expect(read('LX-1.md')).toContain('Summary')
  })

  it('names an issue Jira did not give, and keeps going when something is missing', async () => {
    const result = await build()
    result.issues = [
      {
        source: 'jira',
        key: 'LX-9',
        url: null,
        type: null,
        title: 'LX-9',
        status: null,
        assignee: null,
        description: '',
        criteria: [],
        error: 'HTTP 404 Not Found'
      }
    ]
    const clones = await scanClones(root, true)
    const clone = findClone(clones, { host: 'gitlab.com', project: 'team/backend/x' })!
    const bad = { ...clone, dir: join(root, 'does-not-exist') } // a clone that vanished: git fails for the history
    const ctx = await writeContext({
      root,
      reviewDir: reviewDir(root, 'R-1'),
      result,
      cloneOf: new Map([['backend/x!12', bad]]),
      issueFiles: new Map(),
      drafts: [],
      allClones: clones,
      includeOtherRepos: false
    })
    const index = readFileSync(join(ctx.dir, 'index.md'), 'utf8')
    expect(index).toContain('- `LX-9.md`: LX-9, which could not be read: HTTP 404 Not Found')
    expect(index).toContain('## Notes')
    expect(index).toMatch(/The history or the files before the MR of backend\/x!12 are missing/)
    expect(index).toMatch(/The export of `backend\/x` at `[0-9a-f]{12}` is missing/)
    expect(readdirSync(ctx.dir)).toContain('mr1.md') // the rest is still written
  })

  it('writes review-state.md with the viewer, approvals, threads and the pending comments', async () => {
    const result = await build()
    const md = reviewStateMarkdown(result, [draft('mine', 'my own point'), draft('cl', 'claude point', true)])
    expect(md).toContain('The viewer is `@me`.')
    expect(md).toContain('## `backend/x!12`: Fix two')
    expect(md).toContain('- Approved by: Bob Ray (@bob)')
    expect(md).toContain('- Pipeline: none')
    expect(md).toContain('### Threads (1 open of 1)')
    expect(md).toContain(`- Thread \`${'d'.repeat(40)}\` on \`a.txt\`, new line 2, open,`)
    expect(md).toContain("# The viewer's pending comments")
    expect(md).toContain('my own point')
    expect(md).not.toContain('claude point')
    expect(md).not.toContain('Merged into') // the state lives only in mrN.md
  })
})
