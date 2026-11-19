import { describe, expect, it } from 'vitest'
import type { LineObj } from '../src/shared/diff'
import { buildFile, buildHunks } from '../src/main/diff/file-diff'
import { compute, fromChangedLines } from '../src/main/diff/myers'
import { applyRenames, detectRenames, isGenerated, keysFor } from '../src/main/diff/noise'

const pairs = (path: string, lines: string[], level: 'raw' | 'basic' | 'strict', renames = [] as { from: string; to: string }[]): [number, string][] =>
  keysFor(path, lines, level, renames).map((k) => [k.index, k.key])

describe('noise filter vectors (file 03 section 13.1)', () => {
  it('N1 C# basic with a byte order mark', () => {
    expect(pairs('A.cs', ['﻿using System;', '', 'namespace App;', '  public   class X {}'], 'basic')).toEqual([
      [2, 'namespaceApp;'],
      [3, 'publicclassX{}']
    ])
  })
  it('N2 C# strict modifiers', () => {
    const line = ['    public static readonly int X = 1; // c']
    expect(pairs('A.cs', line, 'strict')).toEqual([[0, 'publicintX=1;//c']])
    expect(pairs('A.cs', line, 'basic')).toEqual([[0, 'publicstaticreadonlyintX=1;//c']])
  })
  it('N3 strict comment prefixes', () => {
    const lines = ['// hi', '  /* start', ' * mid', 'const a = 1;', '#nullable enable']
    expect(pairs('a.ts', lines, 'strict')).toEqual([[3, 'consta=1;']])
    expect(pairs('a.ts', lines, 'basic').map((p) => p[1])).toEqual(['//hi', '/*start', '*mid', 'consta=1;', '#nullableenable'])
  })
  it('N4 TypeScript imports, including a multi-line one', () => {
    const lines = ["import a from 'a';", 'import {', '  b,', '  c', '} from "z";', "import 'side';", 'const q = 1;']
    expect(pairs('x.ts', lines, 'basic')).toEqual([[6, 'constq=1;']])
  })
  it('N5 YAML comments, and the same text in markdown', () => {
    const lines = ['# comment', 'key: value  ', '  # indented']
    expect(pairs('c.yml', lines, 'strict')).toEqual([[1, 'key:value']])
    expect(pairs('c.yml', lines, 'basic')).toEqual([
      [0, '#comment'],
      [1, 'key:value'],
      [2, '#indented']
    ])
    expect(pairs('c.md', lines, 'strict')).toHaveLength(3)
  })
  it('N6 C# using forms', () => {
    const lines = ['using var x = Foo();', 'using (var s = a) {', 'using System.Text;', 'global using Foo.Bar;', 'using static System.Math;', 'using A = B.C;']
    expect(pairs('A.cs', lines, 'basic')).toEqual([
      [0, 'usingvarx=Foo();'],
      [1, 'using(vars=a){']
    ])
  })
  it('N7 namespace renames on the old side', () => {
    const renames = [{ from: 'Old.Core', to: 'New.Core' }]
    const lines = ['namespace Old.Core;', 'using Old.Core.Util;', 'var x = new Old.Core.Foo();', 'var y = NotOld.Core.Z;']
    expect(pairs('B.cs', lines, 'basic', renames)).toEqual([
      [0, 'namespaceNew.Core;'],
      [2, 'varx=newNew.Core.Foo();'],
      [3, 'vary=NotOld.Core.Z;']
    ])
    expect(applyRenames('X.Old.Core', renames)).toBe('X.Old.Core') // a dot before the name blocks the match
  })
  it('N8 raw keeps everything', () => {
    expect(pairs('a.txt', ['  a ', ''], 'raw')).toEqual([
      [0, '  a '],
      [1, '']
    ])
  })
  it('detects a namespace move and keeps the first rename of an old name', () => {
    const r = detectRenames([
      { path: 'a.cs', oldText: 'namespace Old.Core;', newText: 'namespace New.Core;' },
      { path: 'b.cs', oldText: 'namespace Old.Core;', newText: 'namespace Other;' },
      { path: 'c.ts', oldText: 'namespace A;', newText: 'namespace B;' }
    ])
    expect(r).toEqual([{ from: 'Old.Core', to: 'New.Core' }])
  })
})

describe('generated files (file 03 section 6)', () => {
  it('matches names, suffixes and openapi content', () => {
    expect(isGenerated('src/pnpm-lock.yaml', null)).toBe(true)
    expect(isGenerated('Models/AppModelSnapshot.cs', null)).toBe(true)
    expect(isGenerated('a.json', '{ "openapi": "3.0.1"}')).toBe(true)
    expect(isGenerated('a.json', '{ "name": "x"}')).toBe(false)
    expect(isGenerated('a.yml', '# one\n# two\nopenapi: 3.0.0')).toBe(true)
  })
})

describe('line diff vectors (file 03 section 13.2)', () => {
  const show = (s: ReturnType<typeof compute>): string[] => s.map((x) => (x.k === 'eq' ? `E${x.o},${x.n}` : x.k === 'del' ? `D${x.o}` : `I${x.n}`))
  it('L1', () => expect(show(compute(['a', 'b', 'c'], ['a', 'x', 'c']))).toEqual(['E0,0', 'D1', 'I1', 'E2,2']))
  it('L2', () => expect(show(compute([], ['a', 'b']))).toEqual(['I0', 'I1']))
  it('L3', () => expect(show(compute(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e']))).toEqual(['D0', 'E1,0', 'E2,1', 'E3,2', 'I3']))
  it('L4', () => expect(show(fromChangedLines(3, 4, new Set([2]), new Set([2, 3]))!)).toEqual(['E0,0', 'D1', 'I1', 'I2', 'E2,3']))
  it('L5', () => {
    expect(fromChangedLines(3, 3, new Set([1]), new Set())).toBeNull()
    expect(fromChangedLines(3, 3, new Set([5]), new Set([5]))).toBeNull()
  })
  it('finds a minimal script on larger, shuffled input', () => {
    const a = Array.from({ length: 400 }, (_, i) => `l${i}`)
    const b = a.filter((_, i) => i % 7 !== 0).concat(['tail1', 'tail2'])
    const steps = compute(a, b)
    expect(steps.filter((s) => s.k === 'del')).toHaveLength(Math.ceil(400 / 7))
    expect(steps.filter((s) => s.k === 'ins')).toHaveLength(2)
    expect(steps.filter((s) => s.k === 'eq').length + steps.filter((s) => s.k === 'del').length).toBe(400)
  })
})

describe('hunks (file 03 section 13.3)', () => {
  const lines = (n: number, plus: number[], minus: number[] = []): LineObj[] =>
    Array.from({ length: n }, (_, i) => ({ t: minus.includes(i) ? '-' : plus.includes(i) ? '+' : ' ', o: null, n: i, x: '' }) as LineObj)
  const idx = (h: LineObj[]): [number, number] => [h[0].n as number, h[h.length - 1].n as number]
  it('H1 a - and a + in the middle', () => expect(buildHunks(lines(20, [11], [10])).map(idx)).toEqual([[7, 14]]))
  it('H2 six unchanged lines between changes join', () => expect(buildHunks(lines(30, [5, 12])).map(idx)).toEqual([[2, 15]]))
  it('H3 seven unchanged lines between changes split', () =>
    expect(buildHunks(lines(30, [5, 13])).map(idx)).toEqual([
      [2, 8],
      [10, 16]
    ]))
  it('H4 a change near the start', () => {
    const h = buildHunks(lines(5, [1]))
    expect(h).toHaveLength(1)
    expect(h[0]).toHaveLength(5)
  })
  it('H5 no change, no hunk', () => expect(buildHunks(lines(4, []))).toEqual([]))
})

describe('buildFile', () => {
  const side = (text: string): { binary: boolean; lines: string[] } => ({ binary: false, lines: text === '' ? [] : text.replace(/\n$/, '').split('\n') })
  it('shows a whitespace-only change at raw but not at basic', () => {
    const f = buildFile({ path: 'a.txt', oldPath: 'a.txt', status: 'M', old: side('x\n  y\nz\n'), new: side('x\ny\nz\n') }, [])
    expect(f.levels.raw.add + f.levels.raw.del).toBe(2)
    expect(f.levels.basic).toEqual({ hunks: [], add: 0, del: 0 })
    expect(f.lines).toEqual(['x', 'y', 'z'])
    expect(f.oldLines).toEqual(['x', '  y', 'z']) // raw removes a line, so the old text is kept
  })
  it('uses git changed lines for raw positions', () => {
    const f = buildFile(
      {
        path: 'a.txt',
        oldPath: 'a.txt',
        status: 'M',
        old: side('a\nb\nc\n'),
        new: side('a\nB\nc\nd\n'),
        changed: { deleted: new Set([2]), added: new Set([2, 4]) }
      },
      []
    )
    expect(f.levels.raw.hunks[0].map((l) => `${l.t}${l.o ?? ''}/${l.n ?? ''}`)).toEqual([' 1/1', '-2/', '+/2', ' 3/3', '+/4'])
  })
  it('gives a binary file no lines and empty levels', () => {
    const f = buildFile({ path: 'i.png', oldPath: 'i.png', status: 'M', old: { binary: true, lines: [] }, new: { binary: true, lines: [] } }, [])
    expect(f).toMatchObject({ binary: true, lines: null, oldLines: null })
    expect(f.levels.strict).toEqual({ hunks: [], add: 0, del: 0 })
  })
  it('keeps the levels of a generated file but not its lines', () => {
    const f = buildFile({ path: 'pnpm-lock.yaml', oldPath: 'pnpm-lock.yaml', status: 'M', old: side('a\n'), new: side('b\n') }, [])
    expect(f.generated).toBe(true)
    expect(f.lines).toBeNull()
    expect(f.levels.raw.add).toBe(1)
  })
})
