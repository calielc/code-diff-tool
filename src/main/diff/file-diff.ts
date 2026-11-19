import { emptyLevel, LEVELS, type FileObject, type FileStatus, type Level, type LevelName, type LineObj, type LineTarget } from '@shared/diff'
import { compute, fromChangedLines, type Step } from './myers'
import { cleanLine, detectRenames, isGenerated, keysFor, type Rename } from './noise'

const CONTEXT = 3

/** Group a level's lines into hunks with 3 lines of context (file 03 section 7). */
export function buildHunks(lines: LineObj[]): LineObj[][] {
  const hunks: LineObj[][] = []
  let previousEnd = 0
  let index = 0
  while (index < lines.length) {
    if (lines[index].t === ' ') {
      index++
      continue
    }
    const start = Math.max(previousEnd, index - CONTEXT)
    let lastChange = index
    let scan = index
    while (scan < lines.length && scan - lastChange <= 2 * CONTEXT + 1) {
      if (lines[scan].t !== ' ') lastChange = scan
      scan++
    }
    const end = Math.min(lines.length, lastChange + CONTEXT + 1)
    hunks.push(lines.slice(start, end))
    previousEnd = end
    index = end
  }
  return hunks
}

/** The text of one side of a file: its lines, or null when there is no such side or it is binary. */
export interface Side {
  binary: boolean
  lines: string[]
}

/** git's own changed line numbers of the file, 1-based (file 03 section 2.5). */
export interface ChangedLines {
  deleted: Set<number>
  added: Set<number>
}

export interface FileInput {
  path: string
  oldPath: string
  status: FileStatus
  /** Null for an added file. */
  old: Side | null
  /** Null for a deleted file. */
  new: Side | null
  changed?: ChangedLines
}

function level(steps: Step[], oldLines: string[], newLines: string[], oldIdx: number[], newIdx: number[], resolve?: (l: LineObj) => LineTarget | null): Level {
  const lines: LineObj[] = steps.map((s) => {
    const oi = s.k === 'ins' ? null : oldIdx[s.o]
    const ni = s.k === 'del' ? null : newIdx[s.n]
    const text = ni !== null ? newLines[ni] : oldLines[oi as number]
    const line: LineObj = {
      t: s.k === 'eq' ? ' ' : s.k === 'del' ? '-' : '+',
      o: oi === null ? null : oi + 1,
      n: ni === null ? null : ni + 1,
      x: cleanLine(text)
    }
    if (resolve) line.target = resolve(line)
    return line
  })
  return {
    hunks: buildHunks(lines),
    add: lines.filter((l) => l.t === '+').length,
    del: lines.filter((l) => l.t === '-').length
  }
}

/** Build the three levels of one file (file 03 section 3.5). `renames` apply to the old side only. */
export function buildFile(input: FileInput, renames: Rename[], resolve?: (l: LineObj, level: LevelName) => LineTarget | null): FileObject {
  const { path, oldPath } = input
  const binary = !!input.old?.binary || !!input.new?.binary
  const oldLines = input.old && !input.old.binary ? input.old.lines : []
  const newLines = input.new && !input.new.binary ? input.new.lines : []
  const content = input.new ? (input.new.binary ? null : input.new.lines.join('\n')) : input.old && !input.old.binary ? input.old.lines.join('\n') : null
  const generated = isGenerated(input.new ? path : oldPath, content)
  const base: FileObject = {
    path,
    oldPath,
    status: input.status,
    binary,
    generated,
    levels: { raw: emptyLevel(), basic: emptyLevel(), strict: emptyLevel() },
    lines: null,
    oldLines: null
  }
  if (binary) return base

  for (const name of LEVELS) {
    let steps: Step[]
    let oldIdx: number[]
    let newIdx: number[]
    if (name === 'raw') {
      oldIdx = oldLines.map((_, i) => i)
      newIdx = newLines.map((_, i) => i)
      // Git's own numbers first, so + and - sit exactly where the forge expects a comment position.
      steps = (input.changed && fromChangedLines(oldLines.length, newLines.length, input.changed.deleted, input.changed.added)) || compute(oldLines, newLines)
    } else {
      const ok = keysFor(oldPath, oldLines, name, renames)
      const nk = keysFor(path, newLines, name)
      oldIdx = ok.map((k) => k.index)
      newIdx = nk.map((k) => k.index)
      steps = compute(
        ok.map((k) => k.key),
        nk.map((k) => k.key)
      )
    }
    base.levels[name] = level(steps, oldLines, newLines, oldIdx, newIdx, resolve ? (l) => resolve(l, name) : undefined)
  }

  if (!generated) {
    base.lines = input.new ? newLines.map(cleanLine) : null
    const removes = LEVELS.reduce((n, l) => n + base.levels[l].del, 0)
    base.oldLines = input.old && removes > 0 ? oldLines.map(cleanLine) : null
  }
  return base
}

export { detectRenames }
