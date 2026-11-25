import { describe, expect, it } from 'vitest'
import type { ChangeInfo, ChangeSnapshot, ChangeState } from '../src/shared/provider'
import { mrStateKey, type MrFilters, type MrStateKey } from '../src/shared/mr-table'
import { approvalCounts, groupRows, rowApproved, rowStateKey, stateCounts, type ChangeRow } from '../src/shared/mr-rows'

interface RowOver {
  host?: string
  project?: string
  state?: ChangeState
  draft?: boolean
  title?: string
  author?: string
  updatedAt?: string
  reviewers?: string[]
  approvedBy?: string[] | null
  people?: ChangeRow['people']
  url?: string
}

/** A stub row built by hand, a row with no snapshot yet. */
const row = (n: number, over: RowOver = {}): ChangeRow => {
  const host = over.host ?? 'gitlab.com'
  const project = over.project ?? 'team/backend/x'
  const url = over.url ?? (host === 'github.com' ? `https://github.com/${project}/pull/${n}` : `https://${host}/${project}/-/merge_requests/${n}`)
  const author = over.author ?? 'ann'
  const people = over.people ?? { [author]: { name: author, avatarUrl: null } }
  return {
    id: url,
    url,
    repo: project,
    iid: n,
    state: over.state ?? 'opened',
    draft: over.draft ?? false,
    title: over.title ?? `Title ${n}`,
    updatedAt: over.updatedAt ?? '2026-11-10T10:00:00.000Z',
    snapshot: null,
    stub: { author, reviewers: over.reviewers ?? [], people, approvedBy: over.approvedBy === undefined ? null : over.approvedBy },
    defaultBranch: null,
    people,
    viewer: 'me',
    drafts: 0
  }
}

const snapshotRow = (n: number, over: { state?: ChangeState; draft?: boolean; approvedBy?: string[] } = {}): ChangeRow => {
  const state = over.state ?? 'opened'
  const draft = over.draft ?? false
  const url = `https://gitlab.com/team/backend/x/-/merge_requests/${n}`
  const info: ChangeInfo = {
    ref: { provider: 'gitlab', host: 'gitlab.com', project: 'team/backend/x', iid: n },
    url,
    state,
    title: `Title ${n}`,
    description: '',
    draft,
    author: 'ann',
    reviewers: [],
    sourceBranch: 'feat/a',
    targetBranch: 'main',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    mergedAt: null,
    closedAt: null,
    autoMerge: { enabled: false, by: null },
    diffRefs: { base: 'a', start: 'a', head: 'b' },
    pipeline: null,
    userNotesCount: 0,
    behindTarget: null
  }
  const snapshot: ChangeSnapshot = {
    info,
    approvals: { approvedBy: over.approvedBy ?? [], userCanApprove: true, userHasApproved: false },
    threads: [],
    viewerState: null,
    jobs: [],
    people: { ann: { name: 'ann', avatarUrl: null } },
    viewer: 'me'
  }
  return { ...row(n, { state, draft }), snapshot, stub: null, people: snapshot.people }
}

const filters = (states: Partial<Record<MrStateKey, boolean>> = {}, approvals: Partial<MrFilters['approvals']> = {}): MrFilters => ({
  states: { draft: true, opened: true, merged: true, closed: true, ...states },
  approvals: { approved: true, notApproved: true, ...approvals }
})
const ALL_ON = filters()
const OPEN_ONLY = filters({ draft: false, merged: false, closed: false })
const ONLY_APPROVED = filters({}, { notApproved: false })
const ONLY_NOT_APPROVED = filters({}, { approved: false })
const NO_STATES = filters({ draft: false, opened: false, merged: false, closed: false })
const NO_APPROVALS = filters({}, { approved: false, notApproved: false })

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const STATE_ORDER: MrStateKey[] = ['draft', 'opened', 'merged', 'closed']
/** A comparer as a caller would build it: direction included. */
const by = (key: 'repo' | 'state' | 'title' | 'author' | 'reviewers' | 'approvals' | 'updated' | 'id', dir: 'asc' | 'desc' = 'asc') => {
  const sign = dir === 'asc' ? 1 : -1
  const value = (a: ChangeRow, b: ChangeRow): number => {
    switch (key) {
      case 'repo':
        return collator.compare(a.repo, b.repo)
      case 'title':
        return collator.compare(a.title, b.title)
      case 'author':
        return collator.compare(a.people[a.stub?.author ?? '']?.name ?? '', b.people[b.stub?.author ?? '']?.name ?? '')
      case 'state':
        return STATE_ORDER.indexOf(rowStateKey(a)) - STATE_ORDER.indexOf(rowStateKey(b))
      case 'reviewers':
        return (a.stub?.reviewers.length ?? 0) - (b.stub?.reviewers.length ?? 0)
      case 'approvals':
        return (a.stub?.approvedBy?.length ?? 0) - (b.stub?.approvedBy?.length ?? 0)
      case 'updated':
        return Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
      case 'id':
        return a.iid - b.iid
    }
  }
  return (a: ChangeRow, b: ChangeRow): number => value(a, b) * sign
}
const NO_ORDER = (): number => 0
const iids = (rows: ChangeRow[]): number[] => rows.map((r) => r.iid)

describe('rowApproved', () => {
  it.each<[string, string[] | null, boolean]>([
    ['unknown (null)', null, false],
    ['nobody', [], false],
    ['exactly one person', ['kim'], true],
    ['two people', ['kim', 'lee'], true]
  ])('answers for a stub row with approvedBy %s', (_name, approvedBy, expected) => {
    // Arrange
    const r = row(1, { approvedBy })

    // Act
    const approved = rowApproved(r)

    // Assert
    expect(approved).toBe(expected)
  })

  it.each<[string, string[], boolean]>([
    ['nobody', [], false],
    ['exactly one person', ['kim'], true],
    ['three people', ['kim', 'lee', 'max'], true]
  ])('answers for a snapshot row with approvals.approvedBy %s', (_name, approvedBy, expected) => {
    // Arrange
    const r = snapshotRow(1, { approvedBy })

    // Act
    const approved = rowApproved(r)

    // Assert
    expect(approved).toBe(expected)
  })

  it('reads the snapshot and not the stub when a row has both', () => {
    // Arrange
    const r = { ...snapshotRow(1, { approvedBy: [] }), stub: row(1, { approvedBy: ['kim'] }).stub }

    // Act
    const approved = rowApproved(r)

    // Assert
    expect(approved).toBe(false)
  })
})

describe('rowStateKey', () => {
  it.each<[ChangeState, boolean, MrStateKey]>([
    ['opened', true, 'draft'],
    ['opened', false, 'opened'],
    ['merged', true, 'merged'],
    ['merged', false, 'merged'],
    ['closed', true, 'closed'],
    ['closed', false, 'closed'],
    ['locked', false, 'closed'],
    ['locked', true, 'closed']
  ])('maps state %s with draft %s to %s', (state, draft, expected) => {
    // Arrange
    const r = row(1, { state, draft })

    // Act
    const key = rowStateKey(r)

    // Assert
    expect(key).toBe(expected)
  })

  it.each<[ChangeState, boolean]>([
    ['opened', true],
    ['opened', false],
    ['merged', false],
    ['closed', false],
    ['locked', false]
  ])('equals mrStateKey of the snapshot info for a snapshot row, state %s draft %s', (state, draft) => {
    // Arrange
    const r = snapshotRow(1, { state, draft })

    // Act
    const key = rowStateKey(r)

    // Assert
    expect(key).toBe(mrStateKey(r.snapshot!.info))
  })
})

describe('stateCounts', () => {
  it('counts every row by its state key and ignores both filters', () => {
    // Arrange
    const rows = [
      row(1, { state: 'opened', draft: true }),
      row(2, { state: 'opened', draft: true }),
      row(3, { state: 'opened' }),
      row(4, { state: 'merged', draft: true }),
      row(5, { state: 'closed' }),
      row(6, { state: 'locked' }),
      row(7, { state: 'closed', approvedBy: ['kim'] })
    ]

    // Act
    const counts = stateCounts(rows)

    // Assert
    expect(counts).toEqual({ draft: 2, opened: 1, merged: 1, closed: 3 })
  })

  it('gives zero for every state with no rows', () => {
    // Act
    const counts = stateCounts([])

    // Assert
    expect(counts).toEqual({ draft: 0, opened: 0, merged: 0, closed: 0 })
  })

  it('counts one row, and counts a snapshot row like a stub row', () => {
    // Act
    const one = stateCounts([row(1, { state: 'merged' })])
    const snap = stateCounts([snapshotRow(2, { state: 'opened', draft: true })])

    // Assert
    expect(one).toEqual({ draft: 0, opened: 0, merged: 1, closed: 0 })
    expect(snap).toEqual({ draft: 1, opened: 0, merged: 0, closed: 0 })
  })

  it('does not change the rows it is given', () => {
    // Arrange
    const rows = [row(1, { state: 'closed' }), row(2, { draft: true })]
    const before = JSON.stringify(rows)

    // Act
    stateCounts(rows)

    // Assert
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('approvalCounts', () => {
  it('counts approved rows and the others, and counts a stub with unknown approvals as not approved', () => {
    // Arrange
    const rows = [
      row(1, { approvedBy: ['kim'] }),
      row(2, { approvedBy: ['kim', 'lee'] }),
      row(3, { approvedBy: [] }),
      row(4, { approvedBy: null }),
      row(5, { approvedBy: null }),
      snapshotRow(6, { approvedBy: ['kim'] }),
      snapshotRow(7, { approvedBy: [] })
    ]

    // Act
    const counts = approvalCounts(rows, filters().states)

    // Assert
    expect(counts).toEqual({ approved: 3, notApproved: 4 })
  })

  it('counts only the rows whose state is enabled', () => {
    // Arrange
    const rows = [
      row(1, { state: 'opened', approvedBy: ['kim'] }),
      row(2, { state: 'opened', approvedBy: [] }),
      row(3, { state: 'opened', draft: true, approvedBy: ['kim'] }),
      row(4, { state: 'merged', approvedBy: ['kim'] }),
      row(5, { state: 'merged', approvedBy: null }),
      row(6, { state: 'closed', approvedBy: [] })
    ]

    // Act
    const openOnly = approvalCounts(rows, OPEN_ONLY.states)
    const openAndMerged = approvalCounts(rows, filters({ draft: false, closed: false }).states)
    const everything = approvalCounts(rows, ALL_ON.states)

    // Assert
    expect(openOnly).toEqual({ approved: 1, notApproved: 1 })
    expect(openAndMerged).toEqual({ approved: 2, notApproved: 2 })
    expect(everything).toEqual({ approved: 3, notApproved: 3 })
  })

  it('gives 0 and 0 for no rows and when every state is off', () => {
    // Arrange
    const rows = [row(1, { approvedBy: ['kim'] }), row(2)]

    // Act
    const empty = approvalCounts([], ALL_ON.states)
    const off = approvalCounts(rows, NO_STATES.states)

    // Assert
    expect(empty).toEqual({ approved: 0, notApproved: 0 })
    expect(off).toEqual({ approved: 0, notApproved: 0 })
  })

  it('does not change the rows it is given', () => {
    // Arrange
    const rows = [row(1, { approvedBy: ['kim'] }), row(2, { approvedBy: null })]
    const before = JSON.stringify(rows)

    // Act
    approvalCounts(rows, ALL_ON.states)

    // Assert
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('groupRows in state mode', () => {
  it('gives one group for each state that has rows, in the order draft, opened, merged, closed, and leaves out the empty ones', () => {
    // Arrange
    const rows = [
      row(1, { state: 'closed' }),
      row(2, { state: 'opened' }),
      row(3, { state: 'opened', draft: true }),
      row(4, { state: 'closed' }),
      row(5, { state: 'opened', draft: true })
    ]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => g.state)).toEqual(['draft', 'opened', 'closed'])
    expect(groups.map((g) => iids(g.rows).sort())).toEqual([[3, 5], [2], [1, 4]])
  })

  it('maps a locked row into the closed group', () => {
    // Arrange
    const rows = [row(1, { state: 'locked' }), row(2, { state: 'closed' })]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.key, iids(g.rows)])).toEqual([['state:closed', [1, 2]]])
  })

  it('sorts the rows inside a group by the update time, newest first, and equal times by id ascending, when compare says equal', () => {
    // Arrange
    const rows = [
      row(1, { updatedAt: '2026-11-01T08:00:00.000Z' }),
      row(2, { updatedAt: '2026-11-03T08:00:00.000Z' }),
      row(9, { updatedAt: '2026-11-02T08:00:00.000Z' }),
      row(4, { updatedAt: '2026-11-02T08:00:00.000Z' }),
      row(10, { updatedAt: '2026-11-02T08:00:00.000Z' })
    ]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, ALL_ON)

    // Assert: the ids of 10, 4 and 9 sort as strings, so 10 comes before 4 and 9
    expect(groups).toHaveLength(1)
    expect(iids(groups[0].rows)).toEqual([2, 10, 4, 9, 1])
  })

  it('leaves out a state that is turned off', () => {
    // Arrange
    const rows = [row(1, { draft: true }), row(2, { state: 'opened' }), row(3, { state: 'merged' })]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, filters({ draft: false, merged: false }))

    // Assert
    expect(groups.map((g) => g.state)).toEqual(['opened'])
  })

  it('gives no groups for no rows', () => {
    // Act
    const groups = groupRows([], 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(groups).toEqual([])
  })

  it('gives one group for one row', () => {
    // Act
    const groups = groupRows([row(1, { state: 'merged' })], 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.key, g.label, g.state, iids(g.rows)])).toEqual([['state:merged', 'merged', 'merged', [1]]])
  })

  it('compares the update times as moments, not as text', () => {
    // Arrange: 10:00+02:00 is 08:00Z, so it is older than 09:00Z although its text sorts later
    const older = row(1, { updatedAt: '2026-11-01T10:00:00.000+02:00' })
    const newer = row(2, { updatedAt: '2026-11-01T09:00:00.000Z' })

    // Act
    const groups = groupRows([older, newer], 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(iids(groups[0].rows)).toEqual([2, 1])
  })

  it('does not change the list it is given', () => {
    // Arrange
    const rows = [row(1, { updatedAt: '2026-11-01T08:00:00.000Z' }), row(2, { updatedAt: '2026-11-05T08:00:00.000Z' })]
    const before = iids(rows)

    // Act
    groupRows(rows, 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(iids(rows)).toEqual(before)
  })

  it('gives each group the key state:<state>, the state as its label and the state itself', () => {
    // Arrange
    const rows = [row(1, { state: 'opened' }), row(2, { draft: true })]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.key, g.label, g.state])).toEqual([
      ['state:draft', 'draft', 'draft'],
      ['state:opened', 'opened', 'opened']
    ])
  })

  it('shows only the open rows with the default of the home lists', () => {
    // Arrange
    const rows = [row(1, { draft: true }), row(2), row(3, { state: 'merged' }), row(4, { state: 'closed' }), row(5)]

    // Act
    const groups = groupRows(rows, 'state', NO_ORDER, OPEN_ONLY)

    // Assert
    expect(groups.map((g) => g.state)).toEqual(['opened'])
    expect(iids(groups[0].rows).sort()).toEqual([2, 5])
  })
})

describe('groupRows in none mode', () => {
  it('gives one list without key, label and state, with every enabled row, newest first and equal times by id ascending', () => {
    // Arrange
    const rows = [
      row(1, { state: 'closed', updatedAt: '2026-11-01T08:00:00.000Z' }),
      row(2, { draft: true, updatedAt: '2026-11-04T08:00:00.000Z' }),
      row(3, { state: 'merged', updatedAt: '2026-11-02T08:00:00.000Z' }),
      row(8, { state: 'opened', updatedAt: '2026-11-03T08:00:00.000Z' }),
      row(7, { state: 'opened', updatedAt: '2026-11-03T08:00:00.000Z' })
    ]

    // Act
    const groups = groupRows(rows, 'none', NO_ORDER, ALL_ON)

    // Assert
    expect(groups).toHaveLength(1)
    expect(groups[0].state).toBeNull()
    expect(groups[0].key).toBeNull()
    expect(groups[0].label).toBeNull()
    expect(iids(groups[0].rows)).toEqual([2, 7, 8, 3, 1])
  })

  it('leaves out the rows of a state that is turned off', () => {
    // Arrange
    const rows = [row(1, { state: 'closed' }), row(2, { state: 'opened', updatedAt: '2026-11-02T08:00:00.000Z' }), row(3, { state: 'merged' })]

    // Act
    const groups = groupRows(rows, 'none', NO_ORDER, filters({ merged: false, closed: false }))

    // Assert
    expect(groups.flatMap((g) => iids(g.rows))).toEqual([2])
    expect(groups.every((g) => g.state === null)).toBe(true)
  })

  it('returns the one group even when there are no rows', () => {
    // Act
    const groups = groupRows([], 'none', NO_ORDER, ALL_ON)

    // Assert
    expect(groups).toEqual([{ key: null, label: null, state: null, rows: [] }])
  })

  it('returns the one group, empty, when the filters hide every row', () => {
    // Arrange
    const rows = [row(1, { approvedBy: ['kim'] })]

    // Act
    const groups = groupRows(rows, 'none', NO_ORDER, filters({}, { approved: false }))

    // Assert
    expect(groups).toEqual([{ key: null, label: null, state: null, rows: [] }])
  })
})

describe('groupRows in repo mode', () => {
  it('gives one group for each repo, in an order that is numeric-aware and not case-sensitive, with the key repo:<host>/<project> and the path as label', () => {
    // Arrange
    const rows = [
      row(1, { project: 'team/svc10' }),
      row(2, { project: 'Team/alpha' }),
      row(3, { project: 'team/svc2' }),
      row(4, { project: 'team/Beta' }),
      row(5, { project: 'team/svc2' })
    ]

    // Act
    const groups = groupRows(rows, 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => g.label)).toEqual(['Team/alpha', 'team/Beta', 'team/svc2', 'team/svc10'])
    expect(groups.map((g) => g.key)).toEqual([
      'repo:gitlab.com/Team/alpha',
      'repo:gitlab.com/team/Beta',
      'repo:gitlab.com/team/svc2',
      'repo:gitlab.com/team/svc10'
    ])
    expect(groups.every((g) => g.state === null)).toBe(true)
    expect(groups.map((g) => iids(g.rows).sort((a, b) => a - b))).toEqual([[2], [4], [3, 5], [1]])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('keeps the groups ascending by path whatever the compare, %s', (dir) => {
    // Arrange
    const rows = [row(1, { project: 'b/two' }), row(2, { project: 'a/one' }), row(3, { project: 'c/three' })]

    // Act
    const byRepo = groupRows(rows, 'repo', by('repo', dir), ALL_ON)
    const byTitle = groupRows(rows, 'repo', by('title', dir), ALL_ON)

    // Assert
    expect(byRepo.map((g) => g.label)).toEqual(['a/one', 'b/two', 'c/three'])
    expect(byTitle.map((g) => g.label)).toEqual(['a/one', 'b/two', 'c/three'])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('sorts the rows inside a group by compare, title %s', (dir) => {
    // Arrange
    const rows = [
      row(1, { project: 'a/one', title: 'Mango' }),
      row(2, { project: 'a/one', title: 'Banana' }),
      row(3, { project: 'b/two', title: 'Kiwi' }),
      row(4, { project: 'a/one', title: 'Cherry' }),
      row(5, { project: 'b/two', title: 'Apple' })
    ]

    // Act
    const groups = groupRows(rows, 'repo', by('title', dir), ALL_ON)

    // Assert
    expect(iids(groups[0].rows)).toEqual(dir === 'asc' ? [2, 4, 1] : [1, 4, 2])
    expect(iids(groups[1].rows)).toEqual(dir === 'asc' ? [5, 3] : [3, 5])
  })

  it('sorts the rows inside a group by the newest update when compare says equal', () => {
    // Arrange
    const rows = [
      row(1, { project: 'a/one', updatedAt: '2026-11-01T08:00:00.000Z' }),
      row(2, { project: 'a/one', updatedAt: '2026-11-05T08:00:00.000Z' }),
      row(3, { project: 'a/one', updatedAt: '2026-11-03T08:00:00.000Z' })
    ]

    // Act
    const groups = groupRows(rows, 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(iids(groups[0].rows)).toEqual([2, 3, 1])
  })

  it('leaves out the rows of a state that is turned off and drops a repo that has no row left', () => {
    // Arrange
    const rows = [
      row(1, { project: 'a/one', state: 'merged' }),
      row(2, { project: 'b/two', state: 'opened' }),
      row(3, { project: 'b/two', state: 'closed' }),
      row(4, { project: 'c/three', draft: true })
    ]

    // Act
    const some = groupRows(rows, 'repo', NO_ORDER, OPEN_ONLY)

    // Assert
    expect(some.map((g) => g.label)).toEqual(['b/two'])
    expect(iids(some[0].rows)).toEqual([2])
  })

  it('keeps the same path on two hosts as two groups, shows the path as label and puts the host in the key', () => {
    // Arrange
    const rows = [
      row(1, { host: 'github.com', project: 'acme/web' }),
      row(2, { host: 'gitlab.com', project: 'acme/web' }),
      row(3, { host: 'github.com', project: 'acme/web' })
    ]

    // Act
    const groups = groupRows(rows, 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => g.label)).toEqual(['acme/web', 'acme/web'])
    expect(groups.map((g) => g.key)).toEqual(['repo:github.com/acme/web', 'repo:gitlab.com/acme/web'])
    expect(groups.map((g) => iids(g.rows).sort((a, b) => a - b))).toEqual([[1, 3], [2]])
  })

  it('orders two hosts with the same path by host, whatever the input order', () => {
    // Arrange
    const a = row(1, { host: 'gitlab.com', project: 'acme/web' })
    const b = row(2, { host: 'git.example.org', project: 'acme/web' })

    // Act
    const one = groupRows([a, b], 'repo', NO_ORDER, ALL_ON)
    const other = groupRows([b, a], 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(one.map((g) => g.key)).toEqual(['repo:git.example.org/acme/web', 'repo:gitlab.com/acme/web'])
    expect(other.map((g) => g.key)).toEqual(one.map((g) => g.key))
  })

  it('keeps the same iid in two repos as two rows in two groups', () => {
    // Arrange
    const rows = [row(7, { project: 'a/one' }), row(7, { project: 'b/two' })]

    // Act
    const groups = groupRows(rows, 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.label, iids(g.rows)])).toEqual([
      ['a/one', [7]],
      ['b/two', [7]]
    ])
  })

  it('gives no groups for no rows and does not change the list it is given', () => {
    // Arrange
    const rows = [row(1, { project: 'b/two' }), row(2, { project: 'a/one' })]
    const before = iids(rows)

    // Act
    const groups = groupRows(rows, 'repo', NO_ORDER, ALL_ON)
    const empty = groupRows([], 'repo', NO_ORDER, ALL_ON)

    // Assert
    expect(groups).toHaveLength(2)
    expect(iids(rows)).toEqual(before)
    expect(empty).toEqual([])
  })
})

describe('groupRows with a compare', () => {
  const flat = (rows: ChangeRow[], compare: (a: ChangeRow, b: ChangeRow) => number): number[] => iids(groupRows(rows, 'none', compare, ALL_ON)[0].rows)

  it.each<[string, 'asc' | 'desc', number[]]>([
    // Repos: 1 lx-10, 2 LX-2, 3 Lx-3, 4 acme. Numeric aware and case-insensitive: acme, LX-2, Lx-3, lx-10.
    ['repo ascending', 'asc', [4, 2, 3, 1]],
    ['repo descending', 'desc', [1, 3, 2, 4]]
  ])('follows a compare by %s', (_name, dir, expected) => {
    // Arrange
    const rows = [row(1, { project: 'team/lx-10' }), row(2, { project: 'team/LX-2' }), row(3, { project: 'team/Lx-3' }), row(4, { project: 'Acme/web' })]

    // Act
    const order = flat(rows, by('repo', dir))

    // Assert
    expect(order).toEqual(expected)
  })

  it.each<['asc' | 'desc', number[]]>([
    ['asc', [5, 3, 2, 4, 1]],
    ['desc', [1, 2, 4, 3, 5]]
  ])('follows a compare by state %s, and the tie of 2 and 4 does not flip', (dir, expected) => {
    // Arrange: equal times, so the id breaks the tie between 2 and 4 in both directions
    const rows = [
      row(1, { state: 'closed' }),
      row(2, { state: 'merged' }),
      row(3, { state: 'opened' }),
      row(4, { state: 'merged', url: 'https://gitlab.com/team/backend/x/-/merge_requests/40' }),
      row(5, { draft: true })
    ]

    // Act
    const order = flat(rows, by('state', dir))

    // Assert
    expect(order).toEqual(expected)
  })

  it.each<['title' | 'author', 'asc' | 'desc', number[]]>([
    ['title', 'asc', [2, 3, 1]],
    ['title', 'desc', [1, 3, 2]],
    ['author', 'asc', [3, 1, 2]],
    ['author', 'desc', [2, 1, 3]]
  ])('follows a compare by %s %s', (key, dir, expected) => {
    // Arrange: titles "item 10", "Item 2", "item 3"; display names "ann-12", "Zed", "ann-9" behind the usernames u3, u1, u2
    const rows = [
      row(1, { title: 'item 10', author: 'u3', people: { u3: { name: 'ann-12', avatarUrl: null } } }),
      row(2, { title: 'Item 2', author: 'u1', people: { u1: { name: 'Zed', avatarUrl: null } } }),
      row(3, { title: 'item 3', author: 'u2', people: { u2: { name: 'ann-9', avatarUrl: null } } })
    ]

    // Act
    const order = flat(rows, by(key, dir))

    // Assert
    expect(order).toEqual(expected)
  })

  it.each<['asc' | 'desc', number[]]>([
    ['asc', [3, 2, 1]],
    ['desc', [1, 2, 3]]
  ])('follows a compare by updated %s as an instant, not as text', (dir, expected) => {
    // Arrange: row 2 reads as a later time than row 1 but is 06:00Z
    const rows = [
      row(1, { updatedAt: '2026-11-10T10:00:00.000Z' }),
      row(2, { updatedAt: '2026-11-10T11:00:00.000+05:00' }),
      row(3, { updatedAt: '2026-11-09T23:59:59.999Z' })
    ]

    // Act
    const order = flat(rows, by('updated', dir))

    // Assert
    expect(order).toEqual(expected)
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])(
    'breaks a tie by the newest update and then by id ascending, and the tie-break does not flip when the direction is %s',
    (dir) => {
      // Arrange: equal repos. Rows 1 and 2 have the same time, so the id decides between them. Row 3 is older.
      const rows = [
        row(3, { project: 'same/repo', updatedAt: '2026-11-01T10:00:00.000Z' }),
        row(2, { project: 'same/repo', updatedAt: '2026-11-05T10:00:00.000Z' }),
        row(1, { project: 'same/repo', updatedAt: '2026-11-05T10:00:00.000Z' }),
        row(4, { project: 'other/repo', updatedAt: '2026-11-02T10:00:00.000Z' })
      ]

      // Act
      const order = flat(rows, by('repo', dir))

      // Assert
      expect(order).toEqual(dir === 'asc' ? [4, 1, 2, 3] : [1, 2, 3, 4])
    }
  )

  it('applies the tie-break only when compare returns exactly 0, not for a small non-zero value', () => {
    // Arrange: compare ranks row 1 before row 2 by a tiny margin, while row 2 is newer
    const rows = [row(2, { updatedAt: '2026-11-09T10:00:00.000Z' }), row(1, { updatedAt: '2026-11-01T10:00:00.000Z' })]
    const tiny = (a: ChangeRow, b: ChangeRow): number => (a.iid - b.iid) * 0.001

    // Act
    const order = flat(rows, tiny)

    // Assert
    expect(order).toEqual([1, 2])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('sorts inside each group in state mode, title %s, and keeps the group order', (dir) => {
    // Arrange
    const rows = [
      row(1, { title: 'Mango' }),
      row(2, { title: 'Banana' }),
      row(3, { state: 'closed', title: 'Kiwi' }),
      row(5, { draft: true, title: 'Apple' }),
      row(6, { draft: true, title: 'Zebra' })
    ]

    // Act
    const groups = groupRows(rows, 'state', by('title', dir), ALL_ON)

    // Assert
    expect(groups.map((g) => g.state)).toEqual(['draft', 'opened', 'closed'])
    expect(iids(groups[0].rows)).toEqual(dir === 'asc' ? [5, 6] : [6, 5])
    expect(iids(groups[1].rows)).toEqual(dir === 'asc' ? [2, 1] : [1, 2])
    expect(iids(groups[2].rows)).toEqual([3])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('sorting by state in state mode only orders the ties inside a group, %s', (dir) => {
    // Arrange
    const rows = [
      row(1, { updatedAt: '2026-11-01T10:00:00.000Z' }),
      row(2, { updatedAt: '2026-11-04T10:00:00.000Z' }),
      row(3, { draft: true, updatedAt: '2026-11-02T10:00:00.000Z' })
    ]

    // Act
    const groups = groupRows(rows, 'state', by('state', dir), ALL_ON)

    // Assert
    expect(groups.map((g) => g.state)).toEqual(['draft', 'opened'])
    expect(iids(groups[1].rows)).toEqual([2, 1])
  })

  it('does not change the list it is given when it sorts', () => {
    // Arrange
    const rows = [row(3, { title: 'c' }), row(1, { title: 'a' }), row(2, { title: 'b' })]
    const before = iids(rows)

    // Act
    groupRows(rows, 'none', by('title', 'asc'), ALL_ON)

    // Assert
    expect(iids(rows)).toEqual(before)
  })
})

describe('groupRows with a compare by the number of people', () => {
  // Reviewers: 1 has two, 2 has none, 3 has one, 4 has none. Approvals: 1 has one, 2 is unknown (null), 3 has three, 4 has none.
  // Rows 2 and 4 tie at 0 on both columns, and 4 is the newer, so 4 comes first in either direction. An unknown approvals list counts as nobody.
  const rows = [
    row(1, { reviewers: ['a', 'b'], approvedBy: ['a'], updatedAt: '2026-11-03T10:00:00.000Z' }),
    row(2, { reviewers: [], approvedBy: null, updatedAt: '2026-11-01T10:00:00.000Z' }),
    row(3, { reviewers: ['c'], approvedBy: ['a', 'b', 'c'], updatedAt: '2026-11-02T10:00:00.000Z' }),
    row(4, { reviewers: [], approvedBy: [], updatedAt: '2026-11-05T10:00:00.000Z' })
  ]

  it.each<['reviewers' | 'approvals', 'asc' | 'desc', number[]]>([
    ['reviewers', 'asc', [4, 2, 3, 1]],
    ['reviewers', 'desc', [1, 3, 4, 2]],
    ['approvals', 'asc', [4, 2, 1, 3]],
    ['approvals', 'desc', [3, 1, 4, 2]]
  ])('follows a compare by %s %s', (key, dir, expected) => {
    // Act
    const order = iids(groupRows(rows, 'none', by(key, dir), ALL_ON)[0].rows)

    // Assert
    expect(order).toEqual(expected)
  })
})

describe('groupRows with a compare by the change number', () => {
  const flat = (rows: ChangeRow[], dir: 'asc' | 'desc'): ChangeRow[] => groupRows(rows, 'none', by('id', dir), ALL_ON)[0].rows

  it.each<['asc' | 'desc', number[]]>([
    ['asc', [2, 9, 10, 100]],
    ['desc', [100, 10, 9, 2]]
  ])('follows the number %s as a number, so 9 comes before 10', (dir, expected) => {
    // Arrange
    const rows = [row(10), row(2), row(100), row(9)]

    // Act
    const order = iids(flat(rows, dir))

    // Assert
    expect(order).toEqual(expected)
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])(
    'breaks the tie of the same number in two repos by the newest update, then by id ascending, when the direction is %s',
    (dir) => {
      // Arrange: three rows with the number 7, the newest update in the middle id
      const rows = [
        row(7, { project: 'lx-10/c', updatedAt: '2026-11-01T10:00:00.000Z' }),
        row(7, { project: 'acme/api', updatedAt: '2026-11-02T10:00:00.000Z' }),
        row(7, { project: 'LX-2/b', updatedAt: '2026-11-09T10:00:00.000Z' })
      ]

      // Act
      const order = flat(rows, dir).map((r) => r.repo)

      // Assert
      expect(order).toEqual(['LX-2/b', 'acme/api', 'lx-10/c'])
    }
  )

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('breaks the last tie, equal updates and equal numbers, by id ascending when the direction is %s', (dir) => {
    // Arrange
    const rows = [row(7, { host: 'gitlab.com', project: 'acme/web' }), row(7, { host: 'git.example.org', project: 'acme/web' })]

    // Act
    const order = flat(rows, dir).map((r) => r.id)

    // Assert
    expect(order).toEqual(['https://git.example.org/acme/web/-/merge_requests/7', 'https://gitlab.com/acme/web/-/merge_requests/7'])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])(
    'sorts inside each group in state mode and in repo mode by number %s, and keeps the order of the groups',
    (dir) => {
      // Arrange: 12 and 3 are open, 40 and 8 are merged. 3 and 40 are in "a/one", 12 and 8 are in "b/two".
      const rows = [
        row(12, { state: 'opened', project: 'b/two' }),
        row(3, { state: 'opened', project: 'a/one' }),
        row(40, { state: 'merged', project: 'a/one' }),
        row(8, { state: 'merged', project: 'b/two' })
      ]

      // Act
      const byState = groupRows(rows, 'state', by('id', dir), ALL_ON)
      const byRepo = groupRows(rows, 'repo', by('id', dir), ALL_ON)

      // Assert
      expect(byState.map((g) => g.state)).toEqual(['opened', 'merged'])
      expect(iids(byState[0].rows)).toEqual(dir === 'asc' ? [3, 12] : [12, 3])
      expect(iids(byState[1].rows)).toEqual(dir === 'asc' ? [8, 40] : [40, 8])
      expect(byRepo.map((g) => g.label)).toEqual(['a/one', 'b/two'])
      expect(iids(byRepo[0].rows)).toEqual(dir === 'asc' ? [3, 40] : [40, 3])
      expect(iids(byRepo[1].rows)).toEqual(dir === 'asc' ? [8, 12] : [12, 8])
    }
  )
})

describe('groupRows in approval mode', () => {
  it('gives the group Approved and then the group Not approved, with the keys approval:approved and approval:notApproved, the labels approved and notApproved and no state', () => {
    // Arrange
    const rows = [row(1, { approvedBy: [] }), row(2, { approvedBy: ['kim'] }), row(3, { approvedBy: ['kim', 'lee'] }), row(4, { approvedBy: null })]

    // Act
    const groups = groupRows(rows, 'approval', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.key, g.label, g.state])).toEqual([
      ['approval:approved', 'approved', null],
      ['approval:notApproved', 'notApproved', null]
    ])
    expect(groups.map((g) => iids(g.rows).sort())).toEqual([
      [2, 3],
      [1, 4]
    ])
  })

  it('puts a snapshot row with an approver into the Approved group', () => {
    // Arrange
    const rows = [snapshotRow(1, { approvedBy: ['kim'] }), snapshotRow(2, { approvedBy: [] })]

    // Act
    const groups = groupRows(rows, 'approval', NO_ORDER, ALL_ON)

    // Assert
    expect(groups.map((g) => [g.key, iids(g.rows)])).toEqual([
      ['approval:approved', [1]],
      ['approval:notApproved', [2]]
    ])
  })

  it.each<['asc' | 'desc']>([['asc'], ['desc']])('keeps the order Approved, Not approved whatever the compare, %s', (dir) => {
    // Arrange
    const rows = [row(1, { approvedBy: [] }), row(2, { approvedBy: ['kim'] })]

    // Act
    const groups = groupRows(rows, 'approval', by('approvals', dir), ALL_ON)

    // Assert
    expect(groups.map((g) => g.key)).toEqual(['approval:approved', 'approval:notApproved'])
  })

  it('drops an empty group', () => {
    // Act
    const first = groupRows([row(1, { approvedBy: ['kim'] })], 'approval', NO_ORDER, ALL_ON)
    const second = groupRows([row(2, { approvedBy: [] })], 'approval', NO_ORDER, ALL_ON)
    const third = groupRows([], 'approval', NO_ORDER, ALL_ON)

    // Assert
    expect(first.map((g) => g.key)).toEqual(['approval:approved'])
    expect(second.map((g) => g.key)).toEqual(['approval:notApproved'])
    expect(third).toEqual([])
  })

  it('sorts the rows inside each group by compare, and by the newest update then the id when compare says equal', () => {
    // Arrange
    const rows = [
      row(1, { approvedBy: ['kim'], title: 'Mango', updatedAt: '2026-11-01T08:00:00.000Z' }),
      row(2, { approvedBy: ['kim'], title: 'Banana', updatedAt: '2026-11-05T08:00:00.000Z' }),
      row(3, { approvedBy: [], title: 'Kiwi', updatedAt: '2026-11-03T08:00:00.000Z' }),
      row(4, { approvedBy: ['kim'], title: 'Cherry', updatedAt: '2026-11-03T08:00:00.000Z' }),
      row(5, { approvedBy: [], title: 'Apple', updatedAt: '2026-11-07T08:00:00.000Z' })
    ]

    // Act
    const asc = groupRows(rows, 'approval', by('title', 'asc'), ALL_ON)
    const desc = groupRows(rows, 'approval', by('title', 'desc'), ALL_ON)
    const none = groupRows(rows, 'approval', NO_ORDER, ALL_ON)

    // Assert
    expect(asc.map((g) => iids(g.rows))).toEqual([
      [2, 4, 1],
      [5, 3]
    ])
    expect(desc.map((g) => iids(g.rows))).toEqual([
      [1, 4, 2],
      [3, 5]
    ])
    expect(none.map((g) => iids(g.rows))).toEqual([
      [2, 4, 1],
      [5, 3]
    ])
  })

  it('leaves out the rows of a state that is turned off', () => {
    // Arrange
    const rows = [row(1, { approvedBy: ['kim'] }), row(2, { state: 'merged', approvedBy: ['kim'] }), row(3, { draft: true, approvedBy: [] })]

    // Act
    const groups = groupRows(rows, 'approval', NO_ORDER, OPEN_ONLY)

    // Assert
    expect(groups.map((g) => [g.key, iids(g.rows)])).toEqual([['approval:approved', [1]]])
  })

  it('does not change the list it is given', () => {
    // Arrange
    const rows = [row(1, { approvedBy: [], updatedAt: '2026-11-01T08:00:00.000Z' }), row(2, { approvedBy: ['kim'] }), row(3, { approvedBy: [] })]
    const before = JSON.stringify(rows)

    // Act
    groupRows(rows, 'approval', by('title', 'desc'), ONLY_NOT_APPROVED)

    // Assert
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('groupRows with the filters', () => {
  const rows = [
    row(1, { project: 'a/one', approvedBy: ['kim'] }),
    row(2, { project: 'a/one', approvedBy: [] }),
    row(3, { project: 'b/two', approvedBy: null }),
    row(4, { project: 'b/two', draft: true, approvedBy: ['kim', 'lee'] }),
    row(5, { project: 'c/three', draft: true, approvedBy: ['lee'] })
  ]
  const modes = ['none', 'repo', 'state', 'approval'] as const
  const shownIn = (mode: (typeof modes)[number], f: MrFilters): number[] => iids(groupRows(rows, mode, NO_ORDER, f).flatMap((g) => g.rows)).sort()

  it.each(modes)('shows every row when both approval buttons are on, in mode %s', (mode) => {
    // Act
    const shown = shownIn(mode, ALL_ON)

    // Assert
    expect(shown).toEqual([1, 2, 3, 4, 5])
  })

  it.each(modes)('shows only the approved rows when only Approved is on, in mode %s', (mode) => {
    // Act
    const shown = shownIn(mode, ONLY_APPROVED)

    // Assert
    expect(shown).toEqual([1, 4, 5])
  })

  it.each(modes)('shows the not approved rows and the unknown ones when only Not approved is on, in mode %s', (mode) => {
    // Act
    const shown = shownIn(mode, ONLY_NOT_APPROVED)

    // Assert
    expect(shown).toEqual([2, 3])
  })

  it.each(modes)('filters nothing by approval when both buttons are off, like mrVisible, in mode %s', (mode) => {
    // Act
    const shown = shownIn(mode, NO_APPROVALS)

    // Assert
    expect(shown).toEqual([1, 2, 3, 4, 5])
  })

  it.each(modes)('filters nothing by state when every state button is off, like mrVisible, in mode %s', (mode) => {
    // Arrange
    const mixed = [...rows, row(6, { state: 'merged' }), row(7, { state: 'closed' })]

    // Act
    const shown = iids(groupRows(mixed, mode, NO_ORDER, NO_STATES).flatMap((g) => g.rows)).sort()

    // Assert
    expect(shown).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('still applies the approval buttons when every state button is off, and the state buttons when both approval buttons are off', () => {
    // Arrange
    const mixed = [...rows, row(6, { state: 'merged', approvedBy: ['kim'] })]
    const noStatesOnlyApproved = filters({ draft: false, opened: false, merged: false, closed: false }, { notApproved: false })
    const mergedOnlyNoApprovals = filters({ draft: false, opened: false, closed: false }, { approved: false, notApproved: false })

    // Act
    const a = iids(groupRows(mixed, 'none', NO_ORDER, noStatesOnlyApproved)[0].rows).sort()
    const b = iids(groupRows(mixed, 'none', NO_ORDER, mergedOnlyNoApprovals)[0].rows).sort()

    // Assert
    expect(a).toEqual([1, 4, 5, 6])
    expect(b).toEqual([6])
  })

  it('gives no group for a repo or a state or an approval side that has no shown row left', () => {
    // Act
    const byRepo = groupRows(rows, 'repo', NO_ORDER, ONLY_NOT_APPROVED)
    const byState = groupRows(rows, 'state', NO_ORDER, ONLY_NOT_APPROVED)
    const byApproval = groupRows(rows, 'approval', NO_ORDER, ONLY_NOT_APPROVED)

    // Assert
    expect(byRepo.map((g) => g.label)).toEqual(['a/one', 'b/two'])
    expect(byState.map((g) => g.key)).toEqual(['state:opened'])
    expect(byApproval.map((g) => g.key)).toEqual(['approval:notApproved'])
  })

  it('applies the state filter and the approval filter together', () => {
    // Act
    const groups = groupRows(rows, 'none', NO_ORDER, filters({ draft: false, merged: false, closed: false }, { notApproved: false }))

    // Assert
    expect(iids(groups[0].rows)).toEqual([1])
  })

  it('does not change the list it is given', () => {
    // Arrange
    const before = JSON.stringify(rows)

    // Act
    groupRows(rows, 'repo', by('title', 'desc'), ONLY_APPROVED)

    // Assert
    expect(JSON.stringify(rows)).toBe(before)
  })
})
