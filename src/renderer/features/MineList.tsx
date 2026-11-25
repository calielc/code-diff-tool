import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_MINE_APPROVALS, DEFAULT_MINE_STATES, type MineItem, type MineRole } from '@shared/my-changes'
import { rowFromMine, rowFromSnapshot, type ChangeRow, type RowGroupMode } from '@shared/mr-rows'
import type { MrFilters, MrSortKey } from '@shared/mr-table'
import { useAvatars } from './ui'
import { ChangesTable, type TableSort } from './ChangesTable'
import type { Answer, Mine } from './useMine'

/** The row of a list item. Its state, title and updated time come from the list. The snapshot of an old answer stays until a new one arrives, and a failed read leaves the stub with its mark. */
function rowOf(item: MineItem, viewer: string, answer: Answer | undefined): ChangeRow {
  const stub = rowFromMine(item, viewer)
  if (!answer) return stub
  if (!answer.snapshot) return { ...stub, stub: { ...stub.stub!, approvedBy: [], failed: true } }
  const full = rowFromSnapshot({ key: item.url, repo: item.project, defaultBranch: null, snapshot: answer.snapshot }, 0)
  return { ...full, state: stub.state, draft: stub.draft, title: stub.title, updatedAt: stub.updatedAt, people: { ...stub.people, ...full.people } }
}

const NOTHING = {}

export function MineList(props: {
  role: MineRole
  mine: Mine
  picked: Set<string>
  onToggle: (url: string) => void
  onStart: () => void
  blocked: string | null
  onOpenPrereq: () => void
}): React.JSX.Element {
  const { data, answers, request, refresh, reload } = props.mine
  const [filters, setFilters] = useState<MrFilters>({ states: DEFAULT_MINE_STATES, approvals: DEFAULT_MINE_APPROVALS })
  const [mode, setMode] = useState<RowGroupMode>('state')
  const [sort, setSort] = useState<TableSort>({ key: 'updated', dir: 'desc' })
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
  const sortBy = (key: MrSortKey): void => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

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
  const count = props.picked.size
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
        groupMode={mode}
        onGroupMode={setMode}
        leading={{
          header: '',
          cell: (row) => (
            <input type="checkbox" aria-label={`Select ${row.title}`} checked={props.picked.has(row.url)} onChange={() => props.onToggle(row.url)} />
          )
        }}
        busy={NOTHING}
        errors={NOTHING}
        emptyText={data ? 'No changes here.' : 'Reading changes…'}
        toolbar={
          <>
            <button data-testid="mine-refresh" disabled={props.mine.loading} onClick={refreshAll}>
              Refresh
            </button>
            <button
              className="primary"
              data-testid="mine-start"
              disabled={count === 0 || !!props.blocked}
              title={props.blocked ? 'Fix the Prerequisites first' : undefined}
              onClick={props.onStart}
            >
              Start review ({count})
            </button>
          </>
        }
      />
    </div>
  )
}
