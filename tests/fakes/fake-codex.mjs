// A stand-in for `codex`. Started through CODEDIFF_FAKE_CODEX (only when CODEDIFF_TEST is 1).
//   --version        prints 0.0.0-fake
//   login status     exits 0, or 1 with "Not logged in" when FAKE_CODEX_LOGIN=no
//   exec ...         prints the JSONL events of `codex exec --json`
// Every exec call is appended to FAKE_CODEX_LOG as one JSON line: { args, cwd }.
// FAKE_CODEX_MODE: ok (default) | error (turn.failed) | crash (stderr boom, exit 2)
// FAKE_CODEX_ANSWER: the text of the agent message.
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

if (args[0] === '--version') {
  process.stdout.write('0.0.0-fake\n')
  process.exit(0)
}
if (args[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGIN === 'no') {
    process.stderr.write('Not logged in\n')
    process.exit(1)
  }
  process.stdout.write('Logged in\n')
  process.exit(0)
}

if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n')

const resumeAt = args.indexOf('resume')
const thread = resumeAt >= 0 ? args[resumeAt + 1] : `thread-${Math.random().toString(36).slice(2, 8)}`
const mode = process.env.FAKE_CODEX_MODE ?? 'ok'

if (mode === 'crash') {
  process.stderr.write('boom')
  process.exit(2)
}
out({ type: 'thread.started', thread_id: thread })
out({ type: 'turn.started' })
out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } })
out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'completed' } })
out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } })
if (mode === 'error') {
  out({ type: 'turn.failed', error: { message: 'model overloaded' } })
  process.exit(1)
}
out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: process.env.FAKE_CODEX_ANSWER ?? 'Codex says hi' } })
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
