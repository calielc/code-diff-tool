import { shell } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import { SLUG_RE } from '@shared/review'
import type { Result } from '@shared/types'
import { readAppState, writeAppState } from '../services/app-state'
import { cancelBuild, isBuilding, startBuild } from '../services/build'
import { addSpecFiles } from '../services/issues'
import { addToReview, checkDeletable, checkReview, createReview, listReviews, pendingCommentCount, renameReview } from '../services/reviews'
import { takePick } from './issues'
import { handle } from './guard'

const slug = z.string().regex(SLUG_RE)
const form = z.object({ urls: z.string().max(50_000), issues: z.string().max(20_000), slug: z.string().max(200) })

async function rootOrError(): Promise<Result<string>> {
  const root = (await readAppState()).workspaceRoot
  return root ? { ok: true, value: root } : { ok: false, error: 'No workspace root is set. Open Prerequisites.' }
}

export function registerReviewHandlers(): void {
  handle(CH.reviewsList, null, async () => {
    const state = await readAppState()
    return state.workspaceRoot ? listReviews(state.workspaceRoot, state.recentReviews) : []
  })

  handle(CH.reviewsCheck, form, async (input) => {
    const root = await rootOrError()
    return root.ok ? checkReview(root.value, input) : root
  })

  handle(
    CH.reviewsCreate,
    form.extend({ title: z.string(), overwrite: z.boolean(), pick: z.string().uuid().optional() }),
    async (input): Promise<Result<{ slug: string; problems: Record<string, string> }>> => {
      const root = await rootOrError()
      if (!root.ok) return root
      const created = await createReview(root.value, input)
      if (!created.ok) return created
      // Spec files picked in the form join the review once it exists. A refused file is reported, and the review stays.
      const paths = takePick(input.pick)
      const added = paths.length > 0 ? await addSpecFiles(root.value, created.value.slug, paths) : null
      return { ok: true, value: { slug: created.value.slug, problems: added?.ok ? added.value.problems : added ? { files: added.error } : {} } }
    }
  )

  handle(CH.reviewsAddTo, form, async (input) => {
    const root = await rootOrError()
    return root.ok ? addToReview(root.value, input) : root
  })

  handle(CH.reviewsOpen, slug, async (s) => {
    const state = await readAppState()
    const recent = [{ slug: s, openedAt: new Date().toISOString() }, ...state.recentReviews.filter((r) => r.slug !== s)].slice(0, 50)
    await writeAppState({ recentReviews: recent, lastReview: s })
  })

  handle(CH.reviewsBuild, slug, async (s, event) => {
    const root = await rootOrError()
    if (!root.ok) return root
    return startBuild(root.value, s, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send(CH.reviewsBuildProgress, p)
    })
  })

  handle(CH.reviewsCancelBuild, slug, (s) => {
    cancelBuild(s)
  })

  handle(CH.reviewsRename, z.object({ slug, title: z.string().trim().min(1).max(200) }), async (input): Promise<Result<{ title: string }>> => {
    const root = await rootOrError()
    return root.ok ? renameReview(root.value, input.slug, input.title) : root
  })

  handle(CH.reviewsDeleteInfo, slug, async (s): Promise<Result<{ path: string; pending: number }>> => {
    const root = await rootOrError()
    if (!root.ok) return root
    const ok = await checkDeletable(root.value, s, isBuilding)
    return ok.ok ? { ok: true, value: { path: ok.value, pending: await pendingCommentCount(root.value, s) } } : ok
  })

  // Moves the folder to the system trash, never a permanent delete (file 07 section 5.6 rule 5).
  handle(CH.reviewsDelete, slug, async (s): Promise<Result<true>> => {
    const root = await rootOrError()
    if (!root.ok) return root
    const ok = await checkDeletable(root.value, s, isBuilding)
    if (!ok.ok) return ok
    try {
      await shell.trashItem(ok.value)
    } catch (e) {
      return { ok: false, error: `Could not move the folder to the trash: ${e instanceof Error ? e.message : String(e)}. Nothing was deleted.` }
    }
    const state = await readAppState()
    await writeAppState({
      recentReviews: state.recentReviews.filter((r) => r.slug !== s),
      lastReview: state.lastReview === s ? undefined : state.lastReview
    })
    return { ok: true, value: true }
  })
}
