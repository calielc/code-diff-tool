import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { draftTitle, parseMarkdown, type PendingComment } from '../src/shared/comments'
import { isValidThreadId, type ChangeRef } from '../src/shared/provider'
import { deleteNote, postComment, resolveThread, submitReview } from '../src/main/clients/writes'
import type { FakeForge, Fixture } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

let forge: FakeForge

const gl: ChangeRef = { provider: 'gitlab', host: 'gitlab.com', project: 'team/backend/x', iid: 7 }
const hub: ChangeRef = { provider: 'github', host: 'github.com', project: 'o/r', iid: 3 }
const ep = 'projects/team%2Fbackend%2Fx/merge_requests/7'

const refs = { B: 'b'.repeat(40), S: 's'.repeat(40).replace(/s/g, '5'), H: 'a'.repeat(40) }
const comment = (o: Partial<PendingComment>): PendingComment => ({
  id: 'c1',
  mr: 'backend/x!7',
  diffRefs: { base: refs.B, start: refs.S, head: refs.H },
  path: 'src/a.cs',
  oldPath: 'src/a.cs',
  oldLine: null,
  newLine: 12,
  body: 'Please rename.',
  ...o
})

const fixture = (f: Record<string, unknown>): void => forge.setFixture({ 'GET user': { json: { username: 'me' } }, ...(f as Fixture) })
// The writes that carried a body, in order.
const sent = (): { method: string; endpoint: string; body: any }[] => forge.bodies.map((c) => ({ method: c.method, endpoint: c.endpoint, body: c.body }))

beforeEach(async () => {
  forge = await useFakeForge()
})
afterEach(async () => {
  await stopFakeForge(forge)
})

describe('GitLab positions (file 03 vectors P1 to P7)', () => {
  it('P1 an added line has new_line and a null old_line', async () => {
    fixture({ [`POST ${ep}/discussions`]: { empty: true } })
    await postComment(gl, comment({}))
    expect(sent()[0].body).toEqual({
      body: 'Please rename.',
      position: {
        position_type: 'text',
        base_sha: refs.B,
        start_sha: refs.S,
        head_sha: refs.H,
        old_path: 'src/a.cs',
        new_path: 'src/a.cs',
        old_line: null,
        new_line: 12
      }
    })
  })
  it('P2 and P3 a removed line and an unchanged line', async () => {
    fixture({ [`POST ${ep}/discussions`]: { empty: true } })
    await postComment(gl, comment({ oldLine: 5, newLine: null }))
    await postComment(gl, comment({ oldLine: 8, newLine: 9 }))
    expect(sent()[0].body.position).toMatchObject({ old_line: 5, new_line: null })
    expect(sent()[1].body.position).toMatchObject({ old_line: 8, new_line: 9 })
  })
  it('P4 a renamed file sends both paths', async () => {
    fixture({ [`POST ${ep}/discussions`]: { empty: true } })
    await postComment(gl, comment({ oldPath: 'a/Old.cs', path: 'a/New.cs', newLine: 3 }))
    expect(sent()[0].body.position).toMatchObject({ old_path: 'a/Old.cs', new_path: 'a/New.cs', old_line: null, new_line: 3 })
  })
  it('P5 a whole-file comment and an MR comment have no position', async () => {
    fixture({ [`POST ${ep}/discussions`]: { empty: true } })
    await postComment(gl, comment({ newLine: null, body: 'Looks good.' }))
    await postComment(gl, comment({ path: null, oldPath: null, newLine: null, body: 'Overall fine.' }))
    expect(sent().map((s) => s.body)).toEqual([{ body: '`src/a.cs`: Looks good.' }, { body: 'Overall fine.' }])
  })
  it('P6 a refused position (HTTP 400) is posted as a plain discussion, and other errors are thrown', async () => {
    fixture({ [`POST ${ep}/discussions`]: [{ fail: 'HTTP 400 Bad Request' }, { empty: true }] })
    await postComment(gl, comment({}))
    expect(sent()).toHaveLength(2)
    expect(sent()[1].body).toEqual({ body: '`src/a.cs`, line 12: Please rename.' })
    fixture({ [`POST ${ep}/discussions`]: { fail: 'HTTP 403 Forbidden' } })
    await expect(postComment(gl, comment({}))).rejects.toThrow('HTTP 403 Forbidden')
  })
  it('a removed line falls back to its old line number', async () => {
    fixture({ [`POST ${ep}/discussions`]: [{ fail: 'HTTP 400' }, { empty: true }] })
    await postComment(gl, comment({ oldLine: 5, newLine: null, body: 'x' }))
    expect(sent()[1].body.body).toBe('`src/a.cs`, line 5: x')
  })
})

describe('GitHub comments', () => {
  it('posts a line comment with commit, path, line and side', async () => {
    fixture({ 'POST repos/o/r/pulls/3/comments': { empty: true } })
    await postComment(hub, comment({ newLine: 12 }))
    expect(sent()[0].body).toEqual({ body: 'Please rename.', commit_id: refs.H, path: 'src/a.cs', line: 12, side: 'RIGHT' })
  })
  it('uses the old path and the LEFT side for a removed line', async () => {
    fixture({ 'POST repos/o/r/pulls/3/comments': { empty: true } })
    await postComment(hub, comment({ oldPath: 'a/Old.cs', path: 'a/New.cs', oldLine: 5, newLine: null }))
    expect(sent()[0].body).toMatchObject({ path: 'a/Old.cs', line: 5, side: 'LEFT' })
  })
  it('falls back to an issue comment on HTTP 422', async () => {
    fixture({ 'POST repos/o/r/pulls/3/comments': { fail: 'HTTP 422 Validation Failed' }, 'POST repos/o/r/issues/3/comments': { empty: true } })
    await postComment(hub, comment({}))
    expect(sent()[1]).toMatchObject({ endpoint: 'repos/o/r/issues/3/comments', body: { body: '`src/a.cs`, line 12: Please rename.' } })
  })
  it('posts file and PR comments as issue comments', async () => {
    fixture({ 'POST repos/o/r/issues/3/comments': { empty: true } })
    await postComment(hub, comment({ newLine: null, body: 'Looks good.' }))
    expect(sent()[0].body).toEqual({ body: '`src/a.cs`: Looks good.' })
  })
})

describe('delete and resolve', () => {
  it('deletes a note on each provider and refuses a bad id', async () => {
    fixture({ [`DELETE ${ep}/notes/11`]: { empty: true }, 'DELETE repos/o/r/pulls/comments/11': { empty: true } })
    await deleteNote(gl, 11)
    await deleteNote(hub, 11)
    await expect(deleteNote(gl, 0)).rejects.toThrow('positive number')
  })
  it('resolves a GitLab discussion with a PUT body and a GitHub thread with GraphQL', async () => {
    const id = 'd'.repeat(40)
    fixture({ [`PUT ${ep}/discussions/${id}`]: { empty: true }, 'POST graphql': { empty: true } })
    await resolveThread(gl, id, true)
    await resolveThread(hub, 'PRRT_abc12345', false)
    expect(sent()[0]).toMatchObject({ method: 'PUT', body: { resolved: true } })
  })
  it('validates thread ids per provider', () => {
    expect(isValidThreadId('gitlab', 'd'.repeat(40))).toBe(true)
    expect(isValidThreadId('gitlab', 'PRRT_abc12345')).toBe(false)
    expect(isValidThreadId('github', 'PRRT_abc12345')).toBe(true)
    expect(isValidThreadId('github', 'x y')).toBe(false)
  })
})

describe('DraftTitle (vector T1)', () => {
  it.each([
    ['Draft: Fix', false, 'Fix'],
    ['[Draft] (draft) draft:Fix', false, 'Fix'],
    ['Fix', true, 'Draft: Fix'],
    ['Drafty', false, 'Drafty'],
    ['Drafty', true, 'Draft: Drafty'],
    ['draft: Draft: x', false, 'x'],
    ['Draft: Draft: Fix it', false, 'Fix it']
  ])('%s as draft=%s is %s', (title, draft, expected) => expect(draftTitle(title, draft)).toBe(expected))
})

describe('submit review (file 03 section 10.3)', () => {
  const refsMap = new Map([
    ['backend/x!7', gl],
    ['backend/x!8', { ...gl, iid: 8 }]
  ])
  const base = ep
  const none = { approve: [], unapprove: [], requestChanges: [], summaries: {}, ready: [], draft: [] }

  it('refuses to request changes without an overall comment and posts nothing', async () => {
    fixture({})
    const r = await submitReview({ slug: 's', ...none, requestChanges: ['backend/x!7'] }, refsMap)
    expect(r).toEqual({ 'backend/x!7': 'requesting changes needs an overall comment.' })
    expect(sent()).toEqual([])
  })
  it('stops when the viewer already has draft notes in GitLab', async () => {
    fixture({ [`GET ${base}/draft_notes`]: { json: [{ id: 1 }] } })
    const r = await submitReview({ slug: 's', ...none, summaries: { 'backend/x!7': 'hello' } }, refsMap)
    expect(r['backend/x!7']).toBe(
      'you already have draft notes on this change request in GitLab, and publishing would post them too. Submit or delete them in GitLab first.'
    )
    expect(sent()).toEqual([])
  })
  it('creates a draft note, publishes without a state, then approves', async () => {
    fixture({
      [`GET ${base}/draft_notes`]: { json: [] },
      [`POST ${base}/draft_notes`]: { empty: true },
      [`POST ${base}/draft_notes/bulk_publish`]: { empty: true },
      [`POST ${base}/approve`]: { empty: true }
    })
    const r = await submitReview({ slug: 's', ...none, approve: ['backend/x!7'], summaries: { 'backend/x!7': 'LGTM' } }, refsMap)
    expect(r).toEqual({})
    // the call order, from the argv log: list drafts, create the draft, publish, then approve
    const order = forge.calls.filter((c) => c.endpoint.startsWith(base)).map((c) => `${c.method} ${c.endpoint.replace(base, '')}`)
    expect(order).toEqual(['GET /draft_notes', 'POST /draft_notes', 'POST /draft_notes/bulk_publish', 'POST /approve'])
    expect(sent().find((x) => x.endpoint.endsWith('/draft_notes'))?.body).toEqual({ note: 'LGTM' })
  })
  it('publishes with the requested_changes state', async () => {
    fixture({
      [`GET ${base}/draft_notes`]: { json: [] },
      [`POST ${base}/draft_notes`]: { empty: true },
      [`POST ${base}/draft_notes/bulk_publish`]: { empty: true }
    })
    const r = await submitReview({ slug: 's', ...none, requestChanges: ['backend/x!7'], summaries: { 'backend/x!7': 'Please fix' } }, refsMap)
    expect(r).toEqual({})
    expect(sent().find((s) => s.endpoint.endsWith('bulk_publish'))?.body).toEqual({ reviewer_state: 'requested_changes' })
  })
  it('words the failure by how far it got, and one MR never stops another', async () => {
    fixture({
      [`GET ${base}/draft_notes`]: { json: [] },
      [`POST ${base}/draft_notes`]: { empty: true },
      [`POST ${base}/draft_notes/bulk_publish`]: { fail: 'HTTP 500' },
      'GET projects/team%2Fbackend%2Fx/merge_requests/8/draft_notes': { json: [] },
      'POST projects/team%2Fbackend%2Fx/merge_requests/8/draft_notes': { empty: true },
      'POST projects/team%2Fbackend%2Fx/merge_requests/8/draft_notes/bulk_publish': { empty: true },
      'POST projects/team%2Fbackend%2Fx/merge_requests/8/approve': { fail: 'HTTP 403' }
    })
    const r = await submitReview({ slug: 's', ...none, approve: ['backend/x!8'], summaries: { 'backend/x!7': 'a', 'backend/x!8': 'b' } }, refsMap)
    expect(r['backend/x!7']).toBe(
      'POST projects/team%2Fbackend%2Fx/merge_requests/7/draft_notes/bulk_publish failed: HTTP 500 Internal Server Error The overall comment stays in GitLab as your pending review.'
    )
    expect(r['backend/x!8']).toBe('The overall comment went out, then: POST projects/team%2Fbackend%2Fx/merge_requests/8/approve failed: HTTP 403 Forbidden')
  })
  it('marks a draft MR ready from its current title', async () => {
    fixture({ [`GET ${base}`]: { json: { title: 'Draft: Draft: Fix it' } }, [`PUT ${base}`]: { empty: true } })
    const r = await submitReview({ slug: 's', ...none, ready: ['backend/x!7'] }, refsMap)
    expect(r).toEqual({})
    expect(sent()[0].body).toEqual({ title: 'Fix it' })
  })
  it('sends one GitHub review with the text and the verdict', async () => {
    fixture({ 'POST repos/o/r/pulls/3/reviews': { empty: true } })
    const m = new Map([['r!3', hub]])
    await submitReview({ slug: 's', ...none, requestChanges: ['r!3'], summaries: { 'r!3': 'Please fix' } }, m)
    expect(sent()[0].body).toEqual({ event: 'REQUEST_CHANGES', body: 'Please fix' })
    const r = await submitReview({ slug: 's', ...none, requestChanges: ['r!3'] }, m)
    expect(r['r!3']).toBe('requesting changes needs an overall comment.')
  })
})

describe('markdown subset (file 02 section 8.3)', () => {
  it('reads headings two levels down, lists, inline code, bold and http links only', () => {
    const b = parseMarkdown('# Title\n\n- one\n- two with `code`\n\nA **bold** [link](https://x.io) and [bad](javascript:alert(1))')
    expect(b[0]).toMatchObject({ kind: 'heading', level: 3 })
    expect(b[1]).toMatchObject({ kind: 'list' })
    const para = b[2]
    expect(para.kind).toBe('para')
    const kinds = para.kind === 'para' ? para.lines[0].map((i) => i.kind) : []
    expect(kinds).toContain('bold')
    expect(kinds).toContain('link')
    expect(JSON.stringify(para)).not.toContain('"href":"javascript')
  })
})
