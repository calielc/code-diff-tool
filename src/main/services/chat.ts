import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatEvent, ChatRequest, LineChatRequest, ReviewChatRequest } from '@shared/chat'
import { LINE_CHAT_INSTRUCTIONS, REVIEW_CHAT_INSTRUCTIONS } from '@shared/prompts'
import type { Result } from '@shared/types'
import { hasCommit } from '../clients/git'
import { UUID_RE, isModel, type AskInput } from '../processes/claude'
import { ask, capabilities, llmState, missingMessage, toolName } from '../processes/llm'
import { readComments } from './comments'
import { reviewStateMarkdown, type ReviewContext } from './context'
import { exportCommit } from './export'
import { reviewDir } from './reviews'
import { sessionOf } from './session'

export type { ChatEvent, ChatRequest, LineChatRequest, ReviewChatRequest }

const streams = new Map<string, AbortController>()

/** The review context of the first turn of each session. A follow-up must run in the same folder. */
const sessionContexts = new Map<string, ReviewContext>()

/** What was said so far, for a tool that keeps no session. */
const transcripts = new Map<string, { q: string; a: string }[]>()

const appError = (message: string): string => JSON.stringify({ type: 'app_error', message })

/** Check the request and find where Claude runs. The first failure rejects the call and starts nothing (file 04 sections 3.1 and 3.2). */
async function prepare(req: ChatRequest): Promise<Result<{ input: AskInput; stateFile?: () => Promise<void> }>> {
  const s = sessionOf(req.slug)
  if (!s) return { ok: false, error: 'The review is not loaded: open it again.' }
  if (!UUID_RE.test(req.session)) return { ok: false, error: 'session is not a UUID.' }
  if (!isModel(req.model)) return { ok: false, error: 'model is not one of haiku, sonnet, opus, fable.' }
  if (!req.prompt.trim()) return { ok: false, error: 'prompt is empty.' }
  const base = { session: req.session, resume: req.resume, model: req.model, prompt: req.prompt }

  if (req.kind === 'line') {
    const clone = s.cloneOf.get(req.mr)
    if (!clone) return { ok: false, error: `repository ${req.mr} has no local clone in the workspace.` }
    if (!/^[0-9a-f]{40}$/.test(req.sha)) return { ok: false, error: 'sha is not 40 hex characters.' }
    if (!(await hasCommit(clone.dir, req.sha))) return { ok: false, error: `Commit ${req.sha} is not in the clone of ${clone.name}.` }
    try {
      const folder = await exportCommit(clone.dir, req.sha, join(reviewDir(s.root, req.slug), 'heads', req.sha))
      return { ok: true, value: { input: { ...base, workingDirectory: folder, instructions: LINE_CHAT_INSTRUCTIONS, maxTurns: 20, tools: 'Read,Grep,Glob' } } }
    } catch (e) {
      return { ok: false, error: `The code at ${req.sha.slice(0, 12)} could not be exported: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // The review chat: wait for the review context. A follow-up keeps the context of its first turn.
  let ctx = req.resume ? sessionContexts.get(req.session) : undefined
  if (!ctx) {
    try {
      ctx = await s.context
    } catch (e) {
      return { ok: false, error: `The review context failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    sessionContexts.set(req.session, ctx)
  }
  const dir = ctx.dir
  return {
    ok: true,
    value: {
      input: { ...base, workingDirectory: dir, instructions: REVIEW_CHAT_INSTRUCTIONS, maxTurns: 40, tools: 'Read,Grep,Glob', extraDirectories: ctx.repoDirs },
      // review-state.md is written again before every turn, so new pending comments are visible
      stateFile: async () => {
        const drafts = Object.values(await readComments(s.root, req.slug))
        await writeFile(join(dir, 'review-state.md'), reviewStateMarkdown(s.result, drafts), 'utf8')
      }
    }
  }
}

/**
 * Start one chat turn. Resolves at once with the stream id, and the lines arrive through `emit`. A failure before the result
 * line becomes one `app_error` line, so the window always shows why (file 04 section 2.3).
 */
export async function startChat(req: ChatRequest, emit: (e: ChatEvent) => void): Promise<Result<{ id: string }>> {
  const prepared = await prepare(req)
  if (!prepared.ok) return prepared
  const { input, stateFile } = prepared.value
  const id = randomUUID()
  const ac = new AbortController()
  streams.set(id, ac)

  void (async () => {
    let sawResult = false
    let answerText = ''
    try {
      if ((await llmState()) === 'missing') throw new Error(missingMessage())
      await stateFile?.()
      // A tool with no session gets the earlier turns in front of the question.
      let prompt = input.prompt
      let resume = input.resume
      if (!capabilities().resume) {
        const past = transcripts.get(req.session) ?? []
        if (input.resume && past.length > 0)
          prompt = `The earlier questions and answers of this conversation:\n\n${past.map((t) => `Question: ${t.q}\n\nAnswer: ${t.a}`).join('\n\n')}\n\nThe new question:\n\n${input.prompt}`
        resume = false
      }
      for await (const line of ask({ ...input, prompt, resume }, ac.signal)) {
        if (line.startsWith('{')) {
          try {
            const o = JSON.parse(line) as { type?: string; result?: unknown }
            if (o.type === 'result') {
              sawResult = true
              if (typeof o.result === 'string') answerText = o.result
            }
          } catch {
            /* not JSON: passed on as it is */
          }
        }
        emit({ id, line })
      }
      if (!sawResult && !ac.signal.aborted) emit({ id, line: appError(`${toolName()} ended before it answered.`) })
      else if (sawResult && !capabilities().resume) transcripts.set(req.session, [...(transcripts.get(req.session) ?? []), { q: input.prompt, a: answerText }])
    } catch (e) {
      // Claude also exits with an error code after an error result, and the window shows that error already.
      if (!sawResult && !ac.signal.aborted) emit({ id, line: appError(e instanceof Error ? e.message : String(e)) })
    } finally {
      streams.delete(id)
      emit({ id, end: true })
    }
  })()
  return { ok: true, value: { id } }
}

/** Stop a running answer. The whole process tree is killed. */
export function cancelChat(id: string): void {
  streams.get(id)?.abort()
}

export function cancelAllChats(): void {
  for (const ac of streams.values()) ac.abort()
}

/** For the tests: forget the remembered contexts and transcripts. */
export function resetChatMemory(): void {
  sessionContexts.clear()
  transcripts.clear()
}
