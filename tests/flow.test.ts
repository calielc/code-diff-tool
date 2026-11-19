import { describe, expect, it } from 'vitest'
import { checkFlow, fileKey, flowFactsOf, giveUpMessage, globMatch, problemPrompt, relaxJson, type FlowFacts } from '../src/shared/flow'

const facts = (): FlowFacts => ({
  repos: new Set(['backend/x', 'web/y']),
  files: new Map([
    [fileKey('backend/x!1', 'src/A.cs'), new Set([10, 11, 12])],
    [fileKey('backend/x!1', 'src/A.Tests.cs'), new Set([5])],
    [fileKey('web/y!2', 'src/hook.ts'), new Set([3, 4])],
    [fileKey('web/y!2', 'docs/README.md'), new Set([1])]
  ]),
  filesByMr: new Map([
    ['backend/x!1', ['src/A.cs', 'src/A.Tests.cs']],
    ['web/y!2', ['src/hook.ts', 'docs/README.md']]
  ])
})

/** A document that passes every rule. Each test breaks one thing. */
const good = (): Record<string, any> => ({
  summary: 'A user sees the card.',
  lanes: ['web/y', 'backend/x'],
  steps: [
    {
      id: 'hook',
      mr: 'web/y!2',
      path: 'src/hook.ts',
      lines: [[3, 4]],
      title: 'useCard()',
      kind: 'new',
      text: 'Calls it.',
      next: [{ to: 'ctl', label: 'GET /card' }]
    },
    { id: 'ctl', mr: 'backend/x!1', path: 'src/A.cs', lines: [[10, 12]], title: 'A.Get()', kind: 'changed', text: 'Answers it.' },
    { id: 'lib', repo: 'backend/x', title: 'Base', kind: 'existing', text: 'Unchanged.' }
  ],
  review: [
    { mr: 'web/y!2', path: 'src/hook.ts', line: 3, why: 'Check the path.' },
    { mr: 'backend/x!1', path: 'src/A.cs', line: 11, why: 'Check null.' }
  ],
  skip: [
    { why: 'Tests of the code above', items: [{ mr: 'backend/x!1', pattern: '**/*.Tests.cs' }] },
    { why: 'Documentation', items: [{ mr: 'web/y!2', path: 'docs/README.md' }] }
  ]
})
const check = (doc: unknown): ReturnType<typeof checkFlow> => checkFlow(typeof doc === 'string' ? doc : JSON.stringify(doc), facts())

describe('a good flow', () => {
  it('passes, also inside prose and a code fence', () => {
    const r = check('Here it is:\n```json\n' + JSON.stringify(good()) + '\n```\nDone.')
    expect(r.problems).toEqual([])
    expect(r.flow?.steps).toHaveLength(3)
  })
  it('accepts comments and trailing commas, and gives back plain data', () => {
    const text =
      '{ // note\n "summary": "s", /* c */ "lanes": ["web/y",], "steps": [], "review": [\n' +
      '{"mr":"web/y!2","path":"src/hook.ts","line":3,"why":"w"},{"mr":"web/y!2","path":"docs/README.md","why":"w"},' +
      '{"mr":"backend/x!1","path":"src/A.cs","why":"w"},{"mr":"backend/x!1","path":"src/A.Tests.cs","why":"w"},],\n "skip": [] }'
    expect(check(text).problems).toEqual([])
    expect(relaxJson('{"a":"// not a comment","b":[1,],}')).toBe('{"a":"// not a comment","b":[1]}')
  })
})

describe('every rule of the checker has its exact message (file 04 section 5.4)', () => {
  it('no JSON object, or JSON that is not a flow', () => {
    expect(check('nothing here').problems).toEqual(['The answer holds no JSON object.'])
    expect(check('{ broken }').problems[0]).toMatch(/^The answer is not a valid flow document: /)
    expect(check({ steps: 'no' }).problems[0]).toBe('The answer is not a valid flow document: steps is not a list.')
    const d = good()
    d.steps[0].lines = [[1, 'x']]
    expect(check(d).problems[0]).toBe('The answer is not a valid flow document: step 1: a lines pair is not two numbers.')
  })
  it('a step with a file that is not changed, and a step whose lines hold no change', () => {
    const d = good()
    d.steps[1].path = 'src/Nope.cs'
    d.steps[0].lines = [[100, 110]]
    expect(check(d).problems).toEqual(['step hook: lines 100-110 of src/hook.ts hold no change', 'step ctl: backend/x!1 has no changed file src/Nope.cs'])
  })
  it('a step with no path in a repo that is not one of these, and an edge to a step that is not there', () => {
    const d = good()
    d.steps[2].repo = 'other/z'
    d.steps[0].next.push({ to: 'ghost', label: 'x' })
    expect(check(d).problems).toEqual(['step hook: edge to unknown step ghost', 'step lib: no path, and other/z is not a repo of these MRs'])
  })
  it('a lane that is not a repo', () => {
    const d = good()
    d.lanes.push('nowhere')
    expect(check(d).problems).toEqual(['lane nowhere is not a repo of these MRs'])
  })
  it('a review item on a line with no change, and on a file with none', () => {
    const d = good()
    d.review[0].line = 99
    d.review[1].path = 'src/Missing.cs'
    const p = check(d).problems
    expect(p).toContain('review 1: lines 99-99 of src/hook.ts hold no change')
    expect(p).toContain('review 2: backend/x!1 has no changed file src/Missing.cs')
    expect(p).toContain('backend/x!1 src/A.cs is neither in the review order nor in a skip group')
  })
  it('a skip item that matches nothing', () => {
    const d = good()
    d.skip[0].items.push({ mr: 'backend/x!1', pattern: 'none/**' }, { mr: 'backend/x!1' })
    expect(check(d).problems).toEqual([
      `skip 'Tests of the code above': {"mr":"backend/x!1","pattern":"none/**"} matches no changed file`,
      `skip 'Tests of the code above': {"mr":"backend/x!1"} matches no changed file`
    ])
  })
  it('a file in no place, and a file placed twice', () => {
    const d = good()
    d.skip.pop() // README is now in no place
    d.skip[0].items.push({ mr: 'backend/x!1', path: 'src/A.cs' }) // A.cs is in review and in skip
    const p = check(d).problems
    expect(p).toContain('web/y!2 docs/README.md is neither in the review order nor in a skip group')
    expect(p).toContain("backend/x!1 src/A.cs is placed twice: review 2, skip 'Tests of the code above'")
  })
  it('counts a removed line by its old number', () => {
    const f = facts()
    f.files.set(fileKey('backend/x!1', 'src/A.cs'), new Set([50]))
    const d = good()
    d.steps[1].lines = [[50, 50]]
    d.review[1].line = 50
    expect(checkFlow(JSON.stringify(d), f).problems).toEqual([])
  })
})

describe('globs, the retry prompt and the built facts', () => {
  it('matches * within a folder, ** across folders, and the whole path', () => {
    expect(globMatch('src/openapi-docs/*', 'src/openapi-docs/a.json')).toBe(true)
    expect(globMatch('src/openapi-docs/*', 'src/openapi-docs/deep/a.json')).toBe(false)
    expect(globMatch('src/**', 'src/a/b/c.ts')).toBe(true)
    expect(globMatch('**/*.Tests.cs', 'a/b/X.Tests.cs')).toBe(true)
    expect(globMatch('a.b', 'aXb')).toBe(false) // a dot is literal
    expect(globMatch('src', 'src/a')).toBe(false)
    expect(globMatch('', 'a')).toBe(false)
  })
  it('words the problem prompt and the failure', () => {
    expect(problemPrompt(['one', 'two'])).toBe(
      'The answer has these problems. Fix every one, and answer with the whole JSON document again, nothing else:\n- one\n- two'
    )
    expect(giveUpMessage(['one', 'two'])).toBe('The answer still had 2 problem(s) after 3 answers:\none\ntwo')
  })
  it('builds the facts from changes, leaving out a closed one', () => {
    const hunks = [
      [
        { t: ' ', o: 1, n: 1 },
        { t: '-', o: 2, n: null },
        { t: '+', o: null, n: 2 }
      ]
    ]
    const f = flowFactsOf([
      { key: 'r!1', repo: 'r', noDiff: false, files: [{ path: 'a.ts', levels: { raw: { hunks } } }] },
      { key: 'r!2', repo: 'r', noDiff: true, files: [] }
    ])
    expect(f.repos).toEqual(new Set(['r']))
    expect([...f.files.get(fileKey('r!1', 'a.ts'))!].sort()).toEqual([2])
    expect(f.filesByMr.has('r!2')).toBe(false)
  })
})
