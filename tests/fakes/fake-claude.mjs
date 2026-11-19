// A stand-in for `claude`. Started through CODEDIFF_FAKE_CLAUDE (only when CODEDIFF_TEST is 1).
//   --version                 prints 0.0.0-fake
//   auth status --json        prints {"loggedIn":true}, or false when FAKE_CLAUDE_LOGIN=no
//   -p ...                    prints stream-json lines for the scenario picked by the instructions text
// Every print call is appended to FAKE_CLAUDE_LOG as one JSON line: { args, cwd, pid }.
// FAKE_CLAUDE_MODE: ok (default) | error (error result, exit 1) | crash (stderr boom, exit 2) | silent | long
// FAKE_CLAUDE_ANSWER: text to answer with, replacing the scenario text.
// FAKE_CLAUDE_BAD_FIRST=1: the first print call of a session answers "no json here".
// FAKE_CLAUDE_SLEEP_MS: wait before answering.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

if (args[0] === '--version') {
  process.stdout.write('0.0.0-fake\n')
  process.exit(0)
}
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGIN !== 'no' }) + '\n')
  process.exit(0)
}

const value = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const session = value('--resume') ?? value('--session-id') ?? 'none'
const instructions = value('--append-system-prompt') ?? ''
const prompt = args[args.length - 1] ?? ''
let childPid = null

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }) + '\n')
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
out({ type: 'system', subtype: 'init', session_id: session })

if (mode === 'crash') {
  process.stderr.write('boom')
  process.exit(2)
}
if (mode === 'silent') process.exit(0)
if (mode === 'long') {
  // A child process too, so a test can check the whole tree is killed.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  childPid = child.pid
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ child: childPid }) + '\n')
  setInterval(() => {}, 1000)
} else {
  if (mode === 'error') {
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 10, result: '', session_id: session })
    process.exit(1)
  }

  const scenarios = [
    ['You help a reviewer understand a merge request or pull request', 'Hello from fake'],
    ['You help a reviewer understand a set of', 'Fine.\n\n```code-diff-actions\n' + (process.env.FAKE_CLAUDE_ACTIONS ?? '[]') + '\n```'],
    ['You write the executive summary', '## What it does\n\nFake summary.\n\n## AC1: First criterion\n\nHow the code meets it.']
  ]
  let text = scenarios.find(([start]) => instructions.startsWith(start))?.[1] ?? 'ok'
  if (process.env.FAKE_CLAUDE_ANSWER && !instructions.startsWith('You write the executive summary')) text = process.env.FAKE_CLAUDE_ANSWER
  if (process.env.FAKE_CLAUDE_BAD_FIRST === '1' && !prompt.startsWith('The answer has these problems')) {
    const marker = `${process.env.FAKE_CLAUDE_LOG}.bad-${session}`
    if (!existsSync(marker)) {
      writeFileSync(marker, '1')
      text = 'no json here'
    }
  }

  const half = Math.ceil(text.length / 2)
  const wait = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0)
  const finish = () => {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } })
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/ctx/index.md"}' } }
    })
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/ctx/index.md' } }] },
      parent_tool_use_id: null,
      session_id: session
    })
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, half) } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(half) } } })
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session })
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, result: text, session_id: session })
    process.exit(0)
  }
  if (wait > 0) setTimeout(finish, wait)
  else finish()
}
