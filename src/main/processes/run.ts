import { spawn, execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Cancel scope. Every process started inside `cancelScope.run(signal, fn)` is killed (with its children)
 * when the signal aborts, so a canceled build leaves no git or forge process behind (file 07 section 7.4).
 */
export const cancelScope = new AsyncLocalStorage<AbortSignal>()

export interface RunOptions {
  cwd?: string
  /** Default 5 minutes (file 05 section 5.2). */
  timeoutMs?: number
  /** Stdout cap in bytes. Default 64 MB (file 05 section 5.4). */
  maxOutputBytes?: number
  input?: string
}

export interface RunResult {
  /** -1 when the program was stopped by the time-out (file 05 section 5.1 rule 8). */
  code: number | null
  /** Decoded UTF-8. Not trimmed. */
  stdout: string
  /** Raw bytes, for git file contents. */
  stdoutBytes: Buffer
  /** First 64 KB of stderr. */
  stderr: string
  /** Set when the program could not be launched, for example ENOENT. */
  launchError: string | null
  timedOut: boolean
  /** True when stdout went over the cap. */
  tooLarge: boolean
  /** True when the cancel scope aborted the run. */
  canceled: boolean
}

export const DEFAULT_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_OUTPUT_CAP = 64 * 1024 * 1024
const STDERR_CAP = 64 * 1024

/**
 * Test hook: with CODEDIFF_TEST=1, `CODEDIFF_FAKE_<TOOL>` holds a JSON array that replaces the program
 * name, for example ["node","fake-tool.mjs"]. Windows cannot start .cmd shims without a shell,
 * so tests use this instead of fake programs on PATH. Ignored unless CODEDIFF_TEST is 1.
 */
export function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.env['CODEDIFF_TEST'] === '1') {
    const raw = process.env[`CODEDIFF_FAKE_${command.toUpperCase()}`]
    if (raw) {
      const prefix = JSON.parse(raw) as string[]
      return { command: prefix[0], args: [...prefix.slice(1), ...args] }
    }
  }
  return { command, args }
}

/** Stop a process and everything it started (file 05 section 5.5). */
export function killTree(pid: number, force = true): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], () => undefined)
    return
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM'
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      /* already gone */
    }
  }
}

/** Start a program with shell:false so every argument reaches it unchanged (file 05 section 5.1). */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const resolved = resolveCommand(command, args)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cap = opts.maxOutputBytes ?? DEFAULT_OUTPUT_CAP
  return new Promise((resolve) => {
    const out: Buffer[] = []
    let outSize = 0
    let stderr = ''
    let timedOut = false
    let tooLarge = false
    let canceled = false
    let settled = false
    // eslint-disable-next-line prefer-const -- set after `finish`, which clears it
    let timer: NodeJS.Timeout | undefined

    const finish = (code: number | null, launchError: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cancelScope.getStore()?.removeEventListener('abort', onAbort)
      const bytes = Buffer.concat(out)
      resolve({
        code: timedOut ? -1 : code,
        stdout: bytes.toString('utf8'),
        stdoutBytes: bytes,
        stderr,
        launchError,
        timedOut,
        tooLarge,
        canceled
      })
    }

    const child = spawn(resolved.command, resolved.args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const signal = cancelScope.getStore()
    const onAbort = (): void => {
      canceled = true
      if (child.pid) killTree(child.pid, true)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        const pid = child.pid
        killTree(pid, false) // normal end signal first (Windows has only the forced form)
        setTimeout(() => killTree(pid, true), process.platform === 'win32' ? 0 : 3000).unref()
      }
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      if (outSize >= cap) {
        tooLarge = true
        return
      }
      out.push(d)
      outSize += d.length
      if (outSize > cap) {
        tooLarge = true
        if (child.pid) killTree(child.pid, true)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString('utf8').slice(0, STDERR_CAP - stderr.length)
    })
    child.on('error', (e) => finish(null, e.message))
    child.on('close', (code) => finish(code, null))
    child.stdin.on('error', () => undefined)
    child.stdin.end(opts.input ?? '')
  })
}

/** The text of a run that hit the time-out (file 05 section 1.2). */
export function timeoutMessage(command: string, timeoutMs: number): string {
  const minutes = timeoutMs / 60000
  return `\`${command}\` did not finish within ${minutes} minutes, so it was stopped.`
}

/** stderr, or stdout when stderr is empty, trimmed, line breaks turned into spaces (file 05 section 2.1 rule 5). */
export function errorText(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim()).replace(/\s*[\r\n]+\s*/g, ' ')
}
