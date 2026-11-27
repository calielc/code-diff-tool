import { describe, expect, it } from 'vitest'
import type { ChangeSnapshot, Thread } from '../src/shared/provider'
import { pendingChanges, summariseStatus } from '../src/shared/review-status'

type Opts = { state?: 'opened' | 'merged' | 'closed'; draft?: boolean; approvedBy?: string[]; pipeline?: string | null; threads?: Partial<Thread>[] }

const snap = (o: Opts = {}): ChangeSnapshot =>
  ({
    info: { state: o.state ?? 'opened', draft: o.draft ?? false, pipeline: o.pipeline === undefined || o.pipeline === null ? null : { status: o.pipeline } },
    approvals: { approvedBy: o.approvedBy ?? [] },
    threads: (o.threads ?? []).map((t) => ({ resolvable: true, resolved: false, ...t })),
    jobs: []
  }) as unknown as ChangeSnapshot

describe('summariseStatus', () => {
  it('counts the approved changes among the changes that count', () => {
    // Arrange
    const list = [snap({ approvedBy: ['ann'] }), snap(), snap({ approvedBy: ['bob', 'cy'] })]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status).toMatchObject({ total: 3, approved: 2, unread: 0 })
  })

  it('counts a merged change as approved, and leaves a closed change out of every number', () => {
    // Arrange
    const list = [snap({ state: 'merged' }), snap({ state: 'closed', approvedBy: ['ann'], pipeline: 'failed', threads: [{}] }), snap()]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status).toMatchObject({ total: 2, approved: 1, failing: 0, openThreads: 0 })
  })

  it('sums the open threads, and ignores resolved threads and threads that are not resolvable', () => {
    // Arrange
    const list = [snap({ threads: [{}, { resolved: true }, { resolvable: false }] }), snap({ threads: [{}, {}] })]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status?.openThreads).toBe(3)
  })

  it.each([
    [['failed', 'success'], 'failed', 1],
    [['failed', 'failed', 'running'], 'failed', 2],
    [['running', 'success'], 'running', 0],
    [['pending', 'success'], 'running', 0],
    [['success', 'success'], 'passed', 0],
    [['manual', 'skipped'], 'none', 0],
    [[null], 'none', 0]
  ] as const)('gives the pipeline of the pipelines %j as %s with %d failing', (pipelines, pipeline, failing) => {
    // Act
    const status = summariseStatus(pipelines.map((p) => snap({ pipeline: p })))

    // Assert
    expect(status).toMatchObject({ pipeline, failing })
  })

  it('looks at the pipeline of open and draft changes only, not at a merged one', () => {
    // Arrange
    const list = [snap({ state: 'merged', pipeline: 'failed' }), snap({ pipeline: 'success' })]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status).toMatchObject({ pipeline: 'passed', failing: 0 })
  })

  it('counts a change that could not be read as unread, and sums the others', () => {
    // Arrange
    const list = [snap({ approvedBy: ['ann'] }), null]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status).toMatchObject({ total: 1, approved: 1, unread: 1 })
  })

  it('knows nothing when no change could be read, and has an empty status for a review with no change', () => {
    // Act and Assert
    expect(summariseStatus([null, null])).toBeNull()
    expect(summariseStatus([])).toEqual({
      states: { opened: 0, draft: 0, merged: 0, closed: 0 },
      total: 0,
      approved: 0,
      openThreads: 0,
      failing: 0,
      pipeline: 'none',
      unread: 0
    })
  })

  it('counts the changes in each of the four states, and counts a closed change there', () => {
    // Arrange
    const list = [
      snap(),
      snap(),
      snap({ draft: true }),
      snap({ state: 'merged' }),
      snap({ state: 'merged' }),
      snap({ state: 'merged' }),
      snap({ state: 'closed' })
    ]

    // Act
    const status = summariseStatus(list)

    // Assert
    expect(status?.states).toEqual({ opened: 2, draft: 1, merged: 3, closed: 1 })
  })

  it('does not count a change that could not be read in any state', () => {
    // Act
    const status = summariseStatus([snap({ state: 'merged' }), null])

    // Assert
    expect(status?.states).toEqual({ opened: 0, draft: 0, merged: 1, closed: 0 })
  })

  it('says how many changes are still to do: the open and the draft ones, and not the merged and the closed ones', () => {
    // Act and Assert
    expect(pendingChanges(summariseStatus([snap(), snap({ draft: true }), snap({ state: 'merged' }), snap({ state: 'closed' })])!)).toBe(2)
    expect(pendingChanges(summariseStatus([snap({ state: 'merged' }), snap({ state: 'closed' })])!)).toBe(0)
  })
})
