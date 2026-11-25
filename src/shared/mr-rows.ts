// One row of the shared MR/PR table and the pure rules that group, filter, sort and count the rows.
import type { MineItem } from './my-changes'
import { mrStateKey, mrVisible, type MrFilters, type MrStateKey } from './mr-table'
import { parseChangeUrl, type ChangeSnapshot, type ChangeState, type Person } from './provider'

/** What a list row knows before the full snapshot arrives. */
export interface RowStub {
  author: string
  reviewers: string[]
  people: Record<string, Person>
  /** Null while the approvers are not known. */
  approvedBy: string[] | null
  /** True when the read of the full snapshot failed. The cells that need it show a dash and not the placeholder. */
  failed?: boolean
}

export interface ChangeRow {
  /** The url. It is unique across hosts and repos. */
  id: string
  url: string
  /** The repo path, without the host. */
  repo: string
  iid: number
  state: ChangeState
  draft: boolean
  title: string
  updatedAt: string
  snapshot: ChangeSnapshot | null
  stub: RowStub | null
  defaultBranch: string | null
  people: Record<string, Person>
  viewer: string
  drafts: number
}

export type RowGroupMode = 'none' | 'repo' | 'state' | 'approval'

export interface RowGroup {
  /** The key for the collapsed set. Null when the list has no groups. */
  key: string | null
  /** The header text. Null when the list has no groups. */
  label: string | null
  /** The state of the group. Null in the modes repo, approval and none. */
  state: MrStateKey | null
  rows: ChangeRow[]
}

const STATE_ORDER: MrStateKey[] = ['draft', 'opened', 'merged', 'closed']
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function rowFromMine(item: MineItem, viewer: string): ChangeRow {
  return {
    id: item.url,
    url: item.url,
    repo: item.project,
    iid: item.iid,
    state: item.state === 'draft' ? 'opened' : item.state,
    draft: item.state === 'draft',
    title: item.title,
    updatedAt: item.updatedAt,
    snapshot: null,
    stub: { author: item.author, reviewers: [...item.reviewers], people: item.people, approvedBy: item.approvedBy },
    defaultBranch: null,
    people: item.people,
    viewer,
    drafts: 0
  }
}

/** The rows of the home lists, in the order of the items. The viewer of a row is the signed-in user of its host, or empty. */
export const mineRows = (items: MineItem[], viewers: Record<string, string>): ChangeRow[] => items.map((item) => rowFromMine(item, viewers[item.host] ?? ''))

/** A row of a review: the snapshot is complete, so there is no stub. */
export function rowFromSnapshot(mr: { key: string; repo: string; defaultBranch: string | null; snapshot: ChangeSnapshot }, drafts: number): ChangeRow {
  const { info } = mr.snapshot
  return {
    id: mr.key,
    url: info.url,
    repo: mr.repo,
    iid: info.ref.iid,
    state: info.state,
    draft: info.draft,
    title: info.title,
    updatedAt: info.updatedAt,
    snapshot: mr.snapshot,
    stub: null,
    defaultBranch: mr.defaultBranch,
    people: mr.snapshot.people,
    viewer: mr.snapshot.viewer,
    drafts
  }
}

/** A row is approved when at least one person approved it. An unknown list counts as nobody. */
export function rowApproved(row: ChangeRow): boolean {
  const approvedBy = row.snapshot ? row.snapshot.approvals.approvedBy : row.stub?.approvedBy
  return (approvedBy?.length ?? 0) > 0
}

export const rowStateKey = (row: ChangeRow): MrStateKey => mrStateKey(row)

export function stateCounts(rows: ChangeRow[]): Record<MrStateKey, number> {
  const counts: Record<MrStateKey, number> = { draft: 0, opened: 0, merged: 0, closed: 0 }
  for (const r of rows) counts[rowStateKey(r)]++
  return counts
}

/** How many rows in an enabled state are approved and how many are not. The approval pills do not change these counts. */
export function approvalCounts(rows: ChangeRow[], enabledStates: Record<MrStateKey, boolean>): { approved: number; notApproved: number } {
  const counts = { approved: 0, notApproved: 0 }
  for (const r of rows) if (enabledStates[rowStateKey(r)]) counts[rowApproved(r) ? 'approved' : 'notApproved']++
  return counts
}

/**
 * Mode `state`: one group for each state that has rows, in the order draft, opened, merged, closed.
 * Mode `repo`: one group for each host and repo path, ordered by the path and then the host, always ascending.
 * Mode `approval`: the group `approved` and then `notApproved`, without the empty ones.
 * Mode `none`: one group without key, label and state, even when it is empty.
 * The rows of a group follow `compare`. When it returns exactly 0, the newest update goes first and then the id ascending, in both directions.
 * The input is not changed.
 */
export function groupRows(rows: ChangeRow[], mode: RowGroupMode, compare: (a: ChangeRow, b: ChangeRow) => number, filters: MrFilters): RowGroup[] {
  const order = (list: ChangeRow[]): ChangeRow[] =>
    [...list].sort((a, b) => {
      const result = compare(a, b)
      return result !== 0 ? result : Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || textOrder(a.id, b.id)
    })
  const shown = rows.filter((r) => mrVisible({ state: r.state, draft: r.draft, approverCount: rowApproved(r) ? 1 : 0 }, filters))
  if (mode === 'none') return [{ key: null, label: null, state: null, rows: order(shown) }]
  if (mode === 'state')
    return STATE_ORDER.map((state) => ({
      key: `state:${state}`,
      label: state as string | null,
      state: state as MrStateKey | null,
      rows: order(shown.filter((r) => rowStateKey(r) === state))
    })).filter((g) => g.rows.length > 0)
  if (mode === 'approval')
    return (['approved', 'notApproved'] as const)
      .map((side) => ({
        key: `approval:${side}`,
        label: side as string | null,
        state: null as MrStateKey | null,
        rows: order(shown.filter((r) => rowApproved(r) === (side === 'approved')))
      }))
      .filter((g) => g.rows.length > 0)
  const byRepo = new Map<string, { host: string; list: ChangeRow[] }>()
  for (const r of shown) {
    const host = parseChangeUrl(r.url)?.host ?? ''
    const key = `repo:${host}/${r.repo}`
    const group = byRepo.get(key) ?? { host, list: [] }
    group.list.push(r)
    byRepo.set(key, group)
  }
  return [...byRepo.entries()]
    .map(([key, { host, list }]) => ({ key, label: list[0].repo, host, rows: order(list) }))
    .sort((a, b) => collator.compare(a.label, b.label) || textOrder(a.host, b.host))
    .map(({ host: _host, ...g }) => ({ ...g, state: null }))
}
