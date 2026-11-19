import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FLOW_INSTRUCTIONS, FLOW_PROMPT, checkFlow, flowFactsOf, giveUpMessage, problemPrompt, type FlowDocument, type FlowState } from '@shared/flow'
import { answer, capabilities, llmState, missingMessage } from '../processes/llm'
import { atomicWrite, reviewDir } from './reviews'
import type { Session } from './session'

const states = new Map<string, FlowState>()
const running = new Set<string>()
const listeners = new Set<(slug: string, state: FlowState) => void>()

const idle = (): FlowState => ({ pending: false, context: null, error: null, flow: null, problems: [] })

export const flowStateOf = (slug: string): FlowState => states.get(slug) ?? idle()

/** Be told when a flow state changes. Returns an unsubscribe function. */
export function subscribeFlow(cb: (slug: string, state: FlowState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function set(slug: string, patch: Partial<FlowState>): void {
  const next = { ...flowStateOf(slug), ...patch }
  states.set(slug, next)
  for (const l of listeners) l(slug, next)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null // a file that cannot be read counts as missing
  }
}

/**
 * At each build: read the saved flow and check it against the new changes. A valid flow goes to the window. An invalid one
 * starts a run, unless one is already running for this review, and is withheld until the new one arrives (file 04 section 5.1).
 */
export async function startFlow(session: Session): Promise<void> {
  const { root, slug, result } = session
  const dir = reviewDir(root, slug)
  const saved = await readJson<unknown>(join(dir, 'flow.json'))
  const savedIssues = (await readJson<string[]>(join(dir, 'flow-issues.json'))) ?? [] // a flow written before this rule reads as an empty list
  const keys = result.issues.map((t) => t.key)
  let problems: string[] = []
  let flow: FlowDocument | null = null
  if (saved) {
    const check = checkFlow(JSON.stringify(saved), flowFactsOf(result.mrs))
    problems = check.problems
    flow = check.flow
    if (JSON.stringify(savedIssues) !== JSON.stringify(keys)) problems = [...problems, 'The issues of the review changed since it was written.']
    if (problems.length > 0) flow = null
  }
  if (flow) return void set(slug, { pending: false, flow, problems: [], error: null, context: 'ready' })
  if (running.has(slug)) return // a run does not restart while one is in progress
  set(slug, { pending: true, flow: null, problems, error: null, context: 'gathering' })
  void run(session)
}

async function run(session: Session): Promise<void> {
  const { root, slug, result } = session
  const dir = reviewDir(root, slug)
  running.add(slug)
  try {
    await rm(join(dir, 'flow-error.txt'), { force: true })
    const ctx = await session.context.catch((e) => {
      set(slug, { context: 'failed' })
      throw e
    })
    set(slug, { context: 'ready' })
    if ((await llmState()) === 'missing') throw new Error(missingMessage())
    const facts = flowFactsOf(result.mrs)
    const id = randomUUID() // one session for the whole run
    let prompt = FLOW_PROMPT
    let previous = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const text = await answer({
        workingDirectory: ctx.dir,
        session: id,
        resume: attempt > 1 && capabilities().resume,
        model: 'opus',
        effort: 'medium',
        maxTurns: 80,
        tools: 'Read,Grep,Glob',
        instructions: FLOW_INSTRUCTIONS,
        extraDirectories: ctx.repoDirs,
        // a tool with no session gets its earlier answer back with the problems
        prompt: attempt > 1 && !capabilities().resume ? `${FLOW_PROMPT}\n\nYour earlier answer:\n\n${previous}\n\n${prompt}` : prompt
      })
      const check = checkFlow(text, facts)
      if (check.flow) {
        await atomicWrite(join(dir, 'flow.json'), JSON.stringify(check.flow))
        await atomicWrite(join(dir, 'flow-issues.json'), JSON.stringify(result.issues.map((t) => t.key)))
        return void set(slug, { pending: false, flow: check.flow, problems: [], error: null })
      }
      if (attempt === 3) throw new Error(giveUpMessage(check.problems))
      previous = text
      prompt = problemPrompt(check.problems)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await writeFile(join(dir, 'flow-error.txt'), message, 'utf8').catch(() => undefined) // a failed run leaves flow.json as it was
    set(slug, { pending: false, error: message })
  } finally {
    running.delete(slug)
  }
}

/** For the tests. */
export function resetFlowMemory(): void {
  states.clear()
  running.clear()
}
