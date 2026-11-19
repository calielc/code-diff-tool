import { useEffect, useMemo, useState } from 'react'
import { descriptionPreview, initialsOf, sortIssues, type IssueRow, type IssueSortKey } from '@shared/issues'
import { api } from '../api'
import { useReview } from './review-context'
import { Markdown } from './ui'

type Sort = { key: IssueSortKey; dir: 'asc' | 'desc' } | null

const COLUMNS: { key: IssueSortKey; label: string; header: string }[] = [
  { key: 'key', label: 'issue', header: 'Issue' },
  { key: 'type', label: 'type', header: 'Type' },
  { key: 'title', label: 'title', header: 'Title' },
  { key: 'status', label: 'status', header: 'Status' },
  { key: 'assignee', label: 'assignee', header: 'Assignee' },
  { key: 'acs', label: 'acs', header: 'ACs' },
  { key: 'description', label: 'description', header: 'Description' }
]

function loadSort(): Sort {
  try {
    const v = JSON.parse(localStorage.getItem('codediff:issueSort') ?? 'null') as Sort
    return v && COLUMNS.some((c) => c.key === v.key) && (v.dir === 'asc' || v.dir === 'desc') ? v : null
  } catch {
    return null
  }
}

export function IssuesTab(): React.JSX.Element {
  const r = useReview()
  const rows = r.data.issues
  const [sort, setSort] = useState<Sort>(loadSort)
  const [selected, setSelected] = useState<string | null>(null)
  // The file of each issue is asked for once and kept until the review is built again.
  const [files, setFiles] = useState<Record<string, { state: 'waiting' | 'ready' | 'error'; text: string }>>({})

  useEffect(() => {
    try {
      localStorage.setItem('codediff:issueSort', JSON.stringify(sort))
    } catch {
      /* storage can be blocked */
    }
  }, [sort])

  const sorted = useMemo(() => sortIssues(rows, sort?.key ?? null, sort?.dir ?? 'asc'), [rows, sort])
  useEffect(() => {
    if (!selected || !rows.some((t) => t.key === selected)) setSelected(sorted[0]?.key ?? null) // the first row stays selected until another is picked
  }, [rows, sorted, selected])

  useEffect(() => {
    setFiles({})
  }, [r.data])

  useEffect(() => {
    if (!selected || files[selected]) return
    const key = selected
    setFiles((f) => ({ ...f, [key]: { state: 'waiting', text: '' } }))
    void api.issues
      .getFile(r.slug, key)
      .then((res) => setFiles((f) => ({ ...f, [key]: res.ok ? { state: 'ready', text: res.value } : { state: 'error', text: res.error } })))
  }, [selected, files, r.slug])

  const failed = rows.filter((t) => t.error).length
  const total = rows.reduce((n, t) => n + (t.error ? 0 : t.criteria.length), 0)
  const summary =
    rows.length === 0
      ? 'No issue yet'
      : `${rows.length} ${rows.length === 1 ? 'issue' : 'issues'} · ${total} acceptance criteria${failed > 0 ? `, ${failed} Jira did not give` : ''}`

  const clickHeader = (key: IssueSortKey): void =>
    setSort((s) => (!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' }))

  const keyCell = (t: IssueRow): React.JSX.Element =>
    t.url ? (
      <a className="mono strong" href={t.url} onClick={(e) => (e.preventDefault(), e.stopPropagation(), void api.system.openExternal(t.url!))}>
        {t.key}
      </a>
    ) : (
      <span className="mono strong">{t.key}</span>
    )

  const file = selected ? files[selected] : undefined
  return (
    <div className="issues" data-testid="issues-tab">
      <p>
        <strong>Jira issues</strong>{' '}
        <span className="muted" data-testid="issues-summary">
          {summary}
        </span>
      </p>
      <table className="reviews">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={c.key === 'acs' ? 'num' : ''}
              >
                <button className="link" title={`Sort by ${c.label}`} onClick={() => clickHeader(c.key)}>
                  {c.header}
                  {sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                This review names no Jira issue. Add one below.
              </td>
            </tr>
          )}
          {sorted.map((t) => (
            <tr
              key={t.key}
              data-testid={`issue-${t.key}`}
              tabIndex={0}
              aria-selected={t.key === selected}
              className={t.key === selected ? 'selected' : ''}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelected(t.key)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(t.key))}
            >
              <td>{keyCell(t)}</td>
              {t.error ? (
                <td colSpan={6} className="bad-text">
                  {t.source === 'file' ? 'This spec file cannot be read' : 'Jira did not give this issue'}: {t.error}
                </td>
              ) : (
                <>
                  <td className="mono muted">{t.type ?? '–'}</td>
                  <td>{t.title}</td>
                  <td>{t.status ? <span className="pill">{t.status}</span> : '–'}</td>
                  <td>
                    {t.assignee ? (
                      <span className="avatar" title={t.assignee}>
                        {initialsOf(t.assignee)}
                      </span>
                    ) : (
                      <span className="muted">Unassigned</span>
                    )}
                  </td>
                  <td className="num mono muted">{t.criteria.length}</td>
                  <td className="muted small preview">{t.description ? descriptionPreview(t.description) : 'No description'}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length > 0 && (
        <div className="issuedetail" data-testid="issue-detail">
          {!file || file.state === 'waiting' ? (
            <p className="muted">Reading {selected}…</p>
          ) : file.state === 'error' ? (
            <p className="bad-text">{file.text}</p>
          ) : (
            <Markdown text={file.text} />
          )}
        </div>
      )}
      <AddIssues onAdded={r.reload} slug={r.slug} />
    </div>
  )
}

function AddIssues(props: { slug: string; onAdded(): void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [added, setAdded] = useState(false)

  const submit = async (): Promise<void> => {
    const values = text.split(/[\s,]+/).filter(Boolean)
    setProblems([])
    setAdded(false)
    if (values.length === 0) return setStatus({ text: 'Paste one or more Jira issue keys or URLs first.' })
    setBusy(true)
    setStatus({ text: `Checking ${values.length} issue${values.length === 1 ? '' : 's'}…` })
    const r = await api.issues.add(props.slug, values)
    setBusy(false)
    if (!r.ok) return setStatus({ text: r.error, bad: true })
    const { added: keys, problems: probs } = r.value
    const refused = Object.keys(probs)
    if (keys.length > 0 && refused.length === 0) {
      setStatus({ text: `Added ${keys.join(', ')}. Rebuilding the review…` })
      setText('')
      props.onAdded()
      return
    }
    setStatus(keys.length > 0 ? { text: `Added ${keys.join(', ')}. ` } : null)
    setAdded(keys.length > 0)
    setProblems(refused.map((v) => `${v}: ${probs[v]}`))
    setText(refused.join(' ')) // the input now holds the refused values, so they can be fixed
  }

  return (
    <form className="addissues" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <input
        aria-label="Jira issues to add"
        className="mono grow"
        placeholder="Paste Jira issue keys or URLs to add them to this review"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy}>
        Add issues
      </button>
      {status && (
        <span className={status.bad ? 'bad-text small' : 'muted small'} data-testid="add-status">
          {status.text}
        </span>
      )}
      <button
        type="button"
        data-testid="add-spec-files"
        onClick={async () => {
          const picked = await api.issues.pickFiles()
          if (!picked) return
          setBusy(true)
          setProblems([])
          setStatus({ text: `Adding ${picked.names.length} ${picked.names.length === 1 ? 'file' : 'files'}…` })
          const r = await api.issues.addFiles(props.slug, picked.pick)
          setBusy(false)
          if (!r.ok) return setStatus({ text: r.error, bad: true })
          const refused = Object.entries(r.value.problems).map(([n, why]) => `${n}: ${why}`)
          setProblems(refused)
          if (r.value.added.length > 0 && refused.length === 0) {
            setStatus({ text: `Added ${r.value.added.join(', ')}. Rebuilding the review…` })
            props.onAdded()
          } else {
            setStatus(r.value.added.length > 0 ? { text: `Added ${r.value.added.join(', ')}. ` } : null)
            setAdded(r.value.added.length > 0)
          }
        }}
      >
        Add spec files…
      </button>
      {added && (
        <button type="button" onClick={props.onAdded}>
          Reload to see them
        </button>
      )}
      {problems.map((p) => (
        <div key={p} className="bad-text small" data-testid="add-problem">
          {p}
        </div>
      ))}
    </form>
  )
}
