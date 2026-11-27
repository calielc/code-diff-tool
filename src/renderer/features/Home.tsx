import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewSummary } from '@shared/review'
import type { LaunchRequest } from '@shared/launch'
import { parseChoice, parseSort, parseText } from '@shared/view-prefs'
import { api } from '../api'
import { HOME, usePref } from '../prefs'
import { AddToReview } from './AddToReview'
import { NewReview } from './NewReview'
import { MineList } from './MineList'
import { useMine } from './useMine'
import { PIPELINE_BADNESS, type ReviewStatus } from '@shared/review-status'

type Tab = 'reviews' | 'assigned' | 'reviewer'
type SortKey = 'title' | 'issues' | 'lastOpened' | 'approved' | 'comments' | 'pipeline'
const SORT_KEYS: SortKey[] = ['title', 'issues', 'lastOpened', 'approved', 'comments', 'pipeline']
const DEFAULT_SORT: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'lastOpened', dir: 'desc' }
const TABS: Tab[] = ['reviews', 'assigned', 'reviewer']

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) // LX-2 before LX-10

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The status of a review: undefined while it is read, null when nothing could be read. */
type StatusMap = Record<string, ReviewStatus | null | undefined>

function compare(a: ReviewSummary, b: ReviewSummary, key: SortKey, status: StatusMap): number {
  switch (key) {
    case 'title':
      return collator.compare(a.title ?? a.slug, b.title ?? b.slug)
    case 'issues':
      return (a.issueCount ?? -1) - (b.issueCount ?? -1)
    // A review with no status yet comes first when ascending, like a column with no value in the tables of changes.
    case 'approved': {
      const ratio = (s: ReviewStatus | null | undefined): number => (s && s.total > 0 ? s.approved / s.total : -1)
      return ratio(status[a.slug]) - ratio(status[b.slug])
    }
    case 'comments':
      return (status[a.slug]?.openThreads ?? -1) - (status[b.slug]?.openThreads ?? -1)
    case 'pipeline': {
      const rank = (s: ReviewStatus | null | undefined): number => (s ? PIPELINE_BADNESS[s.pipeline] : -1)
      return rank(status[a.slug]) - rank(status[b.slug])
    }
    case 'lastOpened': {
      // A review never opened here comes after every opened one, ordered by the change time of review.json.
      if (!!a.openedAt !== !!b.openedAt) return a.openedAt ? 1 : -1 // ascending: opened first is "smaller" so desc puts it first
      return (a.openedAt ?? a.modifiedAt).localeCompare(b.openedAt ?? b.modifiedAt)
    }
  }
}

export function Home(props: {
  blocked: string | null
  /** True while the Prerequisites dialog is open over Home. The lists of changes stop polling until it closes. */
  paused?: boolean
  launch: LaunchRequest | null
  onLaunchUsed: () => void
  onOpenPrereq: () => void
  onOpenReview: (slug: string) => void
}): React.JSX.Element {
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null)
  // The sort, the search and the open tab are kept in the settings file, so the page opens as it was left.
  const [sort, setSort] = usePref(HOME, 'reviewsSort', (v) => parseSort(v, SORT_KEYS, DEFAULT_SORT) ?? DEFAULT_SORT)
  const [filter, setFilter] = usePref(HOME, 'reviewsSearch', (v) => parseText(v, ''))
  const [selected, setSelected] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [initial, setInitial] = useState<LaunchRequest | null>(null)
  const [autoCheck, setAutoCheck] = useState(false)
  const [addTo, setAddTo] = useState<LaunchRequest | null>(null)
  const [tab, setTab] = usePref(HOME, 'tab', (v) => parseChoice(v, TABS, 'reviews'))
  // The ticks of the two lists of changes are one selection, kept by url. It clears when the New review form closes.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const mine = useMine(tab !== 'reviews' && !props.paused)
  const toggle = (url: string): void =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(url)) next.add(url)
      return next
    })
  // With changes ticked, the New review form opens with them. With none, it opens empty. Either way the reviewer fills in the name and the issues.
  const newReview = (): void => {
    setAutoCheck(false)
    setInitial(picked.size > 0 ? { mrs: [...picked], issues: [], title: '', review: '' } : null)
    setShowNew(true)
  }
  // A request from outside adds to the review it names when that review exists, else it starts a new review.
  useEffect(() => {
    const request = props.launch
    if (!request || props.blocked) return
    props.onLaunchUsed()
    void (async () => {
      const exists = request.review !== '' && (await api.reviews.list()).some((r) => r.slug === request.review)
      if (exists) setAddTo(request)
      else {
        setAutoCheck(true)
        setInitial(request)
        setShowNew(true)
      }
    })()
  }, [props.launch, props.blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  const [deleting, setDeleting] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  // The status of each review comes from the forges, so it arrives one review at a time, after the list. An old status stays on screen while a new one is read.
  const [statuses, setStatuses] = useState<StatusMap>({})
  const load = useCallback(async () => {
    const list = await api.reviews.list()
    setReviews(list)
    for (const r of list) {
      if (r.unreadable) continue
      void api.reviews
        .status(r.slug)
        .catch(() => null)
        .then((s) => setStatuses((old) => (s === null && old[r.slug] ? old : { ...old, [r.slug]: s })))
    }
  }, [])
  useEffect(() => {
    void load()
    window.addEventListener('focus', load) // read again when the window gains focus
    return () => window.removeEventListener('focus', load)
  }, [load])

  const rows = useMemo(() => {
    const text = filter.toLowerCase()
    const kept = (reviews ?? []).filter((r) => !text || (r.title ?? r.slug).toLowerCase().includes(text))
    const sign = sort.dir === 'asc' ? 1 : -1
    // Equal values sort by slug ascending in either direction.
    return kept.sort((a, b) => compare(a, b, sort.key, statuses) * sign || collator.compare(a.slug, b.slug))
  }, [reviews, filter, sort, statuses])

  useEffect(() => {
    if (!selected || !rows.some((r) => r.slug === selected)) setSelected(rows[0]?.slug ?? null)
  }, [rows, selected])

  const head = (key: SortKey, label: string, right = false): React.JSX.Element => (
    <th className={right ? 'num' : ''}>
      <button className="link" onClick={() => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}>
        {label}
        {sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )

  const open = (r: ReviewSummary): void => {
    if (!props.blocked && !r.unreadable) props.onOpenReview(r.slug)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (tab !== 'reviews') return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      filterRef.current?.focus()
      return
    }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
    const i = rows.findIndex((r) => r.slug === selected)
    if (e.key === 'ArrowDown') setSelected(rows[Math.min(rows.length - 1, i + 1)]?.slug ?? null)
    else if (e.key === 'ArrowUp') setSelected(rows[Math.max(0, i - 1)]?.slug ?? null)
    else if (e.key === 'Enter' && rows[i]) open(rows[i])
    else if (e.key === 'Delete' && rows[i]) setDeleting(rows[i].slug)
  }

  const total = reviews?.length ?? 0
  const gate = props.blocked ? 'Fix the Prerequisites first' : undefined
  return (
    <div className="page wide" onKeyDown={onKey} tabIndex={0}>
      {props.blocked && (
        <div className="strip bad-strip" data-testid="blocked-strip">
          {props.blocked} is not ready, so reviews cannot open.
          <button onClick={props.onOpenPrereq}>Open Prerequisites</button>
        </div>
      )}
      <div className="tabbar">
        <div className="tabs" role="tablist">
          {(
            [
              ['reviews', 'Reviews'],
              ['assigned', 'Owned by me'],
              ['reviewer', 'I am the reviewer']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              className={tab === key ? 'on' : ''}
              aria-selected={tab === key}
              data-testid={`home-tab-${key}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab !== 'reviews' && <MineList role={tab} mine={mine} picked={picked} onToggle={toggle} blocked={props.blocked} onOpenPrereq={props.onOpenPrereq} />}
      {tab === 'reviews' && (
        <>
          {reviews === null && (
            <p className="muted" data-testid="review-loading">
              Reading reviews…
            </p>
          )}

          {reviews !== null && total === 0 && (
            <div className="empty">
              <p>No reviews yet.</p>
              <p className="muted">Create a review from the change requests of an issue.</p>
            </div>
          )}

          {total > 0 && (
            <>
              <div className="mrtools reviewtools">
                <input
                  ref={filterRef}
                  aria-label="Filter reviews"
                  placeholder="Filter reviews"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
                />
              </div>
              <table className="reviews">
                <thead>
                  <tr>
                    {head('title', 'Name')}
                    {head('issues', 'Issues', true)}
                    {head('lastOpened', 'Last opened')}
                    {head('approved', 'Approved')}
                    {head('comments', 'Comments')}
                    {head('pipeline', 'Pipelines')}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.slug}
                      data-testid={`review-${r.slug}`}
                      className={r.slug === selected ? 'selected' : ''}
                      onClick={() => setSelected(r.slug)}
                      onDoubleClick={() => open(r)}
                    >
                      <td className={r.unreadable ? 'bad-text' : 'cut strong'}>{r.unreadable ? 'Unreadable review.json' : (r.title ?? r.slug)}</td>
                      <td className="num">{r.issueCount ?? '–'}</td>
                      <td title={r.openedAt ?? `Last changed ${when(r.modifiedAt)}`}>
                        {r.openedAt ? when(r.openedAt) : <span className="muted">Never opened here</span>}
                      </td>
                      <StatusCells status={r.unreadable ? null : statuses[r.slug]} />
                      <td className="rowactions">
                        <button disabled={!!props.blocked || r.unreadable} title={r.unreadable ? 'review.json cannot be read' : gate} onClick={() => open(r)}>
                          Open
                        </button>
                        <button aria-label={`Delete review ${r.slug}`} onClick={() => setDeleting(r.slug)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && (
                <div className="empty">
                  <p>No review matches "{filter}".</p>
                  <button onClick={() => setFilter('')}>Clear filter</button>
                </div>
              )}
              <p className="muted" data-testid="showing">
                Showing {rows.length} of {total} {total === 1 ? 'review' : 'reviews'}
              </p>
            </>
          )}
        </>
      )}

      {/* The same button on the three tabs. The bar sticks to the bottom of the window when the page is long, and sits under the content when it is short. */}
      <div className="newbar">
        <button className="primary" data-testid="new-review" disabled={!!props.blocked} title={gate} onClick={newReview}>
          {picked.size > 0 ? `New review (${picked.size})` : 'New review'}
        </button>
      </div>

      {addTo && (
        <AddToReview
          request={addTo}
          onClose={() => setAddTo(null)}
          onDone={(slug) => {
            setAddTo(null)
            void load()
            props.onOpenReview(slug)
          }}
        />
      )}
      {showNew && (
        <NewReview
          initial={initial}
          autoCheck={autoCheck}
          onClose={() => {
            setShowNew(false)
            setInitial(null)
            setPicked(new Set())
          }}
          onCreated={(slug) => {
            setShowNew(false)
            setPicked(new Set())
            void load()
            props.onOpenReview(slug)
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          slug={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setToast(`Moved ${deleting} to the trash.`)
            setDeleting(null)
            void load()
            setTimeout(() => setToast(null), 6000)
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

/** The Approved, Comments and Pipelines cells of a review row. `undefined` is a status that is still read, and `null` one that could not be read. */
function StatusCells(props: { status: ReviewStatus | null | undefined }): React.JSX.Element {
  const s = props.status
  if (s === undefined) {
    return (
      <>
        <td className="muted">…</td>
        <td className="muted">…</td>
        <td className="muted">…</td>
      </>
    )
  }
  if (s === null) {
    return (
      <>
        <td className="muted" title="The changes could not be read">
          –
        </td>
        <td className="muted">–</td>
        <td className="muted">–</td>
      </>
    )
  }
  const partial = s.unread > 0 ? ` ${s.unread} of the changes could not be read, so the numbers cover the others.` : ''
  const allApproved = s.total > 0 && s.approved === s.total
  return (
    <>
      <td
        className={allApproved ? 'ok-text' : ''}
        data-testid="status-approved"
        title={`${s.approved} of ${s.total} changes are approved or merged.${partial}`}
      >
        {s.total === 0 ? '–' : `${s.approved} of ${s.total}`}
      </td>
      <td className={s.openThreads > 0 ? 'warn-text' : 'muted'} data-testid="status-comments" title={`${s.openThreads} open comment threads.${partial}`}>
        {s.openThreads > 0 ? `${s.openThreads} open` : 'none open'}
      </td>
      <td
        data-testid="status-pipeline"
        title={s.failing > 0 ? `${s.failing} pipeline${s.failing === 1 ? '' : 's'} failing.${partial}` : `Pipelines: ${s.pipeline}.${partial}`}
      >
        {s.pipeline === 'failed' && <span className="bad-text">{s.failing} failing</span>}
        {s.pipeline === 'running' && <span className="warn-text">running</span>}
        {s.pipeline === 'passed' && <span className="ok-text">all green</span>}
        {s.pipeline === 'none' && <span className="muted">–</span>}
      </td>
    </>
  )
}

function DeleteDialog(props: { slug: string; onClose: () => void; onDeleted: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<{ path: string; pending: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.reviews.deleteInfo(props.slug).then((r) => (r.ok ? setInfo(r.value) : setError(r.error)))
  }, [props.slug])

  const del = async (): Promise<void> => {
    setBusy(true)
    const r = await api.reviews.delete(props.slug)
    setBusy(false)
    if (r.ok) props.onDeleted()
    else setError(r.error)
  }

  const needsCheck = !!info && info.pending > 0
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={`Delete review ${props.slug}?`}>
      <div className="modal narrow">
        <h2>Delete review {props.slug}?</h2>
        {info && (
          <>
            <p>This deletes the folder below and everything in it.</p>
            <pre className="mono-box">{info.path}</pre>
            <p className="muted">
              It holds the pending comments, the Summarised page and the Claude results of this review. Comments already posted stay where they are. Your repos
              and Jira are not touched.
            </p>
            {needsCheck && (
              <>
                <p className="bad-text">
                  {info.pending} pending {info.pending === 1 ? 'comment' : 'comments'} will be lost.
                </p>
                <label>
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that these comments are lost.
                </label>
              </>
            )}
          </>
        )}
        {error && (
          <p className="bad-text" data-testid="delete-error">
            {error}
          </p>
        )}
        <footer>
          <span className="grow" />
          <button autoFocus onClick={props.onClose}>
            Cancel
          </button>
          <button className="danger" disabled={!info || busy || (needsCheck && !understood)} onClick={() => void del()}>
            Delete review
          </button>
        </footer>
      </div>
    </div>
  )
}
