import { useMemo, useState } from 'react'
import type { FlowDocument, FlowStep } from '@shared/flow'
import { useReview } from './review-context'

/** A step sits one row below its lowest caller, unless the document sets its row (file 04 section 5.3). */
export function stepRows(flow: FlowDocument): Map<string, number> {
  const rows = new Map<string, number>()
  const callers = new Map<string, string[]>()
  for (const s of flow.steps) for (const e of s.next ?? []) callers.set(e.to, [...(callers.get(e.to) ?? []), s.id])
  const byId = new Map(flow.steps.map((s) => [s.id, s]))
  const rowOf = (id: string, seen: Set<string>): number => {
    const known = rows.get(id)
    if (known !== undefined) return known
    const step = byId.get(id)
    if (step?.row !== undefined) return step.row
    if (seen.has(id)) return 0 // a loop in the edges
    seen.add(id)
    const parents = callers.get(id) ?? []
    return parents.length === 0 ? 0 : Math.max(...parents.map((p) => rowOf(p, seen))) + 1
  }
  for (const s of flow.steps) rows.set(s.id, rowOf(s.id, new Set()))
  return rows
}

const KIND: Record<FlowStep['kind'], string> = { new: 'New', changed: 'Changed', existing: 'Existing' }

/**
 * The Critical thinking view: the chain a reviewer must follow, as boxes in one column per repo, then the code to read in
 * order, then the files that can be skipped (file 02 section 1.1). Each box opens its file at the first line.
 */
export function FlowView(props: { flow: FlowDocument; onOpen(mr: string, path: string, line: number | null): void }): React.JSX.Element {
  const { flow } = props
  const r = useReview()
  const rows = useMemo(() => stepRows(flow), [flow])
  const maxRow = Math.max(0, ...rows.values())
  const [open, setOpen] = useState<Set<number>>(new Set())
  const iid = (mr: string): string => mr.slice(mr.lastIndexOf('!') + 1)
  const laneOf = (s: FlowStep): string => (s.mr ? (r.mrByKey(s.mr)?.repo ?? s.mr.slice(0, s.mr.lastIndexOf('!'))) : (s.repo ?? ''))
  const lanes = flow.lanes.length > 0 ? flow.lanes : [...new Set(flow.steps.map(laneOf))]
  const title = (id: string): string => flow.steps.find((s) => s.id === id)?.title ?? id

  return (
    <div className="flowview" data-testid="flow-view">
      <p className="flowsummary" data-testid="flow-summary">
        {flow.summary}
      </p>

      <div className="lanes" style={{ gridTemplateColumns: `repeat(${Math.max(1, lanes.length)}, minmax(220px, 1fr))` }}>
        {lanes.map((lane) => (
          <div key={lane} className="lane" data-testid={`lane-${lane}`}>
            <div className="lanehead mono">{lane}</div>
            {Array.from({ length: maxRow + 1 }, (_, row) =>
              flow.steps
                .filter((s) => laneOf(s) === lane && rows.get(s.id) === row)
                .map((s) => {
                  const first = s.lines?.[0]?.[0] ?? null
                  return (
                    <div key={s.id} id={`flowstep-${s.id}`} className={`flowbox ${s.kind}`} data-testid={`step-${s.id}`}>
                      <div className="boxhead">
                        <span className={`kind ${s.kind}`}>{KIND[s.kind] ?? s.kind}</span>
                        <strong>{s.title}</strong>
                      </div>
                      <div className="small">{s.text}</div>
                      {s.path && (
                        <button
                          className="link mono small"
                          disabled={!s.mr}
                          title={s.mr ? 'Open the file at this line' : 'Unchanged code: it is not in a change'}
                          onClick={() => s.mr && props.onOpen(s.mr, s.path!, first)}
                        >
                          {s.path}
                          {first ? `:${first}` : ''}
                        </button>
                      )}
                      {(s.next ?? []).map((e) => (
                        <button
                          key={e.to}
                          className="link small edge"
                          onClick={() => document.getElementById(`flowstep-${e.to}`)?.scrollIntoView({ block: 'center' })}
                        >
                          → {e.label ? `${e.label} → ` : ''}
                          {title(e.to)}
                        </button>
                      ))}
                    </div>
                  )
                })
            )}
          </div>
        ))}
      </div>

      <h3>Read in this order</h3>
      <ol className="revieworder" data-testid="flow-review">
        {flow.review.map((item, i) => (
          <li key={i}>
            <button className="link mono small" onClick={() => props.onOpen(item.mr, item.path, item.line ?? null)}>
              !{iid(item.mr)} {item.path}
              {item.line ? `:${item.line}` : ''}
            </button>
            <div className="small">{item.why}</div>
          </li>
        ))}
      </ol>

      <h3>Skipped</h3>
      <div data-testid="flow-skip">
        {flow.skip.map((g, i) => (
          <div key={i} className="skipgroup">
            <button className="link" aria-expanded={open.has(i)} onClick={() => setOpen((o) => new Set(o.has(i) ? [...o].filter((x) => x !== i) : [...o, i]))}>
              {open.has(i) ? '▾' : '▸'} {g.why} <span className="muted">({g.items.length})</span>
            </button>
            {open.has(i) && (
              <ul className="small mono">
                {g.items.map((it, j) => (
                  <li key={j}>
                    !{iid(it.mr)} {it.path ?? it.pattern}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
