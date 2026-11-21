import { issueFile, criteriaFromFile } from '@shared/issues'
import type { IssueData } from '@shared/issues'
import type { BuildResult } from '@shared/review'
import { readComments } from './comments'
import { startSections } from './sections'
import { writeContext, type ReviewContext } from './context'
import { reviewDir } from './reviews'
import { startSummaries, summariesOf } from './summaries'
import { scanClones, type Clone } from './workspace'

/** A criterion of an issue file, named `<key> AC<n>` (file 01 section 3.6). */
export interface Criterion {
  name: string
  text: string
}

/**
 * What a review window knows after a build: the result, and the review context that is written in the background.
 * The chats and the AI runs wait for the context (file 04 section 4.2).
 */
export interface Session {
  root: string
  slug: string
  result: BuildResult
  cloneOf: Map<string, Clone>
  issues: IssueData[]
  context: Promise<ReviewContext>
  /** `gathering` until the context is written, then `ready` or `failed`. */
  contextStatus: 'gathering' | 'ready' | 'failed'
  contextError: string | null
  /** The criteria of the issue files. Known once the summaries are written. */
  criteria: Criterion[]
  /** Called when the context status or the criteria change. */
  onChange: Set<() => void>
}

const sessions = new Map<string, Session>()
const sessionListeners = new Set<(slug: string) => void>()
/** Be told when the context status or the criteria of any review change. */
export function onSessionChange(cb: (slug: string) => void): () => void {
  sessionListeners.add(cb)
  return () => sessionListeners.delete(cb)
}
export const sessionOf = (slug: string): Session | undefined => sessions.get(slug)

/** Start the summaries and then the context, in the background. A failed context is kept as a rejected promise and shown by the chat. */
export function startSession(root: string, slug: string, result: BuildResult, cloneOf: Map<string, Clone>, issues: IssueData[]): Session {
  const dir = reviewDir(root, slug)
  const summaries = startSummaries(dir, slug, issues)
  const session = {
    root,
    slug,
    result,
    cloneOf,
    issues,
    contextStatus: 'gathering',
    contextError: null,
    criteria: [],
    onChange: new Set()
  } as unknown as Session
  const changed = (): void => {
    session.onChange.forEach((f) => f())
    sessionListeners.forEach((f) => f(slug))
  }

  session.context = (async (): Promise<ReviewContext> => {
    await summaries.promise.catch(() => undefined) // the context waits for the summaries, so the issue files hold them
    const found = await summariesOf(slug)
    const issueFiles = new Map(issues.map((t) => [t.key, issueFile(t, found.get(t.key)?.summary ?? null, found.get(t.key)?.reason ?? null)]))
    // The criteria are read from the issue files, which hold the summaries (file 01 section 3.6)
    session.criteria = issues.filter((t) => !t.error).flatMap((t) => criteriaFromFile(t.key, issueFiles.get(t.key) ?? ''))
    changed()
    const drafts = Object.values(await readComments(root, slug))
    return writeContext({ root, reviewDir: dir, result, cloneOf, issueFiles, drafts, allClones: await scanClones(root), includeOtherRepos: true })
  })()
  session.context.then(
    () => {
      session.contextStatus = 'ready'
      changed()
    },
    (e: unknown) => {
      session.contextStatus = 'failed'
      session.contextError = e instanceof Error ? e.message : String(e)
      changed()
    }
  )
  sessions.set(slug, session)
  // The sections are written in the background when it is missing or out of date. Tests start it only when they ask.
  if (process.env['CODEDIFF_TEST'] !== '1' || process.env['CODEDIFF_TEST_SECTIONS'] === '1') void startSections(session)
  return session
}
