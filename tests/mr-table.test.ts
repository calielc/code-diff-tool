import { describe, expect, it } from 'vitest'
import type { ChangeState, PipelineJob } from '../src/shared/provider'
import {
  DEFAULT_MR_FILTERS,
  DEFAULT_MR_SORT,
  approveAllCandidates,
  commentsCell,
  formatMrDate,
  mrSortValue,
  mrStateKey,
  mrVisible,
  parseStoredMrSort,
  pipelineRank,
  pipelineStages,
  stackInfo,
  stateActions,
  yourReview,
  type ApproveCandidateInput,
  type MrFilters,
  type MrSortRow,
  type StackMr,
  type YourReviewInput
} from '../src/shared/mr-table'

const stackMr = (iid: number, source: string, target: string, over: Partial<StackMr> = {}): StackMr => ({
  key: `r!${iid}`,
  iid,
  title: `Title ${iid}`,
  repo: 'r',
  sourceBranch: source,
  targetBranch: target,
  state: 'opened',
  defaultBranch: 'main',
  ...over
})

describe('stackInfo', () => {
  it('gives a lone MR on the default branch no stack', () => {
    // Arrange
    const mrs = [stackMr(1, 'feat/a', 'main')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1']).toMatchObject({ pill: null, tooltip: null, rank: null })
  })

  it('gives an MR on a side branch that nothing else uses no stack, because a stack of 1 is not a stack', () => {
    // Arrange
    const mrs = [stackMr(1, 'feat/a', 'release/1')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1'].pill).toBeNull()
    expect(info['r!1'].rank).toBeNull()
  })

  it('numbers a pair of stacked MRs 1 of 2 and 2 of 2 with the tooltips of the rule', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main'), stackMr(2, 'b', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1']).toMatchObject({ depth: 0, size: 2, pill: '1 of 2', rank: 0, tooltip: 'The base of the stack. !2 stacks on it' })
    expect(info['r!2']).toMatchObject({ depth: 1, size: 2, pill: '2 of 2', rank: 1, tooltip: 'Stacked on !1: Title 1' })
  })

  it('numbers a chain of three and lists the child in the tooltip of the middle one', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main'), stackMr(2, 'b', 'a'), stackMr(3, 'c', 'b')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect([info['r!1'].pill, info['r!2'].pill, info['r!3'].pill]).toEqual(['1 of 3', '2 of 3', '3 of 3'])
    expect([info['r!1'].rank, info['r!2'].rank, info['r!3'].rank]).toEqual([0, 1, 2])
    expect(info['r!2'].tooltip).toBe('Stacked on !1: Title 1. !3 stacks on it')
    expect(info['r!3'].tooltip).toBe('Stacked on !2: Title 2')
  })

  it('ranks by the review-order index of the base times 1000 plus the depth, whatever the order of the stack', () => {
    // Arrange
    const mrs = [stackMr(3, 'c', 'b'), stackMr(9, 'z', 'main'), stackMr(2, 'b', 'a'), stackMr(1, 'a', 'main')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1'].rank).toBe(3000)
    expect(info['r!2'].rank).toBe(3001)
    expect(info['r!3'].rank).toBe(3002)
    expect(info['r!9'].rank).toBeNull()
  })

  it('uses the longest depth for the size and lists several children in review order', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main'), stackMr(3, 'c', 'a'), stackMr(2, 'b', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1']).toMatchObject({ size: 2, pill: '1 of 2', tooltip: 'The base of the stack. !3, !2 stack on it' })
    expect(info['r!2'].pill).toBe('2 of 2')
    expect(info['r!3'].pill).toBe('2 of 2')
  })

  it('does not stack an MR on another repo', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main', { repo: 'one' }), stackMr(2, 'b', 'a', { repo: 'two', key: 'two!2' })]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!1'].pill).toBeNull()
    expect(info['two!2'].pill).toBeNull()
  })

  it('does not stack an MR that targets the default branch of its repo, even when another MR has that branch as source', () => {
    // Arrange
    const mrs = [stackMr(1, 'main', 'release'), stackMr(2, 'b', 'main')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!2'].pill).toBeNull()
  })

  it('prefers an MR that is not closed over a closed one for the same branch, even when the closed one comes first', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main', { state: 'closed' }), stackMr(2, 'a', 'main'), stackMr(3, 'c', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!3'].tooltip).toBe('Stacked on !2: Title 2')
    expect(info['r!3'].rank).toBe(1001)
  })

  it('takes the first MR in review order when both are open', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main'), stackMr(2, 'a', 'main'), stackMr(3, 'c', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!3'].tooltip).toBe('Stacked on !1: Title 1')
  })

  it('takes the first MR in review order when both are closed', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'main', { state: 'closed' }), stackMr(2, 'a', 'main', { state: 'closed' }), stackMr(3, 'c', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!3'].tooltip).toBe('Stacked on !1: Title 1')
  })

  it('still ends when two MRs stack on each other', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'b'), stackMr(2, 'b', 'a')]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(Object.keys(info).sort()).toEqual(['r!1', 'r!2'])
    expect(info['r!1'].depth).toBeLessThanOrEqual(1)
    expect(info['r!2'].depth).toBeLessThanOrEqual(1)
  })

  it('treats every target as a non-default branch when the default branch is unknown', () => {
    // Arrange
    const mrs = [stackMr(1, 'a', 'x', { defaultBranch: null }), stackMr(2, 'b', 'a', { defaultBranch: null })]

    // Act
    const info = stackInfo(mrs)

    // Assert
    expect(info['r!2'].pill).toBe('2 of 2')
  })
})

describe('yourReview', () => {
  const input = (over: Partial<YourReviewInput> = {}): YourReviewInput => ({
    state: 'opened',
    draft: false,
    author: 'ann',
    viewer: 'me',
    viewerState: null,
    userCanApprove: true,
    userHasApproved: false,
    ...over
  })

  it('says Approved by you in green, first of all, with Submit review and Revoke approval', () => {
    // Arrange
    const i = input({ userHasApproved: true, userCanApprove: false })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 0, id: 'approved', text: '✓ Approved by you', tone: 'ok', actions: ['submit', 'revoke'] })
  })

  it('puts the approval before a changes request', () => {
    // Arrange
    const i = input({ userHasApproved: true, viewerState: 'requested_changes' })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r.id).toBe('approved')
  })

  it('says Changes requested by you in red', () => {
    // Arrange
    const i = input({ viewerState: 'requested_changes' })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 1, id: 'changes', text: 'Changes requested by you', tone: 'bad', actions: ['submit', 'approve'] })
  })

  it('says You are the author, with no buttons at all: Mark as draft lives in the State column', () => {
    // Arrange
    const i = input({ author: 'me' })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 2, id: 'author', text: 'You are the author', tone: 'muted', actions: [] })
  })

  it('gives the author of a draft no Mark as ready button: it lives in the State column', () => {
    // Arrange
    const i = input({ author: 'me', draft: true })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r.actions).toEqual([])
  })

  it('gives the author who approved their own MR the approved text and no author button', () => {
    // Arrange
    const i = input({ author: 'me', userHasApproved: true })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r.id).toBe('approved')
    expect(r.actions).toEqual([])
  })

  it('says Merged, no approval for a merged MR, with no buttons, and keeps the author text first', () => {
    // Arrange
    const i = input({ state: 'merged', author: 'me' })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 2, id: 'author', actions: [] })
    expect(yourReview(input({ state: 'merged' }))).toMatchObject({ order: 3, id: 'merged', text: 'Merged, no approval', tone: 'muted', actions: [] })
  })

  it.each<ChangeState>(['closed', 'locked'])('says Closed, not in the diff with its tooltip for a %s MR', (state) => {
    // Arrange
    const i = input({ state })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({
      order: 4,
      id: 'closed',
      text: 'Closed, not in the diff',
      tone: 'muted',
      tooltip: 'A closed change request is listed here only: its files are not in the tree, the diffs or the Summarised page.',
      actions: []
    })
  })

  it('says Not an eligible approver when GitLab says the viewer cannot approve, with Submit review only', () => {
    // Arrange
    const i = input({ userCanApprove: false })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 5, id: 'ineligible', text: 'Not an eligible approver', tone: 'muted', actions: ['submit'] })
  })

  it('says Not reviewed by you yet with Submit review and Approve', () => {
    // Arrange
    const i = input()

    // Act
    const r = yourReview(i)

    // Assert
    expect(r).toMatchObject({ order: 6, id: 'pending', text: 'Not reviewed by you yet', tone: 'muted', tooltip: null, actions: ['submit', 'approve'] })
  })

  it('treats an open draft by someone else like an open MR', () => {
    // Arrange
    const i = input({ draft: true })

    // Act
    const r = yourReview(i)

    // Assert
    expect(r.id).toBe('pending')
    expect(r.actions).toEqual(['submit', 'approve'])
  })
})

describe('approveAllCandidates', () => {
  const c = (iid: number, over: Partial<ApproveCandidateInput> = {}): ApproveCandidateInput => ({
    key: `r!${iid}`,
    iid,
    repo: 'backend/x',
    state: 'opened',
    author: 'ann',
    userCanApprove: true,
    userHasApproved: false,
    ...over
  })

  it('has no candidate, an empty tooltip and a hidden button when nothing can be approved', () => {
    // Arrange
    const mrs = [c(1, { author: 'me' }), c(2, { userHasApproved: true }), c(3, { userCanApprove: false }), c(4, { state: 'merged' }), c(5, { state: 'closed' })]

    // Act
    const all = approveAllCandidates(mrs, 'me')

    // Assert
    expect(all).toEqual({ keys: [], tooltip: '' })
  })

  it('lists exactly one candidate with the tooltip of the rule', () => {
    // Arrange
    const mrs = [c(1, { author: 'me' }), c(2, { repo: 'frontend/y' }), c(3, { userHasApproved: true })]

    // Act
    const all = approveAllCandidates(mrs, 'me')

    // Assert
    expect(all).toEqual({ keys: ['r!2'], tooltip: 'Approves !2 frontend/y' })
  })

  it('lists several candidates in review order and counts a draft', () => {
    // Arrange
    const mrs = [c(7), c(5, { repo: 'frontend/y' }), c(6, { author: 'me' })]

    // Act
    const all = approveAllCandidates(mrs, 'me')

    // Assert
    expect(all).toEqual({ keys: ['r!7', 'r!5'], tooltip: 'Approves !7 backend/x, !5 frontend/y' })
  })
})

describe('mrStateKey and mrVisible', () => {
  const all = (over: Partial<MrFilters['states']> = {}, approvals: Partial<MrFilters['approvals']> = {}): MrFilters => ({
    states: { draft: true, opened: true, merged: true, closed: true, ...over },
    approvals: { approved: true, notApproved: true, ...approvals }
  })
  const off = { draft: false, opened: false, merged: false, closed: false }

  it.each<[ChangeState, boolean, string]>([
    ['opened', true, 'draft'],
    ['opened', false, 'opened'],
    ['merged', true, 'merged'],
    ['merged', false, 'merged'],
    ['closed', true, 'closed'],
    ['closed', false, 'closed']
  ])('maps state %s with draft %s to %s', (state, draft, expected) => {
    // Act
    const key = mrStateKey({ state, draft })

    // Assert
    expect(key).toBe(expected)
  })

  it('has the default of the spec: draft, open and merged on, closed off, both approvals on', () => {
    // Assert
    expect(DEFAULT_MR_FILTERS).toEqual({
      states: { draft: true, opened: true, merged: true, closed: false },
      approvals: { approved: true, notApproved: true }
    })
  })

  it('hides a closed MR by default and shows an open one', () => {
    // Act
    const closed = mrVisible({ state: 'closed', draft: false, approverCount: 0 }, DEFAULT_MR_FILTERS)
    const open = mrVisible({ state: 'opened', draft: false, approverCount: 0 }, DEFAULT_MR_FILTERS)

    // Assert
    expect(closed).toBe(false)
    expect(open).toBe(true)
  })

  it('shows an MR only when its state and its approval class are on', () => {
    // Arrange
    const approved = { state: 'opened', draft: false, approverCount: 1 } as const
    const notApproved = { state: 'opened', draft: false, approverCount: 0 } as const
    const onlyApproved = all({}, { notApproved: false })

    // Act and Assert
    expect(mrVisible(approved, onlyApproved)).toBe(true)
    expect(mrVisible(notApproved, onlyApproved)).toBe(false)
    expect(mrVisible(approved, all({ opened: false }, { notApproved: false }))).toBe(false)
    expect(mrVisible(approved, all({ opened: false, merged: false }))).toBe(false)
    expect(mrVisible(approved, all({ draft: false, opened: false, merged: false, closed: false }))).toBe(true)
  })

  it('counts one approver as approved', () => {
    // Arrange
    const filters = all({}, { approved: false })

    // Act
    const one = mrVisible({ state: 'opened', draft: false, approverCount: 1 }, filters)
    const none = mrVisible({ state: 'opened', draft: false, approverCount: 0 }, filters)

    // Assert
    expect(one).toBe(false)
    expect(none).toBe(true)
  })

  it('filters nothing in a group with every toggle off, the same as every toggle on', () => {
    // Arrange
    const mrs = [
      { state: 'opened', draft: true, approverCount: 0 },
      { state: 'closed', draft: false, approverCount: 2 },
      { state: 'merged', draft: false, approverCount: 1 }
    ] as const
    const noStates: MrFilters = { states: off, approvals: { approved: true, notApproved: true } }
    const noApprovals: MrFilters = { states: { ...off, closed: true }, approvals: { approved: false, notApproved: false } }

    // Act
    const states = mrs.map((m) => mrVisible(m, noStates))
    const approvals = mrs.map((m) => mrVisible(m, noApprovals))

    // Assert
    expect(states).toEqual([true, true, true])
    expect(approvals).toEqual([false, true, false])
  })

  it('still applies the approval group when the state group is empty', () => {
    // Arrange
    const filters: MrFilters = { states: off, approvals: { approved: true, notApproved: false } }

    // Act
    const approved = mrVisible({ state: 'merged', draft: false, approverCount: 1 }, filters)
    const notApproved = mrVisible({ state: 'merged', draft: false, approverCount: 0 }, filters)

    // Assert
    expect(approved).toBe(true)
    expect(notApproved).toBe(false)
  })

  it('shows everything when both groups are empty', () => {
    // Arrange
    const filters: MrFilters = { states: off, approvals: { approved: false, notApproved: false } }

    // Act
    const shown = mrVisible({ state: 'closed', draft: true, approverCount: 0 }, filters)

    // Assert
    expect(shown).toBe(true)
  })
})

describe('formatMrDate', () => {
  const now = new Date('2026-11-19T12:00:00Z')

  it('shows a dash and no tooltip for an empty date', () => {
    // Act and Assert
    expect(formatMrDate(null, now, 'UTC')).toEqual({ text: '–', title: '' })
    expect(formatMrDate('', now, 'UTC')).toEqual({ text: '–', title: '' })
  })

  it('leaves the year out in the current year and pads the hour and minute', () => {
    // Act
    const d = formatMrDate('2026-11-19T09:41:00Z', now, 'UTC')

    // Assert
    expect(d.text).toBe('Nov 19, 09:41')
  })

  it('does not pad the day', () => {
    // Act
    const d = formatMrDate('2026-11-03T09:05:00Z', now, 'UTC')

    // Assert
    expect(d.text).toBe('Nov 3, 09:05')
  })

  it('shows the year when it is not the current year', () => {
    // Act
    const d = formatMrDate('2025-12-03T14:05:00Z', now, 'UTC')

    // Assert
    expect(d.text).toBe('Dec 3, 2025, 14:05')
  })

  it('shows a future year too', () => {
    // Act
    const d = formatMrDate('2027-01-02T08:00:00Z', now, 'UTC')

    // Assert
    expect(d.text).toBe('Jan 2, 2027, 08:00')
  })

  it('uses 24-hour time at 23:59 and at midnight, never 24:00', () => {
    // Act
    const late = formatMrDate('2026-11-19T23:59:00Z', now, 'UTC')
    const midnight = formatMrDate('2026-11-19T00:00:00Z', now, 'UTC')

    // Assert
    expect(late.text).toBe('Nov 19, 23:59')
    expect(midnight.text).toBe('Nov 19, 00:00')
  })

  it('uses the given time zone for the clock, the day and the year', () => {
    // Act
    const tokyo = formatMrDate('2026-11-19T20:30:00Z', now, 'Asia/Tokyo')
    const newYear = formatMrDate('2025-12-31T23:30:00Z', new Date('2026-06-01T00:00:00Z'), 'Pacific/Auckland')
    const sameInstantUtc = formatMrDate('2025-12-31T23:30:00Z', new Date('2026-06-01T00:00:00Z'), 'UTC')

    // Assert
    expect(tokyo.text).toBe('Nov 20, 05:30')
    expect(newYear.text).toBe('Jan 1, 12:30')
    expect(sameInstantUtc.text).toBe('Dec 31, 2025, 23:30')
  })

  it('compares the year in the time zone of the date, not in UTC', () => {
    // Arrange
    const justAfterNewYearInTokyo = new Date('2026-12-31T16:00:00Z')

    // Act
    const d = formatMrDate('2026-12-31T10:00:00Z', justAfterNewYearInTokyo, 'Asia/Tokyo')

    // Assert
    expect(d.text).toBe('Dec 31, 2026, 19:00')
  })

  it('gives the full date and time as the tooltip', () => {
    // Act
    const d = formatMrDate('2026-11-19T09:41:00Z', now, 'UTC')

    // Assert
    expect(d.title.replace(/\u202f/g, ' ')).toBe('Thursday, November 19, 2026 at 9:41 AM')
  })
})

describe('commentsCell', () => {
  const thread = (
    resolved: boolean,
    onFile = true,
    resolvable = true
  ): { resolvable: boolean; resolved: boolean; position: null | { oldPath: null; newPath: string; oldLine: null; newLine: number } } => ({
    resolvable,
    resolved,
    position: onFile ? { oldPath: null, newPath: 'a.ts', oldLine: null, newLine: 1 } : null
  })

  it('says No threads and has no sort value without resolvable threads', () => {
    // Arrange
    const threads = [thread(false, true, false)]

    // Act
    const cell = commentsCell(threads, 0)

    // Assert
    expect(cell).toEqual({ chip: null, chipTitle: null, tone: null, detail: 'No threads', drafts: null, sort: null })
  })

  it('shows an amber chip with the open and resolved counts', () => {
    // Arrange
    const threads = [thread(false), thread(false), thread(true), thread(true), thread(true), thread(false, true, false)]

    // Act
    const cell = commentsCell(threads, 0)

    // Assert
    expect(cell).toEqual({ chip: '2/5', chipTitle: '2 open of 5 threads on GitLab', tone: 'amber', detail: '2 open, 3 resolved', drafts: null, sort: 20005 })
  })

  it('shows a blue chip and all resolved when no thread is open', () => {
    // Arrange
    const threads = [thread(true), thread(true)]

    // Act
    const cell = commentsCell(threads, 0)

    // Assert
    expect(cell).toMatchObject({ chip: '0/2', chipTitle: '0 open of 2 threads on GitLab', tone: 'blue', detail: 'all resolved', sort: 2 })
  })

  it('uses the singular in the tooltip for one thread', () => {
    // Act
    const cell = commentsCell([thread(false)], 0)

    // Assert
    expect(cell.chipTitle).toBe('1 open of 1 thread on GitLab')
    expect(cell.detail).toBe('1 open, 0 resolved')
  })

  it('adds how many threads sit on the change request and not on a file', () => {
    // Arrange
    const threads = [thread(false, false), thread(true, false), thread(true)]

    // Act
    const cell = commentsCell(threads, 0)

    // Assert
    expect(cell.detail).toBe('1 open, 2 resolved, 2 on the change request, not on a file')
  })

  it('adds the on-the-MR text after all resolved', () => {
    // Act
    const cell = commentsCell([thread(true, false)], 0)

    // Assert
    expect(cell.detail).toBe('all resolved, 1 on the change request, not on a file')
  })

  it('shows one draft in the singular with its tooltip, also without threads', () => {
    // Act
    const cell = commentsCell([], 1)

    // Assert
    expect(cell.detail).toBe('No threads')
    expect(cell.drafts).toEqual({ count: 1, label: 'draft', title: 'Your drafts, not posted yet' })
  })

  it('shows several drafts in the plural and none for zero', () => {
    // Act
    const three = commentsCell([thread(false)], 3)
    const zero = commentsCell([thread(false)], 0)

    // Assert
    expect(three.drafts).toEqual({ count: 3, label: 'drafts', title: 'Your drafts, not posted yet' })
    expect(zero.drafts).toBeNull()
  })
})

describe('pipelineRank', () => {
  it('ranks the statuses failed first, in the order of the rule', () => {
    // Arrange
    const order = ['failed', 'canceled', 'running', 'pending', 'created', 'manual', 'scheduled', 'skipped', 'success']

    // Act
    const ranks = order.map((s) => pipelineRank(s))

    // Assert
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('ranks an unknown status after success and gives null without a pipeline', () => {
    // Act and Assert
    expect(pipelineRank('waiting_for_resource')).toBeGreaterThan(8)
    expect(pipelineRank(null)).toBeNull()
  })
})

describe('pipelineStages', () => {
  const job = (name: string, stage: string, status: string, over: Partial<PipelineJob> = {}): PipelineJob => ({
    name,
    stage,
    status,
    allowFailure: false,
    url: `https://x/${name}`,
    ...over
  })
  const statusOf = (jobs: PipelineJob[]): string => pipelineStages(jobs)[0].status

  it('lists the stages in the order they first appear among the jobs', () => {
    // Arrange
    const jobs = [job('b1', 'build', 'success'), job('t1', 'test', 'success'), job('b2', 'build', 'success'), job('d1', 'deploy', 'manual')]

    // Act
    const stages = pipelineStages(jobs)

    // Assert
    expect(stages.map((s) => s.stage)).toEqual(['build', 'test', 'deploy'])
  })

  it('returns no stage for no job', () => {
    // Act and Assert
    expect(pipelineStages([])).toEqual([])
  })

  it('picks the most urgent status, failed first and skipped last, in the order of the rule', () => {
    // Arrange
    const order = [
      'failed',
      'running',
      'pending',
      'preparing',
      'waiting_for_resource',
      'canceled',
      'warning',
      'success',
      'scheduled',
      'manual',
      'created',
      'skipped'
    ]

    // Act and Assert
    for (let i = 0; i < order.length - 1; i++) {
      expect(statusOf([job('later', 's', order[i + 1]), job('first', 's', order[i])])).toBe(order[i])
    }
  })

  it('counts a failed job that may fail as a warning', () => {
    // Arrange
    const jobs = [job('a', 's', 'failed', { allowFailure: true })]

    // Act and Assert
    expect(statusOf(jobs)).toBe('warning')
  })

  it('ranks that warning above success but below a hard failure and a canceled job', () => {
    // Arrange
    const soft = job('soft', 's', 'failed', { allowFailure: true })

    // Act and Assert
    expect(statusOf([job('ok', 's', 'success'), soft])).toBe('warning')
    expect(statusOf([soft, job('hard', 's', 'failed')])).toBe('failed')
    expect(statusOf([soft, job('c', 's', 'canceled')])).toBe('canceled')
  })

  it('uses the first job status when no status is in the list', () => {
    // Act and Assert
    expect(statusOf([job('a', 's', 'odd'), job('b', 's', 'other')])).toBe('odd')
  })

  it('lets a listed status win over an unlisted one', () => {
    // Act and Assert
    expect(statusOf([job('a', 's', 'odd'), job('b', 's', 'skipped')])).toBe('skipped')
  })

  it('links to the first job that decided the status and gives the job list as the tooltip', () => {
    // Arrange
    const jobs = [job('compile', 'build', 'success'), job('lint', 'build', 'failed'), job('unit', 'build', 'failed'), job('pack', 'build', 'created')]

    // Act
    const [stage] = pipelineStages(jobs)

    // Assert
    expect(stage).toEqual({
      stage: 'build',
      status: 'failed',
      label: 'failed',
      tooltip: 'build: failed\ncompile: success\nlint: failed\nunit: failed\npack: not started',
      ariaLabel: 'Stage build: failed',
      url: 'https://x/lint'
    })
  })

  it('spells the status labels with spaces and shows created as not started', () => {
    // Act
    const waiting = pipelineStages([job('w', 'deploy', 'waiting_for_resource')])[0]
    const created = pipelineStages([job('c', 'test', 'created')])[0]

    // Assert
    expect(waiting.label).toBe('waiting for resource')
    expect(waiting.tooltip).toBe('deploy: waiting for resource\nw: waiting for resource')
    expect(created.label).toBe('not started')
    expect(created.ariaLabel).toBe('Stage test: not started')
  })

  it('gives no url when the deciding job has none, and takes the url of a trigger job as given', () => {
    // Act
    const none = pipelineStages([job('a', 's', 'failed', { url: null })])[0]
    const trigger = pipelineStages([job('t', 's', 'running', { url: 'https://gitlab.com/g/p/-/pipelines/9' })])[0]

    // Assert
    expect(none.url).toBeNull()
    expect(trigger.url).toBe('https://gitlab.com/g/p/-/pipelines/9')
  })
})

describe('mrSortValue and the stored sort', () => {
  const row = (over: Partial<MrSortRow> = {}): MrSortRow => ({
    iid: 104,
    stackRank: 3001,
    title: 'Fix The Thing',
    repo: 'Backend/Recommendation-Service',
    authorName: 'Ann LEE',
    approverCount: 2,
    reviewerCount: 3,
    pipelineStatus: 'failed',
    reviewOrder: 5,
    commentsSort: 20005,
    createdAt: '2026-11-03T12:26:00Z',
    updatedAt: '2026-11-09T09:56:00Z',
    mergedAt: '2026-11-10T08:00:00Z',
    state: 'opened',
    draft: false,
    ...over
  })

  it('gives the value of each column as the table of the spec says', () => {
    // Arrange
    const r = row()

    // Act
    const values = {
      mr: mrSortValue(r, 'mr'),
      stack: mrSortValue(r, 'stack'),
      title: mrSortValue(r, 'title'),
      repo: mrSortValue(r, 'repo'),
      pipeline: mrSortValue(r, 'pipeline'),
      author: mrSortValue(r, 'author'),
      approved: mrSortValue(r, 'approved'),
      review: mrSortValue(r, 'review'),
      comments: mrSortValue(r, 'comments'),
      created: mrSortValue(r, 'created'),
      updated: mrSortValue(r, 'updated'),
      merged: mrSortValue(r, 'merged'),
      state: mrSortValue(r, 'state')
    }

    // Assert
    expect(values).toEqual({
      mr: 104,
      stack: 3001,
      title: 'fix the thing',
      repo: 'Backend/Recommendation-Service',
      pipeline: 0,
      author: 'ann lee',
      approved: 2,
      review: 5,
      comments: 20005,
      created: '2026-11-03T12:26:00Z',
      updated: '2026-11-09T09:56:00Z',
      merged: '2026-11-10T08:00:00Z',
      state: 1
    })
  })

  it('gives null for an MR without a stack, a pipeline, resolvable threads, a creation time or a merge time', () => {
    // Arrange
    const r = row({ stackRank: null, pipelineStatus: null, commentsSort: null, createdAt: '', mergedAt: null })

    // Act and Assert
    expect(mrSortValue(r, 'stack')).toBeNull()
    expect(mrSortValue(r, 'pipeline')).toBeNull()
    expect(mrSortValue(r, 'comments')).toBeNull()
    expect(mrSortValue(r, 'created')).toBeNull()
    expect(mrSortValue(r, 'merged')).toBeNull()
  })

  it('ranks the state draft, opened, merged, closed', () => {
    // Act
    const ranks = [
      mrSortValue(row({ state: 'opened', draft: true }), 'state'),
      mrSortValue(row({ state: 'opened' }), 'state'),
      mrSortValue(row({ state: 'merged' }), 'state'),
      mrSortValue(row({ state: 'closed' }), 'state')
    ]

    // Assert
    expect(ranks).toEqual([0, 1, 2, 3])
  })

  it('defaults to Created ascending', () => {
    // Assert
    expect(DEFAULT_MR_SORT).toEqual({ key: 'created', dir: 'asc' })
  })

  it('accepts every new key with both directions', () => {
    // Arrange
    const keys = ['mr', 'stack', 'title', 'repo', 'pipeline', 'author', 'approved', 'review', 'comments', 'created', 'updated', 'merged', 'state']

    // Act and Assert
    for (const key of keys) {
      for (const dir of ['asc', 'desc']) expect(parseStoredMrSort(JSON.stringify({ key, dir }))).toEqual({ key, dir })
    }
  })

  it('falls back to the default for nothing stored, an old key, a bad direction or bad JSON', () => {
    // Act and Assert
    expect(parseStoredMrSort(null)).toEqual(DEFAULT_MR_SORT)
    expect(parseStoredMrSort('{"key":"branch","dir":"asc"}')).toEqual(DEFAULT_MR_SORT)
    expect(parseStoredMrSort('{"key":"title","dir":"up"}')).toEqual(DEFAULT_MR_SORT)
    expect(parseStoredMrSort('not json')).toEqual(DEFAULT_MR_SORT)
  })

  it('keeps a stored "null", the order of the review, as null', () => {
    // Act and Assert
    expect(parseStoredMrSort('null')).toBeNull()
  })
})

describe('the reviewers column', () => {
  const row = (over: Partial<MrSortRow> = {}): MrSortRow => ({
    iid: 1,
    stackRank: null,
    title: 't',
    repo: 'r',
    authorName: 'a',
    approverCount: 0,
    reviewerCount: 0,
    pipelineStatus: null,
    reviewOrder: 0,
    commentsSort: null,
    createdAt: '',
    updatedAt: '2026-11-09T09:56:00Z',
    mergedAt: null,
    state: 'opened',
    draft: false,
    ...over
  })

  it.each([0, 1, 4, 11])('gives the number of reviewers, %s, as the sort value', (count) => {
    // Arrange
    const r = row({ reviewerCount: count, approverCount: 7 })

    // Act
    const value = mrSortValue(r, 'reviewers')

    // Assert
    expect(value).toBe(count)
  })

  it('gives null when the reviewers are not known', () => {
    // Arrange
    const r = row({ reviewerCount: null })

    // Act
    const value = mrSortValue(r, 'reviewers')

    // Assert
    expect(value).toBeNull()
  })

  it('accepts the key reviewers in the stored sort with both directions', () => {
    // Act and Assert
    expect(parseStoredMrSort('{"key":"reviewers","dir":"asc"}')).toEqual({ key: 'reviewers', dir: 'asc' })
    expect(parseStoredMrSort('{"key":"reviewers","dir":"desc"}')).toEqual({ key: 'reviewers', dir: 'desc' })
  })
})

describe('stateActions', () => {
  const input = (over: Partial<YourReviewInput> = {}): YourReviewInput => ({
    state: 'opened',
    draft: false,
    author: 'ann',
    viewer: 'me',
    viewerState: null,
    userCanApprove: true,
    userHasApproved: false,
    ...over
  })

  it.each<[string, Partial<YourReviewInput>, string[]]>([
    ['the author of a ready MR', { author: 'me' }, ['mark-draft']],
    ['the author of a draft', { author: 'me', draft: true }, ['mark-ready']],
    ['someone else on a ready MR', {}, []],
    ['someone else on a draft', { draft: true }, []],
    ['the author of a merged MR', { author: 'me', state: 'merged' }, []],
    ['the author of a closed draft', { author: 'me', state: 'closed', draft: true }, []],
    ['the author of a locked MR', { author: 'me', state: 'locked' }, []],
    ['the author who approved their own MR', { author: 'me', userHasApproved: true }, ['mark-draft']],
    ['the author who cannot approve', { author: 'me', userCanApprove: false, draft: true }, ['mark-ready']]
  ])('gives the right action for %s', (_name, over, expected) => {
    // Arrange
    const i = input(over)

    // Act
    const actions = stateActions(i)

    // Assert
    expect(actions).toEqual(expected)
  })

  it('is the only place of mark-ready and mark-draft: yourReview never returns them while stateActions does for the same inputs', () => {
    // Arrange
    const states: ChangeState[] = ['opened', 'merged', 'closed', 'locked']
    const flags = [false, true]
    const viewerStates = [null, 'requested_changes'] as const
    const authors = ['me', 'ann']
    let checked = 0
    let given = 0

    // Act and Assert
    for (const state of states)
      for (const draft of flags)
        for (const author of authors)
          for (const userCanApprove of flags)
            for (const userHasApproved of flags)
              for (const viewerState of viewerStates) {
                const i = input({ state, draft, author, userCanApprove, userHasApproved, viewerState })
                expect(yourReview(i).actions, JSON.stringify(i)).not.toContain('mark-ready')
                expect(yourReview(i).actions, JSON.stringify(i)).not.toContain('mark-draft')
                const expected = state === 'opened' && author === 'me' ? [draft ? 'mark-ready' : 'mark-draft'] : []
                expect(stateActions(i), JSON.stringify(i)).toEqual(expected)
                checked++
                given += expected.length
              }
    expect(checked).toBe(4 * 2 * 2 * 2 * 2 * 2)
    expect(given).toBe(2 * 2 * 2 * 2) // opened and the author, times draft, can approve, has approved and the viewer state
  })

  it('does not change its input', () => {
    // Arrange
    const i = input({ author: 'me' })
    const before = JSON.stringify(i)

    // Act
    stateActions(i)

    // Assert
    expect(JSON.stringify(i)).toBe(before)
  })
})
