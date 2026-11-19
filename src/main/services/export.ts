import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { run } from '../processes/run'

interface TarEntry {
  path: string
  type: string
  data: Buffer
}

/** Read the number of an octal tar field. */
const octal = (b: Buffer): number => parseInt(b.toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)

/** The `path` of a pax extended header (`<len> path=<value>\n` records). */
function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8')
  const m = /\d+ path=([^\n]*)\n/.exec(text)
  return m ? m[1] : null
}

/** A small tar reader. It handles ustar names with a prefix and pax path headers, which `git archive` writes. */
export function* readTar(buf: Buffer): Generator<TarEntry> {
  let pos = 0
  let pending: string | null = null
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512)
    if (h.every((x) => x === 0)) return
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = octal(h.subarray(124, 136))
    const type = String.fromCharCode(h[156] || 48) // NUL means a regular file
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const data = buf.subarray(pos + 512, pos + 512 + size)
    pos += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      pending = paxPath(data) // the path of the next entry
      continue
    }
    if (type === 'g') continue // a global header (the commit id)
    const path = pending ?? (prefix ? `${prefix}/${name}` : name)
    pending = null
    yield { path, type, data }
  }
}

/**
 * Write the tar entries under `folder`. An entry whose path leaves the folder is skipped. Only directories and regular
 * files are written, so a symbolic link never appears and Claude cannot follow one out of the export. A file is never
 * overwritten.
 */
export async function extractTar(buf: Buffer, folder: string): Promise<void> {
  const base = resolve(folder)
  for (const e of readTar(buf)) {
    const target = resolve(base, e.path)
    if (target !== base && !target.startsWith(base + sep)) continue // path traversal guard
    if (e.type === '5') await mkdir(target, { recursive: true })
    else if (e.type === '0') {
      await mkdir(dirname(target), { recursive: true })
      if (!existsSync(target)) await writeFile(target, e.data)
    }
    // every other type (links, devices) is ignored
  }
}

/**
 * A read-only export of the files of one commit: no `.git` folder and no checkout (file 04 section 4.9). When the target
 * exists it is reused. The export is made in a temporary sibling folder and moved into place, so a run that stops half way
 * leaves no partial target. If another run made the target first, that one is accepted.
 */
export async function exportCommit(clone: string, sha: string, target: string): Promise<string> {
  if (existsSync(target)) return target
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const temp = join(parent, `.${basename(target)}-${randomBytes(8).toString('hex')}`)
  const tar = `${temp}.tar`
  try {
    const r = await run('git', ['archive', '--format=tar', '-o', tar, sha], { cwd: clone })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `git archive exited with ${r.code}`)
    await mkdir(temp, { recursive: true })
    await extractTar(await readFile(tar), temp)
    try {
      await rename(temp, target)
    } catch {
      if (!existsSync(target)) throw new Error('The export could not be moved into place.')
    }
    return target
  } finally {
    await rm(tar, { force: true })
    await rm(temp, { recursive: true, force: true })
  }
}
