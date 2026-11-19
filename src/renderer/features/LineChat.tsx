import { useState } from 'react'
import type { FileObject, LineObj } from '@shared/diff'
import { lineChatFirstPrompt } from '@shared/prompts'
import { ChatInput, Messages, ModelSelect } from './ChatUi'
import { loadModel, saveModel, useChat, type Model } from './useChat'

/** The chat about some lines, opened under a line (file 02 section 10.1). The app keeps nothing of it. */
export function LineChat(props: {
  slug: string
  file: FileObject
  line: LineObj
  /** The changes behind the line. More than one only in the combined view. */
  mrs: { iid: number; title: string; description: string; merged: boolean }[]
  combined: boolean
  /** The change and the commit whose code the AI reads. */
  chatMr: string
  chatSha: string
  onClose(): void
}): React.JSX.Element {
  const [model, setModelState] = useState<Model>(loadModel)
  const setModel = (m: Model): void => (saveModel(m), setModelState(m))
  const { file, line } = props
  const label = line.n !== null ? `line ${line.n}` : `old line ${line.o}`
  const name = file.path.split('/').pop() ?? file.path
  const mrLabels = props.mrs.map((m) => `!${m.iid}${m.merged ? ' (merged)' : ''}`).join(', ')

  const chat = useChat({
    model,
    firstStatus: `Reading ${label}…`,
    request: (question, resume) => ({
      kind: 'line',
      slug: props.slug,
      mr: props.chatMr,
      sha: props.chatSha,
      // a follow-up sends only the question
      prompt: resume
        ? question
        : lineChatFirstPrompt({
            path: file.path,
            status: file.status,
            oldPath: file.oldPath,
            mrs: props.mrs,
            combined: props.combined,
            rows: [{ t: line.t, o: line.o, n: line.n, x: line.x }],
            hunks: file.levels.raw.hunks,
            question
          })
    })
  })

  return (
    <div className="linechat" data-testid="line-chat" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="chathead">
        <strong>✦ {label}</strong>
        <span className="muted small">
          · {name} · {mrLabels}
        </span>
        <span className="grow" />
        <ModelSelect value={model} onChange={setModel} />
        <button aria-label="Close the chat" title="Close (Esc). The chat is not saved." onClick={props.onClose}>
          ×
        </button>
      </div>
      <Messages messages={chat.messages} empty="No questions yet. The AI answers from the code of the change itself." />
      <ChatInput
        placeholder="Ask about these lines. A follow-up keeps them."
        busy={chat.busy}
        onSend={(q) => void chat.send(q)}
        onStop={chat.stop}
        onEscape={props.onClose}
      />
      <div className="muted small chatfoot">
        Enter sends, Shift+Enter adds a line. The AI reads these lines, the diff of the file, the change and the repo at its head, on your own AI tool. Nothing
        is saved.
      </div>
    </div>
  )
}
