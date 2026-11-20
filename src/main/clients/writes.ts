import { draftTitle, fallbackBody, fileCommentBody, type PendingComment, type SubmitInput } from '@shared/comments'
import type { ChangeRef } from '@shared/provider'
import { forgeApi, forgePaged, githubAt, gitlabAt } from './forge-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any> // forge answers are read field by field

const enc = (p: string): string => encodeURIComponent(p)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Post one comment. A position the forge cannot place becomes a plain discussion, so a comment is never lost (file 03 section 10.2). */
export async function postComment(ref: ChangeRef, c: PendingComment): Promise<void> {
  const noLine = c.oldLine === null && c.newLine === null
  const line = c.newLine ?? c.oldLine
  if (ref.provider === 'gitlab') {
    const ep = `projects/${enc(ref.project)}/merge_requests/${ref.iid}/discussions`
    if (noLine) {
      await forgeApi(gitlabAt(ref), ep, 'POST', { body: { body: fileCommentBody(c.path, c.body) } })
      return
    }
    const position = {
      position_type: 'text',
      base_sha: c.diffRefs.base,
      start_sha: c.diffRefs.start,
      head_sha: c.diffRefs.head,
      old_path: c.oldPath,
      new_path: c.path,
      old_line: c.oldLine,
      new_line: c.newLine
    }
    try {
      await forgeApi(gitlabAt(ref), ep, 'POST', { body: { body: c.body, position } })
    } catch (e) {
      if (!/HTTP 400/.test(msg(e))) throw e // any other error goes back to the caller
      await forgeApi(gitlabAt(ref), ep, 'POST', { body: { body: fallbackBody(c.path, line, c.body) } })
    }
    return
  }
  // GitHub: a line comment names the commit, the path, the line and the side. Comments without a line are issue comments.
  const issue = `repos/${ref.project}/issues/${ref.iid}/comments`
  if (noLine) {
    await forgeApi(githubAt(ref), issue, 'POST', { body: { body: fileCommentBody(c.path, c.body) } })
    return
  }
  const side = c.newLine !== null ? 'RIGHT' : 'LEFT'
  const path = side === 'RIGHT' ? c.path : (c.oldPath ?? c.path)
  try {
    await forgeApi(githubAt(ref), `repos/${ref.project}/pulls/${ref.iid}/comments`, 'POST', {
      body: { body: c.body, commit_id: c.diffRefs.head, path, line, side }
    })
  } catch (e) {
    if (!/HTTP 422/.test(msg(e))) throw e
    await forgeApi(githubAt(ref), issue, 'POST', { body: { body: fallbackBody(c.path, line, c.body) } })
  }
}

/** Delete one note. The forge refuses a note of someone else and its text goes back to the user. */
export async function deleteNote(ref: ChangeRef, noteId: number): Promise<void> {
  if (!Number.isInteger(noteId) || noteId <= 0) throw new Error('The note id must be a positive number.')
  if (ref.provider === 'gitlab') await forgeApi(gitlabAt(ref), `projects/${enc(ref.project)}/merge_requests/${ref.iid}/notes/${noteId}`, 'DELETE')
  else await forgeApi(githubAt(ref), `repos/${ref.project}/pulls/comments/${noteId}`, 'DELETE')
}

const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}'
const UNRESOLVE = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}'

/** Resolve or reopen a thread. */
export async function resolveThread(ref: ChangeRef, threadId: string, resolved: boolean): Promise<void> {
  if (ref.provider === 'gitlab') {
    await forgeApi(gitlabAt(ref), `projects/${enc(ref.project)}/merge_requests/${ref.iid}/discussions/${threadId}`, 'PUT', { body: { resolved } })
  } else {
    await forgeApi(githubAt(ref), 'graphql', 'POST', { fields: { query: resolved ? RESOLVE : UNRESOLVE, id: threadId } })
  }
}

/** The error text of a step that failed after earlier steps had worked (file 03 section 10.3). */
class StepError extends Error {}

async function submitGitLab(
  ref: ChangeRef,
  o: { approve: boolean; unapprove: boolean; changes: boolean; summary: string; ready: boolean; draft: boolean }
): Promise<void> {
  const base = `projects/${enc(ref.project)}/merge_requests/${ref.iid}`
  if (o.changes && !o.summary) throw new StepError('requesting changes needs an overall comment.')
  let stage: 'none' | 'drafted' | 'published' = 'none'
  try {
    if (o.summary) {
      const drafts = await forgePaged(gitlabAt(ref), `${base}/draft_notes`)
      if (drafts.length > 0) {
        throw new StepError('you already have draft notes on this MR in GitLab, and publishing would post them too. Submit or delete them in GitLab first.')
      }
      await forgeApi(gitlabAt(ref), `${base}/draft_notes`, 'POST', { body: { note: o.summary } })
      stage = 'drafted'
      // GitLab records "request changes" only as the state of a published review.
      await forgeApi(gitlabAt(ref), `${base}/draft_notes/bulk_publish`, 'POST', o.changes ? { body: { reviewer_state: 'requested_changes' } } : {})
      stage = 'published'
    }
    if (o.approve) await forgeApi(gitlabAt(ref), `${base}/approve`, 'POST', { body: {} })
    if (o.unapprove) await forgeApi(gitlabAt(ref), `${base}/unapprove`, 'POST')
    if (o.ready || o.draft) {
      const current = (await forgeApi(gitlabAt(ref), base, 'GET')) as J // the title as it is now, so a rename since the page loaded stays
      await forgeApi(gitlabAt(ref), base, 'PUT', { body: { title: draftTitle(String(current.title ?? ''), !o.ready) } })
    }
  } catch (e) {
    if (e instanceof StepError) throw e
    if (stage === 'published') throw new StepError(`The overall comment went out, then: ${msg(e)}`)
    if (stage === 'drafted') throw new StepError(`${msg(e)} The overall comment stays in GitLab as your pending review.`)
    throw e
  }
}

const READY = 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}'
const TO_DRAFT = 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id}}}'

async function submitGitHub(
  ref: ChangeRef,
  o: { approve: boolean; unapprove: boolean; changes: boolean; summary: string; ready: boolean; draft: boolean }
): Promise<void> {
  const base = `repos/${ref.project}/pulls/${ref.iid}`
  if (o.changes && !o.summary) throw new StepError('requesting changes needs an overall comment.')
  // GitHub has one review call: the text and the verdict go together.
  if (o.summary || o.approve) {
    const event = o.changes ? 'REQUEST_CHANGES' : o.approve ? 'APPROVE' : 'COMMENT'
    await forgeApi(githubAt(ref), `${base}/reviews`, 'POST', { body: o.summary ? { event, body: o.summary } : { event } })
  }
  if (o.unapprove) {
    // GitHub has no revoke. The only way to withdraw an approval is to dismiss it.
    const viewer = String(((await forgeApi(githubAt(ref), 'user', 'GET')) as J).login)
    const mine = (await forgePaged<J>(githubAt(ref), `${base}/reviews`)).filter((r) => r.user?.login === viewer && r.state === 'APPROVED').pop()
    if (mine) await forgeApi(githubAt(ref), `${base}/reviews/${mine.id}/dismissals`, 'PUT', { body: { message: 'Approval withdrawn' } })
  }
  if (o.ready || o.draft) {
    const id = String(((await forgeApi(githubAt(ref), base, 'GET')) as J).node_id)
    await forgeApi(githubAt(ref), 'graphql', 'POST', { fields: { query: o.ready ? READY : TO_DRAFT, id } })
  }
}

/**
 * Submit one review: each MR on its own, in order, and a failure never stops the others.
 * Returns a map from MR key to its error text. Only failed MRs are in it.
 */
export async function submitReview(input: SubmitInput, refs: Map<string, ChangeRef>): Promise<Record<string, string>> {
  // The MRs to process: approve, unapprove, requestChanges, the keys of summaries, ready and draft, without duplicates.
  const keys = [...new Set([...input.approve, ...input.unapprove, ...input.requestChanges, ...Object.keys(input.summaries), ...input.ready, ...input.draft])]
  const errors: Record<string, string> = {}
  for (const key of keys) {
    const ref = refs.get(key)
    if (!ref) continue
    const opts = {
      approve: input.approve.includes(key),
      unapprove: input.unapprove.includes(key),
      changes: input.requestChanges.includes(key),
      summary: (input.summaries[key] ?? '').trim(),
      ready: input.ready.includes(key),
      draft: input.draft.includes(key)
    }
    try {
      await (ref.provider === 'gitlab' ? submitGitLab(ref, opts) : submitGitHub(ref, opts))
    } catch (e) {
      errors[key] = msg(e)
    }
  }
  return errors
}
