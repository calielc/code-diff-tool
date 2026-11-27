import type { ChangeSnapshot } from './provider'

/** What the Reviews tab shows for one review: how far its changes are, summed over the changes. */
/** The four states that a change shows. A draft is an open change that is marked as a draft. */
export type ChangeStates = Record<'opened' | 'draft' | 'merged' | 'closed', number>

export interface ReviewStatus {
  /** How many of the changes that were read are in each state. A closed change counts here, and nowhere else. */
  states: ChangeStates
  /** The changes that count: open, draft and merged ones. A closed change is left out. */
  total: number
  /** Of those, the changes that are merged or have at least one approval. */
  approved: number
  /** The open threads on the counted changes. */
  openThreads: number
  /** The open and draft changes whose pipeline failed. */
  failing: number
  /** `failed` when any pipeline failed, else `running` when any runs, else `passed` when any passed, else `none`. */
  pipeline: 'failed' | 'running' | 'passed' | 'none'
  /** The changes that could not be read. The numbers then cover only the others. */
  unread: number
}

/** How often the Reviews tab reads the status again while it shows. A return of the window reads it again too. */
export const REVIEW_POLL_MS = 120_000

const RUNNING = new Set(['running', 'pending', 'created'])

/**
 * The status of a review from the snapshots of its changes. A null snapshot is a change that could not be read.
 * With no snapshot at all, and at least one change, nothing is known, so the answer is null.
 */
export function summariseStatus(snapshots: (ChangeSnapshot | null)[]): ReviewStatus | null {
  const read = snapshots.filter((s): s is ChangeSnapshot => s !== null)
  const unread = snapshots.length - read.length
  if (snapshots.length > 0 && read.length === 0) return null
  const counted = read.filter((s) => s.info.state !== 'closed')
  const live = counted.filter((s) => s.info.state !== 'merged')
  const statuses = live.map((s) => s.info.pipeline?.status ?? null)
  const failing = statuses.filter((p) => p === 'failed').length
  const running = statuses.some((p) => p !== null && RUNNING.has(p))
  const passed = statuses.some((p) => p === 'success')
  const states: ChangeStates = { opened: 0, draft: 0, merged: 0, closed: 0 }
  for (const s of read) states[s.info.state === 'merged' ? 'merged' : s.info.state === 'closed' ? 'closed' : s.info.draft ? 'draft' : 'opened']++
  return {
    states,
    total: counted.length,
    approved: counted.filter((s) => s.info.state === 'merged' || s.approvals.approvedBy.length > 0).length,
    openThreads: counted.reduce((sum, s) => sum + s.threads.filter((t) => t.resolvable && !t.resolved).length, 0),
    failing,
    pipeline: failing > 0 ? 'failed' : running ? 'running' : passed ? 'passed' : 'none',
    unread
  }
}

/** The changes that are still to do: open and draft ones. A review with none left is done. */
export const pendingChanges = (s: ReviewStatus): number => s.states.opened + s.states.draft

/** The order of the Pipelines column: the worst first when ascending. */
export const PIPELINE_BADNESS: Record<ReviewStatus['pipeline'], number> = { failed: 0, running: 1, none: 2, passed: 3 }
