/** One step of an edit script. Indexes are 0-based (file 03 section 3.1). */
export type Step = { k: 'eq'; o: number; n: number } | { k: 'del'; o: number } | { k: 'ins'; n: number }

const MAX_EDITS = 3000

/** Myers O(ND) diff over integer keys. Returns null when the edit distance is over the cap. */
function myers(a: number[], b: number[]): Step[] | null {
  const n = a.length
  const m = b.length
  const cap = Math.min(MAX_EDITS, n + m)
  const off = cap + 1
  const v = new Int32Array(2 * cap + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= cap && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found < 0) trace.push(v.slice(off - d, off + d + 1)) // v for k in [-d, d], read as snap[k + d]
  }
  if (found < 0) return null

  const steps: Step[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    const at = (k: number): number => prev[k + (d - 1)]
    const k = x - y
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(pk)
    const py = px - pk
    const ex = pk === k - 1 ? px + 1 : px // the point right after the edit
    const ey = pk === k - 1 ? py : py + 1
    while (x > ex && y > ey) {
      x--
      y--
      steps.push({ k: 'eq', o: x, n: y })
    }
    if (pk === k - 1) {
      x--
      steps.push({ k: 'del', o: x })
    } else {
      y--
      steps.push({ k: 'ins', n: y })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    steps.push({ k: 'eq', o: x, n: y })
  }
  return steps.reverse()
}

/** Inside one changed block all deletes come before all inserts (file 03 section 3.1). */
function deletesFirst(steps: Step[]): Step[] {
  const out: Step[] = []
  let i = 0
  while (i < steps.length) {
    if (steps[i].k === 'eq') {
      out.push(steps[i++])
      continue
    }
    const dels: Step[] = []
    const inss: Step[] = []
    while (i < steps.length && steps[i].k !== 'eq') (steps[i].k === 'del' ? dels : inss).push(steps[i++])
    out.push(...dels, ...inss)
  }
  return out
}

/** The full edit script of two key lists. Keys are compared as exact strings. */
export function compute(oldKeys: string[], newKeys: string[]): Step[] {
  const allDel = (): Step[] => [...oldKeys.map((_, o) => ({ k: 'del', o }) as Step), ...newKeys.map((_, n) => ({ k: 'ins', n }) as Step)]
  if (oldKeys.length === 0 || newKeys.length === 0) return allDel()

  // Map each distinct key to a number, so the diff compares numbers.
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let i = ids.get(s)
    if (i === undefined) ids.set(s, (i = ids.size))
    return i
  }
  const a = oldKeys.map(id)
  const b = newKeys.map(id)

  // Trim the common start and end first. Most real diffs are small, so this keeps Myers cheap.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))
  const steps: Step[] = []
  for (let i = 0; i < pre; i++) steps.push({ k: 'eq', o: i, n: i })
  if (mid) {
    for (const s of mid)
      steps.push(s.k === 'eq' ? { k: 'eq', o: s.o + pre, n: s.n + pre } : s.k === 'del' ? { k: 'del', o: s.o + pre } : { k: 'ins', n: s.n + pre })
  } else {
    // Too different to diff cheaply: the whole middle is replaced.
    for (let o = pre; o < a.length - suf; o++) steps.push({ k: 'del', o })
    for (let n = pre; n < b.length - suf; n++) steps.push({ k: 'ins', n })
  }
  for (let i = suf; i > 0; i--) steps.push({ k: 'eq', o: a.length - i, n: b.length - i })
  return deletesFirst(steps)
}

/**
 * Build a raw script from git's own changed line numbers (1-based sets) so every + and - sits where the
 * forge expects a comment position (file 03 section 3.3). Returns null when the counts do not add up.
 */
export function fromChangedLines(oldCount: number, newCount: number, deleted: Set<number>, added: Set<number>): Step[] | null {
  if (oldCount - deleted.size !== newCount - added.size) return null
  for (const d of deleted) if (d > oldCount) return null
  for (const a of added) if (a > newCount) return null
  const steps: Step[] = []
  let o = 0
  let n = 0
  while (o < oldCount || n < newCount) {
    if (o < oldCount && deleted.has(o + 1)) steps.push({ k: 'del', o: o++ })
    else if (n < newCount && added.has(n + 1)) steps.push({ k: 'ins', n: n++ })
    else steps.push({ k: 'eq', o: o++, n: n++ })
  }
  return steps
}
