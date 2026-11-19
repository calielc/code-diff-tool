// The chat message state, built from the stream-json lines of claude (file 04 section 2).

export const MODEL_NAMES: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

export interface ChatAnswer {
  text: string
  /** The status line, such as `Reading index.md…`. Empty when text is arriving. */
  status: string
  error: string | null
  /** `<Model> · <seconds> s` once the answer is complete. */
  footer: string | null
  stopped: boolean
  /** True once a stream_event line arrived: the session exists, so a follow-up can resume it. */
  started: boolean
  /** The JSON text of the tool call that is open. */
  tool: { name: string; json: string } | null
}

export const newAnswer = (status = ''): ChatAnswer => ({ text: '', status, error: null, footer: null, stopped: false, started: false, tool: null })

const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** The status line from a finished tool call. A call cut off by Stop names nothing. */
function toolStatus(name: string, json: string): string {
  let input: Record<string, unknown> = {}
  try {
    input = JSON.parse(json) as Record<string, unknown>
  } catch {
    /* an empty input */
  }
  if (name === 'Read' && typeof input.file_path === 'string') return `Reading ${lastSegment(input.file_path)}…`
  if (typeof input.pattern === 'string') return `Searching for ${input.pattern}…`
  return `${name}…`
}

interface Line {
  type?: string
  event?: { type?: string; content_block?: { type?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string } }
  result?: unknown
  is_error?: boolean
  subtype?: string
  duration_ms?: number
  message?: string
}

/** Apply one stdout line. Lines that do not parse are skipped. Returns a new state. */
export function applyLine(prev: ChatAnswer, raw: string, model: string): ChatAnswer {
  if (!raw.startsWith('{')) return prev
  let o: Line
  try {
    o = JSON.parse(raw) as Line
  } catch {
    return prev
  }
  const s: ChatAnswer = { ...prev }
  if (o.type === 'app_error') {
    s.error = typeof o.message === 'string' ? o.message : 'The answer failed.'
    return s
  }
  if (o.type === 'result') {
    const seconds = Math.round((o.duration_ms ?? 0) / 1000)
    s.footer = `${MODEL_NAMES[model] ?? model} · ${seconds} s`
    if (o.is_error) s.error = typeof o.result === 'string' && o.result ? o.result : `Claude stopped: ${o.subtype ?? 'error'}`
    else if (!s.text && typeof o.result === 'string') s.text = o.result // no text was streamed
    s.status = ''
    return s
  }
  if (o.type !== 'stream_event' || !o.event) return s
  s.started = true
  const e = o.event
  if (e.type === 'content_block_start') {
    if (e.content_block?.type === 'tool_use') {
      s.tool = { name: e.content_block.name ?? 'tool', json: '' }
      s.status = e.content_block.name === 'Read' ? 'Reading…' : 'Searching…'
    } else if (e.content_block?.type === 'text' && s.text) s.text += '\n\n' // a new text block starts a new paragraph
  } else if (e.type === 'content_block_delta') {
    if (e.delta?.type === 'text_delta') {
      s.text += e.delta.text ?? ''
      s.status = ''
    } else if (e.delta?.type === 'input_json_delta' && s.tool) s.tool = { ...s.tool, json: s.tool.json + (e.delta.partial_json ?? '') }
  } else if (e.type === 'content_block_stop' && s.tool) {
    s.status = toolStatus(s.tool.name, s.tool.json)
    s.tool = null
  }
  return s
}

/** What to show when the stream ends. */
export function endAnswer(a: ChatAnswer): ChatAnswer {
  const done = { ...a, status: '' }
  if (!done.footer && !done.error && !done.stopped) done.error = 'The answer ended before Claude finished.'
  return done
}
