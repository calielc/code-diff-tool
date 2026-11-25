import { useState } from 'react'
import type { UrlSubmitInput } from '@shared/comments'
import type { BuiltMr } from '@shared/review'
import type { Result } from '@shared/types'
import { api } from '../api'
import { useOptionalReview } from './review-context'

type Decision = 'comment' | 'approve' | 'changes'

/** The open changes the viewer did not write can take a review (file 02 section 11). */
export const reviewable = (mrs: BuiltMr[], viewer: string): BuiltMr[] =>
  mrs.filter((m) => m.snapshot.info.state === 'opened' && m.snapshot.info.author !== viewer)

type DialogMr = Pick<BuiltMr, 'key' | 'snapshot'>

/**
 * In a review the dialog sends the review keys to the review channel and reloads the review. On the home lists the caller gives `submit`, which gets the
 * change urls as keys, and `onDone`, which runs after a successful submit.
 */
export function SubmitDialog(props: {
  mrs: DialogMr[]
  onClose(): void
  submit?: (req: UrlSubmitInput) => Promise<Result<Record<string, string>>>
  onDone?: () => void
}): React.JSX.Element {
  const r = useOptionalReview()
  const [text, setText] = useState<Record<string, string>>({})
  const [decision, setDecision] = useState<Record<string, Decision>>({})
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const choice = (k: string): Decision => decision[k] ?? 'comment'
  const needsText = (k: string): boolean => choice(k) === 'changes' && !(text[k] ?? '').trim()

  const submit = async (): Promise<void> => {
    setAttempted(true)
    setBanner(null)
    const keys = props.mrs.map((m) => m.key)
    if (keys.some(needsText)) return // nothing is sent
    const summaries = Object.fromEntries(keys.map((k) => [k, (text[k] ?? '').trim()]).filter(([, t]) => t))
    const approve = keys.filter((k) => choice(k) === 'approve')
    const requestChanges = keys.filter((k) => choice(k) === 'changes')
    if (approve.length === 0 && requestChanges.length === 0 && Object.keys(summaries).length === 0) return props.onClose()
    setBusy(true)
    const request = { approve, unapprove: [], requestChanges, summaries, ready: [], draft: [] }
    const res = await (props.submit ? props.submit(request) : api.review.submit({ slug: r!.slug, ...request }))
    setBusy(false)
    if (!res.ok) return setBanner(`Could not submit: ${res.error}. Check the changes on the forge before you submit again.`)
    const failed = Object.entries(res.value)
    if (failed.length > 0) {
      const iidOf = (key: string): number | undefined => props.mrs.find((m) => m.key === key)?.snapshot.info.ref.iid
      setBanner(`Not posted: ${failed.map(([k, e]) => `!${iidOf(k)}: ${e}`).join('; ')}. The other changes were posted.`)
      return
    }
    // read the changes again, so they show as the forge has them now
    if (props.onDone) props.onDone()
    else r?.reload()
    props.onClose()
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Submit review">
      <div className="modal">
        <header>
          <h2>Submit review</h2>
        </header>
        <div className="body">
          {banner && (
            <div className="banner warn" data-testid="submit-banner">
              {banner}
            </div>
          )}
          {props.mrs.map((m, i) => {
            const iid = m.snapshot.info.ref.iid
            const info = m.snapshot.info
            const approveWhy =
              info.state !== 'opened'
                ? "Not open, so it can't be approved"
                : m.snapshot.approvals.userHasApproved
                  ? 'Already approved by you'
                  : !m.snapshot.approvals.userCanApprove
                    ? "You can't approve this"
                    : null
            return (
              <fieldset key={m.key} className="mrblock">
                <div>
                  <strong>!{iid}</strong> {info.title}
                </div>
                <textarea
                  aria-label={`Overall comment for !${iid}`}
                  autoFocus={i === 0}
                  rows={3}
                  placeholder={`Overall comment for !${iid} (optional, required to request changes)`}
                  value={text[m.key] ?? ''}
                  onChange={(e) => setText({ ...text, [m.key]: e.target.value })}
                />
                <div role="radiogroup" aria-label={`Decision for !${iid}`} className="radios">
                  {(
                    [
                      ['comment', 'Comment', null],
                      ['approve', 'Approve', approveWhy],
                      ['changes', 'Request changes', info.state !== 'opened' ? 'Not open' : null]
                    ] as [Decision, string, string | null][]
                  ).map(([id, label, why]) => (
                    <label key={id} title={why ?? undefined} className={why ? 'disabled' : ''}>
                      <input
                        type="radio"
                        name={`d-${m.key}`}
                        checked={choice(m.key) === id}
                        disabled={!!why}
                        onChange={() => setDecision({ ...decision, [m.key]: id })}
                      />{' '}
                      {label}
                    </label>
                  ))}
                </div>
                {attempted && needsText(m.key) && <div className="bad-text small">Requesting changes needs an overall comment.</div>}
              </fieldset>
            )
          })}
          <p className="muted small">
            Submitting adds the overall comments, and approves or requests changes as you chose per change, under your own account. It posts at once, from this
            app. Your line and file comments are already posted.
          </p>
        </div>
        <footer>
          <span className="grow" />
          <button onClick={props.onClose}>Cancel</button>
          <button className="primary" data-testid="submit-review" disabled={busy} onClick={() => void submit()}>
            Submit review
          </button>
        </footer>
      </div>
    </div>
  )
}
