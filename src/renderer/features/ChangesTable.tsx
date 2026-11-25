import { Fragment, useState } from 'react'
import { approvalCounts, groupRows, stateCounts, type ChangeRow, type RowGroupMode } from '@shared/mr-rows'
import {
  commentsCell,
  compareValues,
  formatMrDate,
  mrSortValue,
  mrStateKey,
  pipelineStages,
  stackInfo,
  stateActions,
  yourReview,
  type MrFilters,
  type MrSortKey,
  type MrSortRow,
  type MrStateKey,
  type StackInfo
} from '@shared/mr-table'
import { parseChangeUrl } from '@shared/provider'
import { branchStatus } from '@shared/review'
import { api } from '../api'
import { Avatar } from './ui'

export const STATE_TEXT: Record<MrStateKey, string> = { draft: 'Draft', opened: 'Open', merged: 'Merged', closed: 'Closed' }

export type RowAction = 'approve' | 'revoke' | 'mark-ready' | 'mark-draft'
export interface RowError {
  action: RowAction
  message: string
}
export interface TableSort {
  key: MrSortKey
  dir: 'asc' | 'desc'
}

const BUSY_TEXT: Record<RowAction, string> = {
  approve: 'Approving…',
  revoke: 'Revoking…',
  'mark-ready': 'Marking as ready…',
  'mark-draft': 'Marking as draft…'
}
const REVIEW_LABEL = { submit: 'Submit review', approve: 'Approve', revoke: 'Revoke approval' } as const
const STAGE_GLYPH: Record<string, string> = { success: '✓', failed: '✕', warning: '!', running: '▶', pending: '…', canceled: '⊘', skipped: '»', manual: '▷' }
const GROUP_MODES: [RowGroupMode, string][] = [
  ['none', 'No group'],
  ['repo', 'Repo'],
  ['state', 'State'],
  ['approval', 'Approval']
]
/** Small icons of the state actions. Ready is a circle with a check, draft is a pencil on a dashed circle. */
const ACTION_ICON: Record<'mark-ready' | 'mark-draft', React.JSX.Element> = {
  'mark-ready': (
    <svg className="ico ready" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-testid="icon-mark-ready">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.2 8.3l2 2 3.7-4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  'mark-draft': (
    <svg className="ico draft" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-testid="icon-mark-draft">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2" />
      <path d="M5.4 10.8l.5-2 3.6-3.6 1.5 1.5-3.6 3.6z" fill="currentColor" />
    </svg>
  )
}

interface CellContext {
  stacks: Record<string, StackInfo>
  busy: Record<string, RowAction>
  errors: Record<string, RowError>
  onAction?: (row: ChangeRow, action: RowAction) => void
  onSubmit?: (row: ChangeRow) => void
}

interface ColumnDef {
  key: MrSortKey
  header: string
  label: string
  cell: (row: ChangeRow, ctx: CellContext) => React.JSX.Element
}

const PLACEHOLDER = (
  <span className="muted" title="Loading">
    …
  </span>
)
/** The cell of a value that only a snapshot has: the placeholder while the read is open, a dash when the read failed. */
const waiting = (row: ChangeRow): React.JSX.Element => <td>{row.stub?.failed ? '–' : PLACEHOLDER}</td>
const authorOf = (row: ChangeRow): string | null => row.snapshot?.info.author ?? row.stub?.author ?? null
const isGithub = (row: ChangeRow): boolean => parseChangeUrl(row.url)?.provider === 'github'
/** A GitHub list gives no reviewers until the snapshot answers, so a stub waits with its approvers. */
const reviewersOf = (row: ChangeRow): string[] | null =>
  row.snapshot ? row.snapshot.info.reviewers : row.stub && !(isGithub(row) && row.stub.approvedBy === null) ? row.stub.reviewers : null
const approvedByOf = (row: ChangeRow): string[] | null => (row.snapshot ? row.snapshot.approvals.approvedBy : (row.stub?.approvedBy ?? null))

function openOutside(e: React.MouseEvent, url: string): void {
  e.preventDefault()
  e.stopPropagation()
  void api.system.openExternal(url)
}

function reviewOf(row: ChangeRow): ReturnType<typeof yourReview> | null {
  const s = row.snapshot
  if (!s) return null
  return yourReview({
    state: s.info.state,
    draft: s.info.draft,
    author: s.info.author,
    viewer: row.viewer,
    viewerState: s.viewerState,
    userCanApprove: s.approvals.userCanApprove,
    userHasApproved: s.approvals.userHasApproved
  })
}

function People(props: { users: string[] | null; row: ChangeRow; testId?: string }): React.JSX.Element {
  const users = props.users
  return (
    <td data-testid={props.testId}>
      {users === null ? (
        PLACEHOLDER
      ) : users.length === 0 ? (
        '–'
      ) : (
        <div className="avatars">
          {users.map((u) => (
            <Avatar key={u} user={u} people={props.row.people} viewer={props.row.viewer} />
          ))}
        </div>
      )}
    </td>
  )
}

const dateCell = (iso: string | null): React.JSX.Element => {
  const d = formatMrDate(iso)
  return (
    <td className="small muted" title={d.title}>
      {d.text}
    </td>
  )
}
const snapshotOnly = (row: ChangeRow, render: (s: NonNullable<ChangeRow['snapshot']>) => React.JSX.Element): React.JSX.Element =>
  row.snapshot ? render(row.snapshot) : waiting(row)

/** The columns, left to right. The order here is the order on the screen. */
const COLUMN_DEFS: ColumnDef[] = [
  { key: 'repo', header: 'Repo', label: 'repo', cell: (row) => <td className="mono muted small">{row.repo}</td> },
  {
    key: 'mr',
    header: 'MR',
    label: 'MR number',
    cell: (row) => (
      <td className="mono strong">
        <a href={row.url} title={row.url} onClick={(e) => openOutside(e, row.url)}>
          {isGithub(row) ? '#' : '!'}
          {row.iid}
        </a>
      </td>
    )
  },
  {
    key: 'stack',
    header: 'Stack',
    label: 'stack',
    cell: (row, ctx) => {
      if (!row.snapshot) return waiting(row)
      const stack = ctx.stacks[row.id]
      return (
        <td>
          {stack?.pill ? (
            <span className="stackpill" title={stack.tooltip ?? undefined}>
              {stack.pill}
            </span>
          ) : (
            '–'
          )}
        </td>
      )
    }
  },
  {
    key: 'title',
    header: 'Title',
    label: 'title',
    cell: (row) => {
      const branch = row.snapshot ? branchStatus(row.snapshot.info) : null
      return (
        <td className="titlecell">
          <div>{row.title}</div>
          {row.snapshot && (
            <div className="mono muted small">
              {row.snapshot.info.sourceBranch} → {row.snapshot.info.targetBranch}
              {branch && (branch.kind === 'level' || branch.kind === 'behind') && (
                <span className={`branchbadge ${branch.kind}`} data-testid={`branch-${row.id}`} data-kind={branch.kind} title={branch.title}>
                  {branch.label}
                </span>
              )}
            </div>
          )}
        </td>
      )
    }
  },
  {
    key: 'pipeline',
    header: 'Pipeline',
    label: 'pipeline',
    cell: (row) =>
      snapshotOnly(row, (s) => {
        const p = s.info.pipeline
        if (!p) return <td>–</td>
        return (
          <td>
            <div className="pipeline">
              {p.url ? (
                <a className={`pipechip ${p.status}`} href={p.url} onClick={(e) => openOutside(e, p.url!)}>
                  {p.status}
                </a>
              ) : (
                <span className={`pipechip ${p.status}`}>{p.status}</span>
              )}
              <span className="pipestages">
                {pipelineStages(s.jobs).map((st) => (
                  <button
                    key={st.stage}
                    className={`stage ${st.status}`}
                    aria-label={st.ariaLabel}
                    title={st.tooltip}
                    disabled={!st.url}
                    onClick={() => void api.system.openExternal(st.url!)}
                  >
                    {STAGE_GLYPH[st.status] ?? '•'}
                  </button>
                ))}
              </span>
            </div>
          </td>
        )
      })
  },
  {
    key: 'author',
    header: 'Author',
    label: 'author',
    cell: (row) => {
      const author = authorOf(row)
      return <People users={author === null ? null : [author]} row={row} />
    }
  },
  { key: 'reviewers', header: 'Reviewers', label: 'reviewers', cell: (row) => <People users={reviewersOf(row)} row={row} testId={`reviewers-${row.id}`} /> },
  { key: 'approved', header: 'Approved by', label: 'approvals', cell: (row) => <People users={approvedByOf(row)} row={row} testId={`approvals-${row.id}`} /> },
  {
    key: 'review',
    header: 'Your review',
    label: 'your review',
    cell: (row, ctx) => {
      const review = reviewOf(row)
      if (!review) return waiting(row)
      const busy = ctx.busy[row.id]
      const error = ctx.errors[row.id]
      const mine = busy === 'approve' || busy === 'revoke'
      const shownError = error && (error.action === 'approve' || error.action === 'revoke') ? error : null
      return (
        <td>
          <div className="yourreview">
            {mine ? (
              <span>
                <span className="spin">◐ </span>
                {BUSY_TEXT[busy]}
              </span>
            ) : (
              <>
                <span className={review.tone} title={review.tooltip ?? undefined}>
                  {review.text}
                </span>
                <span className="actions">
                  {review.actions.flatMap((a) =>
                    (a === 'submit' && ctx.onSubmit) || ((a === 'approve' || a === 'revoke') && ctx.onAction)
                      ? [
                          <button
                            key={a}
                            className={a === 'submit' ? 'primary' : ''}
                            data-testid={a === 'submit' ? `submit-${row.id}` : undefined}
                            onClick={() => (a === 'submit' ? ctx.onSubmit?.(row) : ctx.onAction?.(row, a))}
                          >
                            {REVIEW_LABEL[a]}
                          </button>
                        ]
                      : []
                  )}
                </span>
                {shownError && <span className="err">{shownError.message}</span>}
              </>
            )}
          </div>
        </td>
      )
    }
  },
  {
    key: 'comments',
    header: 'Comments',
    label: 'threads',
    cell: (row) =>
      snapshotOnly(row, (s) => {
        const comments = commentsCell(s.threads, row.drafts)
        return (
          <td className="small">
            {comments.chip && (
              <span className={`threadchip ${comments.tone}`} title={comments.chipTitle ?? undefined}>
                💬 {comments.chip}
              </span>
            )}{' '}
            <span className="muted">{comments.detail === 'No threads' || comments.chip ? comments.detail : ''}</span>
            {comments.drafts && (
              <>
                {' · '}
                <span className="tdrafts" title={comments.drafts.title}>
                  {comments.drafts.count}
                </span>{' '}
                <span className="muted">{comments.drafts.label}</span>
              </>
            )}
          </td>
        )
      })
  },
  { key: 'created', header: 'Created', label: 'creation time', cell: (row) => (row.snapshot ? dateCell(row.snapshot.info.createdAt) : waiting(row)) },
  { key: 'updated', header: 'Updated', label: 'last update', cell: (row) => dateCell(row.snapshot?.info.updatedAt ?? row.updatedAt) },
  { key: 'merged', header: 'Merged', label: 'merge time', cell: (row) => (row.snapshot ? dateCell(row.snapshot.info.mergedAt) : waiting(row)) },
  {
    key: 'state',
    header: 'State',
    label: 'state',
    cell: (row, ctx) => {
      const key = mrStateKey(row)
      const author = row.snapshot?.info.author ?? null
      const actions =
        author === null || !ctx.onAction
          ? []
          : stateActions({ state: row.state, draft: row.draft, author, viewer: row.viewer, viewerState: null, userCanApprove: false, userHasApproved: false })
      const busy = ctx.busy[row.id]
      const error = ctx.errors[row.id]
      const markBusy = busy === 'mark-ready' || busy === 'mark-draft'
      const autoMerge = row.snapshot?.info.autoMerge
      return (
        <td data-testid={`state-${row.id}`}>
          <span className={`statepill ${key}`}>{STATE_TEXT[key]}</span>
          {autoMerge?.enabled && (
            <span className="automerge" title={`Auto-merge is on, set by ${autoMerge.by ?? 'unknown'}. GitLab merges this MR when the pipeline succeeds.`}>
              Auto-merge
            </span>
          )}
          {markBusy ? (
            <span>
              <span className="spin">◐ </span>
              {BUSY_TEXT[busy]}
            </span>
          ) : (
            <>
              {actions.map((a) => (
                <button
                  key={a}
                  title={a === 'mark-ready' ? 'Removes the Draft prefix from the title' : 'Adds Draft: to the title'}
                  onClick={() => ctx.onAction?.(row, a as RowAction)}
                >
                  {ACTION_ICON[a as 'mark-ready' | 'mark-draft']}
                  {a === 'mark-ready' ? 'Mark as ready' : 'Mark as draft'}
                </button>
              ))}
              {error && (error.action === 'mark-ready' || error.action === 'mark-draft') && <span className="err">{error.message}</span>}
            </>
          )}
        </td>
      )
    }
  }
]

function groupName(label: string | null, state: MrStateKey | null): string {
  if (state) return STATE_TEXT[state]
  if (label === 'approved') return 'Approved'
  if (label === 'notApproved') return 'Not approved'
  return label ?? ''
}

export interface ChangesTableProps {
  rows: ChangeRow[]
  sort: TableSort | null
  /** A click on a header. The caller owns the cycle of the sort. */
  onSort: (key: MrSortKey) => void
  filters: MrFilters
  onFilters: (next: MrFilters) => void
  groupMode: RowGroupMode
  onGroupMode: (mode: RowGroupMode) => void
  onAction?: (row: ChangeRow, action: RowAction) => void
  onSubmit?: (row: ChangeRow) => void
  /** The action that runs now, by row id. */
  busy: Record<string, RowAction>
  /** The last failed action, by row id. */
  errors: Record<string, RowError>
  /** Content at the left of the bar above the table. */
  head?: React.ReactNode
  headTestId?: string
  /** Content at the left of the pills in the bar above the table. */
  toolbar?: React.ReactNode
  emptyText: string
}

/** The table of changes: the pills, the group buttons, the sortable columns and the group header rows. The caller owns the data, the sort cycle and the filters. */
export function ChangesTable(props: ChangesTableProps): React.JSX.Element {
  const { rows, sort, filters } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const stacks = stackInfo(
    rows.flatMap((row) =>
      row.snapshot
        ? [
            {
              key: row.id,
              iid: row.iid,
              title: row.title,
              repo: row.repo,
              sourceBranch: row.snapshot.info.sourceBranch,
              targetBranch: row.snapshot.info.targetBranch,
              state: row.state,
              defaultBranch: row.defaultBranch
            }
          ]
        : []
    )
  )
  const sortRows = new Map<string, MrSortRow>(
    rows.map((row) => {
      const s = row.snapshot
      const review = reviewOf(row)
      const author = authorOf(row)
      return [
        row.id,
        {
          iid: row.iid,
          stackRank: stacks[row.id]?.rank ?? null,
          title: row.title,
          repo: row.repo,
          authorName: (author && row.people[author]?.name) || author || '',
          approverCount: approvedByOf(row)?.length ?? 0,
          reviewerCount: reviewersOf(row)?.length ?? null,
          pipelineStatus: s?.info.pipeline?.status ?? null,
          reviewOrder: review?.order ?? -1,
          commentsSort: s ? commentsCell(s.threads, row.drafts).sort : null,
          createdAt: s?.info.createdAt ?? '',
          updatedAt: row.updatedAt,
          mergedAt: s?.info.mergedAt ?? null,
          state: row.state,
          draft: row.draft
        }
      ]
    })
  )
  const position = new Map(rows.map((row, i) => [row.id, i]))
  const compare = (a: ChangeRow, b: ChangeRow): number =>
    sort
      ? compareValues(mrSortValue(sortRows.get(a.id)!, sort.key), mrSortValue(sortRows.get(b.id)!, sort.key)) * (sort.dir === 'asc' ? 1 : -1)
      : position.get(a.id)! - position.get(b.id)!
  const groups = groupRows(rows, props.groupMode, compare, filters)
  const shown = groups.reduce((n, g) => n + g.rows.length, 0)

  const counts = stateCounts(rows)
  const anyState = Object.values(filters.states).some(Boolean)
  const approvals = approvalCounts(rows, anyState ? filters.states : { draft: true, opened: true, merged: true, closed: true })
  const ctx: CellContext = { stacks, busy: props.busy, errors: props.errors, onAction: props.onAction, onSubmit: props.onSubmit }
  const columnCount = COLUMN_DEFS.length

  return (
    <>
      <div className="cardhead mrhead" data-testid={props.headTestId}>
        {props.head}
        <span className="grow" />
        <div className="mrtools">
          {props.toolbar}
          <div className="seg toggles" role="group" aria-label="Show MRs by state">
            {(['draft', 'opened', 'merged', 'closed'] as MrStateKey[]).map((k) => (
              <button
                key={k}
                className={filters.states[k] ? 'on' : ''}
                aria-pressed={filters.states[k]}
                title={`Show or hide the ${STATE_TEXT[k].toLowerCase()} MRs`}
                onClick={() => props.onFilters({ ...filters, states: { ...filters.states, [k]: !filters.states[k] } })}
              >
                {STATE_TEXT[k]} <small>{counts[k]}</small>
              </button>
            ))}
          </div>
          <div className="seg toggles" role="group" aria-label="Show MRs by approval">
            {(
              [
                ['approved', 'Approved', approvals.approved, 'approved'],
                ['notApproved', 'Not approved', approvals.notApproved, 'not approved']
              ] as const
            ).map(([k, label, count, word]) => (
              <button
                key={k}
                className={filters.approvals[k] ? 'on' : ''}
                aria-pressed={filters.approvals[k]}
                title={`Show or hide the ${word} MRs`}
                onClick={() => props.onFilters({ ...filters, approvals: { ...filters.approvals, [k]: !filters.approvals[k] } })}
              >
                {label} <small>{count}</small>
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Group the list" data-testid="group-mode">
            {GROUP_MODES.map(([mode, label]) => (
              <button
                key={mode}
                className={props.groupMode === mode ? 'on' : ''}
                aria-pressed={props.groupMode === mode}
                onClick={() => props.onGroupMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <table className="reviews">
        <thead>
          <tr>
            {COLUMN_DEFS.map((c) => (
              <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button className="link" data-testid={`sort-${c.key}`} title={`Sort by ${c.label}`} onClick={() => props.onSort(c.key)}>
                  {c.header}
                  {sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown === 0 && (
            <tr>
              <td colSpan={columnCount} className="muted">
                {props.emptyText}
              </td>
            </tr>
          )}
          {groups.map((g) => {
            const open = g.key === null || !collapsed.has(g.key)
            const name = groupName(g.label, g.state)
            return [
              g.key !== null && g.rows.length > 0 && (
                <tr key={g.key} className="minegroup" data-testid="group-row">
                  <td colSpan={columnCount}>
                    <button
                      className="chevbtn"
                      data-testid="group-toggle"
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} the ${name} group`}
                      onClick={() => toggle(g.key as string)}
                    >
                      {open ? '▴' : '▾'}
                    </button>
                    <button className="link" onClick={() => toggle(g.key as string)}>
                      {`${name} · ${g.rows.length}`}
                    </button>
                  </td>
                </tr>
              ),
              ...(open ? g.rows : []).map((row) => (
                <tr key={row.id} data-testid={`mr-${row.id}`} data-url={row.url}>
                  {COLUMN_DEFS.map((c) => (
                    <Fragment key={c.key}>{c.cell(row, ctx)}</Fragment>
                  ))}
                </tr>
              ))
            ]
          })}
        </tbody>
      </table>
    </>
  )
}
