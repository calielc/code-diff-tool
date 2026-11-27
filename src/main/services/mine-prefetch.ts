import type { MineResult } from '@shared/my-changes'
import { fetchMine } from '../clients/my-changes'
import { snapshots } from '../clients/snapshots'
import { listAccess } from './credentials'

/** An answer that is older than this is not used, because the window then reads the lists itself. */
const FRESH_MS = 60_000
/** The details of this many of the newest changes are read ahead. The window shows the newest first. */
const WARM_COUNT = 30

let held: { at: number; answer: Promise<MineResult> } | null = null

/** Starts to read the open part of the home lists, and then the details of the newest changes, so the lists are ready when the window asks for them. */
export function prefetchMine(): void {
  // A test that counts calls from the start turns the prefetch off. The variable is ignored unless CODEDIFF_TEST is 1.
  if (process.env['CODEDIFF_TEST'] === '1' && process.env['CODEDIFF_NO_PREFETCH'] === '1') return
  const accesses = listAccess()
    .filter((a): a is typeof a & { kind: 'gitlab' | 'github' } => a.kind !== 'jira')
    .map((a) => ({ provider: a.kind, host: a.host }))
  if (accesses.length === 0) return
  const answer = fetchMine(accesses, Date.now(), 'open')
  held = { at: Date.now(), answer }
  void answer.then((result) => {
    const newest = [...result.items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, WARM_COUNT)
    for (const item of newest) void snapshots.get(item.url, item.updatedAt)
  })
}

/** The answer of the prefetch, once, when it is fresh and every host answered. A failed host is read again by the window. */
export async function takePrefetchedMine(): Promise<MineResult | null> {
  const taken = held
  held = null
  if (!taken || Date.now() - taken.at > FRESH_MS) return null
  const result = await taken.answer
  return result.errors.length === 0 ? result : null
}
