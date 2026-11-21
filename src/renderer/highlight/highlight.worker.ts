// The worker that colours the code, so a big file never blocks the window. It answers one request at a time.

import type { TokenLine } from '@shared/syntax-tokens'
import { highlightLines } from './engine'

export interface Job {
  lang: string
  lines: string[]
}
export interface WorkerRequest {
  id: number
  jobs: Job[]
}
export interface WorkerReply {
  id: number
  results: (TokenLine[] | null)[]
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerReply): void
}
const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  const { id, jobs } = e.data
  void (async () => {
    const results: (TokenLine[] | null)[] = []
    for (const job of jobs) results.push(await highlightLines(job.lang, job.lines))
    scope.postMessage({ id, results })
  })()
}
