import { useState } from 'react'
import type { ChangeSnapshot } from '@shared/provider'
import { api } from '../api'

/** Hidden developer screen: reads one MR or PR by URL and shows raw details and threads (file 05 phase 2). */
export function DevReader({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snap, setSnap] = useState<ChangeSnapshot | null>(null)

  const read = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setSnap(null)
    const r = await api.dev.readChange(url.trim())
    setBusy(false)
    if (r.ok) setSnap(r.value)
    else setError(r.error)
  }

  return (
    <div className="page">
      <header>
        <h1>Developer: read a change</h1>
        <button onClick={onClose}>Close</button>
      </header>
      <p className="muted">Paste a GitLab merge request URL or a GitHub pull request URL.</p>
      <div className="actions">
        <input
          data-testid="dev-url"
          className="grow"
          value={url}
          placeholder="https://gitlab.com/group/project/-/merge_requests/1"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && void read()}
        />
        <button data-testid="dev-read" className="primary" disabled={busy || !url.trim()} onClick={() => void read()}>
          {busy ? 'Reading…' : 'Read'}
        </button>
      </div>
      {error && (
        <div className="detail bad-text" data-testid="dev-error">
          {error}
        </div>
      )}
      {snap && (
        <>
          <h3 data-testid="dev-title">
            {snap.info.title} <span className="pill">{snap.info.ref.provider}</span> <span className="pill">{snap.info.state}</span>
          </h3>
          <p className="muted">
            {snap.threads.length} threads · {snap.approvals.approvedBy.length} approvals · {snap.jobs.length} jobs · viewer {snap.viewer}
          </p>
          <pre className="raw" data-testid="dev-raw">
            {JSON.stringify(snap, null, 2)}
          </pre>
        </>
      )}
    </div>
  )
}
