import { z } from 'zod'
import { CH } from '@shared/channels'
import { COMMENT_ID_RE, type PendingComment, type SubmitInput, type ThreadsAnswer } from '@shared/comments'
import { isValidThreadId } from '@shared/provider'
import { SLUG_RE } from '@shared/review'
import type { Result } from '@shared/types'
import { deleteNote, postComment, resolveThread, submitReview } from '../clients/writes'
import { readThreads } from '../clients/forge'
import { readAppState } from '../services/app-state'
import { pendingSchema, readComments, removeComment, saveComment } from '../services/comments'
import { reviewMrs, type ReviewMr } from '../services/review-context'
import { startWatch, stopWatch } from '../services/watcher'
import { handle } from './guard'

const slug = z.string().regex(SLUG_RE)

async function context(slugName: string): Promise<Result<{ root: string; mrs: Map<string, ReviewMr> }>> {
  const root = (await readAppState()).workspaceRoot
  if (!root) return { ok: false, error: 'No workspace root is set. Open Prerequisites.' }
  const mrs = await reviewMrs(root, slugName)
  return mrs.ok ? { ok: true, value: { root, mrs: mrs.value } } : mrs
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Read the threads back after a write. A failed read-back returns an empty answer and the window says to refresh. */
async function readBack(m: ReviewMr): Promise<ThreadsAnswer> {
  try {
    return { ...(await readThreads(m.ref)), readBack: true }
  } catch {
    return { threads: [], people: {}, readBack: false }
  }
}

export function registerCommentHandlers(): void {
  handle(CH.commentsList, slug, async (s) => {
    const c = await context(s)
    return c.ok ? readComments(c.value.root, s) : {}
  })

  handle(CH.commentsSave, z.object({ slug, comment: pendingSchema }), async ({ slug: s, comment }): Promise<Result<true>> => {
    const c = await context(s)
    if (!c.ok) return c
    if (!c.value.mrs.has(comment.mr)) return { ok: false, error: `Not a change request of this review: ${comment.mr}.` }
    await saveComment(c.value.root, s, comment as PendingComment)
    return { ok: true, value: true }
  })

  handle(CH.commentsRemove, z.object({ slug, id: z.string().regex(COMMENT_ID_RE) }), async ({ slug: s, id }): Promise<Result<true>> => {
    const c = await context(s)
    if (!c.ok) return c
    await removeComment(c.value.root, s, id)
    return { ok: true, value: true }
  })

  /** Post one comment. A draft is removed after the first successful post, so a double click posts once (file 02 section 7). */
  handle(
    CH.commentsPost,
    z.object({ slug, comment: pendingSchema, draft: z.boolean() }),
    async ({ slug: s, comment, draft }): Promise<Result<ThreadsAnswer>> => {
      const c = await context(s)
      if (!c.ok) return c
      const m = c.value.mrs.get(comment.mr)
      if (!m) return { ok: false, error: `Not a change request of this review: ${comment.mr}.` }
      try {
        await postComment(m.ref, comment as PendingComment)
      } catch (e) {
        return { ok: false, error: msg(e) } // any other error: the draft stays
      }
      // The post worked. A later failure must never make the window post the same comment twice.
      if (draft) await removeComment(c.value.root, s, comment.id).catch(() => undefined)
      return { ok: true, value: await readBack(m) }
    }
  )

  handle(
    CH.notesDelete,
    z.object({ slug, mr: z.string(), noteId: z.number().int().positive() }),
    async ({ slug: s, mr, noteId }): Promise<Result<ThreadsAnswer>> => {
      const c = await context(s)
      if (!c.ok) return c
      const m = c.value.mrs.get(mr)
      if (!m) return { ok: false, error: `Not a change request of this review: ${mr}.` }
      try {
        await deleteNote(m.ref, noteId)
      } catch (e) {
        return { ok: false, error: msg(e) }
      }
      return { ok: true, value: await readBack(m) }
    }
  )

  handle(CH.threadsRead, z.object({ slug, mr: z.string() }), async ({ slug: s, mr }): Promise<Result<ThreadsAnswer>> => {
    const c = await context(s)
    if (!c.ok) return c
    const m = c.value.mrs.get(mr)
    if (!m) return { ok: false, error: `Not a change request of this review: ${mr}.` }
    return { ok: true, value: await readBack(m) }
  })

  handle(
    CH.threadsResolve,
    z.object({ slug, mr: z.string(), thread: z.string().max(300), resolved: z.boolean() }),
    async ({ slug: s, mr, thread, resolved }): Promise<Result<true>> => {
      const c = await context(s)
      if (!c.ok) return c
      const m = c.value.mrs.get(mr)
      if (!m) return { ok: false, error: `Not a change request of this review: ${mr}.` }
      if (!isValidThreadId(m.ref.provider, thread)) return { ok: false, error: 'This is not a thread id.' }
      try {
        await resolveThread(m.ref, thread, resolved)
        return { ok: true, value: true }
      } catch (e) {
        return { ok: false, error: msg(e) }
      }
    }
  )

  const lists = z.array(z.string().max(500)).max(100)
  handle(
    CH.reviewSubmit,
    z.object({
      slug,
      approve: lists,
      unapprove: lists,
      requestChanges: lists,
      summaries: z.record(z.string(), z.string().max(65_536)),
      ready: lists,
      draft: lists,
      reopen: lists.optional()
    }),
    async (input: SubmitInput): Promise<Result<Record<string, string>>> => {
      const c = await context(input.slug)
      if (!c.ok) return c
      const named = [
        ...new Set([
          ...input.approve,
          ...input.unapprove,
          ...input.requestChanges,
          ...Object.keys(input.summaries),
          ...input.ready,
          ...input.draft,
          ...(input.reopen ?? [])
        ])
      ]
      const unknown = named.filter((k) => !c.value.mrs.has(k))
      // One bad key refuses the whole submission before anything posts.
      if (unknown.length > 0) return { ok: false, error: `Not a change request of this review: ${unknown.join(', ')}.` }
      const refs = new Map([...c.value.mrs].map(([k, v]) => [k, v.ref]))
      return { ok: true, value: await submitReview(input, refs) }
    }
  )

  handle(CH.watchStart, z.object({ slug, heads: z.record(z.string(), z.string()) }), async ({ slug: s, heads }, event) => {
    const c = await context(s)
    if (!c.ok) return
    await startWatch(c.value.root, s, heads, (e) => {
      if (!event.sender.isDestroyed()) event.sender.send(CH.watchEvent, { slug: s, event: e })
    })
  })
  handle(CH.watchStop, slug, (s) => stopWatch(s))
}
