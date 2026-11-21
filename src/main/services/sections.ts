import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SECTIONS_INSTRUCTIONS,
  SECTIONS_PROMPT,
  basisProblems,
  checkSections,
  giveUpMessage,
  problemPrompt,
  sectionFactsOf,
  type SectionsBasis,
  type SectionsDocument,
  type SectionsState
} from '@shared/sections'
import { answer, capabilities, llmState, missingMessage } from '../processes/llm'
import { atomicWrite, reviewDir } from './reviews'
import type { Session } from './session'

const states = new Map<string, SectionsState>()
const running = new Set<string>()
const listeners = new Set<(slug: string, state: SectionsState) => void>()

const idle = (): SectionsState => ({ pending: false, context: null, error: null, document: null, problems: [] })

export const sectionsStateOf = (slug: string): SectionsState => states.get(slug) ?? idle()

/** Be told when the state of the sections changes. Returns an unsubscribe function. */
export function subscribeSections(cb: (slug: string, state: SectionsState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function set(slug: string, patch: Partial<SectionsState>): void {
  const next = { ...sectionsStateOf(slug), ...patch }
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

/** What the page is written for now: the issues and the head commit of each change. */
const basisOf = (session: Session): SectionsBasis => ({
  issues: session.result.issues.map((t) => t.key),
  heads: Object.fromEntries(session.result.mrs.map((m) => [m.key, m.snapshot.info.diffRefs.head]))
})

/**
 * At each build: read the saved page and check it against the new changes. A valid page goes to the window. An invalid one starts a run,
 * unless one is already running for this review, and is withheld until the new one arrives.
 */
export async function startSections(session: Session): Promise<void> {
  const { slug, result } = session
  const dir = reviewDir(session.root, slug)
  const saved = await readJson<unknown>(join(dir, 'sections.json'))
  let problems: string[] = []
  let document: SectionsDocument | null = null
  if (saved) {
    const check = checkSections(JSON.stringify(saved), sectionFactsOf(result.mrs))
    problems = [...check.problems, ...basisProblems(await readJson<SectionsBasis>(join(dir, 'sections-basis.json')), basisOf(session))]
    document = problems.length === 0 ? check.document : null
  }
  if (document) return void set(slug, { pending: false, document, problems: [], error: null, context: 'ready' })
  if (running.has(slug)) return // a run does not restart while one is in progress
  set(slug, { pending: true, document: null, problems, error: null, context: 'gathering' })
  void run(session)
}

async function run(session: Session): Promise<void> {
  const { root, slug, result } = session
  const dir = reviewDir(root, slug)
  running.add(slug)
  try {
    await rm(join(dir, 'sections-error.txt'), { force: true })
    const ctx = await session.context.catch((e) => {
      set(slug, { context: 'failed' })
      throw e
    })
    set(slug, { context: 'ready' })
    if ((await llmState()) === 'missing') throw new Error(missingMessage())
    const facts = sectionFactsOf(result.mrs)
    const id = randomUUID() // one session for the whole run
    let prompt = SECTIONS_PROMPT
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
        instructions: SECTIONS_INSTRUCTIONS,
        extraDirectories: ctx.repoDirs,
        // a tool with no session gets its earlier answer back with the problems
        prompt: attempt > 1 && !capabilities().resume ? `${SECTIONS_PROMPT}\n\nYour earlier answer:\n\n${previous}\n\n${prompt}` : prompt
      })
      const check = checkSections(text, facts)
      if (check.document) {
        await atomicWrite(join(dir, 'sections.json'), JSON.stringify(check.document))
        await atomicWrite(join(dir, 'sections-basis.json'), JSON.stringify(basisOf(session)))
        return void set(slug, { pending: false, document: check.document, problems: [], error: null })
      }
      if (attempt === 3) throw new Error(giveUpMessage(check.problems))
      previous = text
      prompt = problemPrompt(check.problems)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await writeFile(join(dir, 'sections-error.txt'), message, 'utf8').catch(() => undefined) // a failed run leaves sections.json as it was
    set(slug, { pending: false, error: message })
  } finally {
    running.delete(slug)
  }
}

/** For the tests. */
export function resetSectionsMemory(): void {
  states.clear()
  running.clear()
}
