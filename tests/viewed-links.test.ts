import { describe, expect, it } from 'vitest'
import { linkedViewedIds } from '../src/shared/viewed-links'

const parts = [
  { id: 'x~1', mrs: ['x!1', 'x!2', 'x!3'] },
  { id: 'x~2', mrs: ['x!9'] }
]
const stacked = (path: string, partMrs: string[], n = 1) => ({ id: `cb:x~${n}|${path}`, mrKey: null, partMrs, path })
const single = (mr: string, path: string) => ({ id: `mr:${mr}|${path}`, mrKey: mr, partMrs: [], path })

describe('linkedViewedIds', () => {
  it('marks a stacked file and the same path in every MR of its part', () => {
    expect(linkedViewedIds(stacked('a.ts', ['x!1', 'x!2', 'x!3']), true, parts).sort()).toEqual(
      ['cb:x~1|a.ts', 'mr:x!1|a.ts', 'mr:x!2|a.ts', 'mr:x!3|a.ts'].sort()
    )
  })

  it('unmarks the same ids when a stacked file is unmarked', () => {
    const on = linkedViewedIds(stacked('a.ts', ['x!1', 'x!2', 'x!3']), true, parts).sort()
    expect(linkedViewedIds(stacked('a.ts', ['x!1', 'x!2', 'x!3']), false, parts).sort()).toEqual(on)
  })

  it('marks only its own id for an MR file', () => {
    expect(linkedViewedIds(single('x!2', 'a.ts'), true, parts)).toEqual(['mr:x!2|a.ts'])
  })

  it('unmarks an MR file and the stacked file of every part that holds the MR', () => {
    expect(linkedViewedIds(single('x!2', 'a.ts'), false, parts).sort()).toEqual(['cb:x~1|a.ts', 'mr:x!2|a.ts'])
  })

  it('unmarks the stacked file of each part that holds the MR', () => {
    const two = [
      { id: 'x~1', mrs: ['x!1', 'x!2'] },
      { id: 'x~2', mrs: ['x!2', 'x!3'] }
    ]
    expect(linkedViewedIds(single('x!2', 'a.ts'), false, two).sort()).toEqual(['cb:x~1|a.ts', 'cb:x~2|a.ts', 'mr:x!2|a.ts'])
  })

  it('handles a part with a single MR', () => {
    expect(linkedViewedIds(stacked('a.ts', ['x!9'], 2), true, parts).sort()).toEqual(['cb:x~2|a.ts', 'mr:x!9|a.ts'])
    expect(linkedViewedIds(single('x!9', 'a.ts'), false, parts).sort()).toEqual(['cb:x~2|a.ts', 'mr:x!9|a.ts'])
  })

  it('keeps the same path in two different parts apart', () => {
    expect(linkedViewedIds(stacked('a.ts', ['x!9'], 2), false, parts)).not.toContain('mr:x!1|a.ts')
    expect(linkedViewedIds(single('x!1', 'a.ts'), false, parts)).not.toContain('cb:x~2|a.ts')
  })

  it('adds only its own id for a stacked file with no MRs', () => {
    expect(linkedViewedIds(stacked('a.ts', []), true, parts)).toEqual(['cb:x~1|a.ts'])
  })

  it('keeps a path with a bar and spaces whole', () => {
    const path = 'dir one/a|b c.ts'
    expect(linkedViewedIds(stacked(path, ['x!9'], 2), true, parts).sort()).toEqual([`cb:x~2|${path}`, `mr:x!9|${path}`])
    expect(linkedViewedIds(single('x!1', path), false, parts).sort()).toEqual([`cb:x~1|${path}`, `mr:x!1|${path}`])
  })
})
