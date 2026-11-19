import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/main/processes/run'
import { forgeApi, forgePaged, githubAt, gitlabAt } from '../src/main/clients/forge-api'
import { setCredentialProvider } from '../src/main/clients/rest-api'
import { mapApprovals, mapDiscussions, mapJobs, mapMr, mapViewerState } from '../src/main/clients/gitlab'
import { mapCheckRuns, mapReviews, mapThreads, overallStatus } from '../src/main/clients/github'
import { parseNameStatus } from '../src/main/clients/git'
import { parseChangeUrl } from '../src/shared/provider'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const gl = gitlabAt({ host: 'gitlab.com' })
const hub = githubAt({ host: 'github.com' })
let forge: FakeForge | undefined
afterEach(async () => {
  await stopFakeForge(forge)
  forge = undefined
})

describe('process runner (checks 1 and 2)', () => {
  it('kills a sleeping program and its child at the time-out', async () => {
    const childScript = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});setTimeout(()=>{},600000)"
    const t0 = Date.now()
    const r = await run('node', ['-e', childScript], { timeoutMs: 800 })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBe(-1)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
  it('passes spaces, quotes, | and $ unchanged', async () => {
    const arg = `a b "c" 'd' | $HOME & %PATH% \`x\` ; (y)`
    const r = await run('node', ['-e', 'process.stdout.write(process.argv[1])', arg])
    expect(r.stdout).toBe(arg)
  })
  it('reports a missing program as a launch error', async () => {
    const r = await run('definitely-not-a-real-program-xyz', [])
    expect(r.launchError).toBeTruthy()
  })
  it('keeps raw bytes and does not trim file contents', async () => {
    const r = await run('node', ['-e', 'process.stdout.write(Buffer.from([32,0,255,10]))'])
    expect([...r.stdoutBytes]).toEqual([32, 0, 255, 10])
  })
})

describe('forge calls over REST (checks 3 to 5)', () => {
  it('reads 250 items in 3 requests (check 3)', async () => {
    forge = await useFakeForge({ 'GET projects/x/items': { list: 250 } })
    const items = await forgePaged(gl, 'projects/x/items')
    expect(items).toHaveLength(250)
    const reqs = forge.calls.filter((c) => c.endpoint === 'projects/x/items')
    expect(reqs).toHaveLength(3)
    expect(reqs[1].query).toMatchObject({ per_page: '100', page: '2' })
  })
  it('delivers a body with a quote and a line break unchanged (check 4)', async () => {
    forge = await useFakeForge({ 'POST projects/x/discussions': { echoBody: true } })
    const body = { body: 'He said "hi"\nsecond line | $x', position: null }
    expect(await forgeApi(gl, 'projects/x/discussions', 'POST', { body })).toEqual(body)
  })
  it('shows a failed write on one line (check 5)', async () => {
    forge = await useFakeForge({ 'POST projects/x/approve': { fail: 'HTTP 403\nForbidden' } })
    await expect(forgeApi(gl, 'projects/x/approve', 'POST')).rejects.toThrow('POST projects/x/approve failed: HTTP 403 Forbidden')
  })
  it('keeps the forge message in the error text, and a failed read shows the bare message', async () => {
    forge = await useFakeForge({ 'GET projects/x': { fail: 'HTTP 404 Project Not Found' } })
    await expect(forgeApi(gl, 'projects/x', 'GET')).rejects.toThrow('HTTP 404 Not Found: Project Not Found')
  })
  it('returns null for an empty answer', async () => {
    forge = await useFakeForge({ 'DELETE projects/x/notes/1': { empty: true } })
    expect(await forgeApi(gl, 'projects/x/notes/1', 'DELETE')).toBeNull()
  })
  it('sends the token the way each forge expects it', async () => {
    forge = await useFakeForge({ 'GET user': { json: { username: 'me', login: 'me' } } })
    await forgeApi(gl, 'user', 'GET')
    await forgeApi(hub, 'user', 'GET')
    expect(forge.calls[0].auth).toBe('test-token') // PRIVATE-TOKEN for GitLab
    expect(forge.calls[1].auth).toBe('Bearer test-token') // a bearer token for GitHub
  })
  it('refuses a host with no token, and says what to do', async () => {
    forge = await useFakeForge({})
    setCredentialProvider(() => null)
    await expect(forgeApi(gl, 'user', 'GET')).rejects.toThrow('No access to gitlab.com is set up. Open Prerequisites and add a token.')
    await expect(forgeApi(gl, 'projects/x/approve', 'POST')).rejects.toThrow('POST projects/x/approve failed: No access to gitlab.com is set up.')
  })
  it('turns GitHub GraphQL fields into a query and variables', async () => {
    forge = await useFakeForge({ 'POST graphql': { json: { data: {} } } })
    await forgeApi(hub, 'graphql', 'POST', { fields: { query: 'query($n:Int!){x}', owner: 'o' }, typed: { n: 3 } })
    expect(forge.calls[0].body).toEqual({ query: 'query($n:Int!){x}', variables: { owner: 'o', n: 3 } })
  })
  it('reports an unreachable host', async () => {
    forge = await useFakeForge({})
    process.env.CODEDIFF_API_BASE_GITLAB = 'http://127.0.0.1:1/' // nothing listens here
    await expect(forgeApi(gl, 'user', 'GET')).rejects.toThrow(/Could not reach gitlab\.com/)
  })
})

describe('GitLab mapping (file 05 section 2)', () => {
  const ref = { provider: 'gitlab', host: 'gitlab.com', project: 'g/r', iid: 7 } as const
  it('maps the MR and counts draft only for true', () => {
    const people = {}
    const i = mapMr(
      ref,
      {
        web_url: 'u',
        state: 'merged',
        title: 't',
        draft: 'yes',
        merge_when_pipeline_succeeds: true,
        merge_user: {},
        diff_refs: { base_sha: 'a', start_sha: 'b', head_sha: 'c' },
        closed_at: 'x'
      },
      people
    )
    expect(i.draft).toBe(false)
    expect(i.autoMerge).toEqual({ enabled: false, by: 'unknown' }) // GitLab keeps the flag on a merged MR
    expect(i.closedAt).toBeNull()
    expect(i.diffRefs).toEqual({ base: 'a', start: 'b', head: 'c' })
  })
  it('drops system notes and derives resolved state', () => {
    const d = [
      { id: 'a'.repeat(40), notes: [{ id: 1, system: true, body: 'added 2 commits' }] },
      {
        id: 'b'.repeat(40),
        notes: [
          { id: 2, resolvable: true, resolved: true, body: 'x', author: { username: 'u' }, position: { new_path: 'f', new_line: 3 } },
          { id: 3, resolvable: true, resolved: false, body: 'y', author: { username: 'v' } }
        ]
      }
    ]
    const t = mapDiscussions('https://h/mr', d, {})
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ resolvable: true, resolved: false, url: 'https://h/mr#note_2' })
    expect(t[0].position).toEqual({ oldPath: null, newPath: 'f', oldLine: null, newLine: 3 })
  })
  it('maps approvals, viewer state and jobs', () => {
    expect(mapApprovals({ approved_by: [{ user: { username: 'a', name: 'A' } }], user_can_approve: true, user_has_approved: 'true' }, {})).toEqual({
      approvedBy: ['a'],
      userCanApprove: true,
      userHasApproved: false
    })
    expect(mapViewerState([{ user: { username: 'me' }, state: 'reviewed' }], 'me')).toBe('reviewed')
    expect(mapViewerState([], 'me')).toBeNull()
    const jobs = mapJobs(
      [{ id: 5, name: 'b', stage: 's', status: 'ok', web_url: 'j5' }],
      [{ id: 2, name: 'trig', stage: 's', status: 'ok', downstream_pipeline: { web_url: 'down' }, web_url: 'j2' }]
    )
    expect(jobs.map((j) => [j.name, j.url])).toEqual([
      ['trig', 'down'],
      ['b', 'j5']
    ])
  })
})

describe('GitHub mapping', () => {
  it('uses the latest verdict per person and ignores plain comments', () => {
    const reviews = [
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED', submitted_at: '1' },
      { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2' },
      { user: { login: 'a' }, state: 'COMMENTED', submitted_at: '3' },
      { user: { login: 'me' }, state: 'CHANGES_REQUESTED', submitted_at: '1' }
    ]
    const r = mapReviews(reviews, 'me', 'author', {})
    expect(r.approvals.approvedBy).toEqual(['a'])
    expect(r.viewerState).toBe('requested_changes')
    expect(r.approvals.userCanApprove).toBe(true)
    expect(mapReviews([], 'me', 'me', {}).approvals.userCanApprove).toBe(false) // no self-approval on GitHub
  })
  it('maps GraphQL threads with side and resolved state', () => {
    const t = mapThreads(
      [
        {
          id: 'PRRT_x',
          isResolved: true,
          path: 'a.ts',
          line: 9,
          diffSide: 'LEFT',
          comments: { nodes: [{ databaseId: 5, body: 'b', createdAt: 't', url: 'u', author: { login: 'z' } }] }
        },
        { id: 'empty', comments: { nodes: [] } }
      ],
      {}
    )
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ id: 'PRRT_x', resolved: true, url: 'u' })
    expect(t[0].position).toEqual({ oldPath: 'a.ts', newPath: 'a.ts', oldLine: 9, newLine: null })
  })
  it('turns check runs into jobs and one overall status', () => {
    const jobs = mapCheckRuns([
      { id: 2, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 1, name: 'test', status: 'in_progress' }
    ])
    expect(jobs.map((j) => j.name)).toEqual(['test', 'lint'])
    expect(overallStatus(jobs)).toBe('running')
    expect(overallStatus([{ ...jobs[1], status: 'failure' }])).toBe('failed')
    expect(overallStatus([])).toBeNull()
  })
})

describe('URL parsing and git output', () => {
  it('reads GitLab and GitHub change URLs', () => {
    expect(parseChangeUrl('https://gitlab.com/team/backend/x/-/merge_requests/42')).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      project: 'team/backend/x',
      iid: 42
    })
    expect(parseChangeUrl('https://github.com/o/r/pull/9/files')).toEqual({ provider: 'github', host: 'github.com', project: 'o/r', iid: 9 })
    expect(parseChangeUrl('https://example.com/nope')).toBeNull()
  })
  it('parses name-status output with renames', () => {
    expect(parseNameStatus('M\0a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0')).toEqual([
      { status: 'M', oldPath: null, path: 'a.ts' },
      { status: 'R100', oldPath: 'old.ts', path: 'new.ts' },
      { status: 'A', oldPath: null, path: 'b.ts' }
    ])
  })
})
