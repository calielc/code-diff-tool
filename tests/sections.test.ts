import { describe, expect, it } from 'vitest'
import type { PendingComment } from '../src/shared/comments'
import type { LineObj } from '../src/shared/diff'
import type { Thread } from '../src/shared/provider'
import {
  REST_ID,
  REST_TITLE,
  acceptSection,
  basisProblems,
  checkSections,
  cleanTitle,
  coverageOf,
  excerptOf,
  fileKey,
  giveUpMessage,
  isAccepted,
  problemPrompt,
  rangesOf,
  relaxJson,
  restOf,
  sectionCommentBody,
  sectionDrafts,
  sectionFactsOf,
  sectionOfBody,
  sectionProgress,
  sectionThreads,
  threadTarget,
  unacceptSection,
  viewedId,
  waitingFor,
  withRest,
  type Accepted,
  type FileFacts,
  type SectionFacts,
  type SectionsDocument
} from '../src/shared/sections'

const file = (over: Partial<FileFacts>): FileFacts => ({ rawNew: new Set(), rawOld: new Set(), runs: [], ...over })

/** Two changes. A.cs has two separate changes to read, Gone.cs a removal, hook.ts one change, the lock file one, and the logo none. */
const facts = (): SectionFacts => ({
  files: new Map([
    [
      fileKey('backend/x!1', 'src/A.cs'),
      file({
        rawNew: new Set([10, 11, 40]),
        runs: [
          { new: [10, 11], old: [] },
          { new: [40], old: [] }
        ]
      })
    ],
    [fileKey('backend/x!1', 'src/Gone.cs'), file({ rawOld: new Set([5, 6]), runs: [{ new: [], old: [5, 6] }] })],
    [fileKey('backend/x!1', 'src/A.Tests.cs'), file({ rawNew: new Set([5]), runs: [{ new: [5], old: [] }] })],
    [fileKey('web/y!2', 'src/hook.ts'), file({ rawNew: new Set([3, 4]), runs: [{ new: [3, 4], old: [] }] })],
    [fileKey('web/y!2', 'package-lock.json'), file({ rawNew: new Set([1]), runs: [{ new: [1], old: [] }] })],
    [fileKey('web/y!2', 'logo.png'), file({})]
  ]),
  filesByMr: new Map([
    ['backend/x!1', ['src/A.cs', 'src/Gone.cs', 'src/A.Tests.cs']],
    ['web/y!2', ['src/hook.ts', 'package-lock.json', 'logo.png']]
  ]),
  heads: new Map([
    ['backend/x!1', 'aaa'],
    ['web/y!2', 'bbb']
  ])
})

/** A document that passes every rule. Each test breaks one thing. */
const good = (): Record<string, any> => ({
  summary: 'A user sees the card.',
  sections: [
    {
      id: 'hook',
      title: 'The page asks for the card',
      text: 'The hook calls the endpoint.',
      snippets: [{ mr: 'web/y!2', path: 'src/hook.ts', lines: [3, 4] }]
    },
    {
      id: 'api',
      title: 'The endpoint answers',
      text: 'The controller reads the card.',
      snippets: [
        { mr: 'backend/x!1', path: 'src/A.cs', lines: [10, 12] },
        { mr: 'backend/x!1', path: 'src/A.cs', lines: [38, 41] },
        { mr: 'backend/x!1', path: 'src/Gone.cs', lines: [5, 6], side: 'old' }
      ]
    }
  ],
  restText: 'The tests, the lock file and the logo.'
})
const check = (doc: unknown): ReturnType<typeof checkSections> => checkSections(typeof doc === 'string' ? doc : JSON.stringify(doc), facts())

describe('a good page', () => {
  it('passes, also inside prose and a code fence', () => {
    const r = check('Here it is:\n```json\n' + JSON.stringify(good()) + '\n```\nDone.')
    expect(r.problems).toEqual([])
    expect(r.document?.sections).toHaveLength(2)
    expect(r.document?.restText).toBe('The tests, the lock file and the logo.')
  })
  it('does not ask for coverage: a page may show one change and leave the rest to Everything else', () => {
    const d = good()
    d.sections.pop() // A.cs, Gone.cs, the tests, the lock file and the logo are shown by no section
    delete d.restText
    expect(check(d).problems).toEqual([])
  })
  it('accepts a page with no section, for a change that needs no thought', () => {
    expect(check({ summary: 'Only generated files changed.', sections: [] }).problems).toEqual([])
  })
  it('accepts comments and trailing commas, and ignores the fields of an older page', () => {
    const text = JSON.stringify(good()).replace('"summary"', '// note\n"summary"').replace(/\]\}$/, ',]}')
    expect(check(text).problems).toEqual([])
    const old = good()
    old.sections[0].files = [{ mr: 'web/y!2', path: 'logo.png' }]
    old.sections[0].leftover = true
    expect(check(old).document?.sections[0]).toEqual({
      id: 'hook',
      title: 'The page asks for the card',
      text: 'The hook calls the endpoint.',
      snippets: old.sections[0].snippets
    })
    expect(relaxJson('{"a":"// not a comment","b":[1,],}')).toBe('{"a":"// not a comment","b":[1]}')
  })
})

describe('the checks that stay', () => {
  it('no JSON object, or JSON that is not a page', () => {
    expect(check('nothing here').problems).toEqual(['The answer holds no JSON object.'])
    expect(check('{ broken }').problems[0]).toMatch(/^The answer is not a valid sections document: /)
    expect(check({ sections: 'no' }).problems[0]).toBe('The answer is not a valid sections document: sections is not a list.')
    const d = good()
    d.sections[0].snippets[0].lines = [1, 'x']
    expect(check(d).problems[0]).toContain('section 1, snippet 1: lines is not a pair of whole numbers')
  })
  it('a snippet of a file that is not changed, and of lines that hold no change', () => {
    const d = good()
    d.sections[1].snippets[0].path = 'src/Nope.cs'
    d.sections[0].snippets[0].lines = [100, 110]
    const p = check(d).problems
    expect(p).toContain("section 'api': src/Nope.cs is not a changed file of backend/x!1. Use a path as the .diff files name it")
    // the message tells the tool where the changes are, so one retry can fix the range
    expect(p).toContain("section 'hook': lines 100-110 of src/hook.ts on the new side hold no change. The changed lines on that side are 3-4")
  })
  it('a change that is not in the review, with the keys that are', () => {
    const d = good()
    d.sections[0].snippets[0].mr = 'backend/x!9'
    expect(check(d).problems).toEqual(["section 'hook': backend/x!9 is not a change of this review. The keys are backend/x!1, web/y!2"])
  })
  it('lists the changed lines as ranges for a message, and cuts a long list', () => {
    expect(rangesOf([40, 2, 3, 4, 10, 12])).toBe('2-4, 10, 12, 40')
    expect(rangesOf([])).toBe('none (the file has no change on that side)')
    expect(rangesOf(Array.from({ length: 30 }, (_, i) => i * 2 + 1))).toBe('1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23 and 18 more')
  })
  it('a title or a paragraph that is missing is named', () => {
    const d = good()
    delete d.sections[0].title
    d.sections[1].text = ''
    const p = check(d)
    expect(p.problems).toEqual(['The answer is not a valid sections document: section 1: title is not a string.'])
    const e = good()
    e.sections[1].text = ' '
    e.sections[0].title = ' '
    expect(check(e).problems).toEqual(["section 'hook' has an empty title", "section 'api' has an empty text"])
  })
  it('a removed line is found on the old side only', () => {
    const d = good()
    delete d.sections[1].snippets[2].side
    expect(check(d).problems).toContain(
      "section 'api': lines 5-6 of src/Gone.cs on the new side hold no change. The changed lines on that side are none (the file has no change on that side)"
    )
  })
  it('a range that is too long, a section with no snippet, and too many snippets', () => {
    const d = good()
    d.sections[0].snippets[0].lines = [1, 500]
    expect(check(d).problems).toContain("section 'hook': lines 1-500 of src/hook.ts are more than 120 lines. Split the snippet")
    const e = good()
    e.sections[0].snippets = Array.from({ length: 13 }, () => ({ mr: 'web/y!2', path: 'src/hook.ts', lines: [3, 4] }))
    expect(check(e).problems).toContain("section 'hook': it has 13 snippets, and the limit is 12. Split the section")
    const n = good()
    n.sections[0].snippets = []
    expect(check(n).problems).toEqual(["section 'hook' has no snippet: show the code that the paragraph is about"])
  })
  it('ids and titles are unique and the text is one paragraph', () => {
    const d = good()
    d.sections[1].id = 'hook'
    d.sections[1].title = '**The page asks for the card**'
    d.sections[0].text = 'One.\n\nTwo.'
    d.sections.push({ ...good().sections[1], id: 'empty', text: ' ' })
    const p = check(d).problems
    expect(p).toContain("section 'hook': the id is used twice")
    expect(p).toContain("section 'hook': the title 'The page asks for the card' is used twice")
    expect(p).toContain("section 'hook': the text must be one paragraph, with no blank line")
    expect(p).toContain("section 'empty' has an empty text")
  })
  it('the name of the section that the app adds is kept, and the page has at most 12 sections', () => {
    const d = good()
    d.sections[0].title = 'Everything else'
    d.sections[1].id = REST_ID
    const p = check(d).problems
    expect(p).toContain(`section 'hook': the title "${REST_TITLE}" is kept for the section that the app adds. Leave it out`)
    expect(p).toContain(`section '${REST_ID}': the id is kept for the section that the app adds. Leave "${REST_TITLE}" out`)
    const many = good()
    many.sections = Array.from({ length: 13 }, (_, i) => ({ ...good().sections[0], id: `s${i}`, title: `Idea ${i}` }))
    expect(check(many).problems).toEqual([
      'The page has 13 sections, and the limit is 12. Keep only what a reviewer must think about. The rest goes to "Everything else"'
    ])
  })
})

describe('Everything else, computed from the real diffs', () => {
  const doc = (): SectionsDocument => check(good()).document!
  const key = (e: { mr: string; path: string }): string => `${e.mr} ${e.path}`

  it('holds every file that no snippet is in, with all its changes', () => {
    const rest = restOf(doc(), facts())
    expect(rest.filter((e) => e.whole).map(key)).toEqual(['backend/x!1 src/A.Tests.cs', 'web/y!2 package-lock.json', 'web/y!2 logo.png'])
    expect(rest.find((e) => e.path === 'package-lock.json')?.runs).toEqual([{ new: [1], old: [] }])
    expect(rest.find((e) => e.path === 'logo.png')?.runs).toEqual([]) // a binary file has no change to show, and it is still left out
  })
  it('holds the change of a file that a section shows only in part', () => {
    const d = good()
    d.sections[1].snippets.splice(1, 1) // the change at line 40 of A.cs is no longer shown
    const rest = restOf(check(d).document!, facts())
    expect(rest.find((e) => e.path === 'src/A.cs')).toEqual({ mr: 'backend/x!1', path: 'src/A.cs', whole: false, runs: [{ new: [40], old: [] }] })
    expect(rest.some((e) => e.path === 'src/Gone.cs')).toBe(false) // shown in full
  })
  it('counts a change as shown when a snippet has one of its lines, on the side of the snippet', () => {
    const d = good()
    d.sections[1].snippets[0].lines = [11, 11] // the run at lines 10 and 11
    expect(restOf(check(d).document!, facts()).some((e) => e.path === 'src/A.cs')).toBe(false)
    const e = good()
    e.sections[1].snippets[2] = { mr: 'backend/x!1', path: 'src/Gone.cs', lines: [5, 5] } // new side: a removal is not shown by it
    // the snippet is refused by the check, so test the computation on the document directly
    const unchecked = { ...doc(), sections: doc().sections.map((s) => (s.id === 'api' ? { ...s, snippets: [e.sections[1].snippets[2]] } : s)) }
    expect(restOf(unchecked, facts()).find((x) => x.path === 'src/Gone.cs')).toMatchObject({ whole: false, runs: [{ new: [], old: [5, 6] }] })
  })
  it('holds every file when the page has no section', () => {
    const none = check({ summary: 'Nothing to think about.', sections: [] }).document!
    expect(restOf(none, facts())).toHaveLength(6)
  })
  it('holds nothing when the sections show every change', () => {
    const all: SectionsDocument = {
      summary: '',
      sections: [
        {
          id: 'all',
          title: 'All',
          text: 'x',
          snippets: [
            { mr: 'backend/x!1', path: 'src/A.cs', lines: [10, 40] },
            { mr: 'backend/x!1', path: 'src/Gone.cs', lines: [5, 6], side: 'old' },
            { mr: 'backend/x!1', path: 'src/A.Tests.cs', lines: [5, 5] },
            { mr: 'web/y!2', path: 'src/hook.ts', lines: [3, 4] },
            { mr: 'web/y!2', path: 'package-lock.json', lines: [1, 1] },
            { mr: 'web/y!2', path: 'logo.png', lines: [1, 1] }
          ]
        }
      ]
    }
    expect(restOf(all, facts())).toEqual([])
    expect(withRest(all, [])).toBe(all)
  })
  it('is the last section of the page, with the text that the tool wrote, and its files in one list', () => {
    const rest = restOf(doc(), facts())
    const page = withRest(doc(), rest)
    expect(page.sections.map((s) => s.id)).toEqual(['hook', 'api', REST_ID])
    const last = page.sections[2]
    expect(last).toMatchObject({ title: REST_TITLE, text: 'The tests, the lock file and the logo.', leftover: true, snippets: [] })
    expect(last.files).toEqual(rest.map((e) => ({ mr: e.mr, path: e.path })))
  })
  it('says how the files split between the sections and Everything else', () => {
    const d = good()
    d.sections[1].snippets.splice(1, 1)
    const c = check(d).document!
    expect(coverageOf(c, facts(), restOf(c, facts()))).toEqual({ total: 6, inSections: 3, inRest: 4, inBoth: 1 })
  })
})

describe('the retry prompt and the built facts', () => {
  it('words the problem prompt and the failure', () => {
    expect(problemPrompt(['one', 'two'])).toBe(
      'The answer has these problems. Fix every one, and answer with the whole JSON document again, nothing else:\n- one\n- two'
    )
    expect(giveUpMessage(['one', 'two'])).toBe('The answer still had 2 problem(s) after 3 answers:\none\ntwo')
  })
  it('builds the facts from changes: runs of the Code only level, both sides, and no closed change', () => {
    const L = (t: LineObj['t'], o: number | null, n: number | null): LineObj => ({ t, o, n, x: '' })
    const raw = [[L(' ', 1, 1), L('-', 2, null), L('+', null, 2), L(' ', 3, 3), L('+', null, 4), L(' ', 4, 5)]]
    const strict = [[L(' ', 1, 1), L('-', 2, null), L('+', null, 2), L(' ', 3, 3), L('+', null, 4)]]
    const mk = (hunks: LineObj[][], over = {}) => ({
      path: 'a.ts',
      binary: false,
      generated: false,
      levels: { raw: { hunks: raw }, strict: { hunks } },
      ...over
    })
    const info = { diffRefs: { head: 'h1' } }
    const f = sectionFactsOf([
      { key: 'r!1', noDiff: false, snapshot: { info }, files: [mk(strict), mk([], { path: 'noise.ts' }), mk(strict, { path: 'g.ts' })] },
      { key: 'r!2', noDiff: true, snapshot: { info: { diffRefs: { head: 'h2' } } }, files: [] }
    ])
    const a = f.files.get(fileKey('r!1', 'a.ts'))!
    expect(a.runs).toEqual([
      { new: [2], old: [2] },
      { new: [4], old: [] }
    ])
    expect([...a.rawNew]).toEqual([2, 4])
    expect([...a.rawOld]).toEqual([2])
    expect(f.filesByMr.has('r!2')).toBe(false)
    expect(f.heads.get('r!2')).toBe('h2')
  })
})

describe('what a saved page was written for', () => {
  const now = { issues: ['LX-1'], heads: { 'r!1': 'a', 'r!2': 'b' } }
  it('fits when nothing moved', () => {
    expect(basisProblems(now, now)).toEqual([])
  })
  it('does not fit after new commits, a new change, a gone change, other issues or no record', () => {
    expect(basisProblems({ ...now, heads: { ...now.heads, 'r!1': 'old' } }, now)).toEqual(['r!1 has new commits since the page was written.'])
    expect(basisProblems({ ...now, heads: { 'r!1': 'a' } }, now)).toEqual(['r!2 was not in the review when the page was written.'])
    expect(basisProblems({ ...now, heads: { ...now.heads, 'r!3': 'c' } }, now)).toEqual(['r!3 is no longer in the review.'])
    expect(basisProblems({ ...now, issues: [] }, now)).toEqual(['The issues of the review changed since it was written.'])
    expect(basisProblems(null, now)).toHaveLength(1)
  })
})

describe('the code of a snippet', () => {
  const L = (t: LineObj['t'], o: number | null, n: number | null, x = ''): LineObj => ({ t, o, n, x })
  const hunk = [
    L(' ', 1, 1),
    L(' ', 2, 2),
    L(' ', 3, 3),
    L('-', 4, null, 'old'),
    L('+', null, 4, 'new'),
    L(' ', 5, 5),
    L(' ', 6, 6),
    L(' ', 7, 7),
    L('+', null, 8),
    L(' ', 8, 9)
  ]
  it('shows the whole replaced block with two lines of code around it', () => {
    const e = excerptOf([hunk], { lines: [4, 4] })
    expect(e.pieces).toHaveLength(1)
    expect(e.pieces[0].map((l) => `${l.t}${l.o ?? ''}/${l.n ?? ''}`)).toEqual([' 2/2', ' 3/3', '-4/', '+/4', ' 5/5', ' 6/6'])
    expect(e.truncated).toBe(false)
  })
  it('joins two changes that are close and keeps two that are far apart as two pieces', () => {
    expect(excerptOf([hunk], { lines: [4, 8] }).pieces).toHaveLength(1)
    expect(excerptOf([hunk], { lines: [4, 8] }, 0).pieces).toHaveLength(2)
  })
  it('reads the old side for removed code, and finds nothing outside the range', () => {
    expect(excerptOf([hunk], { lines: [4, 4], side: 'old' }).pieces[0].some((l) => l.t === '-')).toBe(true)
    expect(excerptOf([hunk], { lines: [4, 4], side: 'old' }).pieces[0].some((l) => l.t === '+')).toBe(true) // the block comes whole
    expect(excerptOf([hunk], { lines: [50, 60] }).pieces).toEqual([])
  })
  it('stops at the cap of rows', () => {
    const big = Array.from({ length: 30 }, (_, i) => L('+', null, i + 1))
    const e = excerptOf([big], { lines: [1, 30] }, 0, 10)
    expect(e.pieces.flat()).toHaveLength(10)
    expect(e.truncated).toBe(true)
  })
})

describe('Accept and Viewed', () => {
  /** Two sections share the file `shared.ts`. `solo.ts` belongs to the first section only. */
  const doc: SectionsDocument = {
    summary: '',
    sections: [
      {
        id: 'a',
        title: 'A',
        text: '',
        snippets: [
          { mr: 'r!1', path: 'solo.ts', lines: [1, 2] },
          { mr: 'r!1', path: 'shared.ts', lines: [1, 2] }
        ],
        files: []
      },
      { id: 'b', title: 'B', text: '', snippets: [{ mr: 'r!1', path: 'shared.ts', lines: [9, 9] }], files: [{ mr: 'r!2', path: 'other.ts' }] },
      { id: 'c', title: 'C', text: '', snippets: [], files: [{ mr: 'r!2', path: 'x.md' }] }
    ]
  }
  const solo = viewedId('r!1', 'solo.ts')
  const shared = viewedId('r!1', 'shared.ts')
  const other = viewedId('r!2', 'other.ts')
  /** Apply an accept or an un-accept to a state, as the window does. */
  const step = (s: { accepted: Accepted; viewed: Set<string> }, id: string, on: boolean): { accepted: Accepted; viewed: Set<string> } => {
    if (on) {
      const r = acceptSection(doc, s.accepted, id)
      return { accepted: r.accepted, viewed: new Set([...s.viewed, ...r.mark]) }
    }
    const r = unacceptSection(doc, s.accepted, id)
    return { accepted: r.accepted, viewed: new Set([...s.viewed].filter((k) => !r.unmark.includes(k))) }
  }
  const start = { accepted: {} as Accepted, viewed: new Set<string>() }
  const ok = (s: { accepted: Accepted; viewed: Set<string> }, id: string): boolean => isAccepted(doc, s.accepted, s.viewed, id)

  it('names a viewed mark like the Linear view does', () => {
    expect(viewedId('r!1', 'a/b.ts')).toBe('mr:r!1|a/b.ts')
  })
  it('marks every file of a section as viewed, when no other section shows them', () => {
    const s = step(start, 'c', true)
    expect([...s.viewed]).toEqual([viewedId('r!2', 'x.md')])
    expect(ok(s, 'c')).toBe(true)
  })
  it('keeps a file of two sections unviewed until both are accepted, and shows the first section as accepted', () => {
    const s1 = step(start, 'a', true)
    expect(s1.viewed.has(solo)).toBe(true)
    expect(s1.viewed.has(shared)).toBe(false)
    expect(ok(s1, 'a')).toBe(true) // the reviewer accepted it, and the shared file waits for B
    expect(waitingFor(doc, s1.accepted, 'a', { mr: 'r!1', path: 'shared.ts' }).map((s) => s.id)).toEqual(['b'])
    const s2 = step(s1, 'b', true)
    expect(s2.viewed.has(shared)).toBe(true)
    expect(s2.viewed.has(other)).toBe(true)
    expect(ok(s2, 'a') && ok(s2, 'b')).toBe(true)
  })
  it('un-accepting a section takes the viewed mark from its files, and the other accepted section stays accepted', () => {
    let s = step(step(start, 'a', true), 'b', true)
    s = step(s, 'a', false)
    expect(s.viewed.has(solo)).toBe(false)
    expect(s.viewed.has(shared)).toBe(false) // A no longer reads it
    expect(ok(s, 'a')).toBe(false)
    expect(ok(s, 'b')).toBe(true) // the shared file waits for A, which is not accepted
    expect(s.viewed.has(other)).toBe(true)
    expect(s.accepted).not.toHaveProperty('a')
  })
  it('accepting again after an un-accept marks the files again', () => {
    let s = step(step(start, 'a', true), 'b', true)
    s = step(step(s, 'a', false), 'a', true)
    expect(s.viewed.has(shared)).toBe(true)
    expect(ok(s, 'a')).toBe(true)
  })
  it('a file that the reviewer un-marks in the tree takes the section out of the accepted state', () => {
    const s = step(start, 'c', true)
    const un = { ...s, viewed: new Set<string>() }
    expect(ok(un, 'c')).toBe(false)
    const a = step(step(start, 'a', true), 'b', true)
    expect(ok({ ...a, viewed: new Set([...a.viewed].filter((k) => k !== solo)) }, 'a')).toBe(false)
    expect(ok({ ...a, viewed: new Set([...a.viewed].filter((k) => k !== solo)) }, 'b')).toBe(true) // B does not show that file
  })
  it('a section that was rewritten with other files is no longer accepted, and an unknown id changes nothing', () => {
    const s = step(start, 'c', true)
    const rewritten: SectionsDocument = { ...doc, sections: doc.sections.map((x) => (x.id === 'c' ? { ...x, files: [{ mr: 'r!2', path: 'y.md' }] } : x)) }
    expect(isAccepted(rewritten, s.accepted, s.viewed, 'c')).toBe(false)
    expect(acceptSection(doc, start.accepted, 'nope')).toEqual({ accepted: start.accepted, mark: [] })
  })
  it('Everything else is accepted like any section, and a file that is partly in a section is viewed only when both are accepted', () => {
    // solo.ts is shown whole by A. shared.ts is shown in part by A and B, and its other change is in Everything else. lock.json is only there.
    const page = withRest(
      {
        summary: '',
        sections: [
          { id: 'a', title: 'A', text: '', snippets: [{ mr: 'r!1', path: 'shared.ts', lines: [1, 2] }] },
          { id: 'b', title: 'B', text: '', snippets: [{ mr: 'r!1', path: 'solo.ts', lines: [1, 2] }] }
        ]
      },
      [
        { mr: 'r!1', path: 'shared.ts', whole: false, runs: [{ new: [9], old: [] }] },
        { mr: 'r!1', path: 'lock.json', whole: true, runs: [] }
      ]
    )
    const lock = viewedId('r!1', 'lock.json')
    const run = (s: { accepted: Accepted; viewed: Set<string> }, id: string): { accepted: Accepted; viewed: Set<string> } => {
      const r = acceptSection(page, s.accepted, id)
      return { accepted: r.accepted, viewed: new Set([...s.viewed, ...r.mark]) }
    }
    let s = run(start, 'a')
    expect(s.viewed.has(shared)).toBe(false) // Everything else holds the other change of this file
    s = run(s, REST_ID)
    expect(s.viewed.has(lock)).toBe(true)
    expect(s.viewed.has(shared)).toBe(true) // A and Everything else are accepted
    expect(isAccepted(page, s.accepted, s.viewed, REST_ID)).toBe(true)
    const un = unacceptSection(page, s.accepted, REST_ID)
    expect(un.unmark).toEqual([shared, lock])
    expect(waitingFor(page, un.accepted, 'a', { mr: 'r!1', path: 'shared.ts' }).map((x) => x.id)).toEqual([REST_ID])
  })
  it('counts the viewed files of a section', () => {
    expect(sectionProgress(doc.sections[0], new Set([solo]))).toEqual({ viewed: 1, total: 2 })
    expect(sectionProgress(doc.sections[1], new Set())).toEqual({ viewed: 0, total: 2 })
  })
})

describe('the thread of a section', () => {
  const thread = (body: string, over: Partial<Thread> = {}): Thread => ({
    id: 't',
    resolvable: true,
    resolved: false,
    url: 'u',
    position: null,
    notes: [{ id: 1, author: 'ann', body, createdAt: '2026-01-01T00:00:00Z' }] as Thread['notes'],
    ...over
  })
  it('puts the name of the section in the first line of the comment, and reads it back', () => {
    const body = sectionCommentBody('The *page* asks\nfor it', 'Why a hook?')
    expect(body).toBe('**Section: The page asks for it**\n\nWhy a hook?')
    expect(sectionOfBody(body)).toBe('The page asks for it')
    expect(sectionOfBody('A plain comment.')).toBeNull()
    expect(cleanTitle('  a   *b*  ')).toBe('a b')
  })
  it('finds the threads of a section on any change, and never a thread on a line', () => {
    const mine = thread(sectionCommentBody('Tokens', 'x'))
    const found = sectionThreads('Tokens', [
      { key: 'r!1', threads: [thread('plain'), mine, thread(sectionCommentBody('Other', 'x'))] },
      {
        key: 'r!2',
        threads: [
          thread(sectionCommentBody('Tokens', 'y'), { id: 'u' }),
          thread(sectionCommentBody('Tokens', 'z'), { id: 'v', position: { newPath: 'a', oldPath: 'a', newLine: 1, oldLine: null } })
        ]
      }
    ])
    expect(found.map((f) => `${f.mr}:${f.thread.id}`)).toEqual(['r!1:t', 'r!2:u'])
  })
  it('finds the drafts of a section, and no draft on a file', () => {
    const d = (body: string, path: string | null): PendingComment =>
      ({ id: body, mr: 'r!1', diffRefs: { base: '', start: '', head: '' }, path, oldPath: null, oldLine: null, newLine: null, body }) as PendingComment
    const list = [d(sectionCommentBody('Tokens', 'x'), null), d(sectionCommentBody('Tokens', 'y'), 'a.ts'), d('plain', null)]
    expect(sectionDrafts('Tokens', list).map((x) => x.id)).toEqual([list[0].id])
  })
  it('posts on the open change with the most files of the section', () => {
    const s = {
      id: 's',
      title: 'S',
      text: '',
      snippets: [],
      files: [
        { mr: 'r!1', path: 'a' },
        { mr: 'r!2', path: 'a' },
        { mr: 'r!2', path: 'b' }
      ]
    }
    expect(threadTarget(s, () => true)).toBe('r!2')
    expect(threadTarget(s, (k) => k === 'r!1')).toBe('r!1')
    expect(threadTarget(s, () => false)).toBeNull()
  })
})
