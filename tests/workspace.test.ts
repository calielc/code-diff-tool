import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { findClone, findRepoDirs, parseRemote, scanClones } from '../src/main/services/workspace'

describe('parseRemote', () => {
  it.each([
    ['git@gitlab.com:team/backend/x.git', 'gitlab.com', 'team/backend/x'],
    ['ssh://git@gitlab.com:2222/team/x.git', 'gitlab.com', 'team/x'],
    ['https://gitlab.com/team/backend/x.git', 'gitlab.com', 'team/backend/x'],
    ['https://user:tok@github.com/o/r', 'github.com', 'o/r'],
    ['git@github.com:o/r.git', 'github.com', 'o/r']
  ])('reads %s', (remote, host, project) => {
    expect(parseRemote(remote)).toEqual({ host, project })
  })
  it('refuses a local path', () => {
    expect(parseRemote(String.raw`C:\repos\x`)).toBeNull()
    expect(parseRemote('')).toBeNull()
  })
})

function repo(root: string, rel: string, remote?: string): void {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
}

describe('workspace scan', () => {
  it('finds clones by their origin remote, nested and case-insensitively', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    repo(root, 'backend/x', 'git@gitlab.com:Team/backend/x.git')
    repo(root, 'tool', 'https://github.com/o/tool.git')
    repo(root, 'noremote') // a repo with no origin is ignored
    mkdirSync(join(root, 'node_modules/dep/.git'), { recursive: true }) // never entered
    const clones = await scanClones(root, true)
    expect(clones.map((c) => c.name).sort()).toEqual(['backend/x', 'tool'])
    expect(findClone(clones, { host: 'gitlab.com', project: 'team/backend/X' })?.name).toBe('backend/x')
    expect(findClone(clones, { host: 'github.com', project: 'o/tool' })?.name).toBe('tool')
    expect(findClone(clones, { host: 'github.com', project: 'o/other' })).toBeNull()
  })
  it('does not enter a repo and respects the depth limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    repo(root, 'a', 'git@h:o/a.git')
    mkdirSync(join(root, 'a/inner/.git'), { recursive: true })
    mkdirSync(join(root, 'l1/l2/l3/l4/.git'), { recursive: true }) // four levels down is past the limit
    const found = (await findRepoDirs(root)).map((d) => relative(root, d))
    expect(found).toEqual(['a'])
  })
})
