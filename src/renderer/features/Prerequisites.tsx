import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrereqRow, RowState, ToolStatus } from '@shared/types'
import { TOOL_NAMES, type LlmConfig, type ToolId } from '@shared/llm'
import { api } from '../api'
import { tokenHelp } from '@shared/token-help'

const ICON: Record<RowState | 'checking', { glyph: string; cls: string }> = {
  ready: { glyph: '✓', cls: 'ok' },
  missing: { glyph: '✕', cls: 'bad' },
  'too-old': { glyph: '✕', cls: 'bad' },
  'needs-login': { glyph: '!', cls: 'warn' },
  'not-set-up': { glyph: '!', cls: 'warn' },
  checking: { glyph: '…', cls: 'muted' }
}

const WORD: Record<RowState, string> = {
  ready: 'Ready',
  missing: 'Missing',
  'too-old': 'Too old',
  'needs-login': 'Needs login',
  'not-set-up': 'Not set up'
}

function CommandBox({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="cmd">
      <pre>{command}</pre>
      <button
        onClick={() => {
          void api.system.copyText(command) // copies only, never runs
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Row({ row, checking, children }: { row: PrereqRow; checking: boolean; children?: React.ReactNode }): React.JSX.Element {
  const icon = ICON[checking ? 'checking' : row.state]
  return (
    <div className="row" data-testid={`row-${row.id}`}>
      <span className={`icon ${icon.cls}`}>{icon.glyph}</span>
      <div className="grow">
        <div className="rowhead">
          <strong>{row.name}</strong>
          <span className="pill">{row.required ? 'Required' : row.forge ? 'One of GitLab or GitHub' : 'Optional'}</span>
          <span className="state">{checking ? 'Checking' : WORD[row.state]}</span>
        </div>
        {!checking && (
          <>
            <div className="detail">{row.detail}</div>
            {row.note && <div className="note">{row.note}</div>}
            {row.fixCommand && <CommandBox command={row.fixCommand} />}
          </>
        )}
        {children}
      </div>
    </div>
  )
}

export function Prerequisites(props: { onDone: () => void; onContinueAnyway: () => void; atStart: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<ToolStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const last = useRef(0)
  const latest = useRef(0)

  // Only the newest check may change the screen, so a slow older one cannot overwrite a newer result. `fresh: false` reuses a recent scan of the workspace.
  const check = useCallback(async (fresh = true) => {
    const mine = ++latest.current
    last.current = Date.now()
    setChecking(true)
    try {
      const result = await api.app.checkTools(fresh)
      if (mine === latest.current) setStatus(result)
    } finally {
      if (mine === latest.current) {
        last.current = Date.now()
        setChecking(false)
      }
    }
  }, [])

  useEffect(() => {
    void check()
    void api.app.findRootCandidate().then(setCandidate)
  }, [check])

  // Check again when the window gets focus, at most once every 2 seconds (file 07 section 3.5).
  useEffect(() => {
    const onFocus = (): void => {
      if (Date.now() - last.current >= 2000) void check(false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [check])

  const chooseRoot = async (): Promise<void> => {
    const r = await api.app.chooseRoot()
    if (!r) return
    setRootError(r.ok ? null : r.error)
    if (r.ok) await check()
  }
  const applyCandidate = async (): Promise<void> => {
    if (!candidate) return
    const r = await api.app.setRoot(candidate)
    setRootError(r.ok ? null : r.error)
    if (r.ok) await check()
  }

  const rows = status?.rows ?? []
  // A re-check keeps the rows and their forms on screen, so typed text and open panels survive it.
  const firstCheck = checking && status === null
  return (
    <div className="page">
      <header>
        <h1>Prerequisites</h1>
        <button data-testid="check-again" disabled={checking} onClick={() => void check()}>
          Check again
        </button>
      </header>
      <p className="muted">The app needs these tools. Items marked Required must be ready.</p>

      {rows.map((row) => (
        <Row key={row.id} row={row} checking={firstCheck}>
          {row.access && !firstCheck && <AccessForm row={row} onChanged={() => void check()} />}
          {row.ai && !firstCheck && <AiToolForm row={row} onChanged={() => void check()} />}
          {row.id === 'root' && !firstCheck && (
            <div className="actions">
              {row.state !== 'ready' && candidate && <button onClick={() => void applyCandidate()}>Use this folder ({candidate})</button>}
              <button onClick={() => void chooseRoot()}>{row.state === 'ready' ? 'Change folder…' : 'Choose folder…'}</button>
              {rootError && <div className="detail bad-text">{rootError}</div>}
            </div>
          )}
        </Row>
      ))}

      <footer>
        {props.atStart && !status?.ready && !checking && (
          <button data-testid="continue-anyway" onClick={props.onContinueAnyway}>
            Continue anyway
          </button>
        )}
        <span className="grow" />
        <button className="primary" data-testid="done" disabled={checking || !status?.ready} onClick={props.onDone}>
          Done
        </button>
      </footer>
    </div>
  )
}

/** The saved hosts of an access row, and the form that adds one. The token is checked, saved encrypted, and never shown again. */
function AccessForm(props: { row: PrereqRow; onChanged: () => void }): React.JSX.Element {
  const access = props.row.access!
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState(access.defaultHost)
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jira = access.kind === 'jira'
  const label = props.row.name
  const help = tokenHelp(access.kind, host)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.access.save({ kind: access.kind, host, token, email: jira ? email : undefined })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setToken('') // the token leaves the page as soon as it is saved
    setOpen(false)
    props.onChanged()
  }

  return (
    <div className="accessform" data-testid={`access-${access.kind}`}>
      {access.hosts.map((h) => (
        <div key={h.host} className="actions">
          <span className="mono">{h.host}</span>
          {h.email && <span className="muted small">{h.email}</span>}
          <button onClick={() => void api.access.remove(access.kind, h.host).then(props.onChanged)}>Remove</button>
        </div>
      ))}
      {!open ? (
        <div className="actions">
          <button data-testid={`add-${access.kind}`} onClick={() => setOpen(true)}>
            {access.hosts.length === 0 ? `Add ${label} access…` : 'Add another host…'}
          </button>
        </div>
      ) : (
        <form className="accessfields" onSubmit={(e) => (e.preventDefault(), void save())}>
          <label>
            {jira ? 'Jira site' : `${label} host`}
            <input
              aria-label={jira ? 'Jira site' : `${label} host`}
              value={host}
              placeholder={jira ? 'yourcompany.atlassian.net' : access.defaultHost}
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          {jira && (
            <label>
              Account email
              <input aria-label="Jira account email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label>
            {jira ? 'API token' : 'Personal access token'}
            <input aria-label={`${label} token`} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <details open className="tokenhelp" data-testid={`token-help-${access.kind}`}>
            <summary>How to create a token</summary>
            <p>{help.intro}</p>
            {help.options.map((option, n) => (
              <div key={option.label} className="tokenoption">
                <strong>{option.label}</strong>
                <ol>
                  {option.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <ul>
                  {option.permissions.map((p) => (
                    <li key={p.name}>
                      <strong>{p.name}</strong>: {p.why}
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  <button
                    type="button"
                    data-testid={`token-page-${access.kind}-${n}`}
                    data-url={option.pageUrl ?? ''}
                    disabled={!option.pageUrl}
                    aria-label={`${option.pageLabel}: ${option.label}`}
                    onClick={() => option.pageUrl && void api.system.openExternal(option.pageUrl)}
                  >
                    {option.pageLabel}
                  </button>
                  {!option.pageUrl && (
                    <span className="bad-text" role="status">
                      Check the host name above.
                    </span>
                  )}
                </div>
              </div>
            ))}
            <ul>
              {help.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
          <span className="muted small">The token is checked, then saved encrypted by your operating system. It is never shown again.</span>
          {error && (
            <div className="bad-text small" data-testid={`access-error-${access.kind}`}>
              {error}
            </div>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !token || !host}>
              {busy ? 'Checking…' : 'Check and save'}
            </button>
            <button type="button" onClick={() => (setOpen(false), setToken(''))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

/** Pick the AI tool: Claude Code, Codex, or any other command that prints its answer on standard output. */
function AiToolForm(props: { row: PrereqRow; onChanged: () => void }): React.JSX.Element {
  const current = props.row.ai!
  const [tool, setTool] = useState<ToolId>(current.tool)
  const [name, setName] = useState(current.custom?.name ?? '')
  const [command, setCommand] = useState(current.custom?.command ?? '')
  const [args, setArgs] = useState((current.custom?.args ?? []).join('\n'))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = async (): Promise<void> => {
    setError(null)
    setSaved(false)
    const config: LlmConfig =
      tool === 'custom'
        ? {
            tool,
            custom: {
              name: name.trim() || command.trim(),
              command: command.trim(),
              args: args
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean)
            }
          }
        : { tool }
    const r = await api.llm.set(config)
    if (!r.ok) return setError(r.error)
    setSaved(true)
    props.onChanged()
  }

  return (
    <div className="accessform" data-testid="ai-form">
      <div className="actions">
        <label className="small">
          AI tool{' '}
          <select aria-label="AI tool" value={tool} onChange={(e) => setTool(e.target.value as ToolId)}>
            {(Object.keys(TOOL_NAMES) as ToolId[]).map((t) => (
              <option key={t} value={t}>
                {TOOL_NAMES[t]}
              </option>
            ))}
          </select>
        </label>
        {tool !== 'custom' && (
          <button data-testid="save-ai" onClick={() => void save()}>
            Use {TOOL_NAMES[tool]}
          </button>
        )}
      </div>
      {tool === 'codex' && (
        <span className="muted small">
          Codex runs in a read-only sandbox. It can read the code and run read-only commands, but it cannot write or use the network.
        </span>
      )}
      {tool === 'custom' && (
        <div className="accessfields">
          <label>
            Name
            <input aria-label="Tool name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Command
            <input aria-label="Tool command" value={command} placeholder="my-ai-tool" onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label>
            Arguments, one per line
            <textarea aria-label="Tool arguments" rows={4} value={args} placeholder={'-p\n{prompt}'} onChange={(e) => setArgs(e.target.value)} />
          </label>
          <span className="muted small">
            Placeholders: {'{prompt}'} {'{instructions}'} {'{model}'} {'{effort}'} {'{dir}'} {'{session}'}. With no {'{prompt}'}, the prompt goes to the tool on
            standard input. The tool prints its answer on standard output. It keeps no session, so the app sends the earlier questions again.
          </span>
          <div className="actions">
            <button className="primary" data-testid="save-ai" onClick={() => void save()}>
              Save the tool
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="bad-text small" data-testid="ai-error">
          {error}
        </div>
      )}
      {saved && <div className="muted small">Saved.</div>}
    </div>
  )
}
