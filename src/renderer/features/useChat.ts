import { useCallback, useEffect, useRef, useState } from 'react'
import { applyLine, endAnswer, newAnswer, type ChatAnswer } from '@shared/chat-reader'
import type { ChatEvent, ChatRequest } from '@shared/chat'
import { api } from '../api'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** The streamed answer state, for an assistant message. */
  answer?: ChatAnswer
  /** True while the answer is still streaming. */
  busy?: boolean
}

/** What a screen decides about a turn. The hook adds the session, the resume flag and the model. */
export type BuiltRequest = { kind: 'line'; slug: string; mr: string; sha: string; prompt: string } | { kind: 'review'; slug: string; prompt: string }

export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export const MODEL_OPTIONS: { id: Model; label: string }[] = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' }
]

/** The pick is shared by both chats and kept for the user (default Sonnet). */
export function loadModel(): Model {
  try {
    const v = localStorage.getItem('codediff:askModel')
    return MODEL_OPTIONS.some((m) => m.id === v) ? (v as Model) : 'sonnet'
  } catch {
    return 'sonnet'
  }
}
export function saveModel(m: Model): void {
  try {
    localStorage.setItem('codediff:askModel', m)
  } catch {
    /* storage can be blocked */
  }
}

const uuid = (): string => crypto.randomUUID()

/**
 * One conversation with the AI tool. The app keeps no chat state on disk: the tool keeps the session, and the hook keeps only
 * the UUID and whether the session started (file 04 section 2.4). A first turn that never reached the model leaves no session,
 * so the next question starts a new one.
 */
export function useChat(opts: {
  /** Builds the request for one turn. `resume` is false for the first turn. */
  request: (question: string, resume: boolean) => BuiltRequest
  firstStatus: string
  model: Model
}): {
  messages: ChatMessage[]
  busy: boolean
  send: (question: string) => Promise<void>
  stop: () => void
  reset: () => void
} {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const session = useRef(uuid())
  const started = useRef(false)
  const current = useRef<{ id: string; msg: number } | null>(null)
  // Between pressing Ask and the stream id coming back: a Stop is remembered, and early events are kept.
  const starting = useRef<{ msg: number; stop: boolean } | null>(null)
  const early = useRef<ChatEvent[]>([])
  const handleRef = useRef<(e: ChatEvent) => void>(() => undefined)
  const next = useRef(1)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const patch = useCallback((msg: number, fn: (a: ChatAnswer) => ChatAnswer, extra: Partial<ChatMessage> = {}) => {
    setMessages((all) => all.map((m) => (m.id === msg && m.answer ? { ...m, answer: fn(m.answer), ...extra } : m)))
  }, [])

  useEffect(() => {
    const handle = (e: ChatEvent): void => {
      const cur = current.current
      if (!cur || cur.id !== e.id) return
      if ('end' in e) {
        patch(cur.msg, (a) => endAnswer(a), { busy: false })
        current.current = null
        setBusy(false)
        return
      }
      patch(cur.msg, (a) => {
        const n = applyLine(a, e.line, optsRef.current.model)
        if (n.started) started.current = true // the session exists, so a follow-up resumes it
        return n
      })
    }
    handleRef.current = handle
    return api.chat.onEvent((e) => {
      if (!current.current && starting.current)
        early.current.push(e) // the stream id is not known yet
      else handle(e)
    })
  }, [patch])

  // The chat is stopped when the component goes away, because a running answer costs money.
  useEffect(
    () => () => {
      if (current.current) void api.chat.cancel(current.current.id)
    },
    []
  )

  const send = useCallback(
    async (question: string): Promise<void> => {
      const q = question.trim()
      if (!q || current.current) return
      const userId = next.current++
      const botId = next.current++
      setMessages((m) => [
        ...m,
        { id: userId, role: 'user', text: q },
        { id: botId, role: 'assistant', text: '', answer: newAnswer(optsRef.current.firstStatus), busy: true }
      ])
      setBusy(true)
      const resume = started.current
      const built = optsRef.current.request(q, resume)
      starting.current = { msg: botId, stop: false }
      early.current = []
      const r = await api.chat.start({ ...built, session: session.current, resume, model: optsRef.current.model } as ChatRequest)
      const stopAsked = starting.current?.stop ?? false
      starting.current = null
      if (!r.ok) {
        patch(botId, (a) => ({ ...a, status: '', error: r.error }), { busy: false })
        setBusy(false)
        return
      }
      current.current = { id: r.value.id, msg: botId }
      if (stopAsked) void api.chat.cancel(r.value.id) // Stop was pressed before the id came back
      for (const e of early.current.splice(0)) handleRef.current(e)
    },
    [patch]
  )

  const stop = useCallback(() => {
    const cur = current.current
    if (!cur) {
      if (starting.current) {
        starting.current.stop = true
        patch(starting.current.msg, (a) => ({ ...a, stopped: true, status: '' }))
      }
      return
    }
    patch(cur.msg, (a) => ({ ...a, stopped: true, status: '' }))
    void api.chat.cancel(cur.id)
  }, [patch])

  const reset = useCallback(() => {
    if (current.current) void api.chat.cancel(current.current.id)
    current.current = null
    session.current = uuid()
    started.current = false
    setMessages([])
    setBusy(false)
  }, [])

  return { messages, busy, send, stop, reset }
}
