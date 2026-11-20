import type { ChangeRef } from '@shared/provider'
import type { Result } from '@shared/types'
import { readReviewFile } from './reviews'
import { locateClone, scanClones, type Clone } from './workspace'

export interface ReviewMr {
  key: string
  ref: ChangeRef
  clone: Clone | null
}

/** The changes of a review by MR key `<repo>!<iid>`. Writes only go to changes that are in this map. */
export async function reviewMrs(root: string, slug: string): Promise<Result<Map<string, ReviewMr>>> {
  const review = await readReviewFile(root, slug)
  if (!review.ok) return review
  const clones = await scanClones(root)
  const map = new Map<string, ReviewMr>()
  for (const m of review.value.mrs) {
    const ref: ChangeRef = { provider: m.provider, host: m.host, project: m.projectPath, iid: m.iid }
    const clone = await locateClone(root, clones, ref)
    map.set(`${clone?.name ?? ref.project}!${ref.iid}`, { key: `${clone?.name ?? ref.project}!${ref.iid}`, ref, clone })
  }
  return { ok: true, value: map }
}
