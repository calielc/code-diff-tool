import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { ChangeRef } from '@shared/provider'
import { run } from '../processes/run'

/**
 * The workspace is a folder that holds your repo clones. The app finds them itself: it walks the folder
 * for git repos and reads the `origin` remote of each, so no manifest file is needed.
 */
export interface Clone {
  /** Absolute folder of the clone. */
  dir: string
  /** Folder relative to the workspace root, with forward slashes. This is the repo name shown in MR keys. */
  name: string
  host: string
  /** Project path from the remote, for example "team/backend/x" or "owner/repo". */
  project: string
}

/** Read "git@host:a/b.git", "ssh://git@host/a/b.git" and "https://host/a/b(.git)" into host and project path. */
export function parseRemote(remote: string): { host: string; project: string } | null {
  const r = remote.trim()
  let m = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(r)
  if (/^https?:\/\//i.test(r)) m = /^https?:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(r)
  if (!m || !m[2] || !m[2].includes('/')) return null
  return { host: m[1].toLowerCase(), project: m[2] }
}

/** How many levels below the chosen folder the normal scan looks. */
const SCAN_DEPTH = 4
/** How many levels the second search looks, for a repo that the normal scan missed. */
const DEEP_DEPTH = 8

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'target', 'vendor', '$RECYCLE.BIN', 'System Volume Information'])

/** Walk the root, depth-limited, and return every folder that holds `.git`. The root itself is entered even when it is a repo. A repo below the root is not entered. */
export async function findRepoDirs(root: string, maxDepth = SCAN_DEPTH): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // an unreadable folder is skipped
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(dir)
      if (depth > 0) return // below the chosen folder a repo is not entered, but the chosen folder itself may hold the clones, as a repo of repos does
    }
    if (depth >= maxDepth) return
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) // never follow links, never enter hidden folders
        .map((e) => walk(join(dir, e.name), depth + 1))
    )
  }
  await walk(root, 0)
  return found.sort()
}

type Origin = { host: string; project: string } | null

/** Remotes already read, so a deeper scan only reads the folders the normal scan did not see. A fresh scan reads them again. */
const origins = new Map<string, Origin>()

/** The origin remote of a clone, or null when it has none. */
async function originOf(dir: string, fresh: boolean): Promise<Origin> {
  if (!fresh && origins.has(dir)) return origins.get(dir) ?? null
  const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 15_000 })
  const origin = r.code === 0 ? parseRemote(r.stdout.trim()) : null
  origins.set(dir, origin)
  return origin
}

const cache = new Map<string, { at: number; clones: Clone[] }>()
const TTL_MS = 30_000

/** All clones of the workspace down to `maxDepth` levels. Cached for 30 seconds, `fresh` forces a new scan. */
export async function scanClones(root: string, fresh = false, maxDepth = SCAN_DEPTH): Promise<Clone[]> {
  const key = `${root}|${maxDepth}`
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.clones
  const dirs = await findRepoDirs(root, maxDepth)
  const clones: Clone[] = []
  // Read remotes a few at a time so a big workspace does not start hundreds of processes at once.
  for (let i = 0; i < dirs.length; i += 8) {
    const batch = await Promise.all(dirs.slice(i, i + 8).map(async (dir) => ({ dir, origin: await originOf(dir, fresh) })))
    for (const { dir, origin } of batch) {
      if (origin) clones.push({ dir, name: relative(root, dir).split(/[\\/]/).join('/') || basename(root), ...origin })
    }
  }
  cache.set(key, { at: Date.now(), clones })
  return clones
}
export const resetWorkspaceCache = (): void => {
  cache.clear()
  origins.clear()
}

/** Find the clone of a change's project. The project path must match without regard to letter case. */
export function findClone(clones: Clone[], ref: Pick<ChangeRef, 'host' | 'project'>): Clone | null {
  const sameProject = clones.filter((c) => c.project.toLowerCase() === ref.project.toLowerCase())
  // Prefer a clone on the same host. Ssh remotes can use another host name, so fall back to the project alone.
  return sameProject.find((c) => c.host === ref.host.toLowerCase()) ?? sameProject[0] ?? null
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Find the clone of a change's project. When the normal scan misses it, search deeper before giving up. `fresh` also reads the deep search again. */
export async function locateClone(root: string, clones: Clone[], ref: Pick<ChangeRef, 'host' | 'project'>, fresh = false): Promise<Clone | null> {
  return findClone(clones, ref) ?? findClone(await scanClones(root, fresh, DEEP_DEPTH), ref)
}
