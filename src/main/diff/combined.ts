import type { CombinedPart, FileObject, LineObj, LineTarget } from '@shared/diff'
import { isAncestor, mergeCommit, readText, type BlobCache } from '../clients/git'
import { compute } from './myers'
import { buildFiles, type Resolver } from './mr-files'

/** What the combined view needs to know about one live MR. */
export interface CombinedMr {
  key: string
  iid: number
  base: string
  head: string
  mergedAt: string | null
  createdAt: string
  draft: boolean
  /** The MR's own files, for the line target resolver. */
  files: FileObject[]
}

const time = (s: string | null): number => (s ? Date.parse(s) || 0 : 0)

/** Merged first, then open, then draft. Inside a group by time ascending. The sort is stable (file 03 section 8.2). */
export function orderMrs<T extends Pick<CombinedMr, 'mergedAt' | 'createdAt' | 'draft'>>(mrs: T[]): T[] {
  const group = (m: T): number => (m.mergedAt ? 0 : m.draft ? 2 : 1)
  const when = (m: T): number => (m.mergedAt ? time(m.mergedAt) : time(m.createdAt))
  return [...mrs].sort((a, b) => group(a) - group(b) || when(a) - when(b))
}

/** `starts at !14, which conflicts with the part before it (!11, !12)` */
export const splitReason = (iid: number, before: number[]): string =>
  `starts at !${iid}, which conflicts with the part before it (${before.map((i) => `!${i}`).join(', ')})`

export interface PartPlan {
  mrs: CombinedMr[]
  head: string
  reason: string | null
}

/** The merge procedure of file 03 section 8.3. Returns the parts, each with the head of its merge state. */
export async function planParts(dir: string, ordered: CombinedMr[]): Promise<PartPlan[]> {
  const parts: PartPlan[] = []
  let head = ordered[0].head
  let start = 0
  let reason: string | null = null
  for (let i = 1; i < ordered.length; i++) {
    const previousBase = ordered[i - 1].base
    // Bring in what landed on the target since the previous MR, but only forward. An older base would revert later commits.
    const forward = previousBase !== ordered[i].base && (await isAncestor(dir, previousBase, ordered[i].base))
    let withBase = head
    if (forward) withBase = (await mergeCommit(dir, head, ordered[i].base, previousBase)) ?? head // a conflict here is skipped
    const merged = await mergeCommit(dir, withBase, ordered[i].head, ordered[i].base)
    if (merged === null) {
      parts.push({ mrs: ordered.slice(start, i), head, reason })
      reason = splitReason(
        ordered[i].iid,
        ordered.slice(start, i).map((m) => m.iid)
      )
      start = i
      head = ordered[i].head
    } else head = merged
  }
  parts.push({ mrs: ordered.slice(start), head, reason })
  return parts
}

const rawLines = (f: FileObject): LineObj[] => f.levels.raw.hunks.flat()

/**
 * The line target resolver (file 03 section 8.5). Added and unchanged lines go to the last MR whose own diff adds
 * the matching line. Removed lines go to the first MR whose own diff deletes the matching line.
 */
export function makeResolver(dir: string, mrs: CombinedMr[], cache: BlobCache): Resolver {
  return async (file) => {
    const newTargets = new Map<number, LineTarget>()
    const oldTargets = new Map<number, LineTarget>()
    const newLines = file.new && !file.new.binary ? file.new.lines : null
    const oldLines = file.old && !file.old.binary ? file.old.lines : null

    for (const mr of mrs) {
      const adding = mr.files.find((f) => f.path === file.path && f.status !== 'D' && !f.binary)
      if (adding && newLines) {
        const changed = new Set(
          rawLines(adding)
            .filter((l) => l.t === '+')
            .map((l) => l.n as number)
        )
        if (changed.size > 0) {
          const own = await readText(dir, mr.head, file.path, cache)
          for (const s of compute(newLines, own.lines)) {
            if (s.k === 'eq' && changed.has(s.n + 1)) newTargets.set(s.o + 1, { mr: mr.key, o: null, n: s.n + 1 }) // a later MR overwrites
          }
        }
      }
      const deleting = mr.files.find((f) => f.oldPath === file.oldPath && f.status !== 'A' && !f.binary)
      if (deleting && oldLines) {
        const changed = new Set(
          rawLines(deleting)
            .filter((l) => l.t === '-')
            .map((l) => l.o as number)
        )
        if (changed.size > 0) {
          const own = await readText(dir, mr.base, file.oldPath, cache)
          for (const s of compute(oldLines, own.lines)) {
            if (s.k === 'eq' && changed.has(s.n + 1) && !oldTargets.has(s.o + 1)) oldTargets.set(s.o + 1, { mr: mr.key, o: s.n + 1, n: null }) // the first MR wins
          }
        }
      }
    }
    return (l) => (l.t === '-' ? (l.o !== null ? (oldTargets.get(l.o) ?? null) : null) : l.n !== null ? (newTargets.get(l.n) ?? null) : null)
  }
}

/** Build the combined parts of one repo (file 03 section 8). Needs two or more live MRs. */
export async function buildCombined(dir: string, repo: string, live: CombinedMr[], cache: BlobCache): Promise<CombinedPart[]> {
  if (live.length < 2) return []
  const plans = await planParts(dir, orderMrs(live))
  const out: CombinedPart[] = []
  for (const p of plans) {
    // Only files that some MR of the part touched are shown (file 03 section 8.4).
    const touched = new Set(p.mrs.flatMap((m) => m.files.flatMap((f) => [f.path, f.oldPath])))
    const files = await buildFiles(dir, p.mrs[0].base, p.head, cache, makeResolver(dir, p.mrs, cache), touched)
    out.push({ repo, mrs: p.mrs.map((m) => m.key), available: true, reason: p.reason, headSha: p.head, files })
  }
  return out
}
