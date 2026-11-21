import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildResult } from '@shared/review'
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
  pipelineStages,
  stackInfo,
  yourReview,
  type MrFilters,
  type MrSortKey,
  type MrSortRow,
  type MrStateKey
} from '@shared/mr-table'
import { branchStatus } from '@shared/review'
import { api } from '../api'
import { DiffTab } from './DiffTab'
import { ReviewChat } from './ReviewChat'
import { ReviewProvider, useReview } from './review-context'
import { SubmitDialog } from './SubmitDialog'
import { IssuesTab } from './IssuesTab'
import { AcTab } from './AcTab'
import { AddChanges } from './AddChanges'
import { AiPanel } from './AiPanel'
import { Avatar, useAvatars } from './ui'

type Tab = 'mrs' | 'diff' | 'issues' | 'ac'
// The tab of each review, kept while the review is built again, so a reload does not lose your place.
const lastTab = new Map<string, Tab>()

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'issues', label: 'Issues', testId: 'tab-issues' },
  { id: 'mrs', label: 'Code changes', testId: 'tab-mrs' },
  { id: 'diff', label: 'Diff', testId: 'tab-diff' },
  { id: 'ac', label: 'Acceptance criteria', testId: 'tab-ac' }
]

const MR_COLUMNS: { key: MrSortKey; label: string; header: string }[] = [
  { key: 'mr', label: 'MR number', header: 'MR' },
  { key: 'stack', label: 'stack', header: 'Stack' },
  { key: 'title', label: 'title', header: 'Title' },
  { key: 'repo', label: 'repo', header: 'Repo' },
  { key: 'pipeline', label: 'pipeline', header: 'Pipeline' },
  { key: 'author', label: 'author', header: 'Author' },
  { key: 'approved', label: 'approvals', header: 'Approved by' },
  { key: 'review', label: 'your review', header: 'Your review' },
  { key: 'comments', label: 'threads', header: 'Comments' },
  { key: 'created', label: 'creation time', header: 'Created' },
  { key: 'updated', label: 'last update', header: 'Updated' },
  { key: 'merged', label: 'merge time', header: 'Merged' },
  { key: 'state', label: 'state', header: 'State' }
]

/** An empty value sorts first. Text sorts without regard to case, numbers and dates as numbers. */
function compareValues(x: string | number | null, y: string | number | null): number {
  if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
}

const STAGE_GLYPH: Record<string, string> = { success: '✓', failed: '✕', warning: '!', running: '▶', pending: '…', canceled: '⊘', skipped: '»', manual: '▷' }
const STATE_TEXT: Record<MrStateKey, string> = { draft: 'Draft', opened: 'Open', merged: 'Merged', closed: 'Closed' }
/** Small icons of the actions in the table. Ready is a circle with a check, draft is a pencil on a dashed circle. */
const ACTION_ICON: Partial<Record<'mark-ready' | 'mark-draft', React.JSX.Element>> = {
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
const BUSY_TEXT = { approve: 'Approving…', revoke: 'Revoking…', 'mark-ready': 'Marking as ready…', 'mark-draft': 'Marking as draft…' } as const
type RowAction = keyof typeof BUSY_TEXT

function openOutside(e: React.MouseEvent, url: string): void {
  e.preventDefault()
  void api.system.openExternal(url)
}

function loadFilters(): MrFilters {
  try {
    const v = JSON.parse(localStorage.getItem('codediff:mrFilters') ?? 'null') as Partial<MrFilters> | null
    return v?.states && v.approvals
      ? { states: { ...DEFAULT_MR_FILTERS.states, ...v.states }, approvals: { ...DEFAULT_MR_FILTERS.approvals, ...v.approvals } }
      : DEFAULT_MR_FILTERS
  } catch {
    return DEFAULT_MR_FILTERS
  }
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
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(r.slug) ?? 'mrs')
  const setTab = (t: Tab): void => (lastTab.set(r.slug, t), setTabState(t))
  const [submitFor, setSubmitFor] = useState<string | null>(null)
  const { data } = r
  const draftCount = Object.keys(r.drafts).length
  useAvatars(r.people)
  const [mrSort, setMrSort] = useState(() => {
    try {
      return parseStoredMrSort(localStorage.getItem('codediff:mrSort'))
    } catch {
      return DEFAULT_MR_SORT
    }
  })
  /** A click sorts ascending, a second click descending, a third click returns to the order of the review. */
  const clickMrHeader = (key: MrSortKey): void => {
    const next = mrSort?.key !== key ? { key, dir: 'asc' as const } : mrSort.dir === 'asc' ? { key, dir: 'desc' as const } : null
    setMrSort(next)
    try {
      localStorage.setItem('codediff:mrSort', JSON.stringify(next))
    } catch {
      /* the sort then lasts until the window closes */
    }
  }
  const [filters, setFiltersState] = useState<MrFilters>(loadFilters)
  const setFilters = (next: MrFilters): void => {
    setFiltersState(next)
    try {
      localStorage.setItem('codediff:mrFilters', JSON.stringify(next))
    } catch {
      /* the toggles then last until the window closes */
    }
  }
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const without = (o: Record<string, string>, keys: string[]): Record<string, string> =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
  const act = async (key: string, action: RowAction): Promise<void> => {
    setBusy((b) => ({ ...b, [key]: BUSY_TEXT[action] }))
    setErrors((e) => without(e, [key]))
    const res = await api.review.submit({
      slug: r.slug,
      approve: action === 'approve' ? [key] : [],
      unapprove: action === 'revoke' ? [key] : [],
      requestChanges: [],
      summaries: {},
      ready: action === 'mark-ready' ? [key] : [],
      draft: action === 'mark-draft' ? [key] : []
    })
    const error = res.ok ? res.value[key] : res.error
    if (!error) return r.reload()
    setBusy((b) => without(b, [key]))
    setErrors((e) => ({ ...e, [key]: error }))
  }
  const approveAll = async (keys: string[]): Promise<void> => {
    setBusy((b) => ({ ...b, ...Object.fromEntries(keys.map((k) => [k, BUSY_TEXT.approve])) }))
    setErrors((e) => without(e, keys))
    const res = await api.review.submit({ slug: r.slug, approve: keys, unapprove: [], requestChanges: [], summaries: {}, ready: [], draft: [] })
    const failed: Record<string, string> = res.ok ? res.value : Object.fromEntries(keys.map((k) => [k, res.error]))
    if (Object.keys(failed).length === 0) return r.reload()
    setBusy((b) => without(b, keys))
    setErrors((e) => ({ ...e, ...failed }))
    r.approveInPlace(keys.filter((k) => !failed[k]))
  }
  const stacks = stackInfo(
    data.mrs.map((m) => ({
      key: m.key,
      iid: m.snapshot.info.ref.iid,
      title: m.snapshot.info.title,
      repo: m.repo,
      sourceBranch: m.snapshot.info.sourceBranch,
      targetBranch: m.snapshot.info.targetBranch,
      state: m.snapshot.info.state,
      defaultBranch: m.defaultBranch
    }))
  )
  const rows = data.mrs.map((m) => {
    const i = m.snapshot.info
    const a = m.snapshot.approvals
    const review = yourReview({
      state: i.state,
      draft: i.draft,
      author: i.author,
      viewer: r.viewer,
      viewerState: m.snapshot.viewerState,
      userCanApprove: a.userCanApprove,
      userHasApproved: a.userHasApproved
    })
    const comments = commentsCell(m.snapshot.threads, Object.values(r.drafts).filter((d) => d.mr === m.key).length)
    const sort: MrSortRow = {
      iid: i.ref.iid,
      stackRank: stacks[m.key].rank,
      title: i.title,
      repo: m.repo,
      authorName: r.people[i.author]?.name || i.author,
      approverCount: a.approvedBy.length,
      pipelineStatus: i.pipeline?.status ?? null,
      reviewOrder: review.order,
      commentsSort: comments.sort,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      mergedAt: i.mergedAt,
      state: i.state,
      draft: i.draft
    }
    return {
      m,
      stack: stacks[m.key],
      review,
      comments,
      sort,
      visible: mrVisible({ state: i.state, draft: i.draft, approverCount: a.approvedBy.length }, filters)
    }
  })
  const stateCount = (k: MrStateKey): number => rows.filter((x) => mrStateKey(x.m.snapshot.info) === k).length
  const approvedCount = rows.filter((x) => x.sort.approverCount > 0).length
  const hiddenCount = rows.filter((x) => !x.visible).length
  const canApproveCount = rows.filter((x) => x.m.snapshot.info.state === 'opened' && x.m.snapshot.approvals.userCanApprove).length
  const approveAllNow = approveAllCandidates(
    rows.map((x) => ({
      key: x.m.key,
      iid: x.sort.iid,
      repo: x.m.repo,
      state: x.m.snapshot.info.state,
      author: x.m.snapshot.info.author,
      userCanApprove: x.m.snapshot.approvals.userCanApprove,
      userHasApproved: x.m.snapshot.approvals.userHasApproved
    })),
    r.viewer
  )
  const anyBusy = Object.keys(busy).length > 0
  const shownRows = (
    mrSort ? [...rows].sort((x, y) => compareValues(mrSortValue(x.sort, mrSort.key), mrSortValue(y.sort, mrSort.key)) * (mrSort.dir === 'asc' ? 1 : -1)) : rows
  ).filter((x) => x.visible)
  const visibleKey = useCallback(
    (key: string): boolean => {
      const m = rows.find((x) => x.m.key === key)
      return !m || m.visible
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
  // The keys 1 to 4 switch the tab, unless the reviewer is typing. Ctrl+Tab and Ctrl+Shift+Tab walk through the tabs.
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
        <h1>{data.title}</h1>
        <span className="sub" data-testid="subtitle">
          {data.mrs.length} {data.mrs.length === 1 ? 'change' : 'changes'} in {repoCount} {repoCount === 1 ? 'repo' : 'repos'} · signed in as {data.viewer}
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
            ? 'The AI could not write the Summarised page. Open the Summarised view and press Try again.'
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

      {tab === 'diff' && <DiffTab visible={visibleKey} />}
      {tab !== 'diff' && (
        <div className="tabpane">
          {tab === 'issues' && (
            <div className="panelcard">
              <IssuesTab />
            </div>
          )}
          {tab === 'ac' && <AcTab />}
          {tab === 'mrs' && (
            <div className="panelcard">
              <div className="cardhead mrhead" data-testid="mrs-summary">
                <strong>Merge requests</strong>
                <span className="muted">
                  {stateCount('draft')} draft · {stateCount('opened')} open · {stateCount('merged')} merged · {stateCount('closed')} closed
                  {hiddenCount > 0 && `, ${hiddenCount} hidden`}
                </span>
                {canApproveCount > 0 ? (
                  <span className="okline">{canApproveCount} you can approve</span>
                ) : (
                  <span className="muted">none for you to approve</span>
                )}
                <span className="grow" />
                <div className="mrtools">
                  {approveAllNow.keys.length > 0 && (
                    <button className="primary" title={approveAllNow.tooltip} disabled={anyBusy} onClick={() => void approveAll(approveAllNow.keys)}>
                      {anyBusy ? 'Approving…' : `Approve all (${approveAllNow.keys.length})`}
                    </button>
                  )}
                  <div className="seg toggles" role="group" aria-label="Show MRs by state">
                    {(['draft', 'opened', 'merged', 'closed'] as MrStateKey[]).map((k) => (
                      <button
                        key={k}
                        className={filters.states[k] ? 'on' : ''}
                        aria-pressed={filters.states[k]}
                        title={`Show or hide the ${STATE_TEXT[k].toLowerCase()} MRs`}
                        onClick={() => setFilters({ ...filters, states: { ...filters.states, [k]: !filters.states[k] } })}
                      >
                        {STATE_TEXT[k]} <small>{stateCount(k)}</small>
                      </button>
                    ))}
                  </div>
                  <div className="seg toggles" role="group" aria-label="Show MRs by approval">
                    {(
                      [
                        ['approved', 'Approved', approvedCount, 'approved'],
                        ['notApproved', 'Not approved', rows.length - approvedCount, 'not approved']
                      ] as const
                    ).map(([k, label, count, word]) => (
                      <button
                        key={k}
                        className={filters.approvals[k] ? 'on' : ''}
                        aria-pressed={filters.approvals[k]}
                        title={`Show or hide the ${word} MRs`}
                        onClick={() => setFilters({ ...filters, approvals: { ...filters.approvals, [k]: !filters.approvals[k] } })}
                      >
                        {label} <small>{count}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <table className="reviews">
                <thead>
                  <tr>
                    {MR_COLUMNS.map((c) => (
                      <th key={c.key} aria-sort={mrSort?.key === c.key ? (mrSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        <button className="link" data-testid={`sort-${c.key}`} title={`Sort by ${c.label}`} onClick={() => clickMrHeader(c.key)}>
                          {c.header}
                          {mrSort?.key === c.key ? (mrSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shownRows.length === 0 && (
                    <tr>
                      <td colSpan={MR_COLUMNS.length} className="muted">
                        No MR has the states and approvals turned on. Turn more on above to see the review's {rows.length} MRs.
                      </td>
                    </tr>
                  )}
                  {shownRows.map(({ m, stack, review, comments }) => {
                    const i = m.snapshot.info
                    const branch = branchStatus(i)
                    const created = formatMrDate(i.createdAt)
                    const updated = formatMrDate(i.updatedAt)
                    const merged = formatMrDate(i.mergedAt)
                    const key = mrStateKey(i)
                    const dates = (
                      [
                        ['created', created],
                        ['updated', updated],
                        ['merged', merged]
                      ] as const
                    ).map(([name, d]) => (
                      <td key={name} className="small muted" title={d.title}>
                        {d.text}
                      </td>
                    ))
                    return (
                      <tr key={m.key} data-testid={`mr-${m.key}`}>
                        <td className="mono strong">
                          <a href={i.url} title={m.key} onClick={(e) => openOutside(e, i.url)}>
                            !{i.ref.iid}
                          </a>
                        </td>
                        <td>
                          {stack.pill ? (
                            <span className="stackpill" title={stack.tooltip ?? undefined}>
                              {stack.pill}
                            </span>
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className="titlecell">
                          <div>{i.title}</div>
                          <div className="mono muted small">
                            {i.sourceBranch} → {i.targetBranch}
                            {(branch.kind === 'level' || branch.kind === 'behind') && (
                              <span className={`branchbadge ${branch.kind}`} data-testid={`branch-${m.key}`} data-kind={branch.kind} title={branch.title}>
                                {branch.label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="mono muted small">{m.repo}</td>
                        <td>
                          {i.pipeline ? (
                            <div className="pipeline">
                              {i.pipeline.url ? (
                                <a className={`pipechip ${i.pipeline.status}`} href={i.pipeline.url} onClick={(e) => openOutside(e, i.pipeline!.url!)}>
                                  {i.pipeline.status}
                                </a>
                              ) : (
                                <span className={`pipechip ${i.pipeline.status}`}>{i.pipeline.status}</span>
                              )}
                              <span className="pipestages">
                                {pipelineStages(m.snapshot.jobs).map((st) => (
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
                          ) : (
                            '–'
                          )}
                        </td>
                        <td>
                          <Avatar user={i.author} people={r.people} viewer={r.viewer} />
                        </td>
                        <td data-testid={`approvals-${m.key}`}>
                          {m.snapshot.approvals.approvedBy.length === 0 ? (
                            '–'
                          ) : (
                            <div className="avatars">
                              {m.snapshot.approvals.approvedBy.map((u) => (
                                <Avatar key={u} user={u} people={r.people} viewer={r.viewer} />
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="yourreview">
                            {busy[m.key] ? (
                              <span>
                                <span className="spin">◐ </span>
                                {busy[m.key]}
                              </span>
                            ) : (
                              <>
                                <span className={review.tone} title={review.tooltip ?? undefined}>
                                  {review.text}
                                </span>
                                <span className="actions">
                                  {review.actions.map((a) => (
                                    <button
                                      key={a}
                                      className={a === 'submit' ? 'primary' : ''}
                                      data-testid={a === 'submit' ? `submit-${m.key}` : undefined}
                                      title={
                                        a === 'mark-ready'
                                          ? 'Removes the Draft prefix from the title'
                                          : a === 'mark-draft'
                                            ? 'Adds Draft: to the title'
                                            : undefined
                                      }
                                      onClick={() => (a === 'submit' ? setSubmitFor(m.key) : void act(m.key, a))}
                                    >
                                      {a === 'mark-ready' || a === 'mark-draft' ? ACTION_ICON[a] : null}
                                      {
                                        {
                                          submit: 'Submit review',
                                          approve: 'Approve',
                                          revoke: 'Revoke approval',
                                          'mark-ready': 'Mark as ready',
                                          'mark-draft': 'Mark as draft'
                                        }[a]
                                      }
                                    </button>
                                  ))}
                                </span>
                                {errors[m.key] && <span className="err">{errors[m.key]}</span>}
                              </>
                            )}
                          </div>
                        </td>
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
                        {dates}
                        <td data-testid={`state-${m.key}`}>
                          <span className={`statepill ${key}`}>{STATE_TEXT[key]}</span>
                          {i.autoMerge.enabled && (
                            <span
                              className="automerge"
                              title={`Auto-merge is on, set by ${i.autoMerge.by ?? 'unknown'}. GitLab merges this MR when the pipeline succeeds.`}
                            >
                              Auto-merge
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
