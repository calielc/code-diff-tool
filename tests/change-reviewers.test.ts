import { afterEach, describe, expect, it } from 'vitest'
import { mapPull, readPull } from '../src/main/clients/github'
import { mapMr, readMr } from '../src/main/clients/gitlab'
import { setCredentialProvider } from '../src/main/clients/rest-api'
import type { ChangeRef, Person } from '../src/shared/provider'
import type { Fixture, FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const glRef: ChangeRef = { provider: 'gitlab', host: 'gitlab.com', project: 'team/x', iid: 4 }
const hubRef: ChangeRef = { provider: 'github', host: 'github.com', project: 'acme/widgets', iid: 9 }
const HEAD = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
const BASE = '99aa88bb77cc66dd55ee44ff3300112233445566'

describe('GitLab reader: reviewers', () => {
  const mr = (extra: Record<string, unknown>): Record<string, unknown> => ({
    state: 'opened',
    source_branch: 'feat/x',
    target_branch: 'main',
    author: { username: 'ann', name: 'Ann Lee' },
    ...extra
  })

  it('reads the usernames of the reviewers of the MR in the order GitLab gives them', () => {
    // Arrange
    const json = mr({
      reviewers: [
        { username: 'zed', name: 'Zed Zee' },
        { username: 'bob', name: 'Bob Roe' },
        { username: 'carol', name: 'Carol Poe' }
      ]
    })

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.reviewers).toEqual(['zed', 'bob', 'carol'])
  })

  it('adds every reviewer to the people, with the name and the avatar, next to the author', () => {
    // Arrange
    const people: Record<string, Person> = {}
    const json = mr({ reviewers: [{ username: 'bob', name: 'Bob Roe', avatar_url: 'https://gitlab.com/uploads/bob.png' }, { username: 'carol' }] })

    // Act
    mapMr(glRef, json, people)

    // Assert
    expect(people).toEqual({
      ann: { name: 'Ann Lee', avatarUrl: null },
      bob: { name: 'Bob Roe', avatarUrl: 'https://gitlab.com/uploads/bob.png' },
      carol: { name: 'carol', avatarUrl: null }
    })
  })

  it.each([
    ['missing', {}],
    ['empty', { reviewers: [] }],
    ['null', { reviewers: null }],
    ['not a list', { reviewers: 'bob' }]
  ])('gives no reviewers when the list is %s', (_name, extra) => {
    // Arrange
    const json = mr(extra)

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.reviewers).toEqual([])
  })

  it('leaves out an entry without a username', () => {
    // Arrange
    const json = mr({ reviewers: [{ name: 'No Name' }, null, { username: 'bob' }, { username: 7 }] })

    // Act
    const info = mapMr(glRef, json, {})

    // Assert
    expect(info.reviewers).toEqual(['bob'])
  })

  describe('read of a whole MR', () => {
    const ep = `projects/${encodeURIComponent('team/x')}/merge_requests/4`
    let forge: FakeForge | undefined
    afterEach(async () => {
      await stopFakeForge(forge)
      forge = undefined
    })

    it('keeps the reviewers of the MR when the reviewers endpoint is read too', async () => {
      // Arrange
      forge = await useFakeForge({
        'GET user': { json: { username: 'me' } },
        [`GET ${ep}`]: {
          json: mr({
            reviewers: [
              { username: 'bob', name: 'Bob Roe' },
              { username: 'carol', name: 'Carol Poe' }
            ]
          })
        },
        [`GET ${ep}/approvals`]: { json: { approved_by: [], user_can_approve: true } },
        [`GET ${ep}/discussions`]: { json: [] },
        [`GET ${ep}/reviewers`]: { json: [{ user: { username: 'bob' }, state: 'unreviewed' }] }
      })

      // Act
      const snapshot = await readMr(glRef)

      // Assert
      expect(snapshot.info.reviewers).toEqual(['bob', 'carol'])
      expect(snapshot.people['carol']).toEqual({ name: 'Carol Poe', avatarUrl: null })
    })
  })
})

describe('GitHub reader: reviewers', () => {
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
  const review = (login: string, state: string, at: string): Record<string, unknown> => ({
    user: { login, avatar_url: `https://avatars/${login}.png` },
    state,
    submitted_at: at
  })
  const fixture = (extra: Record<string, unknown>, reviews: Record<string, unknown>[]): Fixture => ({
    'GET user': { json: { login: 'me' } },
    'GET repos/acme/widgets/pulls/9': { json: pull(extra) },
    'GET repos/acme/widgets/pulls/9/reviews': { json: reviews },
    'POST graphql': { json: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } },
    [`GET repos/acme/widgets/commits/${HEAD}/check-runs`]: { json: { check_runs: [] } },
    [`GET repos/acme/widgets/compare/main...${HEAD}`]: { json: { behind_by: 0 } }
  })

  it('maps the requested reviewers to their logins, in order, and adds them to the people', () => {
    // Arrange
    const people: Record<string, Person> = {}
    const json = pull({ requested_reviewers: [{ login: 'zed', avatar_url: 'https://avatars/zed.png' }, { login: 'bob' }] })

    // Act
    const info = mapPull(hubRef, json, people)

    // Assert
    expect(info.reviewers).toEqual(['zed', 'bob'])
    expect(people['zed']).toEqual({ name: 'zed', avatarUrl: 'https://avatars/zed.png' })
    expect(people['bob']).toEqual({ name: 'bob', avatarUrl: null })
  })

  it.each([
    ['missing', {}],
    ['empty', { requested_reviewers: [] }],
    ['null', { requested_reviewers: null }]
  ])('gives no reviewers when requested_reviewers is %s', (_name, extra) => {
    // Arrange
    const json = pull(extra)

    // Act
    const info = mapPull(hubRef, json, {})

    // Assert
    expect(info.reviewers).toEqual([])
  })

  it('lists the requested reviewers first, then everyone with a submitted review, without the author, a pending review or a repeat', async () => {
    // Arrange
    forge = await useFakeForge(
      fixture({ requested_reviewers: [{ login: 'bob' }, { login: 'carol' }] }, [
        review('carol', 'APPROVED', '2026-01-02T10:00:00Z'),
        review('dave', 'COMMENTED', '2026-01-02T11:00:00Z'),
        review('ann', 'COMMENTED', '2026-01-02T12:00:00Z'),
        review('erin', 'PENDING', '2026-01-02T13:00:00Z'),
        review('frank', 'CHANGES_REQUESTED', '2026-01-02T14:00:00Z'),
        review('dave', 'APPROVED', '2026-01-02T15:00:00Z')
      ])
    )

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.reviewers).toEqual(['bob', 'carol', 'dave', 'frank'])
  })

  it('adds a reviewer who only commented to the people, so the table can show the avatar', async () => {
    // Arrange
    forge = await useFakeForge(
      fixture({ requested_reviewers: [{ login: 'bob', avatar_url: 'https://avatars/bob.png' }] }, [review('dave', 'COMMENTED', '2026-01-02T11:00:00Z')])
    )

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.reviewers).toEqual(['bob', 'dave'])
    expect(snapshot.people['bob']).toEqual({ name: 'bob', avatarUrl: 'https://avatars/bob.png' })
    expect(snapshot.people['dave']).toEqual({ name: 'dave', avatarUrl: 'https://avatars/dave.png' })
  })

  it('gives no reviewers for a pull request with no request and no review', async () => {
    // Arrange
    forge = await useFakeForge(fixture({}, []))

    // Act
    const snapshot = await readPull(hubRef)

    // Assert
    expect(snapshot.info.reviewers).toEqual([])
  })
})
