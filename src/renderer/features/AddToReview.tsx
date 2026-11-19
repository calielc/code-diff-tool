import { useState } from 'react'
import type { LaunchRequest } from '@shared/launch'
import { api } from '../api'

/** A request from outside the app names an existing review: show what it brings, and add it when the reviewer agrees. */
export function AddToReview(props: { request: LaunchRequest; onClose: () => void; onDone: (slug: string) => void }): React.JSX.Element {
  const { request } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.reviews.addTo({ slug: request.review, urls: request.mrs.join('\n'), issues: request.issues.join('\n') })
    setBusy(false)
    if (r.ok) props.onDone(r.value.slug)
    else setError(r.error)
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Add to review" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="modal">
        <header>
          <h2>
            Add to review <span className="mono">{request.review}</span>
          </h2>
          <button aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <p className="muted">Another program asked to add these to an existing review. What the review holds now stays.</p>
        {request.mrs.length > 0 && (
          <>
            <strong>Changes</strong>
            <ul className="mono small" data-testid="add-changes">
              {request.mrs.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </>
        )}
        {request.issues.length > 0 && (
          <>
            <strong>Issues</strong>
            <ul className="mono small" data-testid="add-issues">
              {request.issues.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <div className="detail bad-text" data-testid="add-error">
            {error}
          </div>
        )}
        <footer>
          <button onClick={props.onClose}>Cancel</button>
          <button className="primary" data-testid="add-confirm" disabled={busy} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add and open'}
          </button>
        </footer>
      </div>
    </div>
  )
}
