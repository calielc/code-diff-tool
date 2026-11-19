import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setLlmConfig } from '../src/main/processes/llm'
import { startBuild } from '../src/main/services/build'
import { flowStateOf, resetFlowMemory, startFlow } from '../src/main/services/flow'
import { reviewDir } from '../src/main/services/reviews'
import { sessionOf } from '../src/main/services/session'
import { resetWorkspaceCache } from '../src/main/services/workspace'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const fakeClaude = resolve(__dirname, 'fakes/fake-claude.mjs')
const P = encodeURIComponent('team/backend/x')
let root: string
let forge: FakeForge
let log: string
let dir: string

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const calls = (): { args: string[]; cwd: string }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args)
const arg = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]

/** A flow that passes the checker for the one changed file: line 2 holds the change. */
const GOOD = JSON.stringify({
  summary: 'A user sees the change.',
  lanes: ['backend/x'],
  steps: [{ id: 's1', mr: 'backend/x!12', path: 'a.txt', lines: [[2, 2]], title: 'The change', kind: 'changed', text: 'It changes line two.' }],
  review: [{ mr: 'backend/x!12', path: 'a.txt', line: 2, why: 'Check the new value.' }],
  skip: []
})

const waitDone = async (): Promise<void> => {
  await expect.poll(() => flowStateOf('R-1').pending, { timeout: 20_000 }).toBe(false)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codediff-flow-'))
  const repo = join(root, 'backend', 'x')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'T')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const a = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  git(repo, 'commit', '-qam', 'change')
  const b = git(repo, 'rev-parse', 'HEAD')
  forge = await useFakeForge({
    'GET user': { json: { username: 'me' } },
    [`GET projects/${P}/merge_requests/12`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
        state: 'opened',
        title: 'Fix',
        author: { username: 'ann' },
        source_branch: 'f',
        target_branch: 'main',
        diff_refs: { base_sha: a, start_sha: a, head_sha: b }
      }
    },
    [`GET projects/${P}/merge_requests/12/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET projects/${P}/merge_requests/12/discussions`]: { json: [] },
    [`GET projects/${P}/merge_requests/12/reviewers`]: { json: [] }
  })
  log = join(root, 'claude.log')
  writeFileSync(log, '')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['node', fakeClaude])
  process.env.FAKE_CLAUDE_ANSWER = GOOD
  setLlmConfig({ tool: 'claude' })
  resetWorkspaceCache()
  resetFlowMemory()
  dir = reviewDir(root, 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({ title: 'Review', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] })
  )
  const r = await startBuild(root, 'R-1', () => undefined)
  if (!r.ok) throw new Error(r.error)
})
afterEach(async () => {
  for (const k of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_ANSWER', 'FAKE_CLAUDE_BAD_FIRST', 'FAKE_CLAUDE_SLEEP_MS']) delete process.env[k]
  await stopFakeForge(forge)
})

describe('a flow run (file 04 section 5.2)', () => {
  it('writes flow.json and the issue list, with opus at medium effort and 80 turns in the context folder', async () => {
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(flowStateOf('R-1').flow?.summary).toBe('A user sees the change.')
    expect(JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8')).steps[0].id).toBe('s1')
    expect(JSON.parse(readFileSync(join(dir, 'flow-issues.json'), 'utf8'))).toEqual([])
    const c = calls()[0]
    expect(arg(c.args, '--model')).toBe('opus')
    expect(arg(c.args, '--effort')).toBe('medium')
    expect(arg(c.args, '--max-turns')).toBe('80')
    expect(c.args).toContain('--add-dir')
    expect(c.cwd.replace(/\\/g, '/')).toMatch(/context\/\d{8}-\d{6}-\d{3}$/)
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/^You write the Critical thinking flow/)
  })

  it('withholds the flow while a run is pending', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '600'
    await startFlow(sessionOf('R-1')!)
    expect(flowStateOf('R-1')).toMatchObject({ pending: true, flow: null })
    await waitDone()
    expect(flowStateOf('R-1').flow).not.toBeNull()
  })

  it('sends the problems back in the same session with the exact prompt, then accepts the good answer', async () => {
    process.env.FAKE_CLAUDE_BAD_FIRST = '1'
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(calls()).toHaveLength(2)
    const [first, second] = calls()
    expect(second.args).toContain('--resume')
    expect(arg(second.args, '--resume')).toBe(arg(first.args, '--session-id'))
    expect(second.args.at(-1)).toBe(
      'The answer has these problems. Fix every one, and answer with the whole JSON document again, nothing else:\n- The answer holds no JSON object.'
    )
    expect(flowStateOf('R-1').flow).not.toBeNull()
  })

  it('fails after three bad answers, writes flow-error.txt and leaves flow.json alone (acceptance check 3)', async () => {
    process.env.FAKE_CLAUDE_ANSWER = 'no json here'
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(calls()).toHaveLength(3)
    const message = 'The answer still had 1 problem(s) after 3 answers:\nThe answer holds no JSON object.'
    expect(readFileSync(join(dir, 'flow-error.txt'), 'utf8')).toBe(message)
    expect(flowStateOf('R-1')).toMatchObject({ pending: false, error: message, flow: null })
    expect(existsSync(join(dir, 'flow.json'))).toBe(false)
  })

  it('writes the install message when the tool is missing', async () => {
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(flowStateOf('R-1').error).toMatch(/^'claude' not found — install it first/)
    expect(readFileSync(join(dir, 'flow-error.txt'), 'utf8')).toMatch(/^'claude' not found/)
  })
})

describe('a saved flow (file 04 section 5.1)', () => {
  const save = (flow: unknown, issues: string[] = []): void => {
    writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow))
    writeFileSync(join(dir, 'flow-issues.json'), JSON.stringify(issues))
  }

  it('is used as it is when it still matches, and no run starts', async () => {
    save(JSON.parse(GOOD))
    await startFlow(sessionOf('R-1')!)
    expect(flowStateOf('R-1')).toMatchObject({ pending: false, problems: [] })
    expect(flowStateOf('R-1').flow?.steps).toHaveLength(1)
    expect(calls()).toHaveLength(0)
  })

  it('is replaced by a new run when a changed line moved, and the old one is not shown (acceptance check 2)', async () => {
    const stale = JSON.parse(GOOD)
    stale.steps[0].lines = [[99, 99]] // the change is no longer on that line
    save(stale)
    process.env.FAKE_CLAUDE_SLEEP_MS = '500'
    await startFlow(sessionOf('R-1')!)
    expect(flowStateOf('R-1')).toMatchObject({ pending: true, flow: null })
    expect(flowStateOf('R-1').problems).toEqual(['step s1: lines 99-99 of a.txt hold no change'])
    await waitDone()
    expect(flowStateOf('R-1').flow?.steps[0].lines).toEqual([[2, 2]])
  })

  it('is replaced when the issues of the review changed (acceptance check 4)', async () => {
    save(JSON.parse(GOOD), ['LX-1'])
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(calls()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'flow-issues.json'), 'utf8'))).toEqual([])
  })

  it('does not start a second run while one is in progress', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '600'
    await startFlow(sessionOf('R-1')!)
    await startFlow(sessionOf('R-1')!)
    await waitDone()
    expect(calls()).toHaveLength(1)
  })
})
