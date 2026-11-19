import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
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

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'target', 'vendor', '$RECYCLE.BIN', 'System Volume Information'])

/** Walk the root, depth-limited, and return every folder that holds `.git`. A repo is not entered. */
export async function findRepoDirs(root: string, maxDepth = 3): Promise<string[]> {
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
      return
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

/** The origin remote of a clone, or null when it has none. */
async function originOf(dir: string): Promise<{ host: string; project: string } | null> {
  const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 15_000 })
  return r.code === 0 ? parseRemote(r.stdout.trim()) : null
}

let cache: { root: string; at: number; clones: Clone[] } | null = null
const TTL_MS = 30_000

/** All clones of the workspace. Cached for 30 seconds, `fresh` forces a new scan. */
export async function scanClones(root: string, fresh = false): Promise<Clone[]> {
  if (!fresh && cache && cache.root === root && Date.now() - cache.at < TTL_MS) return cache.clones
  const dirs = await findRepoDirs(root)
  const clones: Clone[] = []
  // Read remotes a few at a time so a big workspace does not start hundreds of processes at once.
  for (let i = 0; i < dirs.length; i += 8) {
    const batch = await Promise.all(dirs.slice(i, i + 8).map(async (dir) => ({ dir, origin: await originOf(dir) })))
    for (const { dir, origin } of batch) {
      if (origin) clones.push({ dir, name: relative(root, dir).split(/[\\/]/).join('/'), ...origin })
    }
  }
  cache = { root, at: Date.now(), clones }
  return clones
}
export const resetWorkspaceCache = (): void => {
  cache = null
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
