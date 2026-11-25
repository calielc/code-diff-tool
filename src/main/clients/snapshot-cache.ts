import { parseChangeUrl, type ChangeRef, type ChangeSnapshot } from '@shared/provider'
import type { Result } from '@shared/types'
import type { Limiter } from './limit'

export interface SnapshotCacheDeps {
  read(ref: ChangeRef): Promise<ChangeSnapshot>
  limit: Limiter
  /** True when a token is saved for the host of the change. */
  hasAccess(ref: ChangeRef): boolean
}

export interface SnapshotCache {
  /** The full snapshot of a change. The answer is kept while the updated time stays exactly the same. */
  get(url: string, updatedAt: string): Promise<Result<ChangeSnapshot>>
  /** Forgets the answers of these urls, or of every url when none are named. */
  drop(urls?: string[]): void
}

export function createSnapshotCache(deps: SnapshotCacheDeps): SnapshotCache {
  // One entry for each url, with the answer still open or done. A failed answer is not kept, so a later ask tries again.
  const cache = new Map<string, { updatedAt: string; answer: Promise<Result<ChangeSnapshot>> }>()

  return {
    get(url, updatedAt) {
      const ref = parseChangeUrl(url)
      if (!ref) return Promise.resolve({ ok: false, error: 'This is not a merge request or pull request URL.' })
      if (!deps.hasAccess(ref)) return Promise.resolve({ ok: false, error: `No access is saved for ${ref.host}.` })
      const known = cache.get(url)
      if (known?.updatedAt === updatedAt) return known.answer
      const answer: Promise<Result<ChangeSnapshot>> = deps
        .limit(() => deps.read(ref))
        .then(
          (value): Result<ChangeSnapshot> => ({ ok: true, value }),
          (e): Result<ChangeSnapshot> => {
            if (cache.get(url)?.answer === answer) cache.delete(url)
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }
        )
      cache.set(url, { updatedAt, answer })
      return answer
    },
    drop(urls) {
      if (!urls) cache.clear()
      else for (const u of urls) cache.delete(u)
    }
  }
}
