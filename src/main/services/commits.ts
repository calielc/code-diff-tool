import type { FileObject } from '@shared/diff'
import type { CommitInfo } from '@shared/commits'
import type { Result } from '@shared/types'
import { commitList, mergeBase, parentOf } from '../clients/git'
import { buildFiles } from '../diff/mr-files'
import { sessionOf } from './session'

const SHA_RE = /^[0-9a-f]{40}$/

/** The folder of the clone of a change, and the commits it adds: after the merge base, up to its head. */
async function rangeOf(slug: string, mrKey: string): Promise<Result<{ dir: string; base: string; head: string }>> {
  const s = sessionOf(slug)
  const mr = s?.result.mrs.find((m) => m.key === mrKey)
  const clone = s?.cloneOf.get(mrKey)
  if (!s || !mr || !clone) return { ok: false, error: 'This change has no local clone, so its commits cannot be read.' }
  const { base, head } = mr.snapshot.info.diffRefs
  try {
    return { ok: true, value: { dir: clone.dir, base: (await mergeBase(clone.dir, base, head)) ?? base, head } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The commits of a change that touch a file, oldest first. */
export async function commitsOfFile(slug: string, mrKey: string, path: string, oldPath: string): Promise<Result<CommitInfo[]>> {
  const range = await rangeOf(slug, mrKey)
  if (!range.ok) return range
  try {
    const rows = await commitList(range.value.dir, range.value.base, range.value.head, [...new Set([path, oldPath])])
    return { ok: true, value: rows.map((r) => ({ ...r, short: r.sha.slice(0, 7) })) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** One file as one commit changed it: the diff of the commit against its first parent, with the three levels. */
export async function fileAtCommit(slug: string, mrKey: string, sha: string, path: string, oldPath: string): Promise<Result<FileObject>> {
  if (!SHA_RE.test(sha)) return { ok: false, error: 'Not a commit id.' }
  const range = await rangeOf(slug, mrKey)
  if (!range.ok) return range
  try {
    // Only a commit of this change can be read
    const all = await commitList(range.value.dir, range.value.base, range.value.head)
    if (!all.some((c) => c.sha === sha)) return { ok: false, error: 'That commit is not part of this change.' }
    const parent = await parentOf(range.value.dir, sha)
    if (!parent) return { ok: false, error: 'That is the first commit of the repo, so it has no parent to compare with.' }
    const files = await buildFiles(range.value.dir, parent, sha, new Map(), undefined, new Set([path, oldPath]))
    const file = files.find((f) => f.path === path || f.oldPath === oldPath || f.path === oldPath)
    return file ? { ok: true, value: file } : { ok: false, error: 'That commit does not change this file.' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
