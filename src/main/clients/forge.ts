import { parseChangeUrl, type Approvals, type ChangeInfo, type ChangeRef, type ChangeSnapshot, type Person, type Thread } from '@shared/provider'
import type { Result } from '@shared/types'
import { currentUser as gitlabUser, readMr, readMrApprovals, readMrInfo, readMrThreads } from './gitlab'
import { currentUser as githubUser, readPull, readPullApprovals, readPullInfo, readPullThreads } from './github'

/** The provider is chosen by the ref: github.com is GitHub, other hosts are GitLab. */
export const readInfo = (ref: ChangeRef): Promise<ChangeInfo> => (ref.provider === 'gitlab' ? readMrInfo(ref) : readPullInfo(ref))
export const readSnapshot = (ref: ChangeRef): Promise<ChangeSnapshot> => (ref.provider === 'gitlab' ? readMr(ref) : readPull(ref))
export const viewerOf = (ref: Pick<ChangeRef, 'provider' | 'host'>): Promise<string> =>
  ref.provider === 'gitlab' ? gitlabUser(ref.host) : githubUser(ref.host)

/** Read one change by URL, for the developer screen. */
export async function readChangeByUrl(url: string): Promise<Result<ChangeSnapshot>> {
  const ref = parseChangeUrl(url)
  if (!ref) return { ok: false, error: 'This is not a change request URL.' }
  try {
    return { ok: true, value: await readSnapshot(ref) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const readThreads = (ref: ChangeRef): Promise<{ threads: Thread[]; people: Record<string, Person> }> =>
  ref.provider === 'gitlab' ? readMrThreads(ref) : readPullThreads(ref)
export const readApprovals = (ref: ChangeRef): Promise<{ approvals: Approvals; people: Record<string, Person> }> =>
  ref.provider === 'gitlab' ? readMrApprovals(ref) : readPullApprovals(ref)
