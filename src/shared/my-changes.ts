// The lists "Owned by me" and "I am the reviewer" on the home screen: the shape of one change and the pure rules that sort, group and count them.

import type { Person } from './provider'

export type MineState = 'draft' | 'opened' | 'merged' | 'closed'
export type MineRole = 'assigned' | 'reviewer'

export interface MineItem {
  provider: 'gitlab' | 'github'
  host: string
  /** The repo path, for example `team/backend/x`. */
  project: string
  iid: number
  url: string
  title: string
  author: string
  state: MineState
  /** An ISO time. */
  updatedAt: string
  roles: MineRole[]
  /** The author and the reviewers by username. The snapshot adds the approvers. */
  people: Record<string, Person>
  /** The requested reviewers. On GitHub this is empty until the snapshot answers. */
  reviewers: string[]
  /** The usernames that approved. Null while the snapshot has not answered. */
  approvedBy: string[] | null
}

/** What the main process sends: the changes of every saved access, one error for each host that failed, the signed-in user of each host, and whether any access exists. */
export interface MineResult {
  items: MineItem[]
  errors: { host: string; error: string }[]
  viewers: Record<string, string>
  hasAccess: boolean
}

export const MINE_STATES: MineState[] = ['draft', 'opened', 'merged', 'closed']
export const MINE_WINDOW_MS = 30 * 86_400_000
/** The lists read again this often while a list tab is shown. */
export const MINE_POLL_MS = 60_000
/** Only the open changes show at the start. */
export const DEFAULT_MINE_STATES: Record<MineState, boolean> = { draft: false, opened: true, merged: false, closed: false }

/** A merged or closed change counts only when it was updated in the last 30 days. A draft or open change always counts. */
export function mineWanted(item: MineItem, now: number): boolean {
  if (item.state === 'draft' || item.state === 'opened') return true
  return Date.parse(item.updatedAt) >= now - MINE_WINDOW_MS
}

/** Both approval pills are on at the start. */
export const DEFAULT_MINE_APPROVALS: Record<'approved' | 'notApproved', boolean> = { approved: true, notApproved: true }

/** One item for each url. The roles of the copies are joined without repeats. The inputs are not changed. */
export function mergeMine(lists: MineItem[][]): MineItem[] {
  const byUrl = new Map<string, MineItem>()
  for (const item of lists.flat()) {
    const known = byUrl.get(item.url)
    if (!known) byUrl.set(item.url, { ...item, roles: [...new Set(item.roles)] })
    else known.roles = [...new Set([...known.roles, ...item.roles])]
  }
  return [...byUrl.values()]
}

/** The people of a change that asked for a review, then the ones with a submitted review in the order of their first review. A pending review and the author do not count. */
export function mineReviewers(requested: string[], reviews: { user: string; state: string }[], author: string): string[] {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.user !== author).map((r) => r.user)
  return [...new Set([...requested, ...submitted])]
}

/** A host that failed keeps the changes it gave before, and its error line shows. The other hosts show what they gave now. */
export function keepFailedHosts(previous: MineResult | null, next: MineResult): MineResult {
  if (!previous) return next
  const failed = new Set(next.errors.map((e) => e.host))
  const kept = previous.items.filter((i) => failed.has(i.host))
  const viewers = { ...next.viewers }
  for (const host of failed) if (previous.viewers[host] && !viewers[host]) viewers[host] = previous.viewers[host]
  return { ...next, items: [...next.items, ...kept], viewers }
}

/** Which part of the lists to read: the open and draft changes, the merged and closed ones of the last 30 days, or all of them. */
export type MineScope = 'open' | 'closed' | 'all'

/**
 * The two parts of the lists as one answer. The open part is small and arrives first, so a part that has not arrived is null. A host that failed
 * in both parts gives one error line, and a host that has an error text in one part only shows that text.
 */
export function combineMine(open: MineResult | null, closed: MineResult | null): MineResult | null {
  if (!open || !closed) return open ?? closed
  const errors = [...open.errors, ...closed.errors].filter((e, i, all) => all.findIndex((x) => x.host === e.host && x.error === e.error) === i)
  return {
    items: mergeMine([open.items, closed.items]),
    errors,
    viewers: { ...closed.viewers, ...open.viewers },
    hasAccess: open.hasAccess || closed.hasAccess
  }
}
