import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

const KIND: Record<FlowStep['kind'], string> = { new: 'NEW', changed: 'CHANGED', existing: 'EXISTING' }

interface Line {
  key: string
  d: string
  label: string
  lx: number
  ly: number
  to: string
}

/**
 * The Critical thinking view: the chain a reviewer must follow, as numbered boxes in one column per repo with arrows
 * between them, then the code to read in order, then the files that can be skipped (file 02 section 1.1).
 * Each box opens its file at the first line.
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
  const number = useMemo(() => new Map(flow.steps.map((s, i) => [s.id, i + 1])), [flow])
  const titleOf = (id: string): string => flow.steps.find((s) => s.id === id)?.title ?? id

  // The arrows are drawn over the boxes, from the position of each box on the screen
  const boxRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const measure = useCallback(() => {
    const host = boxRef.current
    if (!host) return
    const base = host.getBoundingClientRect()
    const at = (id: string): DOMRect | null => host.querySelector(`#flowstep-${CSS.escape(id)}`)?.getBoundingClientRect() ?? null
    const next: Line[] = []
    for (const s of flow.steps) {
      for (const e of s.next ?? []) {
        const a = at(s.id)
        const b = at(e.to)
        if (!a || !b) continue
        const ax = a.left - base.left
        const ay = a.top - base.top
        const bx = b.left - base.left
        const by = b.top - base.top
        let d: string
        let lx: number
        let ly: number
        if (Math.abs(ax - bx) < 40) {
          // the same column: straight down, from the bottom of the first box to the top of the second
          const x = ax + a.width / 2
          const y1 = ay + a.height
          const y2 = by
          d = `M ${x} ${y1} L ${x} ${y2 - 2}`
          lx = x + 6
          ly = (y1 + y2) / 2 + 4
        } else {
          // another column: a curve from the side of the first box to the side of the second
          const right = bx > ax
          const x1 = right ? ax + a.width : ax
          const y1 = ay + a.height / 2
          const x2 = right ? bx - 3 : bx + b.width + 3
          const y2 = by + b.height / 2
          const mid = (x1 + x2) / 2
          d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
          lx = mid
          ly = (y1 + y2) / 2 - 6
        }
        next.push({ key: `${s.id}>${e.to}`, d, label: e.label ?? '', lx, ly, to: e.to })
      }
    }
    setLines(next)
    setSize({ w: base.width, h: base.height })
  }, [flow])
  useLayoutEffect(() => {
    measure()
    const host = boxRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(host)
    return () => ro.disconnect()
  }, [measure])

  return (
    <div className="flowview" data-testid="flow-view">
      <p className="flowsummary" data-testid="flow-summary">
        {flow.summary}
      </p>

      <div className="flowcanvas" ref={boxRef}>
        <div className="lanes" style={{ gridTemplateColumns: `repeat(${Math.max(1, lanes.length)}, minmax(240px, 340px))` }}>
          {lanes.map((lane) => (
            <div key={lane} className="lane" data-testid={`lane-${lane}`}>
              <div className="lanehead">{lane}</div>
              {Array.from({ length: maxRow + 1 }, (_, row) =>
                flow.steps
                  .filter((s) => laneOf(s) === lane && rows.get(s.id) === row)
                  .map((s) => {
                    const first = s.lines?.[0]?.[0] ?? null
                    return (
                      <div key={s.id} id={`flowstep-${s.id}`} className={`flowbox ${s.kind}`} data-testid={`step-${s.id}`}>
                        <div className="boxhead">
                          <strong>
                            {number.get(s.id)}. {s.title}
                          </strong>
                        </div>
                        <div className="boxfoot">
                          {s.path ? (
                            <button
                              className="link mono small boxpath"
                              disabled={!s.mr}
                              title={s.mr ? 'Open the file at this line' : 'Unchanged code: it is not in a change'}
                              onClick={() => s.mr && props.onOpen(s.mr, s.path!, first)}
                            >
                              {s.path}
                              {first ? `:${first}` : ''}
                            </button>
                          ) : (
                            <span className="muted mono small">unchanged code</span>
                          )}
                          <span className={`kind ${s.kind}`}>{KIND[s.kind] ?? s.kind}</span>
                        </div>
                        <div className="boxtext small muted">{s.text}</div>
                      </div>
                    )
                  })
              )}
            </div>
          ))}
        </div>
        <svg className="flowlines" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            <marker id="flowarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
            </marker>
          </defs>
          {lines.map((l) => (
            <g key={l.key} data-testid={`edge-${l.key}`}>
              <path d={l.d} className="flowedge" markerEnd="url(#flowarrow)" />
              {l.label && (
                <text x={l.lx} y={l.ly} className="edgelabel" onClick={() => document.getElementById(`flowstep-${l.to}`)?.scrollIntoView({ block: 'center' })}>
                  <title>{titleOf(l.to)}</title>
                  {l.label}
                </text>
              )}
            </g>
          ))}
        </svg>
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
