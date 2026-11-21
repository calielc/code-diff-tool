import { describe, expect, it } from 'vitest'
import { emptyLevel, type FileObject, type Level, type LineObj } from '../src/shared/diff'
import { buildPlan } from '../src/shared/syntax-plan'
import { MAX_LINES } from '../src/shared/syntax-tokens'

const line = (t: LineObj['t'], o: number | null, n: number | null, x: string): LineObj => ({ t, o, n, x })
const level = (...hunks: LineObj[][]): Level => ({ ...emptyLevel(), hunks })

function file(over: Partial<FileObject>): FileObject {
  return {
    path: 'src/a.ts',
    oldPath: 'src/a.ts',
    status: 'M',
    binary: false,
    generated: false,
    levels: { raw: emptyLevel(), basic: emptyLevel(), strict: emptyLevel() },
    lines: null,
    oldLines: null,
    ...over
  }
}

const OLD = ['/*', ' a comment', '*/', 'const a = 1']
const NEW = ['/*', ' a comment', '*/', 'const a = 2', 'const b = 3']

describe('buildPlan with the whole text of both sides', () => {
  const hunk = [line('-', 4, null, 'const a = 1'), line('+', null, 4, 'const a = 2'), line('+', null, 5, 'const b = 3')]
  const plan = buildPlan(file({ lines: NEW, oldLines: OLD }), level(hunk))

  it('colours the whole old file and the whole new file', () => {
    expect(plan.sources.map((s) => [s.key, s.lang, s.lines])).toEqual([
      ['new', 'typescript', NEW],
      ['old', 'typescript', OLD]
    ])
    expect(plan.notice).toBeNull()
  })

  it('takes a removed line from the old file and an added line from the new file, by line number', () => {
    expect(plan.at(hunk[0])).toEqual({ source: 'old', index: 3 })
    expect(plan.at(hunk[1])).toEqual({ source: 'new', index: 3 })
    expect(plan.at(hunk[2])).toEqual({ source: 'new', index: 4 })
  })

  it('takes an unchanged line from the new file, and a line of the Full file by its number', () => {
    expect(plan.at(line(' ', 2, 2, ' a comment'))).toEqual({ source: 'new', index: 1 })
    expect(plan.atNew(2)).toEqual({ source: 'new', index: 1 })
  })
})

describe('buildPlan when a side has no whole text', () => {
  it('colours a deleted file from its old text', () => {
    const l = line('-', 2, null, ' a comment')
    const plan = buildPlan(file({ status: 'D', lines: null, oldLines: OLD }), level([l]))
    expect(plan.sources.map((s) => s.key)).toEqual(['old'])
    expect(plan.at(l)).toEqual({ source: 'old', index: 1 })
    expect(plan.atNew(1)).toBeNull()
  })

  it('colours each hunk by itself for a file with neither text, such as a generated file', () => {
    const a = [line(' ', 1, 1, 'const x = 1'), line('-', 2, null, 'const y = 1'), line('+', null, 2, 'const y = 2')]
    const b = [line('+', null, 40, 'const z = 3')]
    const plan = buildPlan(file({ generated: true }), level(a, b))
    expect(plan.sources.map((s) => [s.key, s.lines])).toEqual([
      ['h0o', ['const x = 1', 'const y = 1']],
      ['h0n', ['const x = 1', 'const y = 2']],
      ['h1n', ['const z = 3']]
    ])
    expect(plan.at(a[0])).toEqual({ source: 'h0n', index: 0 })
    expect(plan.at(a[1])).toEqual({ source: 'h0o', index: 1 })
    expect(plan.at(a[2])).toEqual({ source: 'h0n', index: 1 })
    expect(plan.at(b[0])).toEqual({ source: 'h1n', index: 0 })
  })

  it('colours the removed lines by hunk when only the old text is missing', () => {
    const hunk = [line('-', 2, null, 'old'), line('+', null, 2, 'new')]
    const plan = buildPlan(file({ lines: ['a', 'new'], oldLines: null }), level(hunk))
    expect(plan.sources.map((s) => s.key)).toEqual(['new', 'h0o'])
    expect(plan.at(hunk[0])).toEqual({ source: 'h0o', index: 0 })
    expect(plan.at(hunk[1])).toEqual({ source: 'new', index: 1 })
  })
})

describe('buildPlan leaves a file plain', () => {
  it('for an unknown language and for a binary file', () => {
    expect(buildPlan(file({ path: 'notes.txt', oldPath: 'notes.txt', lines: ['a'] }), level()).sources).toEqual([])
    expect(buildPlan(file({ binary: true, lines: ['a'] }), level()).sources).toEqual([])
  })

  it('above the size limit, and says why', () => {
    const big = new Array<string>(MAX_LINES + 1).fill('const a = 1')
    const plan = buildPlan(file({ lines: big, oldLines: null }), level([line('+', null, 1, 'const a = 1')]))
    expect(plan.sources).toEqual([])
    expect(plan.notice).toBe('Syntax colours are off for this file: it has more than 8,000 lines.')
    expect(plan.atNew(1)).toBeNull()
  })

  it('and a big file of one side still colours the other side', () => {
    const big = new Array<string>(MAX_LINES + 1).fill('x')
    const plan = buildPlan(file({ lines: ['a'], oldLines: big }), level())
    expect(plan.sources.map((s) => s.key)).toEqual(['new'])
    expect(plan.notice).toContain('more than 8,000 lines')
  })
})

describe('buildPlan with a renamed file', () => {
  it('colours the old side by the language of the old name', () => {
    const plan = buildPlan(file({ path: 'src/a.tsx', oldPath: 'src/a.js', status: 'R', lines: ['a'], oldLines: ['b'] }), level())
    expect(plan.sources.map((s) => [s.key, s.lang])).toEqual([
      ['new', 'typescript'],
      ['old', 'javascript']
    ])
  })
})
