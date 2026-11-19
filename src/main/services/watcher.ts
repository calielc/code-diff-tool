import type { ChangeRef } from '@shared/provider'
import type { WatchEvent } from '@shared/watch'
import { readApprovals, readInfo, readThreads } from '../clients/forge'
import { reviewMrs } from './review-context'

interface Watch {
  timer: NodeJS.Timeout | null
  stopped: boolean
}
const watches = new Map<string, Watch>()

const DEFAULT_INTERVAL_MS = 30_000

/** Tests shorten the interval. The variable is ignored unless CODEDIFF_TEST is 1. */
const interval = (): number => (process.env['CODEDIFF_TEST'] === '1' && Number(process.env['CODEDIFF_WATCH_MS'])) || DEFAULT_INTERVAL_MS

/**
 * One watcher per open review (file 05 section 7). It waits one interval before its first round and one interval
 * between the end of a round and the start of the next. An error on one change is ignored and read again next round.
 */
export async function startWatch(root: string, slug: string, heads: Record<string, string>, emit: (e: WatchEvent) => void): Promise<void> {
  stopWatch(slug)
  const ctx = await reviewMrs(root, slug)
  if (!ctx.ok) return
  const refs = new Map<string, ChangeRef>()
  const known = new Map<string, string>()
  for (const [key, sha] of Object.entries(heads)) {
    const m = ctx.value.get(key)
    if (m) {
      refs.set(key, m.ref) // a key that is not an MR of the review is dropped
      known.set(key, sha)
    }
  }
  if (refs.size === 0) return

  const w: Watch = { timer: null, stopped: false }
  watches.set(slug, w)
  const lastStatus = new Map<string, string>()
  const lastApprovals = new Map<string, string>()
  const lastThreads = new Map<string, string>()
  const lastMarker = new Map<string, string>()

  const round = async (): Promise<void> => {
    const moved: string[] = []
    for (const [key, ref] of refs) {
      if (w.stopped) return
      try {
        const info = await readInfo(ref)
        if (info.diffRefs.head && info.diffRefs.head !== known.get(key)) {
          known.set(key, info.diffRefs.head)
          moved.push(key)
        }
        const status = { state: info.state, draft: info.draft }
        const st = JSON.stringify(status)
        if (lastStatus.get(key) !== st) {
          lastStatus.set(key, st)
          emit({ type: 'status', mr: key, status })
        }
        if (info.state !== 'opened') continue // a merged or closed change only gets status events
        try {
          const { approvals, people } = await readApprovals(ref)
          const a = JSON.stringify(approvals)
          if (lastApprovals.get(key) !== a) {
            lastApprovals.set(key, a)
            emit({ type: 'approvals', mr: key, approvals, people })
          }
        } catch {
          /* only the approvals message is skipped. The threads step still runs */
        }
        const marker = `${info.userNotesCount}|${info.updatedAt}`
        if (lastMarker.get(key) === marker) continue
        const { threads, people } = await readThreads(ref)
        const t = JSON.stringify(threads)
        if (lastThreads.get(key) !== t) {
          lastThreads.set(key, t)
          emit({ type: 'threads', mr: key, threads, people })
        }
        lastMarker.set(key, marker)
      } catch {
        /* the next round reads it again */
      }
    }
    if (moved.length > 0 && !w.stopped) emit({ type: 'changed', mrs: moved })
  }

  const schedule = (): void => {
    if (w.stopped) return
    w.timer = setTimeout(async () => {
      await round()
      schedule()
    }, interval())
  }
  schedule()
}

export function stopWatch(slug: string): void {
  const w = watches.get(slug)
  if (w) {
    w.stopped = true
    if (w.timer) clearTimeout(w.timer)
    watches.delete(slug)
  }
}
