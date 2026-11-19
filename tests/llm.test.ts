import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyLine, newAnswer } from '../src/shared/chat-reader'
import type { AskInput } from '../src/main/processes/claude'
import { buildCodexArgs, codexTranslator, forgetThreads, threadOf } from '../src/main/processes/codex'
import { buildCustomArgs } from '../src/main/processes/custom'
import { answer, ask, capabilities, llmState, loginCommand, missingMessage, setLlmConfig, toolName } from '../src/main/processes/llm'

const fakeCodex = resolve(__dirname, 'fakes/fake-codex.mjs')
const fakeCustom = resolve(__dirname, 'fakes/fake-custom.mjs')
let dir: string
let log: string

const SESSION = '3f2b8a1e-5c4d-4e6f-8a9b-0c1d2e3f4a5b'
const input = (o: Partial<AskInput> = {}): AskInput => ({
  workingDirectory: dir,
  session: SESSION,
  resume: false,
  model: 'sonnet',
  instructions: 'You help a reviewer.',
  prompt: 'What changed?',
  ...o
})
const calls = (): { args: string[]; cwd: string }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const collect = async (it: AsyncGenerator<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const l of it) out.push(l)
  return out
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codediff-llm-'))
  log = join(dir, 'codex.log')
  writeFileSync(log, '')
  process.env.CODEDIFF_TEST = '1'
  process.env.CODEDIFF_FAKE_CODEX = JSON.stringify(['node', fakeCodex])
  process.env.FAKE_CODEX_LOG = log
  forgetThreads()
  setLlmConfig({ tool: 'codex' })
})
afterEach(() => {
  for (const k of ['CODEDIFF_TEST', 'CODEDIFF_FAKE_CODEX', 'FAKE_CODEX_LOG', 'FAKE_CODEX_MODE', 'FAKE_CODEX_ANSWER', 'FAKE_CODEX_LOGIN', 'FAKE_CUSTOM_MODE'])
    delete process.env[k]
  setLlmConfig({ tool: 'claude' })
})

describe('Codex command line', () => {
  it('puts the instructions in front of the prompt, uses a read-only sandbox, and ends the options with --', () => {
    const a = buildCodexArgs(input(), null, null)
    expect(a).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir, '--', 'You help a reviewer.\n\nWhat changed?'])
  })
  it('names the model and maps the effort, and resumes with the thread id', () => {
    const a = buildCodexArgs(input({ effort: 'max' }), 'gpt-5-codex', 'thr-1')
    expect(a).toContain('-m')
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-5-codex')
    expect(a[a.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"')
    expect(a.slice(a.indexOf('resume'), a.indexOf('resume') + 2)).toEqual(['resume', 'thr-1'])
    expect(a.at(-2)).toBe('--')
  })
})

describe('Codex events become the shared stream', () => {
  it('translates the events, remembers the thread, and gives the chat reader the text and the result', () => {
    const t = codexTranslator(SESSION)
    const lines = [
      { type: 'thread.started', thread_id: 'thr-9' },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'The answer.' } },
      { type: 'turn.completed' }
    ].flatMap((e) => t.feed(JSON.stringify(e)))
    let a = newAnswer()
    for (const l of lines) a = applyLine(a, l, 'sonnet')
    expect(a.text).toBe('The answer.')
    expect(a.footer).toMatch(/^Sonnet · \d+ s$/)
    expect(a.started).toBe(true)
    expect(threadOf(SESSION)).toBe('thr-9')
  })
  it('turns a failed turn into an error result, once, and ignores events it does not know', () => {
    const t = codexTranslator(SESSION)
    expect(t.feed('not json')).toEqual([])
    expect(t.feed(JSON.stringify({ type: 'something.new' }))).toEqual([])
    const r = t.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'overloaded' } }))
    expect(JSON.parse(r[0])).toMatchObject({ type: 'result', is_error: true, result: 'overloaded' })
    expect(t.feed(JSON.stringify({ type: 'error', message: 'again' }))).toEqual([]) // only the first ending counts
  })
})

describe('asking Codex (through the facade)', () => {
  it('answers, runs in the working folder, and resumes the same thread for a follow-up', async () => {
    process.env.FAKE_CODEX_ANSWER = 'First.'
    expect(await answer(input())).toBe('First.')
    const first = calls()[0]
    expect(first.cwd.toLowerCase()).toBe(dir.toLowerCase())
    expect(first.args).not.toContain('resume')
    const thread = threadOf(SESSION)!
    expect(thread).toMatch(/^thread-/)
    process.env.FAKE_CODEX_ANSWER = 'Second.'
    expect(await answer(input({ resume: true, prompt: 'And then?' }))).toBe('Second.')
    const second = calls()[1].args
    expect(second.slice(second.indexOf('resume'), second.indexOf('resume') + 2)).toEqual(['resume', thread])
  })
  it('starts a new thread when a resumed session is unknown', async () => {
    await answer(input({ resume: true, session: '11111111-1111-4111-8111-111111111111' }))
    expect(calls()[0].args).not.toContain('resume')
  })
  it('streams lines the chat reader understands', async () => {
    let a = newAnswer()
    for (const l of await collect(ask(input()))) a = applyLine(a, l, 'opus')
    expect(a.text).toBe('Codex says hi')
    expect(a.error).toBeNull()
  })
  it('reports a failed turn, a crash, and a missing program in the tool name', async () => {
    process.env.FAKE_CODEX_MODE = 'error'
    await expect(answer(input())).rejects.toThrow('codex answered with an error: model overloaded')
    process.env.FAKE_CODEX_MODE = 'crash'
    await expect(answer(input())).rejects.toThrow('boom')
    process.env.CODEDIFF_FAKE_CODEX = JSON.stringify(['definitely-not-a-real-program-xyz'])
    await expect(answer(input())).rejects.toThrow('Failed to start codex')
  })
  it('reports ok, nologin and missing, with its own messages', async () => {
    expect(await llmState()).toBe('ok')
    process.env.FAKE_CODEX_LOGIN = 'no'
    expect(await llmState()).toBe('nologin')
    expect(loginCommand()).toBe('codex login')
    process.env.CODEDIFF_FAKE_CODEX = JSON.stringify(['definitely-not-a-real-program-xyz'])
    expect(await llmState()).toBe('missing')
    expect(missingMessage()).toMatch(/^'codex' not found — install it first \(npm install -g @openai\/codex/)
    expect(toolName()).toBe('codex')
    expect(capabilities()).toEqual({ resume: true })
  })
})

describe('a custom command', () => {
  const tool = { name: 'mytool', command: 'node', args: [fakeCustom] }

  it('replaces the placeholders and sends the prompt on standard input when no argument holds it', () => {
    const t = { name: 'x', command: 'c', args: ['--model', '{model}', '--dir', '{dir}', '--session={session}'] }
    const b = buildCustomArgs(t, input({ effort: 'low' }))
    expect(b.args).toEqual(['--model', 'sonnet', '--dir', dir, `--session=${SESSION}`])
    expect(b.stdin).toBe('You help a reviewer.\n\nWhat changed?')
  })
  it('puts the prompt in an argument when {prompt} is used, with the instructions in front unless {instructions} is used', () => {
    expect(buildCustomArgs({ name: 'x', command: 'c', args: ['-p', '{prompt}'] }, input())).toEqual({
      args: ['-p', 'You help a reviewer.\n\nWhat changed?'],
      stdin: undefined
    })
    expect(buildCustomArgs({ name: 'x', command: 'c', args: ['-s', '{instructions}', '-p', '{prompt}'] }, input())).toEqual({
      args: ['-s', 'You help a reviewer.', '-p', 'What changed?'],
      stdin: undefined
    })
  })
  it('runs the command, streams its text, and has no session', async () => {
    setLlmConfig({ tool: 'custom', custom: tool })
    const text = await answer(input())
    expect(text).toContain('STDIN "You help a reviewer.\\n\\nWhat changed?"')
    expect(text.endsWith('Done.')).toBe(true)
    let a = newAnswer()
    for (const l of await collect(ask(input()))) a = applyLine(a, l, 'haiku')
    expect(a.text).toContain('Done.')
    expect(capabilities()).toEqual({ resume: false })
    expect(toolName()).toBe('mytool')
  })
  it('reports a crash, a missing command and a missing setting', async () => {
    setLlmConfig({ tool: 'custom', custom: tool })
    process.env.FAKE_CUSTOM_MODE = 'crash'
    await expect(answer(input())).rejects.toThrow('boom')
    setLlmConfig({ tool: 'custom', custom: { name: 'gone', command: 'definitely-not-a-real-program-xyz', args: [] } })
    expect(await llmState()).toBe('missing')
    expect(missingMessage()).toContain("'definitely-not-a-real-program-xyz' could not be started")
    setLlmConfig({ tool: 'custom' })
    expect(() => ask(input())).toThrow('No command is set for the AI tool.')
  })
})
