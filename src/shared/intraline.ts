// The part of a changed line that really changed. A removed line and the added line that replaces it often differ by a
// character or two. These helpers find those characters, so the diff can colour them more strongly than the rest.

export interface Seg {
  text: string
  /** True for the characters that differ from the other line. */
  changed: boolean
}

/** A middle part longer than this (in characters) gets no word matching, only the common start and end trimmed. */
const MAX_MIDDLE = 600
/** The most words of one line that are matched one by one. */
const MAX_TOKENS = 300
/** A line changed this much is a different line: it gets no inner colour. */
const MAX_CHANGED_FRACTION = 0.6
/** An unchanged stretch this short between two changes is merged into them, so a word does not show as scattered marks. */
const MIN_GAP = 2

/** Words, runs of white space and single punctuation marks. */
const TOKEN = /\w+|\s+|[^\w\s]/gu
const tokens = (s: string): { text: string; start: number }[] => [...s.matchAll(TOKEN)].map((m) => ({ text: m[0], start: m.index }))

/**
 * The characters of a and b that differ. The two lines are compared word by word. Inside a word that changed, only the
 * characters after the common start and before the common end are marked, so "jumps" to "jumped" marks "s" and "ed",
 * and "brown" to "red" marks both words whole.
 */
function wordMarks(a: string, b: string): { a: boolean[]; b: boolean[] } {
  const ta = tokens(a)
  const tb = tokens(b)
  const markA = new Array<boolean>(a.length).fill(false)
  const markB = new Array<boolean>(b.length).fill(false)
  const n = ta.length
  const m = tb.length
  if (n > MAX_TOKENS || m > MAX_TOKENS) {
    markA.fill(true)
    markB.fill(true)
    return { a: markA, b: markB }
  }
  const w = m + 1
  const t = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ta[i].text === tb[j].text ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    }
  }
  // The pairs of equal tokens, then the stretches between them are the changes
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ta[i].text === tb[j].text) pairs.push([i++, j++])
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
    else j++
  }
  pairs.push([n, m])
  let ia = 0
  let ja = 0
  for (const [pi, pj] of pairs) {
    const from = (ts: { start: number }[], k: number, end: number): number => (k < ts.length ? ts[k].start : end)
    const sa = from(ta, ia, a.length)
    const ea = from(ta, pi, a.length)
    const sb = from(tb, ja, b.length)
    const eb = from(tb, pj, b.length)
    const blockA = a.slice(sa, ea)
    const blockB = b.slice(sb, eb)
    let p = 0
    const max = Math.min(blockA.length, blockB.length)
    while (p < max && blockA[p] === blockB[p]) p++
    let q = 0
    while (q < max - p && blockA[blockA.length - 1 - q] === blockB[blockB.length - 1 - q]) q++
    for (let k = sa + p; k < ea - q; k++) markA[k] = true
    for (let k = sb + p; k < eb - q; k++) markB[k] = true
    ia = pi + 1
    ja = pj + 1
  }
  return { a: markA, b: markB }
}

/** Short unchanged stretches between two changed runs count as changed. */
function closeGaps(marks: boolean[]): boolean[] {
  const out = marks.slice()
  let i = 0
  while (i < out.length) {
    if (out[i]) {
      i++
      continue
    }
    let j = i
    while (j < out.length && !out[j]) j++
    if (i > 0 && j < out.length && j - i <= MIN_GAP) for (let k = i; k < j; k++) out[k] = true
    i = j
  }
  return out
}

function segments(text: string, marks: boolean[]): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.changed === marks[i]) last.text += text[i]
    else out.push({ text: text[i], changed: marks[i] })
  }
  return out
}

/**
 * The changed characters of a removed line and the added line that replaces it. Returns null when the two lines are the
 * same, or so different that marking the characters would mark nearly the whole line.
 */
export function intraLine(oldText: string, newText: string): { old: Seg[]; new: Seg[] } | null {
  if (oldText === newText) return null
  let p = 0
  const max = Math.min(oldText.length, newText.length)
  while (p < max && oldText[p] === newText[p]) p++
  let s = 0
  while (s < max - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++
  const midOld = oldText.slice(p, oldText.length - s)
  const midNew = newText.slice(p, newText.length - s)

  let markOld: boolean[]
  let markNew: boolean[]
  if (midOld.length > 0 && midNew.length > 0 && midOld.length <= MAX_MIDDLE && midNew.length <= MAX_MIDDLE) {
    const m = wordMarks(midOld, midNew)
    markOld = m.a
    markNew = m.b
  } else {
    markOld = new Array<boolean>(midOld.length).fill(true)
    markNew = new Array<boolean>(midNew.length).fill(true)
  }
  const fullOld = closeGaps([...new Array<boolean>(p).fill(false), ...markOld, ...new Array<boolean>(s).fill(false)])
  const fullNew = closeGaps([...new Array<boolean>(p).fill(false), ...markNew, ...new Array<boolean>(s).fill(false)])
  const changed = Math.max(fullOld.filter(Boolean).length, fullNew.filter(Boolean).length)
  const length = Math.max(oldText.length, newText.length)
  if (length === 0 || changed / length > MAX_CHANGED_FRACTION) return null
  return { old: segments(oldText, fullOld), new: segments(newText, fullNew) }
}
