import type { ChangeRef, ChangeSnapshot } from '@shared/provider'
import { summariseStatus, type ReviewStatus } from '@shared/review-status'
import { readSnapshot } from '../clients/forge'
import { limited } from '../clients/limit'
import { readReviewFile } from './reviews'

/** A read of a change is used again for this long, so a window that asks again on focus does not read the same change twice. */
const FRESH_MS = 60_000
const reads = new Map<string, { at: number; answer: Promise<ChangeSnapshot | null> }>()

function readChange(ref: ChangeRef): Promise<ChangeSnapshot | null> {
  const key = `${ref.provider} ${ref.host} ${ref.project} ${ref.iid}`
  const known = reads.get(key)
  if (known && Date.now() - known.at < FRESH_MS) return known.answer
  const answer = limited(() => readSnapshot(ref)).catch(() => null)
  reads.set(key, { at: Date.now(), answer })
  return answer
}

/** The status of one review: its changes are read at most 6 at a time, and a change that fails to read counts as unread. */
export async function reviewStatus(root: string, slug: string): Promise<ReviewStatus | null> {
  const review = await readReviewFile(root, slug)
  if (!review.ok) return null
  const snapshots = await Promise.all(
    review.value.mrs.map((m) => readChange({ provider: m.provider, host: m.host, project: m.projectPath, iid: m.iid }))
  )
  return summariseStatus(snapshots)
}
