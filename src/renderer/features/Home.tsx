import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SummarisedState, ReviewSummary } from '@shared/review'
import type { LaunchRequest } from '@shared/launch'
import { api } from '../api'
import { AddToReview } from './AddToReview'
import { NewReview } from './NewReview'

type SortKey = 'title' | 'mrs' | 'issues' | 'lastOpened' | 'summarised'
type SummarisedFilter = 'all' | SummarisedState

const SUMMARISED_LABEL: Record<SummarisedState, string> = { writing: 'Writing…', failed: 'Failed', ready: 'Ready', 'not-written': 'Not written' }
const SUMMARISED_ORDER: SummarisedState[] = ['writing', 'failed', 'ready', 'not-written']
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) // LX-2 before LX-10

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function compare(a: ReviewSummary, b: ReviewSummary, key: SortKey): number {
  switch (key) {
    case 'title':
      return collator.compare(a.title ?? a.slug, b.title ?? b.slug)
    case 'mrs':
      return (a.mrCount ?? -1) - (b.mrCount ?? -1)
    case 'issues':
      return (a.issueCount ?? -1) - (b.issueCount ?? -1)
    case 'summarised':
      return SUMMARISED_ORDER.indexOf(a.summarised) - SUMMARISED_ORDER.indexOf(b.summarised)
    case 'lastOpened': {
      // A review never opened here comes after every opened one, ordered by the change time of review.json.
      if (!!a.openedAt !== !!b.openedAt) return a.openedAt ? 1 : -1 // ascending: opened first is "smaller" so desc puts it first
      return (a.openedAt ?? a.modifiedAt).localeCompare(b.openedAt ?? b.modifiedAt)
    }
  }
}

export function Home(props: {
  blocked: string | null
  launch: LaunchRequest | null
  onLaunchUsed: () => void
  onOpenPrereq: () => void
  onOpenReview: (slug: string) => void
}): React.JSX.Element {
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastOpened', dir: 'desc' })
  const [filter, setFilter] = useState('')
  const [summarised, setSummarised] = useState<SummarisedFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [initial, setInitial] = useState<LaunchRequest | null>(null)
  const [addTo, setAddTo] = useState<LaunchRequest | null>(null)
  // A request from outside adds to the review it names when that review exists, else it starts a new review.
  useEffect(() => {
    const request = props.launch
    if (!request || props.blocked) return
    props.onLaunchUsed()
    void (async () => {
      const exists = request.review !== '' && (await api.reviews.list()).some((r) => r.slug === request.review)
      if (exists) setAddTo(request)
      else {
        setInitial(request)
        setShowNew(true)
      }
    })()
  }, [props.launch, props.blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  const [deleting, setDeleting] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => setReviews(await api.reviews.list()), [])
  useEffect(() => {
    void load()
    window.addEventListener('focus', load) // read again when the window gains focus
    return () => window.removeEventListener('focus', load)
  }, [load])

  const rows = useMemo(() => {
    const text = filter.toLowerCase()
    const kept = (reviews ?? []).filter(
      (r) => (summarised === 'all' || r.summarised === summarised) && (!text || (r.title ?? r.slug).toLowerCase().includes(text))
    )
    const sign = sort.dir === 'asc' ? 1 : -1
    // Equal values sort by slug ascending in either direction.
    return kept.sort((a, b) => compare(a, b, sort.key) * sign || collator.compare(a.slug, b.slug))
  }, [reviews, filter, summarised, sort])

  useEffect(() => {
    if (!selected || !rows.some((r) => r.slug === selected)) setSelected(rows[0]?.slug ?? null)
  }, [rows, selected])

  const head = (key: SortKey, label: string, right = false): React.JSX.Element => (
    <th className={right ? 'num' : ''}>
      <button className="link" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))}>
        {label}
        {sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )

  const open = (r: ReviewSummary): void => {
    if (!props.blocked && !r.unreadable) props.onOpenReview(r.slug)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      filterRef.current?.focus()
      return
    }
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
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
      <header>
        <h1>Reviews</h1>
        {total > 0 && (
          <>
            <input
              ref={filterRef}
              aria-label="Filter reviews"
              placeholder="Filter reviews"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            />
            <select aria-label="Summarised state" value={summarised} onChange={(e) => setSummarised(e.target.value as SummarisedFilter)}>
              <option value="all">All summarised</option>
              {SUMMARISED_ORDER.map((f) => (
                <option key={f} value={f}>
                  {SUMMARISED_LABEL[f]}
                </option>
              ))}
            </select>
          </>
        )}
        <button className="primary" data-testid="new-review" disabled={!!props.blocked} title={gate} onClick={() => setShowNew(true)}>
          New review
        </button>
        <button onClick={props.onOpenPrereq}>Prerequisites…</button>
      </header>
      <p className="muted" data-testid="review-count">
        {reviews === null ? 'Reading reviews…' : `${total} ${total === 1 ? 'review' : 'reviews'}`}
      </p>

      {reviews !== null && total === 0 && (
        <div className="empty">
          <p>No reviews yet.</p>
          <p className="muted">Create a review from the merge or pull requests of an issue.</p>
          <button className="primary" disabled={!!props.blocked} title={gate} onClick={() => setShowNew(true)}>
            New review
          </button>
        </div>
      )}

      {total > 0 && (
        <>
          <table className="reviews">
            <thead>
              <tr>
                {head('title', 'Name')}
                {head('mrs', 'Changes', true)}
                {head('issues', 'Issues', true)}
                {head('lastOpened', 'Last opened')}
                {head('summarised', 'Summarised')}
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
                  <td className={r.unreadable ? 'bad-text' : 'cut strong'} title={r.title ?? r.slug}>
                    {r.unreadable ? 'Unreadable review.json' : (r.title ?? r.slug)}
                  </td>
                  <td className="num">{r.mrCount ?? '–'}</td>
                  <td className="num">{r.issueCount ?? '–'}</td>
                  <td title={r.openedAt ?? `Last changed ${when(r.modifiedAt)}`}>
                    {r.openedAt ? when(r.openedAt) : <span className="muted">Never opened here</span>}
                  </td>
                  <td>
                    <span className={`summ ${r.summarised}`}>{SUMMARISED_LABEL[r.summarised]}</span>
                  </td>
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
              <button
                onClick={() => {
                  setFilter('')
                  setSummarised('all')
                }}
              >
                Clear filter
              </button>
            </div>
          )}
          <p className="muted" data-testid="showing">
            Showing {rows.length} of {total} {total === 1 ? 'review' : 'reviews'}
          </p>
        </>
      )}

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
          onClose={() => {
            setShowNew(false)
            setInitial(null)
          }}
          onCreated={(slug) => {
            setShowNew(false)
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
