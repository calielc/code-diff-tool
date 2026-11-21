import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import type { Seg } from '@shared/intraline'
import { limitReason, piecesOf, type TokenLine } from '@shared/syntax-tokens'
import { highlightMany } from './client'
import { setSyntaxColours, useSyntaxColours } from './settings'

/**
 * One line of code. Each piece is a React element or a string, so the text of a repository is never read as HTML.
 * A piece has the class of its token, and the class `chg` when the characters changed inside the line, so the mark
 * of a change stays visible over the colour of a token.
 */
export const Code = memo(function Code({ text, tokens, segs }: { text: string; tokens: TokenLine | null; segs?: Seg[] }): React.JSX.Element {
  if (!tokens && !segs) return <>{text}</>
  return (
    <>
      {piecesOf(text, tokens, segs).map((p, i) =>
        p.kind || p.changed ? (
          <span key={i} className={[p.kind ? `tk-${p.kind}` : '', p.changed ? 'chg' : ''].filter(Boolean).join(' ')}>
            {p.text}
          </span>
        ) : (
          p.text
        )
      )}
    </>
  )
})

/** The text of a code fence of the chat. The fence is coloured as a whole text when its language is known. */
export function CodeBlock({ text, lang }: { text: string; lang: string | null }): React.JSX.Element {
  const on = useSyntaxColours()
  const lines = useMemo(() => text.split('\n'), [text])
  const [done, setDone] = useState<{ lines: string[]; tokens: TokenLine[] } | null>(null)
  useEffect(() => {
    if (!on || !lang || limitReason(lines)) return
    let live = true
    void highlightMany([{ lang, lines }]).then(([tokens]) => {
      if (live && tokens) setDone({ lines, tokens })
    })
    return () => {
      live = false
    }
  }, [on, lang, lines])
  const tokens = on && done?.lines === lines ? done.tokens : null
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          <Code text={line} tokens={tokens?.[i] ?? null} />
        </Fragment>
      ))}
    </>
  )
}

/** The switch of the syntax colours for the file panel, with the reason when a file is too big to colour. */
export function SyntaxToggle({ notice }: { notice: string | null }): React.JSX.Element {
  const on = useSyntaxColours()
  return (
    <>
      {on && notice && (
        <span className="muted small" data-testid="syntax-notice">
          {notice}
        </span>
      )}
      <label className="viewedbtn" title="Colour the code by its language">
        <input type="checkbox" data-testid="syntax-toggle" checked={on} onChange={(e) => setSyntaxColours(e.target.checked)} /> Colours
      </label>
    </>
  )
}
