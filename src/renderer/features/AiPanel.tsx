import { useEffect, useState } from 'react'
import type { AiStateView, RunView } from '@shared/ai'
import { api } from '../api'
import { useReview } from './review-context'

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const modelLabel = (m: string): string => m.charAt(0).toUpperCase() + m.slice(1)

/** m:ss since a time, updated every second while `live`. */
export function useClock(since: string | null, live: boolean): string {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])
  if (!since) return '0:00'
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const timeOf = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

export function pickedSkill(ai: AiStateView): AiStateView['skills'][number] | undefined {
  return ai.skills.find((s) => s.id === ai.picks.skill) ?? ai.skills.find((s) => s.default) ?? ai.skills[0]
}
export function pickedModel(ai: AiStateView): string {
  return ai.picks.model ?? pickedSkill(ai)?.model ?? 'opus'
}

/** The AI review: its pill, and the box with the state of the run, the settings and the drafts (file 02 section 12). */
export function AiPanel(): React.JSX.Element | null {
  const r = useReview()
  const ai = r.ai
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = ai?.review ?? null
  const clock = useClock(run?.startedAt ?? null, run?.state === 'running')
  if (!ai) return null

  const skill = pickedSkill(ai)
  const model = pickedModel(ai)
  const unreadable = Object.keys(ai.unreadable)
  const gathering = ai.context === 'gathering'
  const mine = run && run.drafts ? run.drafts.map((id) => r.drafts[id]).filter(Boolean) : []
  const blocking = mine.filter((d) => d.claude?.severity === 'blocking').length
  const suggestions = mine.length - blocking

  const start = async (without: string[]): Promise<void> => {
    setError(null)
    if (!skill) return
    const res = await api.ai.start({ slug: r.slug, kind: 'review', skill: skill.id, model, withoutIssues: without })
    if (!res.ok) setError(res.error)
  }
  const pick = (patch: Partial<AiStateView['picks']>): void => {
    void api.ai.setPicks({ slug: r.slug, ...ai.picks, ...patch })
  }

  const words =
    run?.state === 'running'
      ? `runs ${clock}`
      : run?.state === 'done'
        ? mine.length === 0
          ? run.drafts?.length
            ? 'no draft pending'
            : 'nothing to comment on'
          : `${blocking} blocking · ${suggestions} suggestion(s)`
        : run?.state === 'failed'
          ? 'failed'
          : run?.state === 'stopped'
            ? 'stopped'
            : ai.context === 'failed'
              ? 'the review context failed'
              : unreadable.length > 0
                ? `cannot read ${unreadable.join(', ')}`
                : 'ready'

  return (
    <div className="aipanel">
      <button className="pill" data-testid="ai-pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {run?.state === 'running' && <span className="spin">◐ </span>}✦ AI review ·{' '}
        <span data-testid="ai-words">{gathering ? 'gathering context…' : words}</span> ▾
      </button>
      {open && (
        <div className={`aibox ${run?.state ?? ''}`} data-testid="ai-box">
          <div className="aihead">
            <strong data-testid="ai-title">{title(ai, run, gathering, clock)}</strong>
            {run?.state === 'running' && (
              <button data-testid="ai-stop" onClick={() => void api.ai.stop(r.slug, 'review')}>
                Stop
              </button>
            )}
            {(!run || run.state !== 'running') && (
              <>
                <button data-testid="ai-settings" onClick={() => setSettings((s) => !s)}>
                  Settings {skill ? `${skill.name} · ${modelLabel(model)}` : ''}
                </button>
                {unreadable.length > 0 ? (
                  <button data-testid="ai-start" disabled={gathering} onClick={() => void start(unreadable)}>
                    Review without {unreadable.join(', ')}
                  </button>
                ) : (
                  <button
                    data-testid="ai-start"
                    disabled={gathering || ai.context === 'failed' || !skill}
                    title={gathering ? 'The review context is not ready yet' : undefined}
                    onClick={() => void start([])}
                  >
                    {run && (run.state === 'stopped' || run.state === 'failed') ? 'Start again' : 'Start the AI review'}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="small muted" data-testid="ai-detail">
            {detail(ai, run, mine.length, gathering, unreadable)}
          </div>
          {run?.state === 'running' && (
            <div className="small muted">
              {run.skill} · {modelLabel(run.model)} · {run.reads} file(s) read · {run.agents} subagent(s)
            </div>
          )}
          {run?.state === 'done' && mine.length > 0 && (
            <div>
              <span className="chip bad">{blocking} blocking</span> <span className="chip">{suggestions} suggestion(s)</span>{' '}
              <button
                data-testid="ai-first"
                onClick={() => {
                  const first = mine.find((d) => d.path && d.claude?.severity === 'blocking') ?? mine.find((d) => d.path)
                  if (first?.path) r.requestOpen(first.mr, first.path, first.newLine ?? first.oldLine)
                }}
              >
                ↓ First {blocking > 0 ? 'blocking draft' : 'draft'}
              </button>
            </div>
          )}
          {error && (
            <pre className="err" data-testid="ai-error">
              {error}
            </pre>
          )}
          {settings && (
            <div className="aisettings" data-testid="ai-settings-menu">
              <label className="small">Review skill</label>
              {ai.skills.map((s) => (
                <label key={s.id} className="radio">
                  <input type="radio" name="skill" checked={skill?.id === s.id} onChange={() => pick({ skill: s.id })} /> <strong>{s.name}</strong>{' '}
                  <span className="muted">
                    {s.plugin}
                    {s.default ? ' · default' : ''}
                  </span>
                  <div className="small muted">{s.description}</div>
                </label>
              ))}
              <button data-testid="ai-skills-folder" onClick={() => void api.ai.pickSkillsFolder(r.slug)}>
                Choose a folder of skills…
              </button>
              <label className="small">Model</label>
              <div className="group">
                {MODELS.map((m) => (
                  <button key={m} className={model === m ? 'on' : ''} data-testid={`ai-model-${m}`} onClick={() => pick({ model: m })}>
                    {modelLabel(m)}
                  </button>
                ))}
              </div>
              <p className="small muted">Saved on this machine. A run that already started keeps its skill and model.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function title(ai: AiStateView, run: RunView | null, gathering: boolean, clock: string): string {
  if (run?.state === 'running') return `AI review runs ${clock}`
  if (run?.state === 'done') return 'AI review done'
  if (run?.state === 'failed') return 'The AI review failed'
  if (run?.state === 'stopped')
    return run.stoppedByRestart ? `The AI review stopped with the app at ${timeOf(run.endedAt)}` : `You stopped the AI review at ${timeOf(run.endedAt)}`
  if (ai.context === 'failed') return 'The review context failed'
  if (Object.keys(ai.unreadable).length > 0) return `Cannot read ${Object.keys(ai.unreadable).join(', ')}`
  return gathering ? 'Gathering context…' : 'AI review'
}

function detail(ai: AiStateView, run: RunView | null, drafts: number, gathering: boolean, unreadable: string[]): string {
  if (run?.state === 'running') return run.step || `Starting ${ai.tool}…`
  if (run?.state === 'done')
    return drafts > 0
      ? 'Each draft stays on the page until you post or delete it. Press c on the Diff tab to walk the comments.'
      : run.drafts?.length
        ? 'No draft of this run is pending any more.'
        : `${ai.tool} found nothing to comment on.`
  if (run?.state === 'failed') return run.error ?? ''
  if (run?.state === 'stopped')
    return run.stoppedByRestart
      ? 'The app stopped while it ran, and nothing arrived. Start it again when you want.'
      : 'Nothing arrived. Start it again when you want.'
  if (ai.context === 'failed') return `${ai.contextError ?? ''} Reload the review to try again.`
  if (unreadable.length > 0)
    return `${unreadable.map((k) => `${k}: ${ai.unreadable[k]}. `).join('')}Without it, the review checks no acceptance criteria of that issue.`
  if (gathering) return 'The app collects the issues, the diffs, the history and the threads. The AI review can start once it is ready.'
  return `${ai.tool} reads the whole review with its issues, and leaves draft comments for you to read first.`
}
