// Which texts of a file to colour, and where the colours of each line of the diff come from.
//
// A diff line is coloured from the whole file it belongs to, so a block comment or a string that spans several lines
// is right. A removed line takes its colours from the whole old file, and an added or unchanged line from the whole
// new file. Some files have no whole text: a generated file, and a file where no line was removed has no old text. For
// those the plan colours each hunk by itself, with the lines of that hunk only. A multi-line token that starts outside
// the hunk can then get a wrong colour, and the text is never wrong. That is the price of not reading the whole file.

import type { FileObject, Level, LineObj } from './diff'
import { languageForPath } from './syntax-language'
import { limitReason } from './syntax-tokens'

/** A text that the highlighter colours as a whole. */
export interface Source {
  key: string
  lang: string
  lines: string[]
}

/** Where the colours of a line are: the line at `index` of the source with this key. */
export interface Place {
  source: string
  index: number
}

export interface Plan {
  /** The texts to colour. A text over a size limit is not here. */
  sources: Source[]
  /** The place of the colours of a line of a hunk, or null for a line with no colours. */
  at(line: LineObj): Place | null
  /** The place of the colours of line n (1-based) of the whole new file, or null. */
  atNew(n: number): Place | null
  /** Why a text was left plain, for the file panel, or null. */
  notice: string | null
}

const EMPTY: Plan = { sources: [], at: () => null, atNew: () => null, notice: null }

export function buildPlan(file: FileObject, level: Level): Plan {
  const lang = languageForPath(file.path)
  if (!lang || file.binary) return EMPTY
  const oldLang = languageForPath(file.oldPath) ?? lang
  const sources: Source[] = []
  let notice: string | null = null
  const add = (key: string, language: string, lines: string[]): boolean => {
    const why = limitReason(lines)
    if (why) {
      notice ??= `Syntax colours are off for this file: ${why}.`
      return false
    }
    sources.push({ key, lang: language, lines })
    return true
  }
  const hasNew = file.lines !== null && add('new', lang, file.lines)
  const hasOld = file.oldLines !== null && add('old', oldLang, file.oldLines)
  const tooBig = notice !== null

  // Lines that no whole text covers are coloured with the lines of their own hunk
  const partial = new Map<LineObj, Place>()
  if (!tooBig && (file.lines === null || file.oldLines === null)) {
    level.hunks.forEach((hunk, h) => {
      for (const side of ['o', 'n'] as const) {
        if (side === 'n' ? file.lines !== null : file.oldLines !== null) continue
        const members = hunk.filter((l) => (side === 'n' ? l.t !== '-' : l.t !== '+'))
        if (members.length === 0) continue
        const key = `h${h}${side}`
        if (
          !add(
            key,
            side === 'n' ? lang : oldLang,
            members.map((l) => l.x)
          )
        )
          continue
        members.forEach((l, index) => {
          // An unchanged line has both a new and an old place. The new one wins.
          if (!partial.has(l) || side === 'n') partial.set(l, { source: key, index })
        })
      }
    })
  }

  return {
    sources,
    notice,
    at: (l) => {
      if (l.t === '-') return hasOld && l.o !== null ? { source: 'old', index: l.o - 1 } : (partial.get(l) ?? null)
      if (hasNew && l.n !== null) return { source: 'new', index: l.n - 1 }
      if (l.t === ' ' && hasOld && l.o !== null) return { source: 'old', index: l.o - 1 }
      return partial.get(l) ?? null
    },
    atNew: (n) => (hasNew ? { source: 'new', index: n - 1 } : null)
  }
}
