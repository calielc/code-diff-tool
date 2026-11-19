import { useMemo, useState } from 'react'
import { parseIssueBox, parseUrlBox } from '@shared/review'
import { api } from '../api'

/** Add merge or pull requests, and issues, to the review that is open. The review is built again after the add. */
export function AddChanges(props: { slug: string; onClose: () => void; onAdded: (message: string) => void }): React.JSX.Element {
  const [urls, setUrls] = useState('')
  const [issues, setIssues] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedUrls = useMemo(() => parseUrlBox(urls), [urls])
  const parsedIssues = useMemo(() => parseIssueBox(issues), [issues])
  const problems = [...parsedUrls.errors.map((e) => e.message), ...parsedIssues.errors]
  const empty = parsedUrls.refs.length === 0 && parsedIssues.keys.length === 0

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.reviews.addTo({ slug: props.slug, urls, issues })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    const parts = [r.value.addedChanges > 0 && `${r.value.addedChanges} change(s)`, r.value.addedIssues > 0 && `${r.value.addedIssues} issue(s)`].filter(
      Boolean
    )
    props.onAdded(parts.length > 0 ? `Added ${parts.join(' and ')}.` : 'Added.')
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Add changes" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="modal">
        <header>
          <h2>Add to this review</h2>
          <button aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <label className="field">
          <strong>Code changes</strong>
          <textarea
            rows={4}
            data-testid="add-urls"
            autoFocus
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="https://gitlab.com/<group>/<repo>/-/merge_requests/<number> or https://github.com/<owner>/<repo>/pull/<number>, one per line"
          />
        </label>
        <label className="field">
          <strong>Issues</strong>
          <textarea rows={2} data-testid="add-issue-keys" value={issues} onChange={(e) => setIssues(e.target.value)} placeholder="LX-2813" />
        </label>
        {problems.map((p) => (
          <div key={p} className="bad-text small" data-testid="add-problem">
            {p}
          </div>
        ))}
        {error && (
          <div className="detail bad-text" data-testid="add-changes-error">
            {error}
          </div>
        )}
        <footer>
          <button onClick={props.onClose}>Cancel</button>
          <button className="primary" data-testid="add-changes-confirm" disabled={busy || empty || problems.length > 0} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </footer>
      </div>
    </div>
  )
}
