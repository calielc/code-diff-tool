import { useEffect, useRef, useState } from 'react'
import type { PendingComment } from '@shared/comments'
import type { Thread } from '@shared/provider'
import { api } from '../api'
import { useReview } from './review-context'
import { Avatar, Markdown, formatDate } from './ui'

/** The comment editor row (file 02 section 7). Ctrl+Enter posts. A failed post keeps the text. */
export function CommentForm(props: {
  hint?: string
  select?: { label: string; options: { value: string; label: string }[]; value: string; onChange(v: string): void }
  initial?: string
  submitLabel: 'Comment' | 'Save'
  onSubmit(text: string): Promise<string | null>
  /** When set, the form also offers to keep the text as a draft that is posted later. */
  onSaveDraft?(text: string): Promise<string | null>
  onCancel(): void
}): React.JSX.Element {
  const [text, setText] = useState(props.initial ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const submit = async (asDraft = false): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || busy) return // an empty text does nothing
    setBusy(true)
    setError(null)
    const err = await (asDraft && props.onSaveDraft ? props.onSaveDraft(trimmed) : props.onSubmit(trimmed))
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <form className="commentform" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <textarea
        ref={ref}
        aria-label="Comment"
        rows={4}
        value={text}
        placeholder="Write a comment (Markdown). Ctrl+Enter posts it."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape') props.onCancel()
        }}
      />
      {error && (
        <div className="banner warn" data-testid="post-error">
          Not posted: {error}
        </div>
      )}
      <div className="formrow">
        {props.select ? (
          <label className="muted small">
            {props.select.label}{' '}
            <select value={props.select.value} onChange={(e) => props.select!.onChange(e.target.value)}>
              {props.select.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="muted small grow">{props.hint}</span>
        )}
        <span className="grow" />
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        {props.onSaveDraft && (
          <button type="button" data-testid="save-draft" disabled={busy} title="Keeps it in the review. You post it later." onClick={() => void submit(true)}>
            Save draft
          </button>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {props.submitLabel}
        </button>
      </div>
    </form>
  )
}

/** One GitLab or GitHub thread, as a collapsible box (file 02 section 8.2). */
export function ThreadCard(props: { mrKey: string; thread: Thread; mrOpen: boolean }): React.JSX.Element {
  const r = useReview()
  const { thread } = props
  const [open, setOpen] = useState(!thread.resolved) // a resolved thread starts closed
  const [busy, setBusy] = useState<null | 'resolve' | 'delete'>(null)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const first = thread.notes[0]
  const last = thread.notes[thread.notes.length - 1]
  const snippet = first.body.replace(/\s+/g, ' ').slice(0, 140)
  const replies = thread.notes.length - 1

  const toggleResolved = async (): Promise<void> => {
    setBusy('resolve')
    setError(null)
    const next = !thread.resolved
    const err = await r.resolve(props.mrKey, thread.id, next)
    setBusy(null)
    if (err) return setError(err)
    r.setThreadResolved(props.mrKey, thread.id, next)
    setOpen(!next) // a resolved thread folds, a reopened one opens
  }

  const del = async (): Promise<void> => {
    setBusy('delete')
    setError(null)
    const err = await r.deleteNote(props.mrKey, last.id)
    setBusy(null)
    if (err) {
      setError(`Not deleted: ${err}`)
      setConfirm(false)
    }
  }

  return (
    <div className="thread" data-testid="thread" data-resolved={thread.resolved}>
      <button className="threadsum" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'}</span>
        <Avatar user={first.author} people={r.people} viewer={r.viewer} />
        <span className="snippet">{snippet}</span>
        {replies > 0 && (
          <span className="muted small">
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {thread.resolvable && <span className={`chip ${thread.resolved ? 'resolved' : 'openchip'}`}>{thread.resolved ? 'Resolved' : 'Open'}</span>}
      </button>
      {open && (
        <div className="threadbody">
          {thread.notes.map((n) => (
            <div key={n.id} className="note">
              <div className="notehead">
                <Avatar user={n.author} people={r.people} viewer={r.viewer} />
                <span className="muted small">{formatDate(n.createdAt)}</span>
              </div>
              <Markdown text={n.body} />
            </div>
          ))}
          <div className="threadfoot">
            {thread.resolvable && props.mrOpen && (
              <button disabled={busy !== null} onClick={() => void toggleResolved()}>
                {busy === 'resolve' ? (thread.resolved ? 'Unresolving…' : 'Resolving…') : thread.resolved ? 'Unresolve thread' : 'Resolve thread'}
              </button>
            )}
            <a href={thread.url} onClick={(e) => (e.preventDefault(), void api.system.openExternal(thread.url))}>
              Open thread
            </a>
            <span className="grow" />
            {last.author === r.viewer &&
              (confirm ? (
                <>
                  <button onClick={() => setConfirm(false)}>Cancel</button>
                  <button autoFocus className="danger" title="It cannot be brought back" disabled={busy !== null} onClick={() => void del()}>
                    {busy === 'delete' ? 'Deleting…' : 'Confirm delete'}
                  </button>
                </>
              ) : (
                <button title="Deletes your last comment in this thread" onClick={() => setConfirm(true)}>
                  Delete
                </button>
              ))}
          </div>
          {error && <div className="bad-text small">{error}</div>}
        </div>
      )}
    </div>
  )
}

/** A pending comment (draft) that is not posted yet (file 02 section 7.6). */
export function DraftCard(props: { draft: PendingComment }): React.JSX.Element {
  const r = useReview()
  const d = props.draft
  const [editing, setEditing] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const iid = d.mr.slice(d.mr.lastIndexOf('!') + 1)
  const where = d.path === null ? ' · on the MR' : d.oldLine === null && d.newLine === null ? ` · general comment on ${d.path}` : ''

  if (editing) {
    return (
      <CommentForm
        initial={d.body}
        submitLabel="Save"
        hint={`Goes to !${iid}`}
        onCancel={() => setEditing(false)}
        onSubmit={async (text) => {
          await r.saveDraft({ ...d, body: text })
          setEditing(false)
          return null
        }}
      />
    )
  }
  return (
    <div className={`draft ${d.claude?.severity === 'blocking' ? 'blocking' : ''}`} data-testid="draft">
      <div className="notehead">
        <strong>{d.claude ? 'Claude' : 'You'}</strong>
        <span className="pill">Draft, not posted</span>
        {d.claude && (
          <span className={`tag ${d.claude.severity === 'blocking' ? 'red' : ''}`}>
            {[d.claude.skill, d.claude.lens, d.claude.severity].filter(Boolean).join(' · ')}
          </span>
        )}
        <span className="grow" />
        <span className="muted small">
          !{iid}
          {where}
        </span>
      </div>
      <Markdown text={d.body} />
      <div className="threadfoot">
        <button disabled={posting} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button disabled={posting} onClick={() => void r.removeDraft(d.id)}>
          Delete
        </button>
        <button
          className="primary"
          disabled={posting}
          title="Posts this comment now"
          onClick={async () => {
            setPosting(true)
            setError(null)
            const err = await r.post(d, true)
            setPosting(false)
            if (err) setError(err)
          }}
        >
          {posting ? 'Posting…' : 'Post comment'}
        </button>
      </div>
      {error && <div className="bad-text small">Not posted: {error}</div>}
    </div>
  )
}
