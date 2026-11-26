import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_MINE_APPROVALS, DEFAULT_MINE_STATES, type MineItem, type MineRole } from '@shared/my-changes'
import { rowFromMine, rowFromSnapshot, type ChangeRow, type RowGroupMode } from '@shared/mr-rows'
import type { MrFilters, MrSortKey } from '@shared/mr-table'
import { api } from '../api'
import { useAvatars } from './ui'
import { ChangesTable, type RowAction, type RowError, type TableSort } from './ChangesTable'
import { SubmitDialog } from './SubmitDialog'
import type { Answer, Mine } from './useMine'

/** The row of a list item. Its state, title and updated time come from the list. The snapshot of an old answer stays until a new one arrives, and a failed read leaves the stub with its mark. */
function rowOf(item: MineItem, viewer: string, answer: Answer | undefined): ChangeRow {
  const stub = rowFromMine(item, viewer)
  if (!answer) return stub
  if (!answer.snapshot) return { ...stub, stub: { ...stub.stub!, approvedBy: [], failed: true } }
  const full = rowFromSnapshot({ key: item.url, repo: item.project, defaultBranch: null, snapshot: answer.snapshot }, 0)
  return { ...full, state: stub.state, draft: stub.draft, title: stub.title, updatedAt: stub.updatedAt, people: { ...stub.people, ...full.people } }
}

interface ListView {
  filters: MrFilters
  mode: RowGroupMode
  sort: TableSort
  collapsed: Set<string>
}
const freshView = (): ListView => ({
  filters: { states: DEFAULT_MINE_STATES, approvals: DEFAULT_MINE_APPROVALS },
  mode: 'state',
  sort: { key: 'updated', dir: 'desc' },
  collapsed: new Set()
})

export function MineList(props: {
  role: MineRole
  mine: Mine
  picked: Set<string>
  onToggle: (url: string) => void
  blocked: string | null
  onOpenPrereq: () => void
}): React.JSX.Element {
  const { data, answers, request, refresh, reread, reload } = props.mine
  // Each tab has its own filters, group mode, sort and collapsed groups. They stay while the app runs, and a switch of tab shows the view of that tab.
  const [views, setViews] = useState<Record<MineRole, ListView>>(() => ({ assigned: freshView(), reviewer: freshView() }))
  const { filters, mode, sort, collapsed } = views[props.role]
  const patch = (change: Partial<ListView>): void => setViews((v) => ({ ...v, [props.role]: { ...v[props.role], ...change } }))
  const setFilters = (next: MrFilters): void => patch({ filters: next })
  const setMode = (next: RowGroupMode): void => patch({ mode: next })
  const [busy, setBusy] = useState<Record<string, RowAction>>({})
  const [errors, setErrors] = useState<Record<string, RowError>>({})
  const [submitFor, setSubmitFor] = useState<string | null>(null)
  const items = useMemo(() => (data?.items ?? []).filter((i) => i.roles.includes(props.role)), [data, props.role])
  const rows = useMemo(() => items.map((i) => rowOf(i, data?.viewers[i.host] ?? '', answers[i.url])), [items, data, answers])
  const people = useMemo(() => Object.assign({}, ...rows.map((r) => r.people)), [rows])
  useAvatars(people)
  // A shown change is read in full when it shows. The main process keeps the answers, so a pill that shows a state again costs no call. With every state pill off all the changes show, so all of them are read.
  const shown = useMemo(() => {
    const anyState = Object.values(filters.states).some(Boolean)
    return items.filter((i) => !anyState || filters.states[i.state])
  }, [items, filters.states])
  useEffect(() => request(shown), [request, shown])
  // A click on a new column sorts ascending. A click on the sorted column reverses it.
  const sortBy = (key: MrSortKey): void => patch({ sort: sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' } })

  const without = <T,>(o: Record<string, T>, url: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== url))
  /** After a write the row reads its snapshot again and the list loads again. The busy text stays until both are done, so the old cells never show as if nothing happened. */
  const refreshRow = async (url: string): Promise<void> => {
    const item = items.find((i) => i.url === url)
    await Promise.all([item ? reread([item]) : undefined, reload()])
    setBusy((b) => without(b, url))
  }
  const act = async (row: ChangeRow, action: RowAction): Promise<void> => {
    const url = row.url
    setBusy((b) => ({ ...b, [url]: action }))
    setErrors((e) => without(e, url))
    const res = await api.changes.submit({
      approve: action === 'approve' ? [url] : [],
      unapprove: action === 'revoke' ? [url] : [],
      requestChanges: [],
      summaries: {},
      ready: action === 'mark-ready' ? [url] : [],
      draft: action === 'mark-draft' ? [url] : [],
      reopen: action === 'reopen' ? [url] : []
    })
    const error = res.ok ? res.value[url] : res.error
    if (!error) return refreshRow(url)
    setBusy((b) => without(b, url))
    setErrors((e) => ({ ...e, [url]: { action, message: error } }))
  }
  const submitRow = rows.find((r) => r.url === submitFor)

  if (data && !data.hasAccess)
    return (
      <div className="empty" data-testid="mine-empty">
        <p>No GitLab or GitHub access yet</p>
        <p className="muted">Add a token to see the changes that are assigned to you or wait for your review.</p>
        <button onClick={props.onOpenPrereq}>Open Prerequisites</button>
      </div>
    )

  const refreshAll = (): void => {
    refresh(shown)
    void reload()
  }
  return (
    <div>
      {data?.errors.map((e) => (
        <p key={e.host} className="bad-text" data-testid="mine-error">
          {e.host}: {e.error}
        </p>
      ))}
      <ChangesTable
        rows={rows}
        sort={sort}
        onSort={sortBy}
        filters={filters}
        onFilters={setFilters}
        collapsed={collapsed}
        onCollapsed={(next) => patch({ collapsed: next })}
        groupMode={mode}
        onGroupMode={setMode}
        leading={{
          header: '',
          cell: (row) => (
            <input type="checkbox" aria-label={`Select ${row.title}`} checked={props.picked.has(row.url)} onChange={() => props.onToggle(row.url)} />
          )
        }}
        onAction={(row, action) => void act(row, action)}
        onSubmit={(row) => setSubmitFor(row.url)}
        busy={busy}
        errors={errors}
        emptyText={data ? 'No changes here.' : 'Reading changes…'}
        toolbar={
          <>
            <button data-testid="mine-refresh" disabled={props.mine.loading} onClick={refreshAll}>
              Refresh
            </button>
          </>
        }
      />
      {submitRow?.snapshot && (
        <SubmitDialog
          mrs={[{ key: submitRow.url, snapshot: submitRow.snapshot }]}
          submit={api.changes.submit}
          onDone={() => void refreshRow(submitRow.url)}
          onClose={() => setSubmitFor(null)}
        />
      )}
    </div>
  )
}
