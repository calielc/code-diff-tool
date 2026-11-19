import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseHunkHeaders, readText, splitLines } from '../src/main/clients/git'
import { buildCombined, orderMrs, splitReason, type CombinedMr } from '../src/main/diff/combined'
import { buildFiles } from '../src/main/diff/mr-files'

let dir: string
const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
const write = (path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}
/** Commit the given files on a new branch from `from` and return the commit sha. */
function branch(name: string, from: string, files: Record<string, string | null | Buffer>, message = name): string {
  git('checkout', '-q', '-B', name, from)
  for (const [p, c] of Object.entries(files)) {
    if (c === null) rmSync(join(dir, p))
    else write(p, c)
  }
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codediff-p4-'))
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
})

const mr = (key: string, iid: number, base: string, head: string, files: CombinedMr['files'], extra: Partial<CombinedMr> = {}): CombinedMr => ({
  key,
  iid,
  base,
  head,
  mergedAt: null,
  createdAt: `2026-01-0${iid}T00:00:00Z`,
  draft: false,
  files,
  ...extra
})

describe('git reads (file 03 section 2)', () => {
  it('counts lines the way git does', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\r\nb')).toEqual(['a\r', 'b']) // a carriage return stays on its line
  })
  it('reads hunk headers', () => {
    const { deleted, added } = parseHunkHeaders('@@ -5,0 +6,2 @@\n@@ -3 +3 @@\n@@ -9,2 +11,0 @@')
    expect([...added].sort((a, b) => a - b)).toEqual([3, 6, 7])
    expect([...deleted].sort((a, b) => a - b)).toEqual([3, 9, 10])
  })
  it('detects binary, a submodule and a path with a space', async () => {
    write('a b.txt', 'one\ntwo\n')
    write('bin.dat', Buffer.from([1, 2, 0, 3]))
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const sha = 'e'.repeat(40)
    git('update-index', '--add', '--cacheinfo', `160000,${sha},sub`)
    git('commit', '-q', '-m', 'sub')
    expect(await readText(dir, 'HEAD', 'a b.txt')).toEqual({ binary: false, lines: ['one', 'two'] })
    expect((await readText(dir, 'HEAD', 'bin.dat')).binary).toBe(true)
    expect(await readText(dir, 'HEAD', 'sub')).toEqual({ binary: false, lines: [`Subproject commit ${sha}`] })
  })
})

describe('files of one change (file 03 sections 2.3 and 9)', () => {
  it('reports A, D, M and R with both paths, and numbers lines like git', async () => {
    write('mod.txt', 'a\nb\nc\n')
    write('gone.txt', 'x\n')
    write('old name.txt', 'line1\nline2\nline3\nline4\n')
    write('img.bin', Buffer.from([0, 1, 2]))
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('mv', 'old name.txt', 'new name.txt')
    const head = branch('feat', base, { 'mod.txt': 'a\nB\nc\nd\n', 'gone.txt': null, 'added.txt': 'new\n', 'img.bin': Buffer.from([0, 9, 9]) })
    const files = await buildFiles(dir, base, head, new Map())
    const by = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort()) // git's order
    expect(by['mod.txt'].status).toBe('M')
    expect(by['gone.txt'].status).toBe('D')
    expect(by['added.txt'].status).toBe('A')
    expect(by['img.bin']).toMatchObject({ binary: true, lines: null })
    expect(by['img.bin'].levels.raw.hunks).toEqual([])
    // "mod.txt": line 2 changed, line 4 added, shown with the numbers git uses
    const raw = by['mod.txt'].levels.raw.hunks[0].map((l) => `${l.t}${l.o ?? ''}/${l.n ?? ''}:${l.x}`)
    expect(raw).toEqual([' 1/1:a', '-2/:b', '+/2:B', ' 3/3:c', '+/4:d'])
    expect(by['mod.txt'].levels.raw).toMatchObject({ add: 2, del: 1 })
  })
  it('shows a rename with both paths', async () => {
    write('old name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-B', 'ren', base)
    git('mv', 'old name.txt', 'new name.txt')
    git('commit', '-q', '-m', 'rename')
    const files = await buildFiles(dir, base, git('rev-parse', 'HEAD'), new Map())
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ status: 'R', oldPath: 'old name.txt', path: 'new name.txt' })
    expect(files[0].levels.raw).toMatchObject({ add: 0, del: 0 })
  })
  it('shows a submodule change as one Subproject line', async () => {
    write('f.txt', 'x\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)
    git('commit', '-q', '-m', 'add sub')
    const base = git('rev-parse', 'HEAD')
    git('update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`)
    git('commit', '-q', '-m', 'move sub')
    const files = await buildFiles(dir, base, git('rev-parse', 'HEAD'), new Map())
    const lines = files[0].levels.raw.hunks[0].map((l) => `${l.t}${l.x}`)
    expect(lines).toEqual([`-Subproject commit ${'1'.repeat(40)}`, `+Subproject commit ${'2'.repeat(40)}`])
  })
})

describe('ordering and reasons (file 03 section 8.2 and vector C1, C3)', () => {
  it('orders merged, then open, then draft, each by time', () => {
    const m = (key: string, o: Partial<CombinedMr>): CombinedMr => ({
      key,
      iid: 0,
      base: '',
      head: '',
      mergedAt: null,
      createdAt: '',
      draft: false,
      files: [],
      ...o
    })
    const ordered = orderMrs([
      m('A', { mergedAt: '2026-01-02' }),
      m('B', { createdAt: '2026-01-01' }),
      m('C', { draft: true, createdAt: '2025-12-31' }),
      m('D', { createdAt: '2026-01-05' }),
      m('E', { mergedAt: '2026-01-01' })
    ])
    expect(ordered.map((x) => x.key)).toEqual(['E', 'A', 'B', 'D', 'C'])
  })
  it('words the split reason', () => expect(splitReason(14, [11, 12])).toBe('starts at !14, which conflicts with the part before it (!11, !12)'))
})

describe('combined view (file 03 section 8)', () => {
  async function ownFiles(base: string, head: string): Promise<CombinedMr['files']> {
    return buildFiles(dir, base, head, new Map())
  }

  it('merges changes to different files into one part and gives every line its owner (section 8.6)', async () => {
    write('f.txt', 'a\nb\nc\n')
    write('other.txt', 'o\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const h1 = branch('mr1', base, { 'f.txt': 'a\nB\nc\n' })
    const h2 = branch('mr2', base, { 'f.txt': 'a\nb\nc\nd\n' })
    const h3 = branch('mr3', base, { 'other.txt': 'o\np\n' })
    const mrs = [
      mr('r!1', 1, base, h1, await ownFiles(base, h1)),
      mr('r!2', 2, base, h2, await ownFiles(base, h2)),
      mr('r!3', 3, base, h3, await ownFiles(base, h3))
    ]
    const parts = await buildCombined(dir, 'r', mrs, new Map())
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ repo: 'r', mrs: ['r!1', 'r!2', 'r!3'], available: true, reason: null })
    const f = parts[0].files.find((x) => x.path === 'f.txt')!
    const rows = f.levels.raw.hunks[0].map(
      (l) => `${l.t}|${l.o ?? ''}|${l.n ?? ''}|${l.x}|${l.target ? `${l.target.mr}:${l.target.o ?? ''}:${l.target.n ?? ''}` : 'null'}`
    )
    expect(rows).toEqual([' |1|1|a|null', '-|2||b|r!1:2:', '+||2|B|r!1::2', ' |3|3|c|null', '+||4|d|r!2::4'])
    expect(parts[0].files.map((x) => x.path).sort()).toEqual(['f.txt', 'other.txt'])
  })

  it('splits a part when a change conflicts with the ones before it', async () => {
    write('f.txt', 'one\ntwo\nthree\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const h1 = branch('mr1', base, { 'f.txt': 'one\nTWO\nthree\n' })
    const h2 = branch('mr2', base, { 'g.txt': 'unrelated\n' })
    const h3 = branch('mr3', base, { 'f.txt': 'one\nzwei\nthree\n' }) // edits the same line as mr1
    const mrs = [
      mr('r!11', 11, base, h1, await ownFiles(base, h1), { createdAt: '2026-01-01T00:00:00Z' }),
      mr('r!12', 12, base, h2, await ownFiles(base, h2), { createdAt: '2026-01-02T00:00:00Z' }),
      mr('r!14', 14, base, h3, await ownFiles(base, h3), { createdAt: '2026-01-03T00:00:00Z' })
    ]
    const parts = await buildCombined(dir, 'r', mrs, new Map())
    expect(parts.map((p) => p.mrs)).toEqual([['r!11', 'r!12'], ['r!14']])
    expect(parts[0].reason).toBeNull()
    expect(parts[1].reason).toBe('starts at !14, which conflicts with the part before it (!11, !12)')
    // the second part is the change's own diff over its touched paths
    expect(parts[1].files.map((f) => f.path)).toEqual(['f.txt'])
  })

  it('builds no combined view for one live change', async () => {
    write('f.txt', 'x\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const h1 = branch('mr1', base, { 'f.txt': 'y\n' })
    expect(await buildCombined(dir, 'r', [mr('r!1', 1, base, h1, await ownFiles(base, h1))], new Map())).toEqual([])
  })
})
