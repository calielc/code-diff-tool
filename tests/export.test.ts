import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportCommit, extractTar, readTar } from '../src/main/services/export'

let repo: string
const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'codediff-export-'))
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false') // keep the bytes exactly as written
})

/** A minimal tar entry, to test the reader on names git would not produce. */
function tarEntry(name: string, content: string, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(type, 156)
  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  body.write(content)
  return Buffer.concat([header, body])
}

describe('the tar reader', () => {
  it('reads files, folders and long paths', () => {
    const long = 'a/'.repeat(60) + 'file.txt' // longer than the 100 characters of a name field, so git writes a pax header
    writeFileSync(join(repo, 'hello.txt'), 'hello\n')
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    writeFileSync(join(repo, 'src', 'deep', 'a b.txt'), 'spaced\n')
    mkdirSync(join(repo, ...long.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(repo, ...long.split('/')), 'long\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, maxBuffer: 1 << 24 })
    const files = Object.fromEntries([...readTar(tar)].filter((e) => e.type === '0').map((e) => [e.path, e.data.toString('utf8')]))
    expect(files['hello.txt']).toBe('hello\n')
    expect(files['src/deep/a b.txt']).toBe('spaced\n')
    expect(files[long]).toBe('long\n')
  })
})

describe('extraction guards (file 04 section 4.9)', () => {
  it('skips an entry that leaves the folder, a link and other types, and never overwrites', async () => {
    const out = mkdtempSync(join(tmpdir(), 'codediff-extract-'))
    const tar = Buffer.concat([
      tarEntry('ok.txt', 'ok'),
      tarEntry('../escape.txt', 'no'),
      tarEntry('sub/../../escape2.txt', 'no'),
      tarEntry('link', 'target', '2'), // a symbolic link
      tarEntry('dev', '', '3'),
      tarEntry('ok.txt', 'second'), // a second entry of the same name does not replace the first
      Buffer.alloc(1024)
    ])
    await extractTar(tar, out)
    expect(readdirSync(out).sort()).toEqual(['ok.txt'])
    expect(readFileSync(join(out, 'ok.txt'), 'utf8')).toBe('ok')
    expect(existsSync(join(out, '..', 'escape.txt'))).toBe(false)
  })
})

describe('exporting a commit', () => {
  it('copies the files of the commit, without .git, and reuses an existing export', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    const sha = git('rev-parse', 'HEAD')
    const target = join(mkdtempSync(join(tmpdir(), 'codediff-heads-')), sha)
    expect(await exportCommit(repo, sha, target)).toBe(target)
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(target, '.git'))).toBe(false)
    writeFileSync(join(target, 'marker.txt'), 'kept') // a reused export is returned unchanged
    await exportCommit(repo, sha, target)
    expect(existsSync(join(target, 'marker.txt'))).toBe(true)
  })
  it('never writes a symbolic link into the export, and leaves no temporary files', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n')
    git('add', '-A')
    // a link entry in the commit, made without a real link
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: '/etc/passwd', encoding: 'utf8' }).trim()
    git('update-index', '--add', '--cacheinfo', `120000,${blob},link`)
    git('commit', '-q', '-m', 'link')
    const sha = git('rev-parse', 'HEAD')
    const heads = mkdtempSync(join(tmpdir(), 'codediff-heads-'))
    const target = join(heads, sha)
    await exportCommit(repo, sha, target)
    expect(readdirSync(target).sort()).toEqual(['a.txt'])
    expect(readdirSync(heads)).toEqual([sha]) // no tar and no temporary folder left behind
    expect(lstatSync(join(target, 'a.txt')).isFile()).toBe(true)
  })
  it('reports a commit git cannot archive', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    await expect(exportCommit(repo, 'f'.repeat(40), join(tmpdir(), 'codediff-never-' + Date.now()))).rejects.toThrow()
  })
})
