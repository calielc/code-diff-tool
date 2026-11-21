// The page side of the highlighter. It sends texts to the worker, keeps the answers in a cache, and gives up on a
// worker that takes too long, so a slow file shows as plain text and the window keeps working.

import type { TokenLine } from '@shared/syntax-tokens'
import type { Job, WorkerReply, WorkerRequest } from './highlight.worker'

/** A worker that has gone this long without an answer is stopped, and the texts it was colouring stay plain. */
export const WORKER_TIMEOUT_MS = 8000
/** The most texts that the cache keeps. A text is one whole file side, so this is a few files. */
const CACHE_SIZE = 48

export type Result = TokenLine[] | null

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve(r: Result[]): void; size: number }>()
// One watchdog for the worker. Each answer restarts it, so a small request that waits behind a slow one is not blamed.
let watchdog: ReturnType<typeof setTimeout> | undefined

function armWatchdog(): void {
  clearTimeout(watchdog)
  watchdog = pending.size > 0 ? setTimeout(stopWorker, WORKER_TIMEOUT_MS) : undefined
}

function stopWorker(): void {
  worker?.terminate()
  worker = null
  for (const [id, p] of pending) {
    p.resolve(new Array<Result>(p.size).fill(null))
    pending.delete(id)
  }
  armWatchdog()
}

function startWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    p.resolve(e.data.results)
    armWatchdog()
  }
  worker.onerror = () => stopWorker()
  return worker
}

function run(jobs: Job[]): Promise<Result[]> {
  const w = startWorker()
  if (!w) return Promise.resolve(jobs.map(() => null))
  return new Promise((resolve) => {
    const id = nextId++
    const idle = pending.size === 0
    pending.set(id, { resolve, size: jobs.length })
    if (idle) armWatchdog()
    const request: WorkerRequest = { id, jobs }
    w.postMessage(request)
  })
}

/** A short key of a text: its language, its size and an FNV-1a hash of its characters. A wrong match only gives wrong colours, never wrong text. */
export function keyOf(job: Job): string {
  let h = 0x811c9dc5
  for (const line of job.lines) {
    for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ 10, 0x01000193)
  }
  return `${job.lang}:${job.lines.length}:${(h >>> 0).toString(36)}`
}

const cache = new Map<string, Promise<Result>>()

/** Colour each text as a whole. A text that was coloured before comes from the cache. The answer for a text that cannot be coloured is null. */
export function highlightMany(jobs: Job[]): Promise<Result[]> {
  const keys = jobs.map(keyOf)
  const answers = new Map<string, Promise<Result>>()
  const missing = jobs.map((_, i) => i).filter((i) => !cache.has(keys[i]))
  if (missing.length > 0) {
    const batch = run(missing.map((i) => jobs[i]))
    missing.forEach((i, n) =>
      answers.set(
        keys[i],
        batch.then((r) => r[n] ?? null)
      )
    )
  }
  for (const k of keys) {
    const hit = answers.get(k) ?? (cache.get(k) as Promise<Result>)
    answers.set(k, hit)
    cache.delete(k) // a hit moves to the end, so the oldest text goes first
    cache.set(k, hit)
  }
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return Promise.all(keys.map((k) => answers.get(k) as Promise<Result>))
}
