import { spawn } from 'node:child_process'
import { killTree, resolveCommand, run } from './run'

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Model = (typeof MODELS)[number]
export type Effort = (typeof EFFORTS)[number]

export const isModel = (v: unknown): v is Model => typeof v === 'string' && (MODELS as readonly string[]).includes(v)
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface AskInput {
  workingDirectory: string
  /** A UUID, lower case, with hyphens. */
  session: string
  /** False for the first turn of a conversation, true for each later turn. */
  resume: boolean
  model: Model
  instructions: string
  prompt: string
  maxTurns?: number
  extraDirectories?: string[]
  tools?: string
  effort?: Effort | null
}

const win = (): boolean => process.platform === 'win32'

/** The text every entry point shows when `claude` is not installed (file 04 section 1.5). */
export const missingMessage = (): string =>
  `'claude' not found — install it first (${win() ? 'irm https://claude.ai/install.ps1 | iex, or `winget install Anthropic.ClaudeCode`' : 'curl -fsSL https://claude.ai/install.sh | bash, or `brew install --cask claude-code`'}), then reopen the review.`

/**
 * The exact command line, in the order of the spec (file 04 section 1.2). It is an argument array, never passed
 * through a shell. `--safe-mode` and `--strict-mcp-config` lock the call down: no hook, MCP server, skill, plugin or
 * CLAUDE.md loads. The tools never include a shell, a writer or the network.
 */
export function buildArgs(i: AskInput): string[] {
  const args = [
    '-p',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    i.tools ?? 'Read,Grep,Glob',
    '--max-turns',
    String(i.maxTurns ?? 20),
    '--model',
    i.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    i.instructions,
    i.resume ? '--resume' : '--session-id',
    i.session
  ]
  if (i.effort) args.push('--effort', i.effort)
  for (const d of i.extraDirectories ?? []) args.push('--add-dir', d)
  args.push('--', i.prompt) // the options end here, because a prompt can start with a dash
  return args
}

const FORBIDDEN_TOOLS = /\b(Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch)\b/

/** Every entry point validates before it starts `claude`. */
export function validateAsk(i: AskInput): string | null {
  if (!isModel(i.model)) return 'model is not one of haiku, sonnet, opus, fable.'
  if (i.effort && !isEffort(i.effort)) return 'effort is not one of low, medium, high, xhigh, max.'
  if (!UUID_RE.test(i.session)) return 'session is not a UUID.'
  if (!i.prompt.trim()) return 'prompt is empty.'
  if (FORBIDDEN_TOOLS.test(i.tools ?? '')) return 'No call gets a shell, a writer or a network tool.'
  return null
}

/**
 * Start a program and yield its stdout lines as they arrive (file 04 section 1.3). Every AI tool uses this: the
 * program runs without a shell, stdin is closed at once (or fed once), and cancel, an early stop of the reader or the end
 * of the generator kill the whole process tree. A non-zero exit throws with the stderr text.
 */
export async function* spawnLines(program: string, args: string[], cwd: string, signal?: AbortSignal, stdin?: string): AsyncGenerator<string> {
  const { command, args: realArgs } = resolveCommand(program, args)
  const child = spawn(command, realArgs, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: !win(), // its own process group, so the whole tree can be killed
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    if (stderr.length < 64 * 1024) stderr += d
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(stdin ?? '') // closed at once: an open stdin makes claude wait 3 seconds

  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', () => reject(new Error(`Failed to start ${program}`)))
  })
  const onAbort = (): void => {
    if (child.pid) killTree(child.pid, true)
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    child.stdout.setEncoding('utf8')
    let buffer = ''
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line) yield line
      }
    }
    if (buffer.trim()) yield buffer.trim()
    const code = await exited
    if (signal?.aborted) return
    if (code !== 0) throw new Error(stderr.trim() || `${program} ended with exit code ${code} before it answered.`)
  } finally {
    // The reader may stop early (Stop, a closed chat, `answer` found its result). Then the process is killed.
    if (child.exitCode === null && child.pid) killTree(child.pid, true)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Run one turn of Claude Code and yield the stdout lines as they arrive. */
export async function* ask(input: AskInput, signal?: AbortSignal): AsyncGenerator<string> {
  const bad = validateAsk(input)
  if (bad) throw new Error(bad)
  yield* spawnLines('claude', buildArgs(input), input.workingDirectory, signal)
}

/** Run one turn and return the final text: the `result` of the first result line (file 04 section 1.4). */
export async function answer(input: AskInput, signal?: AbortSignal): Promise<string> {
  for await (const line of ask(input, signal)) {
    if (!line.startsWith('{')) continue
    let o: { type?: string; is_error?: boolean; result?: unknown }
    try {
      o = JSON.parse(line) as typeof o
    } catch {
      continue
    }
    if (o.type !== 'result') continue
    if (o.is_error) throw new Error(`claude answered with an error: ${typeof o.result === 'string' ? o.result : ''}`)
    return typeof o.result === 'string' ? o.result : ''
  }
  throw new Error('claude ended before it answered.')
}

export type ClaudeState = 'ok' | 'missing' | 'nologin'

/** Installed and logged in (file 04 section 1.5). Anything unclear counts as working. */
export async function claudeState(): Promise<ClaudeState> {
  const v = await run('claude', ['--version'], { timeoutMs: 30_000 })
  if (v.launchError || v.code !== 0) return 'missing'
  const s = await run('claude', ['auth', 'status', '--json'], { timeoutMs: 30_000 })
  try {
    if ((JSON.parse(s.stdout) as { loggedIn?: unknown }).loggedIn === false) return 'nologin'
  } catch {
    /* not JSON, an old claude, or a time-out */
  }
  return 'ok'
}
