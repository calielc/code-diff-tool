import { run } from './run'
import { spawnLines, validateAsk, type AskInput } from './claude'

/**
 * OpenAI Codex CLI, through `codex exec --json`. Its JSONL events are translated into the stream the rest of the app reads
 * (the same lines Claude Code prints), so the chats, the summaries and the runs do not care which tool answers.
 *
 * Differences from Claude Code that the adapter handles:
 * - Codex has no system prompt flag in `exec`, so the instructions go in front of the prompt.
 * - Codex chooses its own thread id. The adapter keeps a map from the app's session UUID to it, and resumes with it.
 * - The read-only sandbox stops writes and the network. Codex can still run read-only commands, which Claude Code's tool list does not allow.
 */

/** Our session UUID to the thread id Codex gave it. */
const threads = new Map<string, string>()
export const rememberThread = (session: string, thread: string): void => void threads.set(session, thread)
export const threadOf = (session: string): string | undefined => threads.get(session)
export const forgetThreads = (): void => threads.clear()

const REASONING: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

/** The command line of one turn. `model` is the Codex model name chosen for the tier, or null for Codex's own default. */
export function buildCodexArgs(i: AskInput, model: string | null, thread: string | null): string[] {
  const options = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', i.workingDirectory]
  if (model) options.push('-m', model)
  if (i.effort) options.push('-c', `model_reasoning_effort="${REASONING[i.effort]}"`)
  const prompt = `${i.instructions}\n\n${i.prompt}`
  return thread ? ['exec', ...options, 'resume', thread, '--', prompt] : ['exec', ...options, '--', prompt]
}

const out = (o: unknown): string => JSON.stringify(o)

interface Translator {
  /** Feed one Codex line, get the normalized lines. */
  feed(line: string): string[]
}

/** Translate Codex JSONL events into stream-json lines. Unknown events are ignored. */
export function codexTranslator(session: string): Translator {
  const started = Date.now()
  let finalText = ''
  let done = false
  return {
    feed(line: string): string[] {
      if (!line.startsWith('{')) return []
      let e: { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string; command?: string } }
      try {
        e = JSON.parse(line) as typeof e
      } catch {
        return []
      }
      const lines: string[] = []
      if (e.type === 'thread.started' && e.thread_id) {
        rememberThread(session, e.thread_id)
        lines.push(out({ type: 'system', subtype: 'init', session_id: session }))
      } else if (e.type === 'item.started' && e.item?.type === 'command_execution') {
        // A command is shown like a tool call, so the status line moves while Codex works.
        lines.push(
          out({
            type: 'stream_event',
            event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'cmd', name: 'Command', input: {} } }
          }),
          out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
        )
      } else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
        finalText = e.item.text
        lines.push(
          out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } }),
          out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: e.item.text } } }),
          out({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
        )
      } else if (!done && e.type === 'turn.completed') {
        done = true
        lines.push(out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - started, result: finalText, session_id: session }))
      } else if (!done && (e.type === 'turn.failed' || e.type === 'error')) {
        done = true
        const message = e.error?.message ?? e.message ?? 'Codex reported an error.'
        lines.push(out({ type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - started, result: message, session_id: session }))
      }
      return lines
    }
  }
}

/** The Codex model for a tier, from the settings. Null means Codex's own default. */
export type ModelMap = Partial<Record<AskInput['model'], string>>

export async function* askCodex(input: AskInput, models: ModelMap, signal?: AbortSignal): AsyncGenerator<string> {
  const bad = validateAsk({ ...input, tools: undefined })
  if (bad) throw new Error(bad)
  const thread = input.resume ? (threadOf(input.session) ?? null) : null // a thread that is unknown starts a new one
  const t = codexTranslator(input.session)
  for await (const line of spawnLines('codex', buildCodexArgs(input, models[input.model] ?? null, thread), input.workingDirectory, signal)) {
    yield* t.feed(line)
  }
}

export async function codexState(): Promise<'ok' | 'missing' | 'nologin'> {
  const v = await run('codex', ['--version'], { timeoutMs: 30_000 })
  if (v.launchError || v.code !== 0) return 'missing'
  // `codex login status` exits non-zero when there is no login. Anything unclear counts as working.
  const s = await run('codex', ['login', 'status'], { timeoutMs: 30_000 })
  if (s.code !== 0 && /not logged in|no credentials|log in/i.test(`${s.stdout}${s.stderr}`)) return 'nologin'
  return 'ok'
}
