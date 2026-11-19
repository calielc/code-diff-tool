import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setLlmConfig } from '../src/main/processes/llm'
import { cancelChat, resetChatMemory, startChat, type ChatEvent, type ChatRequest } from '../src/main/services/chat'
import { reviewDir } from '../src/main/services/reviews'
import { sessionOf } from '../src/main/services/session'
import { startBuild } from '../src/main/services/build'
import { resetWorkspaceCache } from '../src/main/services/workspace'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const fakeClaude = resolve(__dirname, 'fakes/fake-claude.mjs')
const fakeCustom = resolve(__dirname, 'fakes/fake-custom.mjs')
const P = encodeURIComponent('team/backend/x')
const SESSION = '3f2b8a1e-5c4d-4e6f-8a9b-0c1d2e3f4a5b'

let root: string
let forge: FakeForge
let log: string
let shas: { a: string; b: string }

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const calls = (): { args: string[]; cwd: string; pid: number; child?: number }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const arg = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]

/** Run one turn and wait for its end. */
async function turn(req: ChatRequest): Promise<{ lines: string[]; error?: string; id?: string }> {
  const lines: string[] = []
  let done!: () => void
  const ended = new Promise<void>((r) => (done = r))
  const r = await startChat(req, (e: ChatEvent) => ('end' in e ? done() : lines.push(e.line)))
  if (!r.ok) return { lines, error: r.error }
  await ended
  return { lines, id: r.value.id }
}
const line = (o: Partial<ChatRequest> = {}): ChatRequest =>
  ({ kind: 'line', slug: 'R-1', mr: 'backend/x!12', sha: shas.b, session: SESSION, resume: false, model: 'sonnet', prompt: 'Why?', ...o }) as ChatRequest
const review = (o: Partial<ChatRequest> = {}): ChatRequest =>
  ({ kind: 'review', slug: 'R-1', session: SESSION, resume: false, model: 'opus', prompt: 'What changed?', ...o }) as ChatRequest
const results = (lines: string[]): { result?: string }[] => lines.filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l))

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codediff-chat-'))
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
  git(dir, 'commit', '-qam', 'change')
  shas = { a, b: git(dir, 'rev-parse', 'HEAD') }
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
        diff_refs: { base_sha: shas.a, start_sha: shas.a, head_sha: shas.b }
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
  setLlmConfig({ tool: 'claude' })
  resetWorkspaceCache()
  resetChatMemory()
  mkdirSync(reviewDir(root, 'R-1'), { recursive: true })
  writeFileSync(
    join(reviewDir(root, 'R-1'), 'review.json'),
    JSON.stringify({ title: 'Review', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] })
  )
  const r = await startBuild(root, 'R-1', () => undefined)
  if (!r.ok) throw new Error(r.error)
})
afterEach(async () => {
  for (const k of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_ANSWER', 'FAKE_CUSTOM_MODE']) delete process.env[k]
  setLlmConfig({ tool: 'claude' })
  await stopFakeForge(forge)
})

describe('the line chat (file 04 section 3.1, acceptance checks 1 and 2)', () => {
  it('runs in the export of the commit with the documented command line, and streams the answer', async () => {
    const t = await turn(line())
    expect(results(t.lines)[0].result).toBe('Hello from fake')
    const c = calls()[0]
    expect(c.cwd.toLowerCase()).toBe(join(reviewDir(root, 'R-1'), 'heads', shas.b).toLowerCase())
    expect(existsSync(join(c.cwd, 'a.txt'))).toBe(true)
    expect(arg(c.args, '--model')).toBe('sonnet')
    expect(arg(c.args, '--max-turns')).toBe('20')
    expect(arg(c.args, '--tools')).toBe('Read,Grep,Glob')
    expect(arg(c.args, '--session-id')).toBe(SESSION)
    expect(c.args).not.toContain('--effort')
    expect(c.args).not.toContain('--add-dir')
    expect(c.args.at(-2)).toBe('--')
    expect(c.args.at(-1)).toBe('Why?')
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/^You help a reviewer understand a merge request or pull request/)
  })
  it('resumes the same session for a follow-up with only the question', async () => {
    await turn(line())
    await turn(line({ resume: true, prompt: 'And then?' }))
    const second = calls()[1].args
    expect(arg(second, '--resume')).toBe(SESSION)
    expect(second).not.toContain('--session-id')
    expect(second.at(-1)).toBe('And then?')
  })
  it.each([
    [{ slug: 'NOPE' }, 'The review is not loaded: open it again.'],
    [{ session: 'abc' }, 'session is not a UUID.'],
    [{ model: 'gpt' }, 'model is not one of haiku, sonnet, opus, fable.'],
    [{ prompt: '  ' }, 'prompt is empty.'],
    [{ mr: 'x!1' }, 'repo x!1 has no local clone in the workspace.'],
    [{ sha: 'xyz' }, 'sha is not 40 hex characters.'],
    [{ sha: 'f'.repeat(40) }, `Commit ${'f'.repeat(40)} is not in the clone of backend/x.`]
  ])('refuses %j with its reason and starts nothing', async (o, message) => {
    const t = await turn(line(o as Partial<ChatRequest>))
    expect(t.error).toBe(message)
    expect(readFileSync(log, 'utf8').trim()).toBe('')
  })
})

describe('the review chat (file 04 section 3.2, acceptance check 3)', () => {
  it('runs in the context folder with 40 turns and one --add-dir per repo folder, and writes review-state.md', async () => {
    await turn(review())
    const c = calls()[0]
    const ctx = await sessionOf('R-1')!.context
    expect(c.cwd.toLowerCase()).toBe(ctx.dir.toLowerCase())
    expect(arg(c.args, '--max-turns')).toBe('40')
    expect(arg(c.args, '--model')).toBe('opus')
    const dirs = c.args.flatMap((a, i) => (a === '--add-dir' ? [c.args[i + 1]] : []))
    expect(dirs.sort()).toEqual([...ctx.repoDirs].sort())
    expect(dirs.length).toBeGreaterThan(0)
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/^You help a reviewer understand a set of merge or pull requests/)
    expect(readFileSync(join(ctx.dir, 'review-state.md'), 'utf8')).toContain('The viewer is `@me`.')
  })
  it('keeps the context of the first turn for a follow-up, even when a newer build wrote another', async () => {
    await turn(review())
    const first = calls()[0].cwd
    await startBuild(root, 'R-1', () => undefined) // a new build, a new context folder
    await sessionOf('R-1')!.context
    await turn(review({ resume: true, prompt: 'More?' }))
    expect(calls()[1].cwd).toBe(first)
    expect(arg(calls()[1].args, '--resume')).toBe(SESSION)
  })
})

describe('errors and Stop (file 04 section 2.3, acceptance checks 4 to 7)', () => {
  it('adds exactly one app_error line after a crash before any result', async () => {
    process.env.FAKE_CLAUDE_MODE = 'crash'
    const t = await turn(line())
    expect(t.lines.filter((l) => l.includes('app_error'))).toEqual([JSON.stringify({ type: 'app_error', message: 'boom' })])
  })
  it('adds no error line after an error result, and one when the stream ends silently', async () => {
    process.env.FAKE_CLAUDE_MODE = 'error'
    expect((await turn(line())).lines.some((l) => l.includes('app_error'))).toBe(false)
    process.env.FAKE_CLAUDE_MODE = 'silent'
    expect((await turn(line())).lines.filter((l) => l.includes('app_error'))).toEqual([
      JSON.stringify({ type: 'app_error', message: 'claude ended before it answered.' })
    ])
  })
  it('shows the install message when the tool is missing', async () => {
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    const t = await turn(line())
    expect(JSON.parse(t.lines.find((l) => l.includes('app_error'))!).message).toMatch(/^'claude' not found — install it first/)
  })
  it('Stop kills the process and its children and ends the stream', async () => {
    process.env.FAKE_CLAUDE_MODE = 'long'
    let done!: () => void
    const ended = new Promise<void>((r) => (done = r))
    const r = await startChat(line(), (e) => 'end' in e && done())
    expect(r.ok).toBe(true)
    await expect.poll(() => calls().length >= 1 && readFileSync(log, 'utf8').includes('"child"'), { timeout: 10_000 }).toBe(true)
    const raw = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const pids = [raw.find((c) => c.args).pid, raw.find((c) => c.child).child]
    cancelChat((r as { ok: true; value: { id: string } }).value.id)
    await ended
    await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false)
  })
})

describe('a tool with no session (custom command)', () => {
  it('sends the earlier questions and answers again with each follow-up', async () => {
    setLlmConfig({ tool: 'custom', custom: { name: 'mytool', command: 'node', args: [fakeCustom] } })
    const first = await turn(line({ prompt: 'First question' }))
    expect(results(first.lines)[0].result).toContain('Done.')
    const second = await turn(line({ resume: true, prompt: 'Second question' }))
    const text = results(second.lines)[0].result!
    expect(text).toContain('The earlier questions and answers of this conversation')
    expect(text).toContain('First question')
    expect(text).toContain('The new question')
    expect(text).toContain('Second question')
  })
})
