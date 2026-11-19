import { describe, expect, it } from 'vitest'
import { adfToText, criteriaOf } from '../src/shared/adf'
import {
  criteriaFromFile,
  descriptionPreview,
  initialsOf,
  keySortValue,
  sortIssues,
  issueBody,
  issueFile,
  type IssueData,
  type IssueRow
} from '../src/shared/issues'
import { parseIssueKey } from '../src/shared/review'

const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content })
const p = (...c: unknown[]): unknown => ({ type: 'paragraph', content: c })
const t = (text: string): unknown => ({ type: 'text', text })
const li = (...c: unknown[]): unknown => ({ type: 'listItem', content: c })
const ul = (...items: string[]): unknown => ({ type: 'bulletList', content: items.map((i) => li(p(t(i)))) })
const h = (level: number, text: string): unknown => ({ type: 'heading', attrs: { level }, content: [t(text)] })

describe('ADF to text (file 01 section 3.4)', () => {
  it('writes headings, paragraphs and bullet lists with blank lines', () => {
    expect(adfToText(doc(h(2, 'Goal'), p(t('Do   the\nthing')), ul('one', 'two')))).toBe('## Goal\n\nDo the thing\n\n- one\n- two')
  })
  it('numbers an ordered list from attrs.order, marks tasks, and nests lists with two more spaces', () => {
    const ordered = { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('a'))), li(p(t('b')))] }
    const tasks = {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] }
      ]
    }
    const nested = { type: 'bulletList', content: [li(p(t('parent')), ul('child'))] }
    expect(adfToText(doc(ordered, tasks, nested))).toBe('3. a\n4. b\n\n- [x] done\n- [ ] todo\n\n- parent\n  - child')
  })
  it('handles a panel with a title, a code block, a table, a quote, a rule and media (acceptance check 11)', () => {
    const out = adfToText(
      doc(
        { type: 'panel', attrs: { title: 'Note' }, content: [p(t('inside'))] },
        { type: 'codeBlock', content: [t('a = 1\nb = 2')] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [p(t('a'))] },
                { type: 'tableCell', content: [p(t('b'))] }
              ]
            }
          ]
        },
        { type: 'blockquote', content: [p(t('quoted'))] },
        { type: 'rule' },
        { type: 'mediaSingle', content: [{ type: 'media' }] }
      )
    )
    expect(out).toBe('Note\n\ninside\n\n```\na = 1\nb = 2\n```\n\n| a | b |\n\n> quoted\n\n---\n\n[attachment]')
  })
  it('writes mentions, dates and cards as text, and ignores marks', () => {
    const para = p(
      t('Ping '),
      { type: 'mention', attrs: { text: '@ann' } },
      t(' on '),
      { type: 'date', attrs: { timestamp: 1700000000000 } },
      t(' '),
      { type: 'inlineCard', attrs: { url: 'https://x.io' } },
      { type: 'text', text: ' bold', marks: [{ type: 'strong' }] }
    )
    expect(adfToText(doc(para))).toBe('Ping @ann on 2023-11-14 https://x.io bold')
  })
  it('gives nothing for a value that is not an ADF document', () => {
    expect(adfToText(null)).toBe('')
    expect(adfToText({ type: 'text' })).toBe('')
  })
})

describe('acceptance criteria (file 01 section 3.5)', () => {
  it('reads the list under an Acceptance criteria heading and stops at the next heading', () => {
    const d = doc(
      h(2, 'Acceptance criteria'),
      { type: 'orderedList', content: [li(p(t('1. User sees the banner'))), li(p(t('Banner hides after close')))] },
      h(2, 'Notes'),
      ul('not a criterion')
    )
    expect(criteriaOf(d)).toEqual(['User sees the banner', 'Banner hides after close'])
  })
  it('reads a short label paragraph followed by a list and stops at the next heading', () => {
    expect(criteriaOf(doc(p(t('Acceptance criteria:')), ul('first', '[x] second'), h(2, 'Notes'), p(t('later'))))).toEqual(['first', 'second'])
  })
  it('gives none for AC1 alone, and none when there is no start', () => {
    expect(criteriaOf(doc(p(t('AC1')), ul('x')))).toEqual([])
    expect(criteriaOf(doc(h(2, 'Goal'), ul('x')))).toEqual([])
  })
  it('uses paragraphs when the section has no list, and looks inside panels', () => {
    expect(criteriaOf(doc({ type: 'panel', content: [h(3, 'Done when'), p(t('It works')), p(t('It is fast'))] }))).toEqual(['It works', 'It is fast'])
  })
  it('ends a level-2 section at a level-1 heading', () => {
    expect(criteriaOf(doc(h(2, 'AC'), ul('a'), h(1, 'Next'), ul('b')))).toEqual(['a'])
  })
})

describe('issue helpers (file 01 section 3)', () => {
  const key = (v: string): string | null => parseIssueKey(v)
  it('normalizes keys and Jira URLs (acceptance check 1)', () => {
    expect([
      key('lx2813'),
      key('LX-2813'),
      key('lx-2813'),
      key('https://acme.atlassian.net/browse/LX-2813'),
      key('https://acme.atlassian.net/jira/software/projects/LX/boards/1?selectedIssue=LX-2813'),
      key('abc')
    ]).toEqual(['LX-2813', 'LX-2813', 'LX-2813', 'LX-2813', 'LX-2813', null])
  })
  it('builds the issue body with comments and the empty cases', () => {
    expect(issueBody({ description: '', comments: [] })).toBe('## Description\n\nNo description.\n\n## Comments\n\nNo comments.')
    expect(issueBody({ description: 'Text', comments: [{ author: '', created: '2026-01-01', body: 'Hi' }] })).toBe(
      '## Description\n\nText\n\n## Comments\n\n### Someone, 2026-01-01\n\nHi'
    )
  })
  it('cuts a preview at 200 characters and strips list marks', () => {
    expect(descriptionPreview('## Goal\n- one\n1. two\n[x] three')).toBe('Goal one two three')
    expect(descriptionPreview('x'.repeat(250))).toBe('x'.repeat(200) + '…')
    expect(initialsOf('ann.lee_smith')).toBe('AL')
  })
  it('sorts LX-99 before LX-100 and puts empty values last in both directions', () => {
    const row = (key: string, o: Partial<IssueRow> = {}): IssueRow => ({
      source: 'jira',
      key,
      url: null,
      type: null,
      title: key,
      status: null,
      assignee: null,
      description: '',
      criteria: [],
      error: null,
      ...o
    })
    expect(keySortValue('LX-99') < keySortValue('LX-100')).toBe(true)
    const rows = [row('LX-1', { assignee: 'Zed' }), row('LX-2'), row('LX-3', { assignee: 'Amy' })]
    expect(sortIssues(rows, 'assignee', 'asc').map((r) => r.key)).toEqual(['LX-3', 'LX-1', 'LX-2'])
    expect(sortIssues(rows, 'assignee', 'desc').map((r) => r.key)).toEqual(['LX-1', 'LX-3', 'LX-2'])
  })
  const data = (o: Partial<IssueData> = {}): IssueData => ({
    source: 'jira',
    key: 'LX-1',
    url: 'https://j/browse/LX-1',
    type: 'Story',
    status: 'Done',
    assignee: null,
    title: 'Title',
    description: 'd',
    criteria: ['one', 'two'],
    error: null,
    updated: null,
    comments: [],
    attachments: [],
    ...o
  })
  it('builds the three kinds of issue file', () => {
    expect(issueFile(data(), '## What it does\n\nx', null)).toBe(
      '# LX-1: Title\n\n**Type:** Story · **Status:** Done · **Assignee:** unassigned · [Open in Jira](https://j/browse/LX-1)\n\n## What it does\n\nx'
    )
    expect(issueFile(data(), null, 'claude is not installed')).toContain('No summary: claude is not installed.\n\n## AC1\n\none\n\n## AC2\n\ntwo')
    expect(issueFile(data({ criteria: [] }), null, null)).toContain('No summary: claude did not write one.\n\nNo acceptance criteria.')
    expect(issueFile(data({ error: 'boom' }), null, null)).toBe('# LX-1\n\n[Open in Jira](https://j/browse/LX-1)\n\nJira did not give this issue: boom')
  })
  it('reads criteria back from an issue file, named by key and number', () => {
    const file = '# LX-1: T\n\n## AC1: Banner shows\n\nbody\n\n## AC2\n\nSecond one\nwraps\n\n## AC1\n\ndup'
    expect(criteriaFromFile('LX-1', file)).toEqual([
      { name: 'LX-1 AC1', text: 'Banner shows' },
      { name: 'LX-1 AC2', text: 'Second one wraps' }
    ])
  })
})
