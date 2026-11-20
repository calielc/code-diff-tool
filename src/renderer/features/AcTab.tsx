import { useState } from 'react'
import type { AiStateView, RunView } from '@shared/ai'
import type { ChecklistEntry } from '@shared/review-answer'
import { api } from '../api'
import { MODELS, modelLabel, useClock } from './AiPanel'
import { useReview } from './review-context'

const MARK = { covered: '✓', partial: '◐', missing: '✗', none: '○' } as const
const WORD = { covered: 'met', partial: 'partly met', missing: 'not met', none: 'not validated yet' } as const
const iid = (mr: string): string => mr.slice(mr.lastIndexOf('!') + 1)
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const testId = (ac: string): string => ac.replace(' ', '-')

/** The Acceptance criteria tab: the check of each criterion, with suggested comments (file 04 section 8.5). */
export function AcTab(): React.JSX.Element {
  const r = useReview()
  const ai = r.ai
  const run = ai?.ac ?? null
  const clock = useClock(run?.startedAt ?? null, run?.state === 'running')
  const [error, setError] = useState<string | null>(null)
  if (!ai) return <p className="muted">Asking the app…</p>

  const model = ai.picks.acModel ?? 'opus'
  const effort = ai.picks.acEffort ?? 'medium'
  const unreadable = Object.keys(ai.unreadable)
  const entries = new Map<string, ChecklistEntry>((run?.checklist ?? []).map((e) => [e.ac, e]))
  const start = async (without: string[]): Promise<void> => {
    setError(null)
    const res = await api.ai.start({ slug: r.slug, kind: 'ac', model, effort, withoutIssues: without })
    if (!res.ok) setError(res.error)
  }
  const counts = { covered: 0, partial: 0, missing: 0 }
  for (const e of entries.values()) counts[e.state]++

  const noCriteria = ai.criteria.length === 0 && ai.context !== 'gathering'
  return (
    <div data-testid="ac-tab">
      <div className={`aibox inline ${run?.state ?? ''}`} data-testid="ac-box">
        <div className="aihead">
          <strong data-testid="ac-title">{boxTitle(run, noCriteria, clock)}</strong>
          {run?.state === 'running' ? (
            <button data-testid="ac-stop" onClick={() => void api.ai.stop(r.slug, 'ac')}>
              Stop
            </button>
          ) : (
            !noCriteria && (
              <button
                data-testid="ac-start"
                disabled={ai.context !== 'ready'}
                title={ai.context !== 'ready' ? 'The review context is not ready yet' : undefined}
                onClick={() => void start(unreadable)}
              >
                {unreadable.length > 0 ? `Validate without ${unreadable.join(', ')}` : run ? 'Validate again' : 'Validate ACs'}
              </button>
            )
          )}
          {run?.state !== 'running' && (
            <span className="small">
              <select aria-label="AC model" value={model} onChange={(e) => void api.ai.setPicks({ slug: r.slug, ...ai.picks, acModel: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {modelLabel(m)}
                  </option>
                ))}
              </select>{' '}
              <select aria-label="AC effort" value={effort} onChange={(e) => void api.ai.setPicks({ slug: r.slug, ...ai.picks, acEffort: e.target.value })}>
                {['low', 'medium', 'high', 'xhigh', 'max'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
        <div className="small muted" data-testid="ac-detail">
          {detail(ai, run, noCriteria)}
        </div>
        {run?.state === 'running' && (
          <div className="small muted">
            {modelLabel(run.model)}
            {run.effort ? ` · ${run.effort}` : ''} · {run.reads} file(s) read · {run.agents} subagent(s)
          </div>
        )}
        {run?.state === 'done' && (
          <div>
            {counts.covered > 0 && <span className="chip ok">{counts.covered} met</span>}{' '}
            {counts.partial > 0 && <span className="chip warn">{counts.partial} partly met</span>}{' '}
            {counts.missing > 0 && <span className="chip bad">{counts.missing} not met</span>}
          </div>
        )}
        {error && (
          <pre className="err" data-testid="ac-error">
            {error}
          </pre>
        )}
      </div>

      {r.data.issues
        .filter((t) => ai.criteria.some((c) => c.name.startsWith(`${t.key} AC`)))
        .map((t) => (
          <div key={t.key} className="panelcard accard" data-testid={`ac-issue-${t.key}`}>
            <div className="cardhead">
              <strong className="mono">{t.key}</strong>
              <span className="muted">{t.title}</span>
            </div>
            {ai.criteria
              .filter((c) => c.name.startsWith(`${t.key} AC`))
              .map((c) => {
                const e = entries.get(c.name)
                const st = e?.state ?? 'none'
                const n = c.name.slice(c.name.lastIndexOf('AC') + 2)
                return (
                  <div key={c.name} className={`acrow ${st}`} data-testid={`ac-${testId(c.name)}`}>
                    <span className={`acicon ${st}`}>{MARK[st]}</span>
                    <span className="aclabel mono">AC{n}</span>
                    <div className="acbody">
                      <div className="actext">{c.text}</div>
                      {e && <div className="acwhy">{e.why}</div>}
                      {e && e.evidence.length > 0 && (
                        <div className="acevid">
                          {e.evidence.map((ev, i) => (
                            <button key={i} className="link mono small" onClick={() => r.requestOpen(ev.mr, ev.path, ev.newLine)}>
                              !{iid(ev.mr)} {base(ev.path)}
                              {ev.newLine ? `:${ev.newLine}` : ''}
                            </button>
                          ))}
                        </div>
                      )}
                      {e?.draft && run && <Suggestion run={run} entry={e} />}
                    </div>
                    <span className={`acstate ${st}`}>{WORD[st]}</span>
                  </div>
                )
              })}
          </div>
        ))}
    </div>
  )
}

function Suggestion(props: { run: RunView; entry: ChecklistEntry }): React.JSX.Element {
  const r = useReview()
  const d = props.entry.draft!
  const mr = r.mrByKey(d.mr)
  const line = d.newLine ?? d.oldLine
  const where = d.path ? `!${iid(d.mr)} ${base(d.path)}${line ? `:${line}` : ''}` : `!${iid(d.mr)} · on the MR`
  const exists = !!r.drafts[d.id]
  let blocked: string | null = null
  if (!mr) blocked = `!${iid(d.mr)} is no longer in the review.`
  else if (mr.snapshot.info.state !== 'opened') blocked = `!${iid(d.mr)} is no longer open.`
  else if (props.run.commits[d.mr] && mr.snapshot.info.diffRefs.head !== props.run.commits[d.mr])
    blocked = `!${iid(d.mr)} has new commits since the validation. Validate again.`
  return (
    <div className="suggestion" data-testid={`ac-suggestion-${testId(props.entry.ac)}`}>
      <div className="small muted">Suggested comment · {where}</div>
      <div>{d.body}</div>
      {exists ? (
        <span className="small">Draft added</span>
      ) : (
        <button data-testid="ac-add-draft" disabled={!!blocked} title={blocked ?? undefined} onClick={() => void r.saveDraft(d)}>
          Add as draft
        </button>
      )}
      {blocked && <div className="small warn">{blocked}</div>}
    </div>
  )
}

function boxTitle(run: RunView | null, noCriteria: boolean, clock: string): string {
  if (noCriteria) return 'No acceptance criteria'
  if (run?.state === 'running') return `AI validates the ACs ${clock}`
  if (run?.state === 'done') return 'ACs validated'
  if (run?.state === 'failed') return 'The AC validation failed'
  if (run?.state === 'stopped') return run.stoppedByRestart ? 'The AC validation stopped with the app' : 'You stopped the AC validation'
  return 'Acceptance criteria'
}

function detail(ai: AiStateView, run: RunView | null, noCriteria: boolean): string {
  if (noCriteria) return 'The issue files of this review name no acceptance criteria, so there is nothing to validate.'
  if (run?.state === 'running') return run.step || `Starting ${ai.tool}…`
  if (run?.state === 'failed') return run.error ?? ''
  if (run?.state === 'stopped') return 'Nothing arrived. Validate again when you want.'
  if (run?.state === 'done') return ''
  return 'The AI reads the issues, the MRs and the code of each repo, and says for each criterion whether the MRs meet it. For a criterion they do not fully meet, it can suggest a comment that you add as a draft.'
}
