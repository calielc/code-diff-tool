import { useEffect, useMemo, useState } from 'react'
import { MAX_ISSUES, MAX_URLS, parseIssueBox, parseUrlBox, slugFromName, suggestReviewName, type CheckResult } from '@shared/review'
import type { LaunchRequest } from '@shared/launch'
import { api } from '../api'

export function NewReview(props: {
  initial?: LaunchRequest | null
  /** True when the form runs the check at once, as for a request from outside the app. Changes that the reviewer ticked wait for the reviewer. */
  autoCheck?: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}): React.JSX.Element {
  const [urls, setUrls] = useState(() => props.initial?.mrs.join('\n') ?? '')
  const [issues, setIssues] = useState(() => props.initial?.issues.join('\n') ?? '')
  // Spec files picked in the dialog: a token for the main process, and the names to show.
  const [specs, setSpecs] = useState<{ pick: string; names: string[] } | null>(null)
  const [fileProblems, setFileProblems] = useState<{ slug: string; list: string[] } | null>(null)
  const [name, setName] = useState(() => {
    const initial = props.initial
    if (!initial) {
      return ''
    }
    return (
      initial.title ||
      initial.review ||
      suggestReviewName({ issueKeys: parseIssueBox(initial.issues.join('\n')).keys, refs: parseUrlBox(initial.mrs.join('\n')).refs })
    )
  })
  const [existing, setExisting] = useState<string[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<CheckResult | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const parsedUrls = useMemo(() => parseUrlBox(urls), [urls])
  const parsedIssues = useMemo(() => parseIssueBox(issues), [issues])

  // Field messages. An empty field shows its message only after a press of "Check".
  const urlMessages: string[] = [...parsedUrls.errors.map((e) => e.message)]
  if (submitted && urls.trim() === '') urlMessages.push('Enter at least one merge request or pull request URL.')
  if (parsedUrls.refs.length > MAX_URLS) urlMessages.push(`Send 1 to ${MAX_URLS} URLs.`)
  const issueMessages: string[] = [...parsedIssues.errors]
  if (parsedIssues.keys.length > MAX_ISSUES) issueMessages.push(`Send 1 to ${MAX_ISSUES} issue keys or URLs.`)
  const suggested = suggestReviewName({ issueKeys: parsedIssues.keys, refs: parsedUrls.refs })
  const effectiveName = name.trim() || suggested
  const slug = slugFromName(effectiveName, existing)
  const hasFieldError = urlMessages.length > 0 || issueMessages.length > 0 || effectiveName === '' || urls.trim() === ''

  const dirty = urls.trim() !== '' || issues.trim() !== '' || name.trim() !== ''
  const close = (): void => (dirty && !checked ? setConfirmDiscard(true) : props.onClose())

  const check = async (taken: string[] = existing): Promise<void> => {
    setSubmitted(true)
    setError(null)
    if (hasFieldError) return
    setBusy(true)
    const r = await api.reviews.check({ urls, issues, slug: slugFromName(effectiveName, taken) })
    setBusy(false)
    if (r.ok) setChecked(r.value)
    else setError(r.error)
  }

  // The slug of a new review is free among the reviews that exist. A request from outside the app then runs the check at once, and leaves Create to the reviewer. Ticked changes only fill the form, so the reviewer can add a name and issues first.
  useEffect(() => {
    void api.reviews.list().then((list) => {
      const taken = list.map((r) => r.slug)
      setExisting(taken)
      if (props.initial && props.autoCheck) void check(taken)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.reviews.create({ urls, issues, slug, title: effectiveName, overwrite: false, pick: specs?.pick })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    const refused = Object.entries(r.value.problems).map(([name, why]) => `${name}: ${why}`)
    // A refused file is shown before the review opens, so it is not lost silently.
    if (refused.length > 0) setFileProblems({ slug: r.value.slug, list: refused })
    else props.onCreated(r.value.slug)
  }

  // Enter runs the next step. Shift, Ctrl, Alt or Cmd with Enter adds a new line. The keys never reach the page behind the dialog.
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return close()
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const target = e.target as HTMLElement
    if (target.tagName === 'BUTTON') return
    e.stopPropagation()
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
      if (target instanceof HTMLTextAreaElement) {
        e.preventDefault()
        target.setRangeText('\n', target.selectionStart, target.selectionEnd, 'end')
        target.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return
    }
    e.preventDefault()
    if (busy) return
    if (checked) void create()
    else void check()
  }

  const included = checked?.mrs.filter((m) => !m.skipped).length ?? 0
  const skipped = (checked?.mrs.length ?? 0) - included

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="New review" onKeyDown={onKey}>
      <div className="modal">
        <header>
          <h2>New review</h2>
          <button aria-label="Close" onClick={close}>
            ×
          </button>
        </header>

        {!checked ? (
          <div className="body">
            <label className="field">
              <strong>Name</strong>
              <input
                autoFocus
                data-testid="name"
                value={name}
                placeholder={suggested ? `Defaults to ${suggested}` : 'Name of the review'}
                onChange={(e) => setName(e.target.value)}
              />
              {submitted && effectiveName === '' && (
                <span className="bad-text" data-testid="name-error">
                  Enter a name, or add an issue or a change.
                </span>
              )}
            </label>

            <label className="field">
              <strong>Jira issues (optional)</strong>
              <textarea rows={2} data-testid="issues" value={issues} placeholder="LX-2813" onChange={(e) => setIssues(e.target.value)} />
              <span className="muted">A key such as LX-2813, or a Jira URL. One per line.</span>
              <span className="specrow">
                <button type="button" data-testid="pick-specs" onClick={async (e) => (e.preventDefault(), setSpecs(await api.issues.pickFiles()))}>
                  Add spec files…
                </button>
                {specs ? (
                  <span className="small" data-testid="spec-names">
                    {specs.names.join(', ')}{' '}
                    <button type="button" className="link" onClick={() => setSpecs(null)}>
                      Clear
                    </button>
                  </span>
                ) : (
                  <span className="muted small">A .md, .txt or .html file with the spec. It counts as an issue.</span>
                )}
              </span>
              {parsedIssues.merged > 0 && <span className="muted">{parsedIssues.merged} merged into the same key.</span>}
              {issueMessages.map((m) => (
                <span key={m} className="bad-text">
                  {m}
                </span>
              ))}
            </label>

            <label className="field">
              <span className="labelrow">
                <strong>Code changes</strong>
                <span className={parsedUrls.refs.length > MAX_URLS ? 'bad-text' : 'muted'}>
                  {parsedUrls.refs.length} of {MAX_URLS}
                </span>
              </span>
              <textarea
                data-testid="urls"
                rows={4}
                value={urls}
                placeholder="https://gitlab.com/<group>/<repo>/-/merge_requests/<number> or https://github.com/<owner>/<repo>/pull/<number>"
                onChange={(e) => setUrls(e.target.value)}
              />
              <span className="muted">One URL per line.</span>
              {parsedUrls.duplicates > 0 && (
                <span className="muted">
                  {parsedUrls.duplicates} {parsedUrls.duplicates === 1 ? 'duplicate' : 'duplicates'} ignored.
                </span>
              )}
              {urlMessages.map((m) => (
                <span key={m} className="bad-text" data-testid="url-error">
                  {m}
                </span>
              ))}
            </label>

            {error && (
              <div className="detail bad-text" data-testid="check-error">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="body">
            <ul className="checklist mono" data-testid="check-list">
              {checked.mrs.map((m) => (
                <li key={m.key} className={m.skipped ? 'muted' : ''}>
                  <span className={m.skipped ? '' : 'ok-text'}>{m.skipped ? '–' : '✓'}</span>{' '}
                  {m.skipped ? `${m.key} (skipped: ${m.skipped})` : `${m.key} (${m.state}${m.draft ? ', draft' : ''})`} {m.title}
                </li>
              ))}
            </ul>
            <p data-testid="check-summary">
              {included} {included === 1 ? 'change' : 'changes'} will be in the review, {skipped} skipped.
            </p>
            {error && <div className="detail bad-text">{error}</div>}
          </div>
        )}

        {fileProblems && (
          <div className="banner warn" data-testid="file-problems">
            The review was created. These files were not added:
            {fileProblems.list.map((p) => (
              <div key={p}>{p}</div>
            ))}
            <button onClick={() => props.onCreated(fileProblems.slug)}>Open the review</button>
          </div>
        )}
        <footer>
          <span className="grow" />
          <button onClick={checked ? () => setChecked(null) : close}>{checked ? 'Back' : 'Cancel'}</button>
          {!checked ? (
            <button className="primary" data-testid="check" disabled={busy || parsedUrls.refs.length > MAX_URLS} onClick={() => void check()}>
              {busy ? `Reading ${parsedUrls.refs.length}…` : 'Check'}
            </button>
          ) : (
            <button className="primary" data-testid="create" disabled={busy} onClick={() => void create()}>
              Create and open
            </button>
          )}
        </footer>

        {confirmDiscard && (
          <div className="modal-back inner" role="dialog" aria-label="Discard this review?">
            <div className="modal narrow">
              <h2>Discard this review?</h2>
              <footer>
                <span className="grow" />
                <button autoFocus onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </button>
                <button className="danger" onClick={props.onClose}>
                  Discard
                </button>
              </footer>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
