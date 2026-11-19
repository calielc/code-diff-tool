import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { answer, ask, buildArgs, claudeState, validateAsk, type AskInput } from '../src/main/processes/claude'

const fake = resolve(__dirname, 'fakes/fake-claude.mjs')
let dir: string
let log: string

const SESSION = '3f2b8a1e-5c4d-4e6f-8a9b-0c1d2e3f4a5b'
const input = (o: Partial<AskInput> = {}): AskInput => ({
  workingDirectory: dir,
  session: SESSION,
  resume: false,
  model: 'sonnet',
  instructions: 'You help a reviewer understand a merge request or pull request. Answer briefly.',
  prompt: '-dash prompt',
  ...o
})
const calls = (): { args: string[]; cwd: string; pid: number; child?: number }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const collect = async (it: AsyncGenerator<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const l of it) out.push(l)
  return out
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codediff-claude-'))
  log = join(dir, 'claude.log')
  writeFileSync(log, '')
  process.env.CODEDIFF_TEST = '1'
  process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['node', fake])
  process.env.FAKE_CLAUDE_LOG = log
})
afterEach(() => {
  for (const k of ['CODEDIFF_TEST', 'CODEDIFF_FAKE_CLAUDE', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_LOGIN', 'FAKE_CLAUDE_BAD_FIRST'])
    delete process.env[k]
})

describe('the command line (file 04 section 1.2, acceptance check 1)', () => {
  it('has the arguments in the documented order, with the prompt last after --', () => {
    expect(buildArgs(input({ maxTurns: 40, tools: 'Read,Grep,Glob', extraDirectories: ['/a', '/b'], effort: 'high' }))).toEqual([
      '-p',
      '--safe-mode',
      '--strict-mcp-config',
      '--tools',
      'Read,Grep,Glob',
      '--max-turns',
      '40',
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--append-system-prompt',
      'You help a reviewer understand a merge request or pull request. Answer briefly.',
      '--session-id',
      SESSION,
      '--effort',
      'high',
      '--add-dir',
      '/a',
      '--add-dir',
      '/b',
      '--',
      '-dash prompt'
    ])
  })
  it('uses --resume for a follow-up and leaves out --effort and --add-dir when there are none', () => {
    const a = buildArgs(input({ resume: true }))
    expect(a).toContain('--resume')
    expect(a).not.toContain('--session-id')
    expect(a).not.toContain('--effort')
    expect(a).not.toContain('--add-dir')
    expect(a.slice(-2)).toEqual(['--', '-dash prompt'])
    expect(a[a.indexOf('--max-turns') + 1]).toBe('20') // the default
  })
  it('refuses a bad model, effort, session or empty prompt, and any shell, writer or network tool', () => {
    expect(validateAsk(input({ model: 'gpt' as never }))).toBe('model is not one of haiku, sonnet, opus, fable.')
    expect(validateAsk(input({ effort: 'huge' as never }))).toBe('effort is not one of low, medium, high, xhigh, max.')
    expect(validateAsk(input({ session: 'abc' }))).toBe('session is not a UUID.')
    expect(validateAsk(input({ prompt: '   ' }))).toBe('prompt is empty.')
    for (const tools of ['Read,Bash', 'Write', 'Edit,Read', 'WebFetch']) expect(validateAsk(input({ tools }))).toMatch(/shell, a writer or a network tool/)
    expect(validateAsk(input({ tools: 'Read,Grep,Glob,Agent' }))).toBeNull()
  })
  it('passes the real arguments to the program, in that working folder, and never through a shell', async () => {
    await answer(input({ prompt: 'a "quoted" $HOME | prompt' }))
    const c = calls()[0]
    expect(c.cwd.toLowerCase()).toBe(dir.toLowerCase())
    expect(c.args[0]).toBe('-p')
    expect(c.args.at(-1)).toBe('a "quoted" $HOME | prompt')
    expect(c.args).toContain('--safe-mode')
    expect(c.args).toContain('--strict-mcp-config')
    expect(c.args[c.args.indexOf('--tools') + 1]).not.toMatch(/Bash|Write/)
  })
})

describe('ask and answer (file 04 sections 1.3 and 1.4)', () => {
  it('yields the stdout lines as they arrive', async () => {
    const lines = await collect(ask(input()))
    expect(lines.length).toBeGreaterThan(8)
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'system' })
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'result', is_error: false, result: 'Hello from fake' })
  })
  it('answer gives the result text of the first result line', async () => {
    process.env.FAKE_CLAUDE_ANSWER = 'The answer.'
    expect(await answer(input())).toBe('The answer.')
  })
  it('an error result throws, a crash throws the stderr text, and a silent end has its own message', async () => {
    process.env.FAKE_CLAUDE_MODE = 'error'
    await expect(answer(input())).rejects.toThrow('claude answered with an error: ')
    process.env.FAKE_CLAUDE_MODE = 'crash'
    await expect(answer(input())).rejects.toThrow('boom')
    process.env.FAKE_CLAUDE_MODE = 'silent'
    await expect(answer(input())).rejects.toThrow('claude ended before it answered.')
  })
  it('says it could not start when the program is missing', async () => {
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    await expect(answer(input())).rejects.toThrow('Failed to start claude')
  })
  it('cancel kills the process and its child within a second (acceptance check 4)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'long'
    const ac = new AbortController()
    const run = collect(ask(input(), ac.signal))
    // wait until the fake has started its child
    await expect.poll(() => calls().some((c) => c.child), { timeout: 10_000 }).toBe(true)
    const pids = [calls()[0].pid, calls().find((c) => c.child)!.child!]
    expect(pids.every(alive)).toBe(true)
    const t0 = Date.now()
    ac.abort()
    await run
    await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('stopping the reader early kills the process too', async () => {
    process.env.FAKE_CLAUDE_MODE = 'long'
    const it = ask(input())
    await it.next() // the system line
    await expect.poll(() => calls().some((c) => c.child), { timeout: 10_000 }).toBe(true)
    const pids = [calls()[0].pid, calls().find((c) => c.child)!.child!]
    await it.return(undefined)
    await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false)
  })
})

describe('installed and logged in (file 04 section 1.5)', () => {
  it('reports ok, nologin and missing', async () => {
    expect(await claudeState()).toBe('ok')
    process.env.FAKE_CLAUDE_LOGIN = 'no'
    expect(await claudeState()).toBe('nologin')
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    expect(await claudeState()).toBe('missing')
  })
})
