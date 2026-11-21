import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SECTIONS_INSTRUCTIONS,
  SECTIONS_PROMPT,
  SECTIONS_PROMPT_VERSION,
  basisProblems,
  checkSections,
  giveUpMessage,
  problemPrompt,
  sectionFactsOf,
  type SectionsBasis,
  type SectionsDocument,
  type SectionsState
} from '@shared/sections'
import type { Effort, Model } from '../processes/claude'
import { answer, capabilities, llmState, missingMessage } from '../processes/llm'
import { atomicWrite, reviewDir } from './reviews'
import type { Session } from './session'

/**
 * How the AI tool writes the page. They are named here, in one place, so a change of model is one line. The page is written when the
 * reader opens the view, so a fast and cheap model suits it. A weaker model gets an explicit prompt, and the checks send exact problems back.
 */
export const SECTIONS_MODEL: Model = 'sonnet'
export const SECTIONS_EFFORT: Effort = 'medium'
/** The most turns of the tool in one try. */
export const SECTIONS_MAX_TURNS = 80
/** The tries for one page: the answer, and two fixes of the problems that the checker found. */
export const SECTIONS_TRIES = 3
/** A try that gives no answer in this time is stopped, and the run fails with a message. */
export const SECTIONS_TRY_TIMEOUT_MS = 10 * 60_000

const states = new Map<string, SectionsState>()
/** The newest session of each review. A rebuild replaces it. */
const sessions = new Map<string, Session>()
/** The reviews with a run in progress. It never holds a review twice, so two runs never start for one review. */
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
  version: SECTIONS_PROMPT_VERSION,
  heads: Object.fromEntries(session.result.mrs.map((m) => [m.key, m.snapshot.info.diffRefs.head]))
})

/** The saved page, checked against the changes of the session. The page is valid, or the problems say why it is out of date. */
async function readSaved(session: Session): Promise<{ document: SectionsDocument | null; problems: string[] }> {
  const dir = reviewDir(session.root, session.slug)
  const saved = await readJson<unknown>(join(dir, 'sections.json'))
  if (!saved) return { document: null, problems: [] }
  const check = checkSections(JSON.stringify(saved), sectionFactsOf(session.result.mrs))
  const problems = [...check.problems, ...basisProblems(await readJson<SectionsBasis>(join(dir, 'sections-basis.json')), basisOf(session))]
  return { document: problems.length === 0 ? check.document : null, problems }
}

/**
 * At each build: read the saved page and check it against the new changes. A valid page goes to the window. An invalid or missing page
 * is withheld, and nothing is written. A build never starts the AI tool. The page is written when the reader opens the Summarised
 * view (`requestSections`).
 */
export async function loadSections(session: Session): Promise<void> {
  sessions.set(session.slug, session)
  if (running.has(session.slug)) return // a run is in progress: its state stays, and its end checks the page against this session
  const { document, problems } = await readSaved(session)
  set(session.slug, { pending: false, document, problems: document ? [] : problems, error: null, context: document ? 'ready' : null })
}

/**
 * The reader opened the Summarised view, or pressed Try again. A valid saved page is used as it is. Otherwise the AI tool writes the
 * page, unless a run is in progress for the review. Leaving the view does not stop a run: the page is saved when it ends, and it is
 * there when the reader comes back.
 */
export async function requestSections(slug: string): Promise<void> {
  const session = sessions.get(slug)
  if (!session || running.has(slug)) return
  running.add(slug) // set before the first wait, so a second request finds it
  let started = false
  try {
    const saved = await readSaved(session)
    if (saved.document) return void set(slug, { pending: false, document: saved.document, problems: [], error: null, context: 'ready' })
    set(slug, { pending: true, document: null, problems: saved.problems, error: null, context: 'gathering' })
    started = true
  } finally {
    if (!started) running.delete(slug) // a valid saved page, or a failed read: no run, so the review is free again
  }
  await run(session)
}

async function run(session: Session): Promise<void> {
  const { root, slug, result } = session
  const dir = reviewDir(root, slug)
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
    for (let attempt = 1; attempt <= SECTIONS_TRIES; attempt++) {
      const stop = new AbortController()
      const timer = setTimeout(() => stop.abort(), tryTimeoutMs)
      let text: string
      try {
        text = await answer(
          {
            workingDirectory: ctx.dir,
            session: id,
            resume: attempt > 1 && capabilities().resume,
            model: SECTIONS_MODEL,
            effort: SECTIONS_EFFORT,
            maxTurns: SECTIONS_MAX_TURNS,
            tools: 'Read,Grep,Glob',
            instructions: SECTIONS_INSTRUCTIONS,
            extraDirectories: ctx.repoDirs,
            // a tool with no session gets its earlier answer back with the problems
            prompt: attempt > 1 && !capabilities().resume ? `${SECTIONS_PROMPT}\n\nYour earlier answer:\n\n${previous}\n\n${prompt}` : prompt
          },
          stop.signal
        )
      } catch (e) {
        // The timer stopped the tool, so the reader gets the reason and not the message of a tool that was killed
        if (stop.signal.aborted) {
          const waited = tryTimeoutMs >= 60_000 ? `${Math.round(tryTimeoutMs / 60_000)} minutes` : `${(tryTimeoutMs / 1000).toFixed(1)} seconds`
          throw new Error(`The AI tool gave no answer in ${waited}, so the run was stopped.`, { cause: e })
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
      const check = checkSections(text, facts)
      // A page that is too long after the last try is cut to its first sections, which are in the order of their importance. The note in
      // restText says so, and the changes of the others fall to Everything else. Any other problem still fails the run.
      const page = check.document ?? (attempt === SECTIONS_TRIES ? check.overflow : undefined)
      if (page) {
        await atomicWrite(join(dir, 'sections.json'), JSON.stringify(page))
        await atomicWrite(join(dir, 'sections-basis.json'), JSON.stringify(basisOf(session)))
        const current = sessions.get(slug)
        running.delete(slug)
        // The review was built again during the run: check the new page against the new changes
        if (current && current !== session) return void (await loadSections(current))
        return void set(slug, { pending: false, document: page, problems: [], error: null })
      }
      if (attempt === SECTIONS_TRIES) throw new Error(giveUpMessage(check.problems))
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

let tryTimeoutMs = SECTIONS_TRY_TIMEOUT_MS
/** For the tests: a short time limit, or no argument to restore the real one. */
export function setSectionsTimeoutForTests(ms?: number): void {
  tryTimeoutMs = ms ?? SECTIONS_TRY_TIMEOUT_MS
}

/** For the tests. */
export function resetSectionsMemory(): void {
  states.clear()
  sessions.clear()
  running.clear()
}
