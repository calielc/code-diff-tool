import { useEffect, useMemo, useState } from 'react'
import type { FileObject, Level, LineObj } from '@shared/diff'
import { buildPlan, type Plan } from '@shared/syntax-plan'
import type { TokenLine } from '@shared/syntax-tokens'
import { highlightMany } from './client'
import { useSyntaxColours } from './settings'

export interface FileHighlight {
  /** The tokens of a line of the diff, or null while they are not ready and for a file that stays plain. */
  line(l: LineObj): TokenLine | null
  /** The tokens of line n (1-based) of the whole new file, for the Full file layout. */
  newLine(n: number): TokenLine | null
  /** Why the file stays plain, for the file panel, or null. */
  notice: string | null
}

const PLAIN: FileHighlight = { line: () => null, newLine: () => null, notice: null }

/**
 * The colours of the lines of one file. The first render shows plain text. The worker colours the whole old and new
 * text, and the page draws again when the answer arrives, so the colours never delay the first render.
 */
export function useFileHighlight(file: FileObject, level: Level): FileHighlight {
  const on = useSyntaxColours()
  const plan = useMemo(() => buildPlan(file, level), [file, level])
  const [done, setDone] = useState<{ plan: Plan; sources: Map<string, TokenLine[] | null> } | null>(null)

  useEffect(() => {
    if (!on || plan.sources.length === 0) return
    let live = true
    void highlightMany(plan.sources.map((s) => ({ lang: s.lang, lines: s.lines }))).then((results) => {
      if (live) setDone({ plan, sources: new Map(plan.sources.map((s, i) => [s.key, results[i]])) })
    })
    return () => {
      live = false
    }
  }, [plan, on])

  return useMemo<FileHighlight>(() => {
    if (!on) return PLAIN
    const ready = done?.plan === plan ? done.sources : null
    const tokens = (at: { source: string; index: number } | null): TokenLine | null => (at ? (ready?.get(at.source)?.[at.index] ?? null) : null)
    return { line: (l) => tokens(plan.at(l)), newLine: (n) => tokens(plan.atNew(n)), notice: plan.notice }
  }, [on, plan, done])
}
