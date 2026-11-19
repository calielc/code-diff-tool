import { describe, expect, it } from 'vitest'
import { applyLine, endAnswer, newAnswer, type ChatAnswer } from '../src/shared/chat-reader'
import { cardHeader, lineChatFirstPrompt, parseActions, reviewChatPrompt, splitActions, validateAction, type ReviewFacts } from '../src/shared/prompts'

const o = (x: unknown): string => JSON.stringify(x)

/** The lines of file 04 section 12.2 for the answer T1 + T2. */
const lines = (t1: string, t2: string): string[] => [
  o({ type: 'system', subtype: 'init', session_id: 'S' }),
  o({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } } }),
  o({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/ctx/index.md"}' } }
  }),
  o({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  o({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } }),
  o({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t1 } } }),
  o({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t2 } } }),
  o({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }),
  o({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, result: t1 + t2, session_id: 'S' })
]

describe('the stream reader (file 04 section 2, acceptance check 3 of section 12.3)', () => {
  it('builds the text, walks the status line, and ends with the model and seconds', () => {
    let a: ChatAnswer = newAnswer('Reading the change…')
    const seen: string[] = []
    for (const l of lines('Hel', 'lo')) {
      a = applyLine(a, l, 'sonnet')
      seen.push(a.status)
    }
    expect(a.text).toBe('Hello')
    expect(seen).toContain('Reading…')
    expect(seen).toContain('Reading index.md…')
    expect(a.status).toBe('') // cleared when the text arrived and again at the result
    expect(a.footer).toBe('Sonnet · 1 s')
    expect(a.started).toBe(true)
    expect(a.error).toBeNull()
  })
  it('does not count the system line as started, so a failure before any stream event can start again', () => {
    expect(applyLine(newAnswer(), o({ type: 'system', subtype: 'init' }), 'sonnet').started).toBe(false)
  })
  it('starts a new paragraph for a new text block, and uses the result text when nothing streamed', () => {
    let a = newAnswer()
    for (const l of [
      o({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'One' } } }),
      o({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } }),
      o({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Two' } } })
    ])
      a = applyLine(a, l, 'opus')
    expect(a.text).toBe('One\n\nTwo')
    expect(applyLine(newAnswer(), o({ type: 'result', is_error: false, duration_ms: 400, result: 'From result' }), 'haiku')).toMatchObject({
      text: 'From result',
      footer: 'Haiku · 0 s'
    })
  })
  it('names a search by its pattern and any other tool by its name', () => {
    let a = newAnswer()
    a = applyLine(a, o({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Grep' } } }), 'sonnet')
    expect(a.status).toBe('Searching…')
    a = applyLine(
      a,
      o({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"pattern":"Create' } } }),
      'sonnet'
    )
    a = applyLine(
      a,
      o({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'Async"}' } } }),
      'sonnet'
    )
    a = applyLine(a, o({ type: 'stream_event', event: { type: 'content_block_stop' } }), 'sonnet')
    expect(a.status).toBe('Searching for CreateAsync…')
    a = applyLine(a, o({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Glob' } } }), 'sonnet')
    a = applyLine(a, o({ type: 'stream_event', event: { type: 'content_block_stop' } }), 'sonnet') // cut off: no input
    expect(a.status).toBe('Glob…')
  })
  it('shows an error result, the app error line, and an answer that ended early', () => {
    expect(applyLine(newAnswer(), o({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 10, result: '' }), 'sonnet').error).toBe(
      'Claude stopped: error_max_turns'
    )
    expect(applyLine(newAnswer(), o({ type: 'result', is_error: true, result: 'Rate limited' }), 'sonnet').error).toBe('Rate limited')
    expect(applyLine(newAnswer(), o({ type: 'app_error', message: 'boom' }), 'sonnet').error).toBe('boom')
    expect(endAnswer(newAnswer()).error).toBe('The answer ended before Claude finished.')
    expect(endAnswer({ ...newAnswer(), stopped: true }).error).toBeNull()
    expect(endAnswer({ ...newAnswer(), footer: 'Sonnet · 1 s' }).error).toBeNull()
  })
  it('skips lines that are not JSON', () => {
    const a = newAnswer()
    expect(applyLine(a, 'warning: something', 'sonnet')).toBe(a)
    expect(applyLine(a, '{broken', 'sonnet')).toBe(a)
  })
})

describe('the actions block (file 04 section 6)', () => {
  const facts: ReviewFacts = {
    mrs: new Map([
      ['r!1', { iid: 1, open: true, paths: new Set(['a.ts', 'old.ts']) }],
      ['r!2', { iid: 2, open: false, paths: new Set(['m.ts']) }]
    ]),
    threads: new Map([
      ['t1', { mr: 'r!1', resolvable: true }],
      ['t2', { mr: 'r!1', resolvable: false }],
      ['t3', { mr: 'r!2', resolvable: true }]
    ])
  }
  it('hides the block, also while it still streams, and keeps the text before it', () => {
    expect(splitActions('I propose one.\n\n```code-diff-actions\n[{"type":"open"}]\n```')).toEqual({ text: 'I propose one.', json: '[{"type":"open"}]\n' })
    expect(splitActions('Text\n```code-diff-actions\n[{"ty')).toEqual({ text: 'Text', json: '[{"ty' })
    expect(splitActions('No block here.')).toEqual({ text: 'No block here.', json: null })
  })
  it('gives one invalid card for bad JSON or a non-array, and keeps 50 of 51', () => {
    const bad = [{ action: null, error: "Claude's action list is not valid JSON." }]
    expect(parseActions('not json', facts)).toEqual(bad)
    expect(parseActions('{"a":1}', facts)).toEqual(bad)
    const many = JSON.stringify(Array.from({ length: 51 }, () => ({ type: 'open', mr: 'r!1', path: 'a.ts' })))
    expect(parseActions(many, facts)).toHaveLength(50)
  })
  it.each([
    [1, 'Not an action.'],
    [{ type: 'dance' }, 'Unknown action type dance.'],
    [{ type: 'resolve', thread: 'nope' }, 'No such thread in this review.'],
    [{ type: 'resolve', thread: 't2' }, 'This note cannot be resolved.'],
    [{ type: 'resolve', thread: 't3' }, 'The MR is not open.'],
    [{ type: 'comment', mr: 'x!9', path: 'a.ts', body: 'b' }, 'No MR x!9 in this review.'],
    [{ type: 'comment', mr: 'r!2', path: 'm.ts', body: 'b' }, 'The MR is not open, so it takes no new comment.'],
    [{ type: 'comment', mr: 'r!1', path: 'zzz.ts', body: 'b' }, '!1 does not change zzz.ts.'],
    [{ type: 'comment', mr: 'r!1', path: 'a.ts', line: 0, body: 'b' }, 'The line is not a line number.'],
    [{ type: 'comment', mr: 'r!1', path: 'a.ts', line: 1.5, body: 'b' }, 'The line is not a line number.'],
    [{ type: 'comment', mr: 'r!1', path: 'a.ts', body: '  ' }, 'The comment is empty.'],
    [{ type: 'open', mr: 'r!1', path: 'zzz.ts' }, '!1 does not change zzz.ts.'],
    [{ type: 'viewed', mr: 'r!1', paths: [] }, 'No files named.'],
    [{ type: 'viewed', mr: 'r!1', paths: ['a.ts', 'q.ts', 'z.ts'] }, '!1 does not change q.ts, z.ts.']
  ])('refuses %j with its message', (entry, message) => {
    expect(validateAction(entry, facts)).toEqual({ action: null, error: message })
  })
  it('accepts good actions, with the old path of a renamed file allowed and a whole-file comment', () => {
    expect(validateAction({ type: 'comment', mr: 'r!1', path: 'old.ts', line: 12, body: 'Check null.' }, facts).error).toBeNull()
    expect(validateAction({ type: 'comment', mr: 'r!1', path: 'a.ts', line: null, body: 'Whole file.' }, facts).action).toMatchObject({ line: null })
    expect(validateAction({ type: 'open', mr: 'r!1', path: 'a.ts', line: 3 }, facts).error).toBeNull()
    expect(validateAction({ type: 'viewed', mr: 'r!1', paths: ['a.ts'] }, facts).error).toBeNull()
    expect(validateAction({ type: 'resolve', thread: 't1' }, facts).action).toMatchObject({ resolved: true })
    expect(validateAction({ type: 'resolve', thread: 't1', resolved: false }, facts).action).toMatchObject({ resolved: false })
  })
  it('writes the card headers', () => {
    const iid = (k: string): string | undefined => k.split('!')[1]
    expect(cardHeader({ type: 'comment', mr: 'r!105', path: 'a.ts', line: 42, body: 'x' }, iid)).toBe('Comment · !105 a.ts:42')
    expect(cardHeader({ type: 'open', mr: 'r!105', path: 'a.ts' }, iid)).toBe('Open · !105 a.ts')
    expect(cardHeader({ type: 'viewed', mr: 'r!105', paths: ['a', 'b'] }, iid)).toBe('Mark viewed · !105 2 files')
    expect(cardHeader({ type: 'viewed', mr: 'r!105', paths: ['a'] }, iid)).toBe('Mark viewed · !105 1 file')
    expect(cardHeader({ type: 'resolve', thread: 'r!9', resolved: false }, iid)).toBe('Unresolve thread on !9 · changes the review at once')
  })
})

describe('the chat prompts (file 04 section 3)', () => {
  it('builds the first turn of the line chat in the documented order', () => {
    const p = lineChatFirstPrompt({
      path: 'src/A.cs',
      status: 'R',
      oldPath: 'src/Old.cs',
      mrs: [{ iid: 105, title: 'Fix it', description: '  Why.  ' }],
      combined: false,
      rows: [
        { t: '-', o: 8, n: null, x: 'old' },
        { t: '+', o: null, n: 8, x: 'new' }
      ],
      hunks: [
        [
          { t: ' ', o: 7, n: 7, x: 'ctx' },
          { t: '-', o: 8, n: null, x: 'old' },
          { t: '+', o: null, n: 8, x: 'new' }
        ]
      ],
      question: 'Why?'
    })
    expect(p).toBe(
      [
        'I review a merge or pull request, and I have a question about some lines of the file `src/A.cs`, renamed from `src/Old.cs`. Your working folder holds the repo at the head of MR !105.',
        '## MR !105: Fix it\n\nWhy.',
        '## The lines I ask about\n\nOld line number, new line number, then - for a removed line or + for an added line.\n\n```\n    8       - old\n          8 + new\n```',
        '## The whole diff of the file\n\n```diff\n@@ -7 +7 @@\n ctx\n-old\n+new\n```',
        '## My question\n\nWhy?'
      ].join('\n\n')
    )
  })
  it('says the plural, the combined place, and the deleted-file note', () => {
    const p = lineChatFirstPrompt({
      path: 'a',
      status: 'D',
      oldPath: 'a',
      mrs: [
        { iid: 1, title: 't', description: '' },
        { iid: 2, title: 'u', description: 'd' }
      ],
      combined: true,
      rows: [],
      hunks: [],
      question: 'q'
    })
    expect(p).toContain(
      'I review merge or pull requests, and I have a question about some lines of the file `a`, which the change deletes, so it is not in the working folder. Your working folder holds the repo at the merge of the MRs it combines (!1, !2).'
    )
    expect(p).toContain('## MR !1: t\n\n(no description)')
  })
  it('builds the review chat first turn and the follow-up', () => {
    const base = { mrCount: 3, title: 'LX-1: Thing', screen: { path: 'a.ts', where: 'MR !7 (backend/x)' }, question: 'What changed?' }
    expect(reviewChatPrompt({ ...base, resume: false })).toBe(
      'I review these merge or pull requests as one change: LX-1: Thing. Read `index.md` first.\n\nI now look at `a.ts` in MR !7 (backend/x).\n\n## My question\n\nWhat changed?'
    )
    expect(reviewChatPrompt({ ...base, resume: true })).toBe('I now look at `a.ts` in MR !7 (backend/x).\n\nWhat changed?')
    expect(reviewChatPrompt({ ...base, mrCount: 1, screen: null, resume: false })).toBe(
      'I review this merge or pull request: LX-1: Thing. Read `index.md` first.\n\n## My question\n\nWhat changed?'
    )
    expect(reviewChatPrompt({ ...base, screen: null, resume: true })).toBe('What changed?')
  })
})
