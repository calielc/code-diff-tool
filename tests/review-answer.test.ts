import { describe, expect, it } from 'vitest'
import { checkReviewAnswer, type AnswerMr } from '../src/shared/review-answer'

const refs = { base: 'b'.repeat(40), start: 's'.repeat(40).replace(/s/g, '1'), head: 'a'.repeat(40) }
const mrs = (): AnswerMr[] => [
  {
    key: 'backend/x!1',
    state: 'opened',
    diffRefs: refs,
    files: [
      {
        path: 'src/A.cs',
        oldPath: 'src/Old.cs',
        lines: Array.from({ length: 20 }, (_, i) => `line${i + 1}`),
        levels: {
          raw: {
            hunks: [
              [
                { t: ' ', o: 9, n: 9, x: 'ctx' },
                { t: '-', o: 10, n: null, x: 'removed' },
                { t: '+', o: null, n: 10, x: 'added' }
              ]
            ]
          }
        }
      }
    ]
  },
  { key: 'backend/x!2', state: 'merged', diffRefs: refs, files: [] }
]
const run = (answer: unknown, o: { skill?: string | null; criteria?: string[] } = {}): ReturnType<typeof checkReviewAnswer> =>
  checkReviewAnswer({
    mrs: mrs(),
    criteria: o.criteria ?? [],
    skill: o.skill === undefined ? 'review-code' : o.skill,
    text: typeof answer === 'string' ? answer : JSON.stringify(answer)
  })
const finding = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  mr: 'backend/x!1',
  path: 'src/A.cs',
  newLine: 10,
  lens: 'Correctness',
  severity: 'blocking',
  body: 'Check null.',
  ...o
})

describe('findings become drafts (file 04 section 7.10)', () => {
  it('makes a line comment with the line numbers, the text and the documented body', () => {
    const r = run({ findings: [finding()], checklist: [], report: 'Short.' })
    expect(r.problems).toEqual([])
    expect(r.report).toBe('Short.')
    const d = r.drafts[0]
    expect(d.id).toMatch(/^cr[0-9a-f]{20}$/)
    expect(d).toMatchObject({
      mr: 'backend/x!1',
      view: 'mr',
      diffRefs: refs,
      path: 'src/A.cs',
      oldPath: 'src/Old.cs',
      oldLine: null,
      newLine: 10,
      combinedPath: null,
      lineText: 'added',
      body: '🤖 Correctness, blocking: Check null.',
      claude: { skill: 'review-code', lens: 'Correctness', severity: 'blocking' }
    })
  })
  it('makes a removed-line comment from oldLine, and finds the file by its old path', () => {
    const d = run({ findings: [finding({ path: 'src/Old.cs', newLine: undefined, oldLine: 10 })] }).drafts[0]
    expect(d).toMatchObject({ oldLine: 10, newLine: null, lineText: 'removed', path: 'src/A.cs' })
  })
  it('makes a file comment when no hunk holds the line, a comment on the MR with no path, and keeps the path text when the file is not changed', () => {
    expect(run({ findings: [finding({ newLine: 15 })] }).drafts[0]).toMatchObject({
      path: 'src/A.cs',
      newLine: null,
      body: '🤖 Correctness, blocking: Line 15: Check null.'
    })
    expect(run({ findings: [finding({ path: undefined, newLine: undefined })] }).drafts[0]).toMatchObject({
      path: null,
      oldPath: null,
      body: '🤖 Correctness, blocking: Check null.'
    })
    expect(run({ findings: [finding({ path: 'docs/Other.md', newLine: 3 })] }).drafts[0]).toMatchObject({
      path: null,
      body: '🤖 Correctness, blocking: `docs/Other.md`, line 3: Check null.'
    })
  })
  it.each([
    [{ mr: 'x!9' }, 'finding 1: `x!9` is not the key of an MR in `index.md`'],
    [{ lens: '' }, 'finding 1: `lens` is empty'],
    [{ severity: 'major' }, 'finding 1: `severity` is `major`, not `blocking` or `suggestion`'],
    [{ body: '  ' }, 'finding 1: `body` is empty'],
    [{ newLine: 0 }, 'finding 1: `newLine` is 0, not a line number'],
    [{ newLine: 'ten' }, 'finding 1: `newLine` is ten, not a line number'],
    [{ newLine: 99 }, 'finding 1: `src/A.cs` has 20 lines, so it has no new line 99']
  ])('refuses %j with its message and makes no draft', (o, message) => {
    const r = run({ findings: [finding(o)] })
    expect(r.problems).toEqual([message])
    expect(r.drafts).toEqual([])
  })
  it('collects the problems of every finding, and refuses a finding that is not an object', () => {
    expect(run({ findings: [finding({ body: '' }), 5, finding({ lens: '' })] }).problems).toEqual([
      'finding 1: `body` is empty',
      'finding 2 is not an object',
      'finding 3: `lens` is empty'
    ])
  })
  it('refuses a missing list, no JSON and broken JSON', () => {
    expect(run({}).problems).toEqual(['`findings` is missing or not a list. Give `[]` when there is no finding.'])
    expect(run('Sorry.').problems).toEqual(['The answer holds no JSON object.'])
    expect(run('{ "findings": [ }').problems[0]).toMatch(/^The answer is not valid JSON: /)
    expect(run('Here:\n```json\n{ "findings": [], }\n```').problems).toEqual([])
  })
})

describe('the checklist (file 04 section 7.10)', () => {
  const crit = ['LX-1 AC1', 'LX-1 AC2']
  const entry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    ac: 'LX-1 AC1',
    state: 'covered',
    why: 'It is there.',
    evidence: [
      { mr: 'backend/x!1', path: 'src/Old.cs', newLine: 10 },
      { mr: 'backend/x!1', path: 'nope.cs', newLine: 1 }
    ],
    ...o
  })

  it('keeps evidence of changed files by their new path, and drops a link to a file that is not changed', () => {
    const r = run({ findings: [], checklist: [entry(), entry({ ac: 'LX-1 AC2', state: 'missing', why: 'No.' })] }, { criteria: crit })
    expect(r.problems).toEqual([])
    expect(r.checklist[0].evidence).toEqual([{ mr: 'backend/x!1', path: 'src/A.cs', newLine: 10 }])
    expect(r.checklist[0].draft).toBeNull()
  })
  it.each([
    [[entry({ ac: 'LX-9 AC1' }), entry({ ac: 'LX-1 AC2' })], 'checklist entry 1: no issue file has the criterion `LX-9 AC1`'],
    [[entry(), entry()], 'checklist entry 2: LX-1 AC1 is in the checklist twice'],
    [[entry({ state: 'done' }), entry({ ac: 'LX-1 AC2' })], 'checklist entry 1: the state of LX-1 AC1 is `done`, not `covered`, `partial` or `missing`'],
    [[entry({ why: '' }), entry({ ac: 'LX-1 AC2' })], 'checklist entry 1: the `why` of LX-1 AC1 is empty'],
    [[entry()], 'the checklist misses LX-1 AC2: give every criterion of the issue files exactly once']
  ])('refuses %j', (list, message) => {
    expect(run({ findings: [], checklist: list }, { criteria: crit }).problems).toContain(message)
  })
  it('wants a checklist only when there are criteria', () => {
    expect(run({ findings: [] }, { criteria: crit }).problems).toEqual([
      '`checklist` is missing or not a list: give one entry per criterion of the issue files.'
    ])
    expect(run({ findings: [] }, { criteria: [] }).problems).toEqual([])
  })
})

describe('the acceptance criteria check and its suggested comments (file 04 section 8.4)', () => {
  const crit = ['LX-1 AC1']
  const suggestion = { mr: 'backend/x!1', path: 'src/A.cs', newLine: 10, body: 'Add the missing case.' }
  const ac = (state: string, comment: unknown): ReturnType<typeof run> =>
    run({ checklist: [{ ac: 'LX-1 AC1', state, why: 'Why.', evidence: [], comment }] }, { skill: null, criteria: crit })

  it('makes a Spec draft for a missing criterion (blocking) and a partial one (suggestion), tied to the criterion', () => {
    const missing = ac('missing', suggestion)
    expect(missing.problems).toEqual([])
    expect(missing.checklist[0].draft).toMatchObject({
      body: '🤖 Spec, blocking: Add the missing case.',
      claude: { skill: 'LX-1 AC1', lens: 'Spec', severity: 'blocking', ac: 'LX-1 AC1' }
    })
    expect(ac('partial', suggestion).checklist[0].draft).toMatchObject({ body: '🤖 Spec, suggestion: Add the missing case.' })
    expect(missing.drafts).toEqual([]) // a check saves no comments itself
  })
  it('makes no draft for a covered criterion, for an MR that is not open, or for an invalid suggestion, and none of these is a problem', () => {
    expect(ac('covered', suggestion).checklist[0].draft).toBeNull()
    expect(ac('missing', { ...suggestion, mr: 'backend/x!2' }).checklist[0].draft).toBeNull() // merged
    const dropped = ac('missing', { ...suggestion, body: '' })
    expect(dropped.checklist[0].draft).toBeNull()
    expect(dropped.problems).toEqual([])
    expect(ac('missing', null).checklist[0].draft).toBeNull()
  })
  it('has no findings to check', () => {
    expect(run({ checklist: [] }, { skill: null, criteria: [] }).problems).toEqual([])
  })
})
