import { useEffect, useState } from 'react'
import { reviewChatPrompt } from '@shared/prompts'
import { ChatInput, Messages, ModelSelect } from './ChatUi'
import { useReview } from './review-context'
import { loadModel, saveModel, useChat, type Model } from './useChat'

const EMPTY =
  'Ask anything about this change: how the changes fit together, what a file does, what could break. The AI reads every diff, the descriptions, the threads, the issues and the code of each repo. Ask it to do something, such as check the tests and comment on gaps: it proposes the comments and other steps as cards, and you apply them.'

/** The round button at the bottom right, and the panel about the whole review (file 02 section 10.3). */
export function ReviewChat(): React.JSX.Element {
  const r = useReview()
  const [open, setOpen] = useState(false)
  const [model, setModelState] = useState<Model>(loadModel)
  const setModel = (m: Model): void => (saveModel(m), setModelState(m))
  const chat = useChat({
    model,
    firstStatus: 'Reading the change…',
    request: (question, resume) => ({
      kind: 'review',
      slug: r.slug,
      prompt: reviewChatPrompt({ mrCount: r.data.mrs.length, title: r.data.title, screen: r.screen, question, resume })
    })
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const has = chat.messages.length > 0
  const tip = `Ask the AI about every change of this review${has ? '. Your chat is kept.' : ''}${chat.busy ? '. The AI is answering.' : ''}`
  return (
    <>
      {!open && (
        <button
          className={`chatfab ${chat.busy ? 'pulse' : ''}`}
          aria-label="Ask the AI about this change"
          title={tip}
          data-testid="review-chat-button"
          onClick={() => setOpen(true)}
        >
          ✦{has && <span className="dot" data-testid="chat-dot" />}
        </button>
      )}
      {open && (
        <div className="chatpanel" role="dialog" aria-label="Ask about this change" data-testid="review-chat">
          <div className="chathead">
            <strong>✦ Ask about this change</strong>
            <span className="muted small">
              · {r.data.mrs.length} {r.data.mrs.length === 1 ? 'MR' : 'MRs'}
            </span>
            <span className="grow" />
            <ModelSelect value={model} onChange={setModel} />
            <button aria-label="New chat" title="Start a new chat" onClick={chat.reset}>
              ↺
            </button>
            <button aria-label="Minimise the chat" title="Minimise (Esc). The chat stays until you reload the page." onClick={() => setOpen(false)}>
              –
            </button>
          </div>
          <Messages messages={chat.messages} empty={EMPTY} actions />
          <ChatInput
            placeholder="Ask about the whole change"
            busy={chat.busy}
            onSend={(q) => void chat.send(q)}
            onStop={chat.stop}
            onEscape={() => setOpen(false)}
          />
          <div className="muted small chatfoot">Enter sends, Shift+Enter adds a line. Runs on your own AI tool. Nothing is saved.</div>
        </div>
      )}
    </>
  )
}
