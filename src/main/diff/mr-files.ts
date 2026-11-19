import type { FileObject, FileStatus, LineTarget } from '@shared/diff'
import { changedFiles, changedLines, readText, type BlobCache, type TextRead } from '../clients/git'
import { buildFile, detectRenames } from './file-diff'
import type { LineObj } from '@shared/diff'
import type { LevelName } from '@shared/diff'

/** Run `fn` over `items` with at most `limit` running at once. The result keeps the order of the items. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

const statusOf = (letter: string): FileStatus => {
  const c = letter[0]
  if (c === 'A' || c === 'D') return c
  return c === 'R' || c === 'C' ? 'R' : 'M' // a type change or any unknown status becomes M, a copy becomes R
}

export type Resolver = (file: {
  path: string
  oldPath: string
  old: TextRead | null
  new: TextRead | null
}) => Promise<(l: LineObj, level: LevelName) => LineTarget | null>

/**
 * The files of a diff between two commits, with their three levels (file 03 section 3.5 and 9).
 * Every file git reports is included, in git's order.
 */
export async function buildFiles(dir: string, base: string, head: string, cache: BlobCache, resolver?: Resolver, only?: Set<string>): Promise<FileObject[]> {
  let names = await changedFiles(dir, base, head)
  if (only) names = names.filter((n) => only.has(n.path) || (n.oldPath !== null && only.has(n.oldPath)))
  const items = names.map((n) => ({ path: n.path, oldPath: n.oldPath ?? n.path, status: statusOf(n.status) }))

  // Read every text first, because a namespace rename is detected across all changed files.
  const texts = await mapLimit(items, 8, async (f) => ({
    old: f.status === 'A' ? null : await readText(dir, base, f.oldPath, cache),
    new: f.status === 'D' ? null : await readText(dir, head, f.path, cache)
  }))
  const renames = detectRenames(
    items.map((f, i) => ({
      path: f.path,
      oldText: texts[i].old && !texts[i].old!.binary ? texts[i].old!.lines.join('\n') : null,
      newText: texts[i].new && !texts[i].new!.binary ? texts[i].new!.lines.join('\n') : null
    }))
  )

  return mapLimit(items, 8, async (f, i) => {
    const { old, new: nw } = texts[i]
    const changed = await changedLines(dir, base, head, f.oldPath, f.path)
    const resolve = resolver ? await resolver({ path: f.path, oldPath: f.oldPath, old, new: nw }) : undefined
    return buildFile({ ...f, old, new: nw, changed }, renames, resolve)
  })
}
