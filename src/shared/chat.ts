// The types of the chat requests, shared by the window and the main process.

export interface LineChatRequest {
  kind: 'line'
  slug: string
  /** The MR key of the repo the lines belong to. */
  mr: string
  sha: string
  session: string
  resume: boolean
  model: string
  prompt: string
}

export interface ReviewChatRequest {
  kind: 'review'
  slug: string
  session: string
  resume: boolean
  model: string
  prompt: string
}

export type ChatRequest = LineChatRequest | ReviewChatRequest

/** A line of the answer, or the end of the stream. */
export type ChatEvent = { id: string; line: string } | { id: string; end: true }
