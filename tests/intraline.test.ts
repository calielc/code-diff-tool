import { describe, expect, it } from 'vitest'
import { intraLine, type Seg } from '../src/shared/intraline'

const changedText = (segs: Seg[]): string =>
  segs
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join('|')
const join = (segs: Seg[]): string => segs.map((s) => s.text).join('')

describe('intraLine', () => {
  it('marks one or two changed characters and nothing else', () => {
    const r = intraLine('const total = items.length;', 'const total = items.length + 1;')!
    expect(changedText(r.old)).toBe('')
    expect(changedText(r.new)).toBe(' + 1')
    const c = intraLine('return count == 0;', 'return count != 0;')!
    expect(changedText(c.old)).toBe('=')
    expect(changedText(c.new)).toBe('!')
  })

  it('keeps every character: the segments join back to the line', () => {
    const a = 'The quick brown fox jumps over the lazy dog'
    const b = 'The quick red fox jumped over the lazy dog'
    const r = intraLine(a, b)!
    expect(join(r.old)).toBe(a)
    expect(join(r.new)).toBe(b)
    expect(changedText(r.new)).toContain('red')
    expect(r.old[0]).toEqual({ text: 'The quick ', changed: false })
  })

  it('marks an inserted or a removed stretch on one side only', () => {
    const r = intraLine('foo(a, b)', 'foo(a, b, c)')!
    expect(changedText(r.old)).toBe('')
    expect(changedText(r.new)).toBe(', c')
    const d = intraLine('foo(a, b, c)', 'foo(a, b)')!
    expect(changedText(d.old)).toBe(', c')
    expect(changedText(d.new)).toBe('')
  })

  it('merges a one or two character gap between changes, so a word is not scattered', () => {
    const r = intraLine('the version 1.34.1 is here', 'the version 1.35.2 is here')!
    // 1.34.1 -> 1.35.2: the changes at "4" and "1" are two characters apart and show as one stretch
    expect(r.new.filter((s) => s.changed)).toHaveLength(1)
    expect(changedText(r.new)).toBe('5.2')
  })

  it('gives nothing for equal lines and for lines that are mostly different', () => {
    expect(intraLine('same', 'same')).toBeNull()
    expect(intraLine('alpha beta gamma', 'completely other text')).toBeNull()
    expect(intraLine('two', 'TWO')).toBeNull()
  })

  it('handles empty sides and very long lines', () => {
    expect(intraLine('', 'x')).toBeNull()
    const long = 'a'.repeat(1000)
    const r = intraLine(long + 'X' + long, long + 'Y' + long)!
    expect(changedText(r.old)).toBe('X')
    expect(changedText(r.new)).toBe('Y')
    expect(intraLine('a'.repeat(300) + 'x'.repeat(300), 'b'.repeat(300) + 'y'.repeat(300))).toBeNull()
  })
})
