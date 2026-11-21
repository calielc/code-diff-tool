import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LineObj } from '../src/shared/diff'
import {
  changeKey,
  checkSections,
  fileKey,
  pageExcerpts,
  pickInRun,
  restOf,
  rowsOf,
  sectionFactsOf,
  snippetRows,
  type ChangeLine,
  type FileExcerpt,
  type Row,
  type Section,
  type SectionsDocument,
  type SnippetRef
} from '../src/shared/sections'

/** The hunks of each file of a unified diff, as the diff engine hands them over. */
function parseDiff(text: string): Map<string, LineObj[][]> {
  const files = new Map<string, LineObj[][]>()
  let hunks: LineObj[][] | null = null
  let o = 0
  let n = 0
  for (const line of text.split('\n')) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line)
    if (file) {
      files.set(file[1], (hunks = []))
      continue
    }
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (head && hunks) {
      o = Number(head[1])
      n = Number(head[2])
      hunks.push([])
      continue
    }
    if (!hunks || hunks.length === 0 || line.startsWith('\\') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---')) continue
    const cur = hunks[hunks.length - 1]
    if (line.startsWith('+')) cur.push({ t: '+', o: null, n: n++, x: line.slice(1) })
    else if (line.startsWith('-')) cur.push({ t: '-', o: o++, n: null, x: line.slice(1) })
    else if (line.startsWith(' ')) cur.push({ t: ' ', o: o++, n: n++, x: line.slice(1) })
  }
  return files
}

const lineOf = (row: Row): LineObj[] => (row.kind === 'line' ? [row.line] : [])

interface Drawn {
  section: string
  key: string
}

/** Every changed row that a page draws, with the section that draws it. */
function drawnChanges(page: Record<string, FileExcerpt[]>): Drawn[] {
  return Object.entries(page).flatMap(([section, files]) =>
    files.flatMap((e) =>
      e.groups
        .flatMap((g) => g.flatMap(lineOf))
        .filter((l) => l.t !== ' ')
        .map((l) => ({ section, key: `${fileKey(e.mr, e.path)}|${changeKey(l as ChangeLine)}` }))
    )
  )
}

/**
 * The invariant of the page. No changed line is drawn twice. Every changed row of a section is inside one of its ranges, or is a removed row
 * that comes with the added row that replaces it. Every unchanged row is within two rows of a changed row (a single hidden line between two context rows shows as a line, not as a fold).
 */
function expectTight(page: Record<string, FileExcerpt[]>, hunksOf: (mr: string, path: string) => LineObj[][]): void {
  const seen = new Map<string, string>()
  for (const d of drawnChanges(page)) {
    expect(seen.get(d.key), `${d.key} is drawn in ${seen.get(d.key)} and in ${d.section}`).toBeUndefined()
    seen.set(d.key, d.section)
  }
  for (const files of Object.values(page)) {
    for (const e of files) {
      // the lines that the ranges pick, found again from the hunks by the same rule
      const picked = new Set<string>()
      for (const h of hunksOf(e.mr, e.path)) {
        const run: ChangeLine[] = []
        const flush = (): void => {
          if (run.length === 0) return
          for (const r of e.ranges) pickInRun(run, r).forEach((p, i) => p && picked.add(changeKey(run[i])))
          run.length = 0
        }
        for (const l of h) {
          if (l.t === ' ') flush()
          else run.push({ t: l.t, n: l.n, o: l.o })
        }
        flush()
      }
      for (const g of e.groups) {
        g.forEach((row, i) => {
          if (row.kind !== 'line') return
          const l = row.line
          if (l.t !== ' ') expect(picked.has(changeKey(l as ChangeLine)), `${e.path}: ${changeKey(l as ChangeLine)} is outside the ranges`).toBe(true)
          else {
            const near = [g[i - 1], g[i + 1], g[i - 2], g[i + 2]].some((x) => x && x.kind === 'line' && x.line.t !== ' ')
            expect(near, `${e.path}: the context row ${l.n} has no changed row within two rows`).toBe(true)
          }
        })
      }
    }
  }
}

const fixtureDiff = parseDiff(readFileSync(join(__dirname, 'fixtures/pr4-image-binary.diff'), 'utf8'))
const fixturePage = JSON.parse(readFileSync(join(__dirname, 'fixtures/pr4-sections.json'), 'utf8')) as SectionsDocument
const K = 'code-diff-app!4'
const hunksOf = (mr: string, path: string): LineObj[][] => (mr === K ? (fixtureDiff.get(path) ?? []) : [])

describe('the real page of the review of the Images and Binary types (a diff of the repo and the saved page)', () => {
  const facts = sectionFactsOf([
    {
      key: K,
      noDiff: false,
      snapshot: { info: { diffRefs: { head: 'h' } } },
      files: [...fixtureDiff].map(([path, hunks]) => ({ path, levels: { raw: { hunks }, strict: { hunks } } }))
    }
  ])
  const check = checkSections(JSON.stringify(fixturePage), facts)

  it('still passes the check of its ranges, so the fixture is a valid page for this diff', () => {
    // The page was written when ranges could be wide. Only the ranges that hold a change matter here.
    expect(check.problems.filter((p) => !p.includes('too wide'))).toEqual([])
  })

  it('draws every changed line once across the sections and Everything else, and every row is inside its range', () => {
    const doc = fixturePage
    const page = pageExcerpts(doc.sections, hunksOf)
    expectTight(page, hunksOf)
    // Everything else draws what no snippet picks, and none of it is drawn by a section
    const sectionKeys = new Set(drawnChanges(page).map((d) => d.key))
    const rest = restOf(doc, facts)
    for (const e of rest) {
      const keys = new Set(e.keys ?? [])
      const groups = rowsOf(hunksOf(e.mr, e.path), (run) => run.map((l) => e.whole || keys.has(changeKey(l))))
      for (const l of groups.flatMap((g) => g.flatMap((r) => lineOf(r))).filter((x) => x.t !== ' '))
        expect(
          sectionKeys.has(`${fileKey(e.mr, e.path)}|${changeKey(l as ChangeLine)}`),
          `${e.path}: ${changeKey(l as ChangeLine)} is in a section and in Everything else`
        ).toBe(false)
    }
  })

  it('draws the second range of a hunk only with its own rows: 87-91 and 98-99 of file-kinds.ts', () => {
    const doc = fixturePage
    const page = pageExcerpts(doc.sections, hunksOf)
    const third = page['visible-options'][0]
    const nums = third.groups.flatMap((g) => g.flatMap(lineOf)).filter((l) => l.t !== ' ')
    const newLines = nums.filter((l) => l.n !== null).map((l) => l.n as number)
    expect(newLines.every((n) => (n >= 87 && n <= 91) || (n >= 98 && n <= 99))).toBe(true)
    expect(new Set(newLines).size).toBe(newLines.length) // each line once
    expect(third.ranges.map((r) => r.lines)).toEqual([
      [87, 91],
      [98, 99]
    ])
  })

  it('puts the ranges of one section in the order of the file, with one block for the file', () => {
    const page = pageExcerpts(fixturePage.sections, hunksOf)
    const first = page['classification-order']
    expect(first).toHaveLength(1) // one file, one header
    expect(first[0].ranges.map((r) => r.lines)).toEqual([
      [43, 57],
      [76, 83]
    ]) // the AI wrote 76-83 first
  })

  it('reports how many rows each section draws', () => {
    const page = pageExcerpts(fixturePage.sections, hunksOf)
    const counts = Object.fromEntries(Object.entries(page).map(([id, files]) => [id, files.flatMap((e) => e.groups.flatMap((g) => g.flatMap(lineOf))).length]))
    console.log('rows drawn by section', JSON.stringify(counts))
    expect(Object.values(counts).every((c) => c > 0)).toBe(true)
  })
})

describe('the rows of ranges inside one hunk', () => {
  const L = (t: LineObj['t'], o: number | null, n: number | null): LineObj => ({ t, o, n, x: '' })
  /** A hunk like the one of the screenshot: context, a block of added lines, a removed pair, more added lines, and context. */
  const hunk = (): LineObj[] => [
    ...Array.from({ length: 4 }, (_, i) => L(' ', 80 + i, 80 + i)),
    ...Array.from({ length: 12 }, (_, i) => L('+', null, 84 + i)),
    L(' ', 92, 96),
    L('-', 93, null),
    L('+', null, 97),
    L('+', null, 98),
    ...Array.from({ length: 3 }, (_, i) => L(' ', 94 + i, 99 + i))
  ]
  const section = (id: string, ...ranges: Pick<SnippetRef, 'lines' | 'side'>[]): Section => ({
    id,
    title: id,
    text: 'x',
    snippets: ranges.map((r) => ({ mr: 'r!1', path: 'f.ts', ...r }))
  })
  const page = (...sections: Section[]): Record<string, FileExcerpt[]> => pageExcerpts(sections, () => [hunk()])
  const news = (e: FileExcerpt): number[] =>
    e.groups
      .flatMap((g) => g.flatMap(lineOf))
      .filter((l) => l.t === '+')
      .map((l) => l.n as number)

  it('two ranges of one hunk draw their own lines, and a fold joins the space between', () => {
    const p = page(section('a', { lines: [98, 98] }, { lines: [85, 86] }))
    expect(p.a).toHaveLength(1)
    expect(news(p.a[0])).toEqual([85, 86, 98]) // in the order of the file, with only the picked lines
    expect(p.a[0].groups[0].some((r) => r.kind === 'fold')).toBe(true)
    expectTight(p, () => [hunk()])
  })
  it('a range inside another draws nothing twice, and ranges that touch are one block', () => {
    const p = page(section('a', { lines: [85, 90] }, { lines: [87, 88] }, { lines: [91, 92] }))
    expect(news(p.a[0])).toEqual([85, 86, 87, 88, 89, 90, 91, 92])
    expect(p.a[0].groups[0].filter((r) => r.kind === 'fold')).toHaveLength(0)
    expectTight(p, () => [hunk()])
  })
  it('a second section draws only the lines that the first one does not, and says where the others are', () => {
    const p = page(section('a', { lines: [85, 90] }), section('b', { lines: [88, 94] }), section('c', { lines: [86, 87] }))
    expect(news(p.a[0])).toEqual([85, 86, 87, 88, 89, 90])
    expect(news(p.b[0])).toEqual([91, 92, 93, 94])
    expect(p.c[0].groups).toEqual([])
    expect(p.c[0].shownIn).toBe(1)
    expect(p.b[0].shownIn).toBeNull()
    expectTight(p, () => [hunk()])
  })
  it('a removed row comes with the added row that replaces it, and not with a range that does not hold the added row', () => {
    const withAdded = page(section('a', { lines: [97, 97] }))
    const rows = withAdded.a[0].groups.flatMap((g) => g.flatMap(lineOf))
    expect(rows.filter((l) => l.t === '-').map((l) => l.o)).toEqual([93])
    expect(rows.filter((l) => l.t === '+').map((l) => l.n)).toEqual([97])
    const apart = page(section('a', { lines: [98, 98] }))
    expect(apart.a[0].groups.flatMap((g) => g.flatMap(lineOf)).filter((l) => l.t === '-')).toEqual([]) // 97 is not picked, so the removed row stays out
  })
  it('a range with only removed rows is an old side range, and it does not repeat the removed row that a new side range draws', () => {
    const old = page(section('a', { lines: [93, 93], side: 'old' }))
    expect(
      old.a[0].groups
        .flatMap((g) => g.flatMap(lineOf))
        .filter((l) => l.t !== ' ')
        .map((l) => changeKey(l as ChangeLine))
    ).toEqual(['-93'])
    const both = page(section('a', { lines: [97, 97] }), section('b', { lines: [93, 93], side: 'old' }))
    expect(both.b[0].shownIn).toBe(1)
    expectTight(both, () => [hunk()])
  })
  it('snippetRows cuts to its range, with one context row, and never draws the whole block', () => {
    const rows = snippetRows([hunk()], { lines: [88, 89] })[0]
    expect(rows.flatMap(lineOf).map((l) => l.n)).toEqual([88, 89]) // the next lines are changed lines that no range picks, so they stay out
    expect(rows.filter((r) => r.kind === 'fold')).toHaveLength(0)
  })
})

describe('any set of ranges in one hunk keeps the invariant (a fixed seed)', () => {
  // mulberry32, so the test is the same on every run
  const seeded =
    (seed: number): (() => number) =>
    () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  /** A made-up hunk of 60 lines: blocks of added lines, replaced blocks, removed lines and context, in a random order. */
  const makeHunk = (rand: () => number): LineObj[] => {
    const out: LineObj[] = []
    let o = 1
    let n = 1
    while (out.length < 60) {
      const kind = rand()
      const len = 1 + Math.floor(rand() * 6)
      for (let i = 0; i < len; i++) {
        if (kind < 0.35) out.push({ t: ' ', o: o++, n: n++, x: '' })
        else if (kind < 0.6) out.push({ t: '+', o: null, n: n++, x: '' })
        else if (kind < 0.75) out.push({ t: '-', o: o++, n: null, x: '' })
        else {
          // a replaced block: removed lines, then added lines
          out.push({ t: '-', o: o++, n: null, x: '' })
          out.push({ t: '+', o: null, n: n++, x: '' })
        }
      }
    }
    return out
  }
  it('holds for 300 random pages of up to five sections, each with up to four ranges, on either side', () => {
    const rand = seeded(20261121)
    for (let round = 0; round < 300; round++) {
      const h = makeHunk(rand)
      const maxNew = Math.max(...h.map((l) => l.n ?? 0))
      const maxOld = Math.max(...h.map((l) => l.o ?? 0))
      const sections: Section[] = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, s) => ({
        id: `s${s}`,
        title: `s${s}`,
        text: 'x',
        snippets: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
          const old = rand() < 0.25
          const top = old ? maxOld : maxNew
          const from = 1 + Math.floor(rand() * top)
          return {
            mr: 'r!1',
            path: 'f.ts',
            lines: [from, Math.min(top, from + Math.floor(rand() * 12))] as [number, number],
            ...(old ? { side: 'old' as const } : {})
          }
        })
      }))
      const page = pageExcerpts(sections, () => [h])
      expectTight(page, () => [h])
    }
  })
})
