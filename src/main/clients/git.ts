import { errorText, run, timeoutMessage, DEFAULT_TIMEOUT_MS } from '../processes/run'

export class GitError extends Error {}

export const MAX_BLOB_BYTES = 50 * 1024 * 1024

const SHA_RE = /^[0-9a-f]{40}$/

/** Run git in a repo folder. Output is trimmed text. A non-zero exit is an error unless `allowFail`. */
async function git(cwd: string, args: string[], allowFail = false): Promise<{ code: number; stdout: string }> {
  const r = await run('git', args, { cwd })
  if (r.canceled) throw new GitError('Canceled.')
  if (r.timedOut) throw new GitError(timeoutMessage(`git ${args.join(' ')}`, DEFAULT_TIMEOUT_MS))
  if (r.launchError) throw new GitError(`'git' could not start: ${r.launchError}`)
  if (r.tooLarge) throw new GitError('The answer was larger than 64 MB.')
  if (r.code !== 0 && !allowFail) throw new GitError(`git ${args[0]} failed: ${errorText(r)}`)
  return { code: r.code ?? -1, stdout: r.stdout.trim() }
}

const assertSha = (sha: string): void => {
  if (!SHA_RE.test(sha)) throw new GitError(`Not a commit id: ${sha}`)
}

/** `git cat-file -e <sha>^{commit}` */
export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  assertSha(sha)
  return (await git(cwd, ['cat-file', '-e', `${sha}^{commit}`], true)).code === 0
}

/** `git merge-base --is-ancestor <a> <b>` */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  assertSha(a)
  assertSha(b)
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b], true)).code === 0
}

/** `git merge-base <a> <b>`, used for GitHub where the API has no merge base. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  assertSha(a)
  assertSha(b)
  const r = await git(cwd, ['merge-base', a, b], true)
  return r.code === 0 && SHA_RE.test(r.stdout) ? r.stdout : null
}

/**
 * Fetch change heads and target branches. The commits go into the object store only, no ref is written.
 * GitLab publishes refs/merge-requests/<iid>/head, GitHub publishes refs/pull/<n>/head.
 */
export async function fetchHeads(cwd: string, provider: 'gitlab' | 'github', iids: number[], targetBranches: string[]): Promise<void> {
  const refs = iids.map((n) => (provider === 'gitlab' ? `refs/merge-requests/${n}/head` : `refs/pull/${n}/head`))
  await git(cwd, ['fetch', '--quiet', '--no-recurse-submodules', 'origin', ...refs, ...targetBranches])
}

export interface NameStatus {
  status: string
  path: string
  oldPath: string | null
}

/** Parse `git diff -M --name-status -z` output. Renames and copies carry two paths. */
export function parseNameStatus(raw: string): NameStatus[] {
  const parts = raw.split('\0').filter((p, i, a) => p !== '' || i < a.length - 1)
  const out: NameStatus[] = []
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]
    if (!status) break
    if (status[0] === 'R' || status[0] === 'C') {
      out.push({ status, oldPath: parts[i++] ?? null, path: parts[i++] ?? '' })
    } else {
      out.push({ status, oldPath: null, path: parts[i++] ?? '' })
    }
  }
  return out
}

export interface CommitRow {
  sha: string
  author: string
  date: string
  subject: string
}

/** The commits after `base` up to `head`, oldest first, optionally only those that touch one of the paths. */
export async function commitList(cwd: string, base: string, head: string, paths: string[] = []): Promise<CommitRow[]> {
  assertSha(base)
  assertSha(head)
  const args = ['log', '--reverse', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', `${base}..${head}`]
  if (paths.length > 0) args.push('--', ...paths)
  const r = await git(cwd, args)
  return r.stdout
    .split('\x1e')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split('\x1f')
      return { sha, author, date, subject: subject ?? '' }
    })
}

/** The first parent of a commit, or null for a root commit. */
export async function parentOf(cwd: string, sha: string): Promise<string | null> {
  assertSha(sha)
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^1`], true)
  return r.code === 0 && SHA_RE.test(r.stdout) ? r.stdout : null
}

/** Changed files between two commits. */
export async function changedFiles(cwd: string, base: string, head: string): Promise<NameStatus[]> {
  assertSha(base)
  assertSha(head)
  const r = await run('git', ['diff', '-M', '--name-status', '-z', base, head], { cwd })
  if (r.code !== 0) throw new GitError(`git diff failed: ${errorText(r)}`)
  return parseNameStatus(r.stdout)
}

/** Read a file at a commit as raw bytes. Refuses a blob over 50 MB (file 05 section 5.4). */
export async function readBlob(cwd: string, revision: string, path: string): Promise<{ bytes: Buffer } | { tooLarge: string }> {
  const size = await git(cwd, ['cat-file', '-s', `${revision}:${path}`], true)
  if (size.code === 0 && Number(size.stdout) > MAX_BLOB_BYTES) {
    return { tooLarge: `${path} is larger than 50 MB and is shown as a binary file.` }
  }
  const r = await run('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd, maxOutputBytes: MAX_BLOB_BYTES })
  if (r.tooLarge) return { tooLarge: `${path} is larger than 50 MB and is shown as a binary file.` }
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${errorText(r)}`)
  return { bytes: r.stdoutBytes } // raw, never trimmed
}

/** `git ls-tree <revision> -- <path>`, used to find a submodule entry. */
export async function treeEntry(cwd: string, revision: string, path: string): Promise<string | null> {
  const r = await git(cwd, ['ls-tree', revision, '--', path])
  return r.stdout || null
}

export interface TextRead {
  binary: boolean
  /** Split on \n only, a trailing empty piece removed (file 03 section 2.4). */
  lines: string[]
}

export type BlobCache = Map<string, Promise<TextRead>>

/** Split text on \n. A final empty piece is dropped, so "a\nb\n" and "a\nb" both have 2 lines and "" has 0. */
export function splitLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Read a file at a revision. Binary when a NUL byte is in the first 8000 bytes. A submodule is one line (file 03 section 2.4). */
export function readText(cwd: string, revision: string, path: string, cache: BlobCache = new Map()): Promise<TextRead> {
  const key = `${revision}\0${path}`
  let hit = cache.get(key)
  if (!hit) {
    hit = (async () => {
      const entry = await git(cwd, ['ls-tree', revision, '--', path], true)
      const [header] = entry.stdout.split('\t')
      const [mode, , object] = (header ?? '').split(' ')
      if (mode === '160000') return { binary: false, lines: [`Subproject commit ${object}`] }
      const blob = await readBlob(cwd, revision, path)
      if ('tooLarge' in blob) return { binary: true, lines: [] }
      const head = blob.bytes.subarray(0, 8000)
      if (head.includes(0)) return { binary: true, lines: [] }
      return { binary: false, lines: splitLines(blob.bytes.toString('utf8')) }
    })()
    cache.set(key, hit)
  }
  return hit
}

export interface ChangedSets {
  deleted: Set<number>
  added: Set<number>
}

/** Read the hunk headers of `git diff -U0` into the deleted and added line numbers (file 03 section 2.5). */
export function parseHunkHeaders(output: string): ChangedSets {
  const deleted = new Set<number>()
  const added = new Set<number>()
  for (const m of output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1])
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const newStart = Number(m[3])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    for (let i = 0; i < oldCount; i++) deleted.add(oldStart + i)
    for (let i = 0; i < newCount; i++) added.add(newStart + i)
  }
  return { deleted, added }
}

/** git's own changed line numbers. The algorithm flag stops a local diff.algorithm setting from moving lines. */
export async function changedLines(cwd: string, base: string, head: string, oldPath: string, path: string): Promise<ChangedSets> {
  assertSha(base)
  assertSha(head)
  const paths = oldPath === path ? [path] : [oldPath, path]
  const r = await git(
    cwd,
    ['diff', '--no-color', '--no-ext-diff', '--diff-algorithm=default', '--indent-heuristic', '-M', '-U0', base, head, '--', ...paths],
    true
  )
  return parseHunkHeaders(r.stdout)
}

/**
 * Merge in memory (file 03 section 2.6). Returns the new commit sha, or null on a conflict.
 * The commit has no ref and exists only as an object.
 */
export async function mergeCommit(cwd: string, current: string, head: string, mergeBase: string): Promise<string | null> {
  for (const s of [current, head, mergeBase]) assertSha(s)
  const r = await run('git', ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, current, head], { cwd })
  if (r.canceled) throw new GitError('Canceled.')
  if (r.code === 1) return null // a conflict
  if (r.code !== 0) throw new GitError(`git merge-tree failed in ${cwd} (exit code ${r.code}): ${r.stderr.trim()}`)
  const tree = r.stdout.split('\n')[0].trim()
  const c = await git(cwd, ['commit-tree', tree, '-p', current, '-p', head, '-m', 'combined'])
  return c.stdout
}
