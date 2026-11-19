import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildProgress, BuildResult, BuildStage } from '@shared/review'
import { api } from '../api'
import { MrsScreen } from './MrsScreen'

const ICON: Record<BuildStage['state'], string> = { waiting: '○', running: '◐', done: '✓', skipped: '–', failed: '✕' }
const mmss = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function ReviewView(props: { slug: string; onHome: () => void; onOpenPrereq: () => void }): React.JSX.Element {
  const [progress, setProgress] = useState<BuildProgress | null>(null)
  const [result, setResult] = useState<BuildResult | null>(null)
  const [error, setError] = useState<{ message: string; stage: string | null } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [lastChange, setLastChange] = useState(Date.now())
  const [canceling, setCanceling] = useState(false)
  const run = useRef(0)

  const build = useCallback(async () => {
    const id = ++run.current
    setError(null)
    setResult(null)
    setCanceling(false)
    const r = await api.reviews.build(props.slug)
    if (id !== run.current) return
    if (r.ok) setResult(r.value)
    else if (r.error === 'Canceled.')
      props.onHome() // a window with no result closes after a cancel
    else setError({ message: r.error, stage: null })
  }, [props])

  useEffect(() => {
    const off = api.reviews.onBuildProgress((p) => {
      if (p.slug !== props.slug) return
      setProgress(p)
      setLastChange(Date.now())
    })
    void api.reviews.open(props.slug)
    void build()
    return () => {
      off()
      // a counter, not a node: the cleanup must bump the current value
      // eslint-disable-next-line react-hooks/exhaustive-deps
      run.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.slug])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  const cancel = async (): Promise<void> => {
    setCanceling(true)
    await api.reviews.cancelBuild(props.slug)
  }

  const failedStage = progress?.stages.find((s) => s.state === 'failed')
  const title = result?.title ?? props.slug

  if (result) return <MrsScreen result={result} slug={props.slug} onHome={props.onHome} onReload={() => void build()} />

  const needsPrereq = !!error && /authenticat|login|not found|could not start|auth/i.test(error.message)
  return (
    <div className="page build" data-testid="build">
      <h1 className="center">{title}</h1>
      <p className="center muted">Reading and diffing the changes. This takes a few seconds.</p>

      {progress && progress.queued > 0 ? (
        <p className="center" data-testid="queued">
          Waiting for another review to finish building…
          {progress.queued > 1 ? ` Position ${progress.queued} in the queue.` : ''}
        </p>
      ) : (
        progress && (
          <>
            <div className="bar" role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
              <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <ul className="stages">
              {progress.stages.map((s) => (
                <li
                  key={s.id}
                  data-testid={`stage-${s.id}`}
                  data-state={s.state}
                  className={s.state === 'failed' ? 'bad-text' : s.state === 'waiting' || s.state === 'skipped' ? 'muted' : ''}
                >
                  <span className="stageicon">{ICON[s.state]}</span>
                  <span className="grow">{s.label}</span>
                  <span className="muted">{s.state === 'skipped' ? 'skipped' : s.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {!error && progress && progress.queued === 0 && now - lastChange > 30_000 && (
        <p className="muted center">This is taking longer than usual. The forge or the network can be slow.</p>
      )}

      {error ? (
        <div className="errorpanel" data-testid="build-error">
          <strong>The review cannot be built</strong>
          <pre className="mono-box selectable">{error.message}</pre>
          <div className="actions">
            <button className="primary" onClick={() => void build()}>
              Retry
            </button>
            <button onClick={props.onHome}>Back to Home</button>
            <button onClick={() => void api.system.copyText(`${title}\nFailed stage: ${failedStage?.label ?? 'unknown'}\n${error.message}`)}>
              Copy details
            </button>
            {needsPrereq && <button onClick={props.onOpenPrereq}>Open Prerequisites</button>}
          </div>
        </div>
      ) : (
        <footer>
          <span className="muted" data-testid="elapsed">
            Elapsed {mmss(now - (progress?.startedAt ?? now))}
          </span>
          <span className="grow" />
          <button data-testid="cancel-build" disabled={canceling} onClick={() => void cancel()}>
            {canceling ? 'Canceling…' : 'Cancel'}
          </button>
        </footer>
      )}
    </div>
  )
}
