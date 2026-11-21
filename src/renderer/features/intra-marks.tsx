import type { LineObj } from '@shared/diff'
import { intraLine, type Seg } from '@shared/intraline'

/** The characters that really changed in a removed line and the added line that replaces it, found for each pair of a run. */
export function intraMapOf(hunks: LineObj[][]): Map<LineObj, Seg[]> {
  const out = new Map<LineObj, Seg[]>()
  for (const h of hunks) {
    let i = 0
    while (i < h.length) {
      if (h[i].t === ' ') {
        i++
        continue
      }
      const dels: LineObj[] = []
      const adds: LineObj[] = []
      while (i < h.length && h[i].t === '-') dels.push(h[i++])
      while (i < h.length && h[i].t === '+') adds.push(h[i++])
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = intraLine(dels[k].x, adds[k].x)
        if (r) {
          out.set(dels[k], r.old)
          out.set(adds[k], r.new)
        }
      }
    }
  }
  return out
}

/** The text of a line, with the changed characters of a modified line marked. */
export function codeOf(marks: Map<LineObj, Seg[]>, l: LineObj): React.ReactNode {
  const segs = marks.get(l)
  return segs
    ? segs.map((g, i) =>
        g.changed ? (
          <span key={i} className="chg">
            {g.text}
          </span>
        ) : (
          g.text
        )
      )
    : l.x
}
