import { useMemo, useState } from 'react'
import { parseUrlBox } from '@shared/review'
import { api } from '../api'

/** The row at the bottom of the Code changes tab: paste merge or pull request URLs and add them to the open review. */
export function AddChanges(props: { slug: string; onAdded: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = useMemo(() => parseUrlBox(text), [text])
  const problem = parsed.errors[0]?.message ?? null
  const empty = parsed.refs.length === 0

  const add = async (): Promise<void> => {
    if (empty || problem) return
    setBusy(true)
    setError(null)
    const r = await api.reviews.addTo({ slug: props.slug, urls: text, issues: '' })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setText('')
    props.onAdded() // the review is built again with what it holds now. Unsent comments are drafts on disk, so they stay.
  }

  return (
    <form className="addissues" data-testid="add-changes-form" onSubmit={(e) => (e.preventDefault(), void add())}>
      <input
        aria-label="Merge or pull requests to add"
        data-testid="add-urls"
        className="mono grow"
        placeholder="Paste merge request or pull request URLs to add them to this review"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="primary" data-testid="add-changes-confirm" disabled={busy || empty || problem !== null}>
        {busy ? 'Adding…' : 'Add changes'}
      </button>
      {(problem || error) && (
        <span className="bad-text small" data-testid={problem ? 'add-problem' : 'add-changes-error'}>
          {problem ?? error}
        </span>
      )}
    </form>
  )
}
