import { useEffect, useRef, useState } from 'react'
import type { BuildResult, BuiltMr } from '@shared/review'
import { conversationThreads } from '@shared/threads'
import { api } from '../api'
import { DiffTab } from './DiffTab'
import { ReviewChat } from './ReviewChat'
import { ReviewProvider, useReview } from './review-context'
import { SubmitDialog } from './SubmitDialog'
import { DraftCard, ThreadCard } from './ThreadViews'
import { IssuesTab } from './IssuesTab'
import { AcTab } from './AcTab'
import { AddChanges } from './AddChanges'
import { AiPanel } from './AiPanel'

type Tab = 'mrs' | 'diff' | 'issues' | 'ac'
// The tab of each review, kept while the review is built again, so a reload does not lose your place.
const lastTab = new Map<string, Tab>()

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'issues', label: 'Issues', testId: 'tab-issues' },
  { id: 'mrs', label: 'Code changes', testId: 'tab-mrs' },
  { id: 'diff', label: 'Diff', testId: 'tab-diff' },
  { id: 'ac', label: 'Acceptance criteria', testId: 'tab-ac' }
]

type MrSortKey = 'mr' | 'title' | 'repo' | 'state' | 'pipeline' | 'author' | 'approved' | 'comments' | 'updated'
const MR_COLUMNS: { key: MrSortKey; label: string; header: string }[] = [
  { key: 'mr', label: 'MR number', header: 'MR' },
  { key: 'title', label: 'title', header: 'Title' },
  { key: 'repo', label: 'repo', header: 'Repo' },
  { key: 'state', label: 'state', header: 'State' },
  { key: 'pipeline', label: 'pipeline', header: 'Pipeline' },
  { key: 'author', label: 'author', header: 'Author' },
  { key: 'approved', label: 'approvals', header: 'Approved by' },
  { key: 'comments', label: 'open comments', header: 'Comments' },
  { key: 'updated', label: 'last update', header: 'Updated' }
]

/** Text sorts without regard to case, numbers and dates as numbers; an empty value sorts first. */
function compareMrs(a: BuiltMr, b: BuiltMr, key: MrSortKey): number {
  const text = (m: BuiltMr): string | number => {
    const i = m.snapshot.info
    switch (key) {
      case 'mr':
        return i.ref.iid
      case 'title':
        return i.title.toLowerCase()
      case 'repo':
        return m.repo.toLowerCase()
      case 'state':
        return (i.draft ? 'draft' : i.state).toLowerCase()
      case 'pipeline':
        return (i.pipeline?.status ?? '').toLowerCase()
      case 'author':
        return i.author.toLowerCase()
      case 'approved':
        return m.snapshot.approvals.approvedBy.join(', ').toLowerCase()
      case 'comments':
        return m.snapshot.threads.filter((t) => t.resolvable && !t.resolved).length
      case 'updated':
        return i.updatedAt ? new Date(i.updatedAt).getTime() : 0
    }
  }
  const x = text(a)
  const y = text(b)
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
}

const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('')

/** A date as "3 Nov, 12:26" in the time zone of the computer. */
const when = (iso: string): string => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–')

const STATE_WORD: Record<string, string> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'locked' }

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
  const stateCount = (k: 'draft' | 'opened' | 'merged' | 'closed'): number =>
    data.mrs.filter((m) => (k === 'draft' ? m.snapshot.info.draft : !m.snapshot.info.draft && m.snapshot.info.state === k)).length
  const [mrSort, setMrSort] = useState<{ key: MrSortKey; dir: 'asc' | 'desc' } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('codediff:mrSort') ?? 'null') as { key: MrSortKey; dir: 'asc' | 'desc' } | null
      return v && MR_COLUMNS.some((c) => c.key === v.key) && (v.dir === 'asc' || v.dir === 'desc') ? v : null
    } catch {
      return null
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
  const sortedMrs = mrSort ? [...data.mrs].sort((a, b) => compareMrs(a, b, mrSort.key) * (mrSort.dir === 'asc' ? 1 : -1)) : data.mrs
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
    if (r.nav) setTab('diff')
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
      {(r.flow.pending || r.flow.error) && (
        <div className="banner warn" data-testid="flow-banner" title={r.flow.error ?? undefined}>
          {r.flow.error
            ? 'The AI could not write Critical thinking. Reload the review to try again.'
            : r.flow.problems.length > 0
              ? `Critical thinking is out of date: the MRs changed since it was written (${r.flow.problems.length} problem(s)). The AI is writing it again.`
              : r.flow.context === 'gathering'
                ? 'Gathering context for Critical thinking…'
                : 'The AI is writing Critical thinking…'}
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

      {tab === 'diff' && <DiffTab />}
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
              <div className="cardhead" data-testid="mrs-summary">
                <strong>Code changes</strong>
                <span className="muted">
                  {stateCount('draft')} draft · {stateCount('opened')} open · {stateCount('merged')} merged · {stateCount('closed')} closed
                  {data.skipped.length > 0 && ` · ${data.skipped.length} hidden`}
                </span>
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
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedMrs.map((m) => {
                    const i = m.snapshot.info
                    const open = m.snapshot.threads.filter((t) => t.resolvable && !t.resolved).length
                    const canReview = i.state === 'opened' && i.author !== r.viewer
                    const conversation = conversationThreads(m.snapshot.threads).filter((t) => !(r.hideResolved && t.resolved))
                    const drafts = Object.values(r.drafts).filter((d) => d.mr === m.key && d.path === null)
                    return [
                      <tr key={m.key} data-testid={`mr-${m.key}`}>
                        <td className="mono strong">
                          <a href={i.url} title={m.key} onClick={(e) => (e.preventDefault(), void api.system.openExternal(i.url))}>
                            !{i.ref.iid}
                          </a>
                        </td>
                        <td className="titlecell" title={i.title}>
                          <div>{i.title}</div>
                          <div className="mono muted small">
                            {i.sourceBranch} → {i.targetBranch}
                          </div>
                        </td>
                        <td className="mono small">{m.repo}</td>
                        <td data-testid={`state-${m.key}`}>
                          <span className={`statepill ${i.draft ? 'draft' : i.state}`}>
                            {STATE_WORD[i.state]}
                            {i.draft ? ', draft' : ''}
                            {m.noDiff ? ' (no diff)' : ''}
                          </span>
                        </td>
                        <td>{i.pipeline ? <span className={`pipechip ${i.pipeline.status}`}>{i.pipeline.status}</span> : '–'}</td>
                        <td>
                          <span className="person">
                            <span className="avatar">{initials(i.author)}</span>
                            {i.author}
                          </span>
                        </td>
                        <td data-testid={`approvals-${m.key}`}>{m.snapshot.approvals.approvedBy.join(', ') || '–'}</td>
                        <td className="mono small">
                          <span className="tthreads">
                            💬 {open}/{m.snapshot.threads.filter((t) => t.resolvable).length}
                          </span>{' '}
                          <span className="muted">{open === 0 && m.snapshot.threads.length > 0 ? 'all resolved' : ''}</span>
                        </td>
                        <td className="small muted">{when(i.updatedAt)}</td>
                        <td>
                          <button
                            data-testid={`submit-${m.key}`}
                            disabled={!canReview}
                            title={canReview ? undefined : 'Only an open change by someone else can take a review'}
                            onClick={() => setSubmitFor(m.key)}
                          >
                            Submit review
                          </button>
                        </td>
                      </tr>,
                      (conversation.length > 0 || drafts.length > 0) && (
                        <tr key={`${m.key}-conv`} className="extra">
                          <td colSpan={10}>
                            {conversation.map((t) => (
                              <ThreadCard key={t.id} mrKey={m.key} thread={t} mrOpen={i.state === 'opened'} />
                            ))}
                            {drafts.map((d) => (
                              <DraftCard key={d.id} draft={d} />
                            ))}
                          </td>
                        </tr>
                      )
                    ]
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
