import type { UrlSubmitInput } from '@shared/comments'
import { parseChangeUrl, type ChangeRef } from '@shared/provider'
import type { Result } from '@shared/types'

export interface SubmitByUrlDeps {
  /** The write path of the review. It gets a ref for every url the request names. */
  submit(input: UrlSubmitInput, refs: Map<string, ChangeRef>): Promise<Record<string, string>>
  hasAccess(ref: ChangeRef): boolean
  /** Forgets the kept snapshots of these urls. */
  dropSnapshots(urls: string[]): void
}

/**
 * The actions of a review for changes named by url. Every url must be a change on a host with saved access, or nothing is written.
 * After the write the snapshots of every named url are dropped, also when some writes failed, because the forge may have changed.
 */
export async function submitByUrls(deps: SubmitByUrlDeps, input: UrlSubmitInput): Promise<Result<Record<string, string>>> {
  const urls = [
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
  const refs = new Map<string, ChangeRef>()
  const bad: string[] = []
  for (const url of urls) {
    const ref = parseChangeUrl(url)
    if (ref) refs.set(url, ref)
    else bad.push(url)
  }
  if (bad.length > 0) return { ok: false, error: `Not a change request url: ${bad.join(', ')}.` }
  const noAccess = [...new Set([...refs.values()].filter((ref) => !deps.hasAccess(ref)).map((ref) => ref.host))]
  if (noAccess.length > 0) return { ok: false, error: noAccess.map((host) => `No access is saved for ${host}.`).join(' ') }
  if (urls.length === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: await deps.submit(input, refs) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    deps.dropSnapshots(urls)
  }
}
