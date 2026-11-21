import { useEffect, useMemo, useRef, useState } from 'react'
import { newCommentId, type PendingComment } from '@shared/comments'
import { languageForFence } from '@shared/syntax-language'
import { CodeBlock } from '../highlight/Code'
import { cardHeader, parseActions, splitActions, type Card, type ReviewFacts } from '@shared/prompts'
import { MODEL_OPTIONS, type ChatMessage, type Model } from './useChat'
import { useReview } from './review-context'
import { Markdown } from './ui'

/** Markdown with fenced code blocks. An open fence, while the answer streams, shows as code until it closes. */
export function ChatMarkdown({ text }: { text: string }): React.JSX.Element {
  const parts = text.split('```')
  return (
    <div className="chatmd">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="codeblock">
            {/* A fence that is still open stays plain, so a streaming answer does not start a job for each piece */}
            <CodeBlock text={p.replace(/^[^\n]*\n/, '')} lang={i === parts.length - 1 ? null : languageForFence(p.split('\n', 1)[0])} />
          </pre>
        ) : p.trim() ? (
          <Markdown key={i} text={p} />
        ) : null
      )}
    </div>
  )
}

export function ModelSelect(props: { value: Model; onChange(m: Model): void }): React.JSX.Element {
  return (
    <select aria-label="Model" title="The model of the next answer" value={props.value} onChange={(e) => props.onChange(e.target.value as Model)}>
      {MODEL_OPTIONS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  )
}

/** The facts the card validator needs: each change, whether it is open, its paths, and each thread. */
export function useFacts(): ReviewFacts {
  const r = useReview()
  return useMemo(() => {
    const mrs = new Map(
      r.data.mrs.map((m) => [
        m.key,
        { iid: m.snapshot.info.ref.iid, open: m.snapshot.info.state === 'opened', paths: new Set(m.files.flatMap((f) => [f.path, f.oldPath])) }
      ])
    )
    const threads = new Map(r.data.mrs.flatMap((m) => m.snapshot.threads.map((t) => [t.id, { mr: m.key, resolvable: t.resolvable }] as const)))
    return { mrs, threads }
  }, [r.data])
}

type CardState = 'ready' | 'busy' | 'applied' | 'dismissed'

/** The proposed actions of an answer, as cards. Nothing happens until the reviewer presses Apply (file 04 section 6.5). */
export function ActionCards({ json }: { json: string }): React.JSX.Element | null {
  const r = useReview()
  const facts = useFacts()
  const cards: Card[] = useMemo(() => parseActions(json, facts), [json, facts])
  const [state, setState] = useState<Record<number, { s: CardState; error?: string }>>({})
  const stateOf = (i: number): { s: CardState; error?: string } => state[i] ?? { s: 'ready' }
  const iidOf = (key: string): string | undefined =>
    facts.mrs.get(key)?.iid.toString() ?? (facts.threads.get(key) ? facts.mrs.get(facts.threads.get(key)!.mr)?.iid.toString() : undefined)

  const apply = async (i: number): Promise<void> => {
    const a = cards[i].action
    if (!a || stateOf(i).s !== 'ready') return
    setState((s) => ({ ...s, [i]: { s: 'busy' } }))
    try {
      if (a.type === 'comment') {
        const mr = r.mrByKey(a.mr)!
        const file = mr.files.find((f) => f.path === a.path || f.oldPath === a.path)!
        const lineText = a.line ? (file.levels.raw.hunks.flat().find((l) => l.n === a.line && l.t !== '-')?.x ?? file.lines?.[a.line - 1]) : undefined
        const draft: PendingComment = {
          id: newCommentId(),
          mr: a.mr,
          diffRefs: mr.snapshot.info.diffRefs,
          path: file.path,
          oldPath: file.oldPath,
          oldLine: null,
          newLine: a.line ?? null,
          body: a.body,
          view: 'mr',
          combinedPath: null,
          ...(lineText !== undefined ? { lineText } : {})
        }
        await r.saveDraft(draft) // a draft, not posted
      } else if (a.type === 'open') r.requestOpen(a.mr, a.path, a.line ?? null)
      else if (a.type === 'viewed') r.requestViewed(a.mr, a.paths)
      else {
        const t = facts.threads.get(a.thread)!
        const thread = r.mrByKey(t.mr)?.snapshot.threads.find((x) => x.id === a.thread)
        const want = a.resolved !== false
        if (thread && thread.resolved !== want) {
          const err = await r.resolve(t.mr, a.thread, want)
          if (err) throw new Error(err)
          r.setThreadResolved(t.mr, a.thread, want)
        }
      }
      setState((s) => ({ ...s, [i]: { s: 'applied' } }))
    } catch (e) {
      setState((s) => ({ ...s, [i]: { s: 'ready', error: e instanceof Error ? e.message : String(e) } })) // back to ready with the error
    }
  }

  const ready = cards.map((c, i) => (c.action && stateOf(i).s === 'ready' ? i : -1)).filter((i) => i >= 0)
  if (cards.length === 0) return null
  return (
    <div className="cards" data-testid="action-cards">
      {cards.map((c, i) => {
        const st = stateOf(i)
        const invalid = c.action === null
        return (
          <div key={i} className={`card ${invalid ? 'invalid' : ''} ${st.s === 'applied' || st.s === 'dismissed' ? 'faded' : ''}`} data-testid="action-card">
            <strong>{c.action ? cardHeader(c.action, iidOf) : 'Not applied'}</strong>
            {c.action?.type === 'comment' && <Markdown text={c.action.body} />}
            {c.action?.type === 'viewed' && <div className="mono small">{c.action.paths.join(', ')}</div>}
            {(c.error || st.error) && <div className="bad-text small">{c.error ?? st.error}</div>}
            {c.action && st.s === 'ready' && (
              <div className="threadfoot">
                <button className="primary" onClick={() => void apply(i)}>
                  Apply
                </button>
                <button onClick={() => setState((s) => ({ ...s, [i]: { s: 'dismissed' } }))}>Dismiss</button>
              </div>
            )}
            {c.action && st.s !== 'ready' && (
              <span className="muted small">{st.s === 'busy' ? 'Applying…' : st.s === 'applied' ? 'Applied' : 'Dismissed'}</span>
            )}
          </div>
        )
      })}
      {ready.length > 1 && (
        <button
          onClick={async () => {
            for (const i of ready) await apply(i) // the ready cards, one after the other
          }}
        >
          Apply all {ready.length}
        </button>
      )}
    </div>
  )
}

/** The messages of a chat, following the end of the answer unless the reader scrolled up by more than 40 px. */
export function Messages(props: { messages: ChatMessage[]; empty: string; actions?: boolean }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  return (
    <div
      className="chatmessages"
      ref={box}
      data-testid="chat-messages"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {props.messages.length === 0 && <p className="muted small">{props.empty}</p>}
      {props.messages.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} className="bubble user" data-testid="chat-question">
              {m.text}
            </div>
          )
        }
        const a = m.answer!
        const { text, json } = props.actions ? splitActions(a.text) : { text: a.text, json: null }
        return (
          <div key={m.id} className="bubble bot" data-testid="chat-answer">
            {text && <ChatMarkdown text={text} />}
            {a.status && (
              <div className="muted small" data-testid="chat-status">
                <span className="spin">◐</span> {a.status}
              </div>
            )}
            {a.error && (
              <div className="bad-text small" data-testid="chat-error">
                {a.error}
              </div>
            )}
            {a.stopped && <div className="muted small">Stopped</div>}
            {a.footer && !a.error && (
              <div className="muted small" data-testid="chat-footer">
                {a.footer}
              </div>
            )}
            {a.footer && json !== null && !a.error && <ActionCards json={json} />}
          </div>
        )
      })}
    </div>
  )
}

export function ChatInput(props: { placeholder: string; busy: boolean; onSend(text: string): void; onStop(): void; onEscape?(): void }): React.JSX.Element {
  const [text, setText] = useState('')
  const send = (): void => {
    if (!text.trim() || props.busy) return
    props.onSend(text)
    setText('')
  }
  return (
    <div className="chatinput">
      <textarea
        aria-label="Question"
        rows={2}
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') props.onEscape?.()
        }}
      />
      {props.busy ? (
        <button data-testid="chat-stop" onClick={props.onStop}>
          Stop
        </button>
      ) : (
        <button className="ask" data-testid="chat-ask" onClick={send}>
          Ask
        </button>
      )}
    </div>
  )
}
