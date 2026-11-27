import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildResult } from '@shared/review'
import { DEFAULT_MR_FILTERS, DEFAULT_MR_SORT, approveAllCandidates, mrStateKey, mrVisible, SORT_KEYS, type MrSortKey } from '@shared/mr-table'
import { rowFromSnapshot, stateCounts, type RowGroupMode } from '@shared/mr-rows'
import { parseChoice, parseFlags, parseList, parseSort, sortToPref } from '@shared/view-prefs'
import { api } from '../api'
import { reviewScope, usePref } from '../prefs'
import { ChangesTable, STATE_TEXT, type RowAction, type RowError } from './ChangesTable'
import { DiffTab } from './DiffTab'
import { ReviewChat } from './ReviewChat'
import { ReviewProvider, useReview } from './review-context'
import { SubmitDialog } from './SubmitDialog'
import { IssuesTab } from './IssuesTab'
import { AcTab } from './AcTab'
import { AddChanges } from './AddChanges'
import { AiPanel } from './AiPanel'
import { useAvatars } from './ui'

type Tab = 'mrs' | 'summarised' | 'diff' | 'issues' | 'ac'
const TAB_IDS: Tab[] = ['mrs', 'summarised', 'diff', 'issues', 'ac']
const GROUP_MODES: RowGroupMode[] = ['none', 'repo', 'state', 'approval', 'updated']

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'mrs', label: 'Code changes', testId: 'tab-mrs' },
  { id: 'summarised', label: 'Summarised', testId: 'tab-summarised' },
  { id: 'diff', label: 'Diff', testId: 'tab-diff' },
  { id: 'issues', label: 'Issues', testId: 'tab-issues' },
  { id: 'ac', label: 'Acceptance criteria', testId: 'tab-ac' }
]

// Other screens import the text of a state from here.
export { STATE_TEXT }

/** The name of the review in the header. A click turns it into an input: Enter or a blur saves, Escape cancels. */
function ReviewName(props: { slug: string; name: string; onSaved: (title: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  const editing = draft !== null
  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  const start = (): void => {
    finished.current = false
    setError(null)
    setDraft(props.name)
  }
  const stop = (): void => {
    finished.current = true
    setDraft(null)
    setError(null)
  }
  const save = async (): Promise<void> => {
    if (finished.current || draft === null) {
      return
    }
    const title = draft.trim().slice(0, 200)
    if (!title) {
      return setError('Enter a name.')
    }
    finished.current = true
    if (title === props.name) {
      return stop()
    }
    const r = await api.reviews.rename(props.slug, title)
    if (r.ok) {
      props.onSaved(r.value.title)
      return stop()
    }
    finished.current = false
    setError(r.error)
  }

  if (!editing) {
    return (
      <h1>
        <button className="renamebtn" data-testid="review-name" title="Click to rename" onClick={start}>
          <span className="renametext">{props.name}</span>
          <svg
            className="editicon"
            data-testid="review-name-icon"
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M11.5 2.5l2 2L5 13l-3 1 1-3z" strokeLinejoin="round" />
            <path d="M10 4l2 2" />
          </svg>
        </button>
      </h1>
    )
  }
  return (
    <span className="renamebox">
      <input
        ref={input}
        className="renameinput"
        data-testid="review-name-input"
        aria-label="Review name"
        style={{ width: `${Math.max(20, draft.length + 1)}ch` }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            stop()
          }
        }}
      />
      {error && (
        <span className="bad-text small" role="alert" data-testid="review-name-error">
          {error}
        </span>
      )}
    </span>
  )
}

/** The review after a build: the MRs tab and the Diff tab, with live data from the watcher. */
export function MrsScreen(props: { result: BuildResult; slug: string; onHome: () => void; onReload: () => void }): React.JSX.Element {
  return (
    <ReviewProvider slug={props.slug} result={props.result} onReload={props.onReload}>
      <Screen onHome={props.onHome} />
    </ReviewProvider>
  )
}

function Screen(props: { onHome: () => void }): React.JSX.Element {
  const r = useReview()
  // The tab, the sort, the filters, the grouping and the collapsed groups of this review are kept in the settings file, for this review only.
  const scope = reviewScope(r.slug)
  const [tab, setTab] = usePref(scope, 'tab', (v) => parseChoice(v, TAB_IDS, 'mrs'))
  const [name, setName] = useState(r.data.title)
  useEffect(() => setName(r.data.title), [r.data.title])
  const [submitFor, setSubmitFor] = useState<string | null>(null)
  const { data } = r
  const draftCount = Object.keys(r.drafts).length
  useAvatars(r.people)
  const [mrSort, setMrSort] = usePref(scope, 'mrSort', (v) => parseSort(v, SORT_KEYS, DEFAULT_MR_SORT), sortToPref)
  /** A click sorts ascending, a second click descending, a third click returns to the order of the review. */
  const clickMrHeader = (key: MrSortKey): void => {
    const next = mrSort?.key !== key ? { key, dir: 'asc' as const } : mrSort.dir === 'asc' ? { key, dir: 'desc' as const } : null
    setMrSort(next)
  }
  const [filters, setFilters] = usePref(scope, 'mrFilters', (v) => {
    const saved = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
    return { states: parseFlags(saved['states'], DEFAULT_MR_FILTERS.states), approvals: parseFlags(saved['approvals'], DEFAULT_MR_FILTERS.approvals) }
  })
  const [groupMode, setGroupMode] = usePref(scope, 'mrGroup', (v) => parseChoice(v, GROUP_MODES, 'none'))
  const [collapsed, setCollapsed] = usePref(
    scope,
    'mrCollapsed',
    (v) => new Set(parseList(v)),
    (c) => [...c]
  )
  const [busy, setBusy] = useState<Record<string, RowAction>>({})
  const [errors, setErrors] = useState<Record<string, RowError>>({})
  const without = <T,>(o: Record<string, T>, keys: string[]): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
  const act = async (key: string, action: RowAction): Promise<void> => {
    setBusy((b) => ({ ...b, [key]: action }))
    setErrors((e) => without(e, [key]))
    const res = await api.review.submit({
      slug: r.slug,
      approve: action === 'approve' ? [key] : [],
      unapprove: action === 'revoke' ? [key] : [],
      requestChanges: [],
      summaries: {},
      ready: action === 'mark-ready' ? [key] : [],
      draft: action === 'mark-draft' ? [key] : [],
      reopen: action === 'reopen' ? [key] : []
    })
    const error = res.ok ? res.value[key] : res.error
    setBusy((b) => without(b, [key]))
    // A write that worked is shown in the row at once. The review is not built again, so the tab, the scroll and the open file stay where they are.
    if (!error) return r.applyInPlace([key], action)
    setErrors((e) => ({ ...e, [key]: { action, message: error } }))
  }
  const approveAll = async (keys: string[]): Promise<void> => {
    setBusy((b) => ({ ...b, ...Object.fromEntries(keys.map((k) => [k, 'approve' as const])) }))
    setErrors((e) => without(e, keys))
    const res = await api.review.submit({ slug: r.slug, approve: keys, unapprove: [], requestChanges: [], summaries: {}, ready: [], draft: [] })
    const failed: Record<string, string> = res.ok ? res.value : Object.fromEntries(keys.map((k) => [k, res.error]))
    setBusy((b) => without(b, keys))
    r.applyInPlace(
      keys.filter((k) => !failed[k]),
      'approve'
    )
    if (Object.keys(failed).length === 0) return
    setErrors((e) => ({ ...e, ...Object.fromEntries(Object.entries(failed).map(([k, message]) => [k, { action: 'approve' as const, message }])) }))
  }
  const rows = data.mrs.map((m) => ({
    ...rowFromSnapshot(m, Object.values(r.drafts).filter((d) => d.mr === m.key).length),
    people: r.people
  }))
  const stateCount = stateCounts(rows)
  const hiddenCount = rows.filter((x) => !mrVisible({ state: x.state, draft: x.draft, approverCount: x.snapshot!.approvals.approvedBy.length }, filters)).length
  const canApproveCount = rows.filter((x) => x.state === 'opened' && x.snapshot!.approvals.userCanApprove).length
  const approveAllNow = approveAllCandidates(
    rows.map((x) => ({
      key: x.id,
      iid: x.iid,
      repo: x.repo,
      state: x.state,
      author: x.snapshot!.info.author,
      userCanApprove: x.snapshot!.approvals.userCanApprove,
      userHasApproved: x.snapshot!.approvals.userHasApproved
    })),
    r.viewer
  )
  const anyBusy = Object.keys(busy).length > 0
  const visibleKey = useCallback(
    (key: string): boolean => {
      const m = rows.find((x) => x.id === key)
      return !m || mrVisible({ state: m.state, draft: m.draft, approverCount: m.snapshot!.approvals.approvedBy.length }, filters)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filters]
  )
  const repoCount = new Set(data.mrs.map((m) => m.repo)).size
  const threadsAll = data.mrs.flatMap((m) => m.snapshot.threads.filter((t) => t.resolvable))
  const threadTotal = threadsAll.length
  const threadOpen = threadsAll.filter((t) => !t.resolved).length
  const fileIds = data.mrs.flatMap((m) => m.files.map((f) => `mr:${m.key}|${f.path}`))
  const fileTotal = fileIds.length
  const viewedCount = fileIds.filter((id) => r.viewed.has(id)).length
  // The keys 1 to 5 switch the tab, unless the reviewer is typing. Ctrl+Tab and Ctrl+Shift+Tab walk through the tabs.
  const tabNow = useRef(tab)
  tabNow.current = tab
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      // Ctrl+Tab goes to the next tab and Ctrl+Shift+Tab to the prior one, in the order of the tabs, also while typing
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
        e.preventDefault()
        const i = TABS.findIndex((x) => x.id === tabNow.current)
        setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id)
        return
      }
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1].id)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // An Open card of the review chat shows the Diff tab.
  useEffect(() => {
    if (!r.nav) return
    const info = r.mrByKey(r.nav.mr)?.snapshot.info
    if (info && !visibleKey(r.nav.mr)) {
      const approved = (r.mrByKey(r.nav.mr)?.snapshot.approvals.approvedBy.length ?? 0) > 0
      setFilters({
        states: { ...filters.states, [mrStateKey(info)]: true },
        approvals: { ...filters.approvals, [approved ? 'approved' : 'notApproved']: true }
      })
    }
    setTab('diff')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.nav?.nonce])

  return (
    <div className="page wide" data-testid="mrs-tab">
      <header className="reviewhead">
        <button className="ghost" onClick={props.onHome} title="Back to the reviews">
          ← Reviews
        </button>
        <ReviewName slug={r.slug} name={name} onSaved={setName} />
        <span className="sub" data-testid="subtitle">
          {data.mrs.length} {data.mrs.length === 1 ? 'change request' : 'change requests'} in {repoCount} {repoCount === 1 ? 'repository' : 'repositories'} ·
          signed in as {data.viewer}
          {data.issues.length > 0 && ` · ${data.issues.map((t) => t.key).join(', ')}`}
        </span>
        <span className="grow" />
        <button className="ghost" onClick={r.reload}>
          Reload
        </button>
        <AiPanel />
      </header>
      {r.refreshBanner && (
        <div className="banner warn" data-testid="refresh-banner">
          New commits on {r.refreshBanner.map((k) => `!${k.slice(k.lastIndexOf('!') + 1)}`).join(', ')}. <button onClick={r.reload}>Refresh</button>
        </div>
      )}
      {(r.sections.pending || r.sections.error) && (
        <div
          className="banner warn"
          data-testid="sections-banner"
          title={r.sections.error ?? (r.sections.problems.length > 0 ? r.sections.problems.slice(0, 8).join('\n') : undefined)}
        >
          {r.sections.error
            ? 'The AI could not write the Summarised page. Open the Summarised tab and press Try again.'
            : r.sections.problems.length > 0
              ? `The Summarised page is out of date: the changes moved since it was written (${r.sections.problems.length} problem(s)). The AI is writing it again.`
              : r.sections.context === 'gathering'
                ? 'Gathering context for the Summarised page…'
                : 'The AI is writing the Summarised page…'}
        </div>
      )}
      <div className="tabs" role="tablist">
        {TABS.map((t, i) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} data-testid={t.testId} onClick={() => setTab(t.id)}>
            <span>{t.label}</span>
            {t.id === 'issues' && (
              <span className="tcount" data-testid="count-issues">
                {data.issues.length}
              </span>
            )}
            {t.id === 'mrs' && (
              <>
                <span className="tcount" data-testid="count-mrs">
                  {data.mrs.length}/{data.mrs.length + data.skipped.length}
                </span>
                {threadTotal > 0 && (
                  <span className="tthreads" title={`${threadOpen} open of ${threadTotal} threads`}>
                    💬 {threadOpen}/{threadTotal}
                  </span>
                )}
              </>
            )}
            {t.id === 'diff' && (
              <>
                <span className="tcount" data-testid="count-diff">
                  {viewedCount}/{fileTotal}
                </span>
                {draftCount > 0 && (
                  <span className="tdrafts" data-testid="count-drafts" title="Your drafts, not posted yet">
                    {draftCount} {draftCount === 1 ? 'draft' : 'drafts'}
                  </span>
                )}
              </>
            )}
            {t.id === 'ac' && (
              <span className="acdots" data-testid="ac-dots">
                {(r.ai?.criteria ?? []).map((c, n) => {
                  const st = r.ai?.ac?.checklist?.find((e) => e.ac === c.name)?.state ?? 'none'
                  return (
                    <span key={c.name} className={`acdot ${st}`} title={c.name}>
                      {n + 1}
                    </span>
                  )
                })}
              </span>
            )}
            <span className="tkey">{i + 1}</span>
          </button>
        ))}
      </div>

      {tab === 'diff' && <DiffTab mode="diff" visible={visibleKey} />}
      {tab === 'summarised' && <DiffTab mode="summarised" visible={visibleKey} />}
      {tab !== 'diff' && tab !== 'summarised' && (
        <div className="tabpane">
          {tab === 'issues' && (
            <div className="panelcard">
              <IssuesTab />
            </div>
          )}
          {tab === 'ac' && <AcTab />}
          {tab === 'mrs' && (
            <div className="panelcard">
              <ChangesTable
                rows={rows}
                sort={mrSort}
                onSort={clickMrHeader}
                filters={filters}
                onFilters={setFilters}
                groupMode={groupMode}
                onGroupMode={setGroupMode}
                collapsed={collapsed}
                onCollapsed={setCollapsed}
                onAction={(row, action) => void act(row.id, action)}
                onSubmit={(row) => setSubmitFor(row.id)}
                busy={busy}
                errors={errors}
                headTestId="mrs-summary"
                head={
                  <>
                    <strong>Change requests</strong>
                    <span className="muted">
                      {stateCount.draft} draft · {stateCount.opened} open · {stateCount.merged} merged · {stateCount.closed} closed
                      {hiddenCount > 0 && `, ${hiddenCount} hidden`}
                    </span>
                    {canApproveCount > 0 ? (
                      <span className="okline">{canApproveCount} you can approve</span>
                    ) : (
                      <span className="muted">none for you to approve</span>
                    )}
                  </>
                }
                toolbar={
                  approveAllNow.keys.length > 0 && (
                    <button className="primary" title={approveAllNow.tooltip} disabled={anyBusy} onClick={() => void approveAll(approveAllNow.keys)}>
                      {anyBusy ? 'Approving…' : `Approve all (${approveAllNow.keys.length})`}
                    </button>
                  )
                }
                emptyText={`No change request has the states and approvals turned on. Turn more on above to see the review's ${rows.length} change requests.`}
              />
              {data.skipped.length > 0 && (
                <>
                  <h3>Skipped</h3>
                  <ul className="checklist mono">
                    {data.skipped.map((s) => (
                      <li key={s.key} className="muted">
                        – {s.key} ({s.reason}) {s.title}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <AddChanges slug={r.slug} onAdded={r.reload} />
            </div>
          )}
        </div>
      )}
      <ReviewChat />
      {submitFor && r.mrByKey(submitFor) && <SubmitDialog mrs={[r.mrByKey(submitFor)!]} onClose={() => setSubmitFor(null)} />}
    </div>
  )
}
