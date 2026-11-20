import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { findClone, findRepoDirs, locateClone, parseRemote, scanClones } from '../src/main/services/workspace'

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
    mkdirSync(join(root, 'l1/l2/l3/l4/.git'), { recursive: true }) // four levels down is the last level that is scanned
    mkdirSync(join(root, 'm1/m2/m3/m4/m5/.git'), { recursive: true }) // five levels down is past the limit
    const found = (await findRepoDirs(root)).map((d) => relative(root, d).split(/[\\/]/).join('/'))
    expect(found).toEqual(['a', 'l1/l2/l3/l4'])
  })
  it('still scans inside the chosen folder when that folder is itself a repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:team/meta.git'], { cwd: root })
    repo(root, 'backend/api', 'git@gitlab.com:team/api.git')
    repo(root, 'tools/web/app', 'git@gitlab.com:team/app.git')
    repo(root, 'backend/api/inner', 'git@gitlab.com:team/inner.git') // a repo below the top folder is still not entered
    const clones = await scanClones(root, true)
    expect(clones.map((c) => c.name).sort()).toEqual([basename(root), 'backend/api', 'tools/web/app'].sort())
    expect(findClone(clones, { host: 'gitlab.com', project: 'team/app' })?.name).toBe('tools/web/app')
    expect(findClone(clones, { host: 'gitlab.com', project: 'team/meta' })?.dir).toBe(root)
  })
  it('finds a clone two, three and four levels down by its origin remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    repo(root, 'g/two', 'git@gitlab.com:team/two.git')
    repo(root, 'g/h/three', 'git@gitlab.com:team/three.git')
    repo(root, 'g/h/i/four', 'git@gitlab.com:team/four.git')
    repo(root, 'g/h/i/j/five', 'git@gitlab.com:team/five.git') // past the limit
    const clones = await scanClones(root, true)
    expect(clones.map((c) => c.name).sort()).toEqual(['g/h/i/four', 'g/h/three', 'g/two'])
    expect(findClone(clones, { host: 'gitlab.com', project: 'team/four' })?.name).toBe('g/h/i/four')
    expect(findClone(clones, { host: 'gitlab.com', project: 'team/five' })).toBeNull()
  })
})

describe('locateClone', () => {
  it('searches deeper than the normal scan, up to exactly eight levels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    repo(root, 'a/b/c/d/e/six', 'git@gitlab.com:team/six.git') // six levels down: past the normal scan, within the deep search
    repo(root, 'm/n/o/p/q/r/s/eight', 'git@gitlab.com:team/eight.git') // eight levels down: the last level of the deep search
    repo(root, 'p/q/r/s/t/u/v/w/nine', 'git@gitlab.com:team/nine.git') // nine levels down: past the deep search
    repo(root, 'near', 'git@gitlab.com:team/near.git')
    const clones = await scanClones(root, true)
    expect(clones.map((c) => c.name)).toEqual(['near'])
    expect((await locateClone(root, clones, { host: 'gitlab.com', project: 'team/near' }))?.name).toBe('near')
    expect((await locateClone(root, clones, { host: 'gitlab.com', project: 'team/six' }))?.name).toBe('a/b/c/d/e/six')
    expect((await locateClone(root, clones, { host: 'gitlab.com', project: 'team/eight' }))?.name).toBe('m/n/o/p/q/r/s/eight')
    expect(await locateClone(root, clones, { host: 'gitlab.com', project: 'team/nine' })).toBeNull()
    expect(await locateClone(root, clones, { host: 'gitlab.com', project: 'team/missing' })).toBeNull()
  })
  it('sees a clone made after an earlier miss only when asked for a fresh search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codediff-ws-'))
    repo(root, 'near', 'git@gitlab.com:team/near.git')
    const clones = await scanClones(root, true)
    const ref = { host: 'gitlab.com', project: 'team/late' }
    expect(await locateClone(root, clones, ref)).toBeNull() // fills the deep cache
    repo(root, 'x/y/z/a/b/late', 'git@gitlab.com:team/late.git')
    expect(await locateClone(root, clones, ref)).toBeNull() // the cached deep result is still used
    expect((await locateClone(root, clones, ref, true))?.name).toBe('x/y/z/a/b/late')
  })
})
