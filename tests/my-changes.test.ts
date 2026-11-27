import { describe, expect, it } from 'vitest'
import {
  combineMine,
  DEFAULT_MINE_APPROVALS,
  DEFAULT_MINE_STATES,
  MINE_POLL_MS,
  MINE_STATES,
  mergeMine,
  mineReviewers,
  mineWanted,
  type MineItem,
  type MineResult,
  type MineState
} from '../src/shared/my-changes'

const item = (n: number, over: Partial<MineItem> = {}): MineItem => ({
  provider: 'gitlab',
  host: 'gitlab.com',
  project: 'team/backend/x',
  iid: n,
  url: `https://gitlab.com/team/backend/x/-/merge_requests/${n}`,
  title: `Title ${n}`,
  author: 'ann',
  state: 'opened',
  updatedAt: '2026-11-10T10:00:00.000Z',
  roles: ['assigned'],
  reviewers: [],
  approvedBy: null,
  ...over,
  people: over.people ?? { [over.author ?? 'ann']: { name: over.author ?? 'ann', avatarUrl: null } }
})

const urls = (items: MineItem[]): string[] => items.map((i) => i.url)

describe('mineWanted', () => {
  // Thirty days before 2026-11-25T12:00:00.000Z is 2026-10-26T12:00:00.000Z: 25 days back is 31 October, and 5 more is 26 October.
  const now = Date.parse('2026-11-25T12:00:00.000Z')

  it.each<[MineState, string, boolean]>([
    ['merged', '2026-10-26T12:00:00.000Z', true],
    ['merged', '2026-10-26T12:00:00.001Z', true],
    ['merged', '2026-10-26T11:59:59.999Z', false],
    ['closed', '2026-10-26T12:00:00.000Z', true],
    ['closed', '2026-10-26T12:00:00.001Z', true],
    ['closed', '2026-10-26T11:59:59.999Z', false]
  ])('keeps a %s change updated at %s only when it is not older than 30 days (kept: %s)', (state, updatedAt, kept) => {
    // Arrange
    const old = item(1, { state, updatedAt })

    // Act
    const wanted = mineWanted(old, now)

    // Assert
    expect(wanted).toBe(kept)
  })

  it.each<MineState>(['draft', 'opened'])('keeps a %s change however old it is', (state) => {
    // Arrange
    const ancient = item(2, { state, updatedAt: '2020-01-01T00:00:00.000Z' })

    // Act
    const wanted = mineWanted(ancient, now)

    // Assert
    expect(wanted).toBe(true)
  })

  it('keeps a merged change that was updated just now', () => {
    // Arrange
    const fresh = item(3, { state: 'merged', updatedAt: '2026-11-25T12:00:00.000Z' })

    // Act
    const wanted = mineWanted(fresh, now)

    // Assert
    expect(wanted).toBe(true)
  })

  it('measures the 30 days from the given time and not from the clock', () => {
    // Arrange
    const merged = item(4, { state: 'merged', updatedAt: '2026-10-26T12:00:00.000Z' })
    const oneDayLater = now + 86_400_000

    // Act
    const wantedAtNow = mineWanted(merged, now)
    const wantedLater = mineWanted(merged, oneDayLater)

    // Assert
    expect(wantedAtNow).toBe(true)
    expect(wantedLater).toBe(false)
  })
})

describe('mergeMine', () => {
  it('keeps one item for a url that is in two lists and joins the roles', () => {
    // Arrange
    const assigned = [item(1, { roles: ['assigned'] }), item(2, { roles: ['assigned'] })]
    const reviewer = [item(2, { roles: ['reviewer'] }), item(3, { roles: ['reviewer'] })]

    // Act
    const merged = mergeMine([assigned, reviewer])

    // Assert
    expect(urls(merged).sort()).toEqual(urls([item(1), item(2), item(3)]).sort())
    const both = merged.find((m) => m.iid === 2)!
    expect([...both.roles].sort()).toEqual(['assigned', 'reviewer'])
    expect(merged.find((m) => m.iid === 1)!.roles).toEqual(['assigned'])
    expect(merged.find((m) => m.iid === 3)!.roles).toEqual(['reviewer'])
  })

  it('does not repeat a role when both lists carry the same one', () => {
    // Arrange
    const lists = [[item(5, { roles: ['reviewer'] })], [item(5, { roles: ['reviewer'] })]]

    // Act
    const merged = mergeMine(lists)

    // Assert
    expect(merged).toHaveLength(1)
    expect(merged[0].roles).toEqual(['reviewer'])
  })

  it('keeps two items that have the same number in different repos', () => {
    // Arrange
    const a = item(7, { project: 'team/a', url: 'https://gitlab.com/team/a/-/merge_requests/7' })
    const b = item(7, { project: 'team/b', url: 'https://gitlab.com/team/b/-/merge_requests/7' })

    // Act
    const merged = mergeMine([[a], [b]])

    // Assert
    expect(merged).toHaveLength(2)
  })

  it('gives an empty list for no lists and for empty lists', () => {
    // Arrange
    const none: MineItem[][] = []

    // Act
    const fromNone = mergeMine(none)
    const fromEmpty = mergeMine([[], []])

    // Assert
    expect(fromNone).toEqual([])
    expect(fromEmpty).toEqual([])
  })

  it('does not change the lists it is given', () => {
    // Arrange
    const first = [item(1, { roles: ['assigned'] })]
    const second = [item(1, { roles: ['reviewer'] })]

    // Act
    mergeMine([first, second])

    // Assert
    expect(first[0].roles).toEqual(['assigned'])
    expect(second[0].roles).toEqual(['reviewer'])
  })
})

describe('DEFAULT_MINE_STATES', () => {
  it('turns only the open state on', () => {
    // Arrange
    const expected: Record<MineState, boolean> = { draft: false, opened: true, merged: false, closed: false }

    // Act
    const states = DEFAULT_MINE_STATES

    // Assert
    expect(states).toEqual(expected)
  })

  it('has a key for every state, so a new state cannot be left out', () => {
    // Arrange
    const keys = Object.keys(DEFAULT_MINE_STATES).sort()

    // Act
    const expected = [...MINE_STATES].sort()

    // Assert
    expect(keys).toEqual(expected)
  })
})

describe('MINE_POLL_MS', () => {
  it('is 60 seconds', () => {
    // Arrange
    const sixtySeconds = 60 * 1000

    // Act
    const interval = MINE_POLL_MS

    // Assert
    expect(interval).toBe(sixtySeconds)
  })
})

describe('mineReviewers', () => {
  it('lists the requested reviewers first and then the people who reviewed, each once and in the order of their first review', () => {
    // Arrange
    const reviews = [
      { user: 'gus', state: 'APPROVED' },
      { user: 'fay', state: 'COMMENTED' },
      { user: 'ivy', state: 'CHANGES_REQUESTED' },
      { user: 'gus', state: 'COMMENTED' }
    ]

    // Act
    const reviewers = mineReviewers(['fay', 'hal'], reviews, 'eve')

    // Assert
    expect(reviewers).toEqual(['fay', 'hal', 'gus', 'ivy'])
  })

  it.each(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'])('counts a person whose review is %s', (state) => {
    // Arrange
    const reviews = [{ user: 'kim', state }]

    // Act
    const reviewers = mineReviewers([], reviews, 'eve')

    // Assert
    expect(reviewers).toEqual(['kim'])
  })

  it('does not count a pending review, and does not count the author', () => {
    // Arrange
    const reviews = [
      { user: 'zed', state: 'PENDING' },
      { user: 'eve', state: 'COMMENTED' }
    ]

    // Act
    const reviewers = mineReviewers([], reviews, 'eve')

    // Assert
    expect(reviewers).toEqual([])
  })

  it('gives nobody when there are no requested reviewers and no reviews', () => {
    // Arrange
    const none: { user: string; state: string }[] = []

    // Act
    const reviewers = mineReviewers([], none, 'eve')

    // Assert
    expect(reviewers).toEqual([])
  })
})

describe('DEFAULT_MINE_APPROVALS', () => {
  it('turns both the approved and the not approved pill on', () => {
    // Arrange

    // Act
    const approvals = DEFAULT_MINE_APPROVALS

    // Assert
    expect(approvals).toEqual({ approved: true, notApproved: true })
  })
})

describe('combineMine', () => {
  const item = (url: string, roles: MineItem['roles'], state: MineItem['state'] = 'opened'): MineItem => ({
    provider: 'gitlab',
    host: 'gitlab.com',
    project: 'g/p',
    iid: 1,
    url,
    title: 't',
    author: 'a',
    state,
    updatedAt: '2026-01-01T00:00:00Z',
    roles,
    people: {},
    reviewers: [],
    approvedBy: null
  })
  const result = (items: MineItem[], over: Partial<MineResult> = {}): MineResult => ({
    items,
    errors: [],
    viewers: { 'gitlab.com': 'me' },
    hasAccess: true,
    ...over
  })

  it('gives the part that has arrived while the other is still null', () => {
    // Arrange
    const open = result([item('u1', ['assigned'])])

    // Act and Assert
    expect(combineMine(open, null)).toBe(open)
    expect(combineMine(null, open)).toBe(open)
    expect(combineMine(null, null)).toBeNull()
  })

  it('joins the two parts and merges the roles of a change that both parts hold', () => {
    // Arrange
    const open = result([item('u1', ['assigned']), item('u2', ['reviewer'])])
    const closed = result([item('u3', ['assigned'], 'merged'), item('u1', ['reviewer'])])

    // Act
    const all = combineMine(open, closed)

    // Assert
    expect(all?.items.map((i) => i.url).sort()).toEqual(['u1', 'u2', 'u3'])
    expect(all?.items.find((i) => i.url === 'u1')?.roles.sort()).toEqual(['assigned', 'reviewer'])
  })

  it('shows one error line for a host that failed in both parts, and keeps a different text of the same host', () => {
    // Arrange
    const down = { host: 'gitlab.com', error: 'HTTP 503' }
    const open = result([], { errors: [down] })
    const closed = result([], { errors: [down, { host: 'gitlab.com', error: 'HTTP 500' }] })

    // Act
    const all = combineMine(open, closed)

    // Assert
    expect(all?.errors).toEqual([down, { host: 'gitlab.com', error: 'HTTP 500' }])
  })

  it('keeps the viewers of both parts, and says there is access when either part says so', () => {
    // Arrange
    const open = result([], { viewers: { 'gitlab.com': 'me' }, hasAccess: false })
    const closed = result([], { viewers: { 'github.com': 'me2' }, hasAccess: true })

    // Act
    const all = combineMine(open, closed)

    // Assert
    expect(all?.viewers).toEqual({ 'github.com': 'me2', 'gitlab.com': 'me' })
    expect(all?.hasAccess).toBe(true)
  })
})
