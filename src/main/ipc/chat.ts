import { z } from 'zod'
import { CH } from '@shared/channels'
import { SLUG_RE } from '@shared/review'
import type { Result } from '@shared/types'
import { cancelChat, startChat, type ChatEvent } from '../services/chat'
import { handle } from './guard'

const common = { slug: z.string().regex(SLUG_RE), session: z.string().max(64), resume: z.boolean(), model: z.string().max(20), prompt: z.string().max(200_000) }

const request = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), mr: z.string().max(500), sha: z.string().max(64), ...common }),
  z.object({ kind: z.literal('review'), ...common })
])

export function registerChatHandlers(): void {
  /** Starts one turn. The lines come back as `chat:event` messages until the end message. */
  handle(CH.chatStart, request, async (req, event): Promise<Result<{ id: string }>> => {
    const sender = event.sender
    const r = await startChat(req, (e: ChatEvent) => {
      if (!sender.isDestroyed()) sender.send(CH.chatEvent, e)
    })
    // A chat whose window closes is stopped, because it costs money while it runs.
    if (r.ok) sender.once('destroyed', () => cancelChat(r.value.id))
    return r
  })
  handle(CH.chatCancel, z.string().uuid(), (id) => cancelChat(id))
}
