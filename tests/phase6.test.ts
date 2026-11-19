import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIssue } from '../src/main/clients/jira'
import { addIssues, getIssueFile, setJiraAccessProvider } from '../src/main/services/issues'
import { reviewDir } from '../src/main/services/reviews'
import type { FakeForge, Fixture } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

let forge: FakeForge | undefined
let root: string
const access = { site: 'acme.atlassian.net', cred: { token: 'jira-token', email: 'me@example.com' } }

const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content })
const p = (text: string): unknown => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const li = (text: string): unknown => ({ type: 'listItem', content: [p(text)] })
const description = doc(
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
  { type: 'bulletList', content: [li('Learner sees the card'), li('Card links to the course')] }
)

const issue = (key: string, over: Record<string, unknown> = {}): Fixture => ({
  [`GET rest/api/3/issue/${key}`]: {
    json: {
      key,
      fields: {
        summary: `Title of ${key}`,
        issuetype: { name: 'Story' },
        status: { name: 'In Review' },
        assignee: { displayName: 'Ann Lee' },
        updated: '2026-11-10T15:23:11.465+0100',
        description,
        attachment: [{ id: 5, filename: 'a.png', mimeType: 'image/png', size: 10 }, { filename: 'no-id.txt' }],
        ...over
      }
    }
  },
  [`GET rest/api/3/issue/${key}/comment`]: {
    json: { total: 1, comments: [{ author: { displayName: 'Bob' }, created: '2026-11-11T10:00:00.000+0100', body: doc(p('Looks right')) }] }
  }
})

beforeEach(async () => {
  forge = await useFakeForge()
  root = mkdtempSync(join(tmpdir(), 'codediff-p6-'))
  setJiraAccessProvider(() => access)
})
afterEach(async () => {
  setJiraAccessProvider(() => null)
  await stopFakeForge(forge)
})

describe('Jira over REST (file 05 section 3.3)', () => {
  it('reads the fields, the description text, the criteria, the comments and the attachments', async () => {
    forge!.setFixture(issue('LX-1'))
    const t = await readIssue(access, 'LX-1')
    expect(t).toMatchObject({
      key: 'LX-1',
      url: 'https://acme.atlassian.net/browse/LX-1',
      type: 'Story',
      status: 'In Review',
      assignee: 'Ann Lee',
      title: 'Title of LX-1',
      error: null,
      updated: '2026-11-10T15:23:11.465+0100'
    })
    expect(t.description).toBe('## Acceptance criteria\n\n- Learner sees the card\n- Card links to the course')
    expect(t.criteria).toEqual(['Learner sees the card', 'Card links to the course'])
    expect(t.comments).toEqual([{ author: 'Bob', created: '2026-11-11T10:00:00.000+0100', body: 'Looks right' }])
    expect(t.attachments).toEqual([{ id: '5', filename: 'a.png', mimeType: 'image/png', size: 10 }]) // an attachment with no id is dropped
  })
  it('sends the account email and token as Basic auth', async () => {
    forge!.setFixture(issue('LX-1'))
    await readIssue(access, 'LX-1')
    expect(forge!.calls[0].auth).toBe(`Basic ${Buffer.from('me@example.com:jira-token').toString('base64')}`)
  })
  it('turns a missing field into the documented default', async () => {
    forge!.setFixture(issue('LX-2', { summary: undefined, assignee: null, description: null, issuetype: undefined, status: undefined, attachment: undefined }))
    const t = await readIssue(access, 'LX-2')
    expect(t).toMatchObject({ title: 'LX-2', assignee: null, type: null, status: null, description: '', criteria: [], attachments: [] })
  })
  it('reads comments page by page', async () => {
    const c = (n: number): unknown => ({ author: { displayName: `U${n}` }, created: 'x', body: doc(p(`c${n}`)) })
    forge!.setFixture({
      ...issue('LX-3'),
      'GET rest/api/3/issue/LX-3/comment': [
        { json: { total: 150, comments: Array.from({ length: 100 }, (_, i) => c(i)) } },
        { json: { total: 150, comments: Array.from({ length: 50 }, (_, i) => c(100 + i)) } }
      ]
    })
    expect((await readIssue(access, 'LX-3')).comments).toHaveLength(150)
  })
  it('gives a failed row with the error, and no access gives the setup message (acceptance checks 4 and 5)', async () => {
    forge!.setFixture({ 'GET rest/api/3/issue/LX-9': { fail: 'HTTP 404 Issue does not exist or you do not have permission to see it.' } })
    const bad = await readIssue(access, 'LX-9')
    expect(bad).toMatchObject({
      key: 'LX-9',
      title: 'LX-9',
      error: 'HTTP 404 Not Found: Issue does not exist or you do not have permission to see it.',
      criteria: [],
      url: 'https://acme.atlassian.net/browse/LX-9'
    })
    expect((await readIssue(null, 'LX-1')).error).toBe('No Jira access is set up. Open Prerequisites and add your site and a token.')
  })
})

describe('adding issues (file 01 section 3.9)', () => {
  const seedReview = (issues: string[]): void => {
    mkdirSync(reviewDir(root, 'R-1'), { recursive: true })
    writeFileSync(join(reviewDir(root, 'R-1'), 'review.json'), JSON.stringify({ title: 'R', mrs: [], skipped: [], issues }))
  }
  const saved = (): string[] => JSON.parse(readFileSync(join(reviewDir(root, 'R-1'), 'review.json'), 'utf8')).issues

  it('adds good keys, merges duplicates, and reports each problem by its value as typed', async () => {
    seedReview(['LX-1'])
    forge!.setFixture({ ...issue('LX-1'), ...issue('LX-2'), 'GET rest/api/3/issue/LX-404': { fail: 'HTTP 404 Not Found' } })
    const r = await addIssues(root, 'R-1', ['lx2', 'LX-2', 'https://acme.atlassian.net/browse/LX-1', 'abc', 'LX-404'])
    expect(r).toEqual({
      ok: true,
      value: { added: ['LX-2'], problems: { abc: 'Not a Jira issue key or URL.', 'LX-1': 'Already in this review.', 'LX-404': 'HTTP 404 Not Found' } }
    })
    expect(saved()).toEqual(['LX-1', 'LX-2'])
  })
  it('refuses nothing or too many values, and writes nothing when nothing was added', async () => {
    seedReview([])
    expect(await addIssues(root, 'R-1', [])).toEqual({ ok: false, error: 'Send 1 to 20 Jira issue keys or URLs.' })
    expect(
      await addIssues(
        root,
        'R-1',
        Array.from({ length: 21 }, (_, i) => `LX-${i + 1}`)
      )
    ).toEqual({ ok: false, error: 'Send 1 to 20 Jira issue keys or URLs.' })
    forge!.setFixture({})
    const r = await addIssues(root, 'R-1', ['abc'])
    expect(r).toMatchObject({ ok: true, value: { added: [] } })
    expect(saved()).toEqual([])
  })
  it('gives the issue file, and refuses a key that is not in the review', async () => {
    seedReview(['LX-1'])
    forge!.setFixture(issue('LX-1'))
    const ok = await getIssueFile(root, 'R-1', 'LX-1')
    expect(ok.ok && ok.value).toContain('# LX-1: Title of LX-1')
    expect(ok.ok && ok.value).toContain(
      '**Type:** Story · **Status:** In Review · **Assignee:** Ann Lee · [Open in Jira](https://acme.atlassian.net/browse/LX-1)'
    )
    expect(ok.ok && ok.value).toContain('## AC1\n\nLearner sees the card')
    expect(await getIssueFile(root, 'R-1', 'LX-7')).toEqual({ ok: false, error: 'LX-7 is not an issue of this review.' })
    expect(await getIssueFile(root, 'NOPE', 'LX-1')).toEqual({ ok: false, error: 'The review is not loaded: open it again.' })
  })
})
