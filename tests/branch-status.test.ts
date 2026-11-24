import { afterEach, describe, expect, it } from 'vitest'
import { readPull } from '../src/main/clients/github'
import { mapMr, readMr } from '../src/main/clients/gitlab'
import { setCredentialProvider } from '../src/main/clients/rest-api'
import type { ChangeRef } from '../src/shared/provider'
import { branchStatus } from '../src/shared/review'
import type { Fixture, FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const glRef: ChangeRef = { provider: 'gitlab', host: 'gitlab.com', project: 'team/x', iid: 4 }
const hubRef: ChangeRef = { provider: 'github', host: 'github.com', project: 'acme/widgets', iid: 9 }

const HEAD = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
const BASE = '99aa88bb77cc66dd55ee44ff3300112233445566'

describe('branchStatus', () => {
  it('says Up to date for an open change that is level with its target', () => {
    // Arrange
    const info = { state: 'opened', draft: false, targetBranch: 'release/2.4', behindTarget: 0 } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'level', label: 'Up to date', title: 'Level with release/2.4', sortValue: 0 })
  })

  it('treats a draft like an open change', () => {
    // Arrange
    const info = { state: 'opened', draft: true, targetBranch: 'main', behindTarget: 0 } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'level', label: 'Up to date', title: 'Level with main', sortValue: 0 })
  })

  it('uses the singular for one commit behind', () => {
    // Arrange
    const info = { state: 'opened', draft: false, targetBranch: 'main', behindTarget: 1 } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'behind', label: '1 behind', title: '1 commit behind main. Rebase or merge to catch up.', sortValue: 1 })
  })

  it('uses the plural and the count for 25 commits behind', () => {
    // Arrange
    const info = { state: 'opened', draft: true, targetBranch: 'develop', behindTarget: 25 } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'behind', label: '25 behind', title: '25 commits behind develop. Rebase or merge to catch up.', sortValue: 25 })
  })

  it('uses the plural for two commits behind', () => {
    // Arrange
    const info = { state: 'opened', draft: false, targetBranch: 'main', behindTarget: 2 } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'behind', label: '2 behind', title: '2 commits behind main. Rebase or merge to catch up.', sortValue: 2 })
  })

  it.each([false, true])('says the status is not known for an open change with no count (draft %s)', (draft) => {
    // Arrange
    const info = { state: 'opened', draft, targetBranch: 'main', behindTarget: null } as const

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'unknown', label: '–', title: 'Not known', sortValue: -1 })
  })

  it.each([
    ['merged', 0],
    ['merged', 7],
    ['merged', null],
    ['closed', 3],
    ['closed', null],
    ['locked', 12],
    ['locked', 0]
  ] as const)('has no status for a %s change, whatever the count (%s)', (state, behindTarget) => {
    // Arrange
    const info = { state, draft: false, targetBranch: 'main', behindTarget }

    // Act
    const status = branchStatus(info)

    // Assert
    expect(status).toEqual({ kind: 'none', label: '–', title: '', sortValue: -1 })
  })

  it('sorts none and unknown first, then level, then by the number behind', () => {
    // Arrange
    const open = (behindTarget: number | null) => ({ state: 'opened', draft: false, targetBranch: 'main', behindTarget }) as const
    const merged = { state: 'merged', draft: false, targetBranch: 'main', behindTarget: 9 } as const

    // Act
    const values = [open(25), open(0), open(null), merged, open(1)].map((i) => branchStatus(i).sortValue)

    // Assert
    expect(values).toEqual([25, 0, -1, -1, 1])
  })
})

describe('GitLab reader: behindTarget', () => {
  const mr = (extra: Record<string, unknown>): Record<string, unknown> => ({
    state: 'opened',
    source_branch: 'feat/x',
    target_branch: 'main',
    author: { username: 'ann', name: 'Ann Lee' },
    ...extra
  })

  it.each([0, 1, 37])('reads diverged_commits_count %s', (count) => {
    // Arrange
    const json = mr({ diverged_commits_count: count })

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.behindTarget).toBe(count)
  })

  it('gives null when diverged_commits_count is missing', () => {
    // Arrange
    const json = mr({})

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.behindTarget).toBeNull()
  })

  it.each([['5'], [null], [true], [{}]])('gives null when diverged_commits_count is not a number (%j)', (value) => {
    // Arrange
    const json = mr({ diverged_commits_count: value })

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.behindTarget).toBeNull()
  })

  it.each(['merged', 'closed'])('gives null for a %s change even when GitLab sends a count', (state) => {
    // Arrange
    const json = mr({ state, diverged_commits_count: 8 })

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.state).toBe(state)
    expect(info.behindTarget).toBeNull()
  })
})

describe('GitLab reader: asks GitLab for the behind count', () => {
  const ep = `projects/${encodeURIComponent('team/x')}/merge_requests/4`
  let forge: FakeForge | undefined
  afterEach(async () => {
    await stopFakeForge(forge)
    forge = undefined
  })

  // GitLab leaves diverged_commits_count out of an MR unless the request sets include_diverged_commits_count.
  it('sends include_diverged_commits_count with the read of the MR and keeps the number GitLab answers', async () => {
    // Arrange
    forge = await useFakeForge({
      'GET user': { json: { username: 'me' } },
      [`GET ${ep}`]: {
        json: { state: 'opened', source_branch: 'feat/x', target_branch: 'main', author: { username: 'ann', name: 'Ann Lee' }, diverged_commits_count: 5 }
      },
      [`GET ${ep}/approvals`]: { json: { approved_by: [], user_can_approve: false } },
      [`GET ${ep}/discussions`]: { json: [] },
      [`GET ${ep}/reviewers`]: { json: [] }
    })

    // Act
    const snapshot = await readMr(glRef)

    // Assert
    const read = forge.calls.filter((c) => c.method === 'GET' && c.endpoint === ep)
    expect(read).toHaveLength(1)
    expect(read[0].query['include_diverged_commits_count']).toBe('true')
    expect(snapshot.info.behindTarget).toBe(5)
  })
})

describe('GitHub reader: behindTarget', () => {
  let forge: FakeForge | undefined
  afterEach(async () => {
    await stopFakeForge(forge)
    forge = undefined
    setCredentialProvider(() => null)
  })

  const pull = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    state: 'open',
    title: 'Fix widgets',
    user: { login: 'ann' },
    head: { ref: 'feat/x', sha: HEAD },
    base: { ref: 'main', sha: BASE },
    ...extra
  })
  const fixture = (compare: Fixture[string], extra: Record<string, unknown> = {}): Fixture => ({
    'GET user': { json: { login: 'me' } },
    'GET repos/acme/widgets/pulls/9': { json: pull(extra) },
    'GET repos/acme/widgets/pulls/9/reviews': { json: [] },
    'POST graphql': { json: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } },
    [`GET repos/acme/widgets/commits/${HEAD}/check-runs`]: { json: { check_runs: [] } },
    [`GET repos/acme/widgets/compare/main...${HEAD}`]: compare
  })
  const compareCalls = (): number => forge!.calls.filter((c) => c.endpoint.startsWith('repos/acme/widgets/compare/')).length

  it('reads behind_by from one compare call for an open pull request', async () => {
    // Arrange
    forge = await useFakeForge(fixture({ json: { behind_by: 6, ahead_by: 2 } }))

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.behindTarget).toBe(6)
    expect(compareCalls()).toBe(1)
  })

  it('reads 0 when the branch is level', async () => {
    // Arrange
    forge = await useFakeForge(fixture({ json: { behind_by: 0, ahead_by: 3 } }))

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.behindTarget).toBe(0)
  })

  it('gives null and still builds when the compare call fails', async () => {
    // Arrange
    forge = await useFakeForge(fixture({ fail: 'HTTP 500 boom' }))

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.behindTarget).toBeNull()
    expect(snapshot.info.title).toBe('Fix widgets')
    expect(snapshot.info.state).toBe('opened')
    expect(compareCalls()).toBe(1)
  })

  it.each([[{ json: { ahead_by: 2 } }], [{ json: { behind_by: '4' } }], [{ json: { behind_by: null } }]])(
    'gives null when behind_by is missing or not a number (%j)',
    async (compare) => {
      // Arrange
      forge = await useFakeForge(fixture(compare))

      // Act
      const snapshot = await readPull(hubRef)

      // Assert
      expect(snapshot.info.behindTarget).toBeNull()
    }
  )

  it.each([
    ['merged', { state: 'closed', merged: true, merged_at: '2026-01-02T00:00:00Z' }],
    ['closed', { state: 'closed', merged: false, closed_at: '2026-01-02T00:00:00Z' }]
  ])('gives null for a %s pull request without a compare call', async (state, extra) => {
    // Arrange
    forge = await useFakeForge(fixture({ json: { behind_by: 5 } }, extra))

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.state).toBe(state)
    expect(snapshot.info.behindTarget).toBeNull()
    expect(compareCalls()).toBe(0)
  })
})
