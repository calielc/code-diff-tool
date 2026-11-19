import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { problemPrompt } from '@shared/flow'
import { acPrompt, AC_INSTRUCTIONS, REVIEW_INSTRUCTIONS, reviewPrompt } from '@shared/review-prompts'
import { checkReviewAnswer, type ChecklistEntry } from '@shared/review-answer'
import type { Result } from '@shared/types'
import { isEffort, isModel, type Effort, type Model } from '../processes/claude'
import { ask, capabilities, llmState, missingMessage, toolName } from '../processes/llm'
import { readAppState } from './app-state'
import { readComments, saveComment } from './comments'
import { claudeDraftsMarkdown, threadsMarkdown } from './context'
import { atomicWrite, reviewDir, reviewsDir } from './reviews'
import { sessionOf, type Criterion, type Session } from './session'
import { listSkills, readPicks, type AiPicks, type ReviewSkill } from './skills'
import { randomUUID } from 'node:crypto'

export type RunKind = 'review' | 'ac'

/** The record of a run, saved after every change (file 04 section 7.6). */
export interface RunRecord {
  skill: string | null
  plugin: string | null
  model: string
  effort: string | null
  startedAt: string
  /** The head commit of each MR that the run read. */
  commits: Record<string, string>
  state: 'running' | 'done' | 'failed' | 'stopped'
  lastStepAt: string | null
  endedAt: string | null
  stoppedByRestart: boolean | null
  error: string | null
  withoutIssues: string[] | null
  drafts: string[] | null
  checklist: ChecklistEntry[] | null
  report: string | null
}

/** A run as the window sees it: the record, plus the live counters while it runs. */
export interface LiveRun extends RunRecord {
  reads: number
  agents: number
  step: string
}

export interface AiState {
  context: 'gathering' | 'ready' | 'failed' | null
  contextError: string | null
  /** Issues that could not be read, with the reason. */
  unreadable: Record<string, string>
  criteria: Criterion[]
  skills: Omit<ReviewSkill, 'folder'>[]
  picks: AiPicks
  review: LiveRun | null
  ac: LiveRun | null
  /** The AI tool, for messages. */
  tool: string
}

const FILE: Record<RunKind, string> = { review: 'review-run.json', ac: 'ac-run.json' }

interface Active {
  live: LiveRun
  abort: AbortController
}
const active = new Map<string, Active>()
const keyOf = (slug: string, kind: RunKind): string => `${slug}:${kind}`
const listeners = new Set<(slug: string) => void>()

/** Be told when a run, or the context, changes. Returns an unsubscribe function. */
export function subscribeAi(cb: (slug: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const notify = (slug: string): void => listeners.forEach((l) => l(slug))

const record = (live: LiveRun): RunRecord => {
  const { reads: _r, agents: _a, step: _s, ...rec } = live
  return rec
}

async function save(root: string, slug: string, kind: RunKind, live: LiveRun): Promise<void> {
  await atomicWrite(join(reviewDir(root, slug), FILE[kind]), JSON.stringify(record(live), null, 2)).catch(() => undefined)
  notify(slug)
}

async function readRecord(root: string, slug: string, kind: RunKind): Promise<LiveRun | null> {
  try {
    const r = JSON.parse(await readFile(join(reviewDir(root, slug), FILE[kind]), 'utf8')) as RunRecord
    return { ...r, reads: 0, agents: 0, step: '' }
  } catch {
    return null // a file that is missing or does not parse reads as no record
  }
}

/** The state of the AI features of a review. */
export async function aiState(slug: string, skillsFolder?: string | null): Promise<AiState | null> {
  const s = sessionOf(slug)
  if (!s) return null
  const folder = skillsFolder !== undefined ? skillsFolder : ((await readAppState()).skillsFolder ?? null)
  const skills = await listSkills(folder)
  return {
    context: s.contextStatus,
    contextError: s.contextError,
    unreadable: Object.fromEntries(s.issues.filter((t) => t.error).map((t) => [t.key, t.error as string])),
    criteria: s.criteria,
    skills: skills.map(({ folder: _f, text: _t, ...rest }) => rest),
    picks: await readPicks(s.root),
    review: active.get(keyOf(slug, 'review'))?.live ?? (await readRecord(s.root, slug, 'review')),
    ac: active.get(keyOf(slug, 'ac'))?.live ?? (await readRecord(s.root, slug, 'ac')),
    tool: toolName()
  }
}

export interface StartRequest {
  slug: string
  kind: RunKind
  /** The skill id, for a review. */
  skill?: string
  model: string
  effort?: string | null
  withoutIssues: string[]
}

// ---- Progress (file 04 section 7.8) ----

const HEX40 = /^[0-9a-f]{40}$/

/** The short path: inside the context folder from there, a commit export folder as `<commit8>/<rest>` or `<repo>/<rest>`. */
export function shortPath(path: string, contextDir: string): string {
  const prefix = contextDir + sep
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  const parts = path.split(/[\\/]/)
  const at = parts
    .map((p, i) => (HEX40.test(p) ? i : -1))
    .filter((i) => i >= 0)
    .pop()
  if (at === undefined || at < 2) return path
  const rest = parts.slice(at + 1).join('/')
  return parts[at - 1] === 'heads' ? `${parts[at].slice(0, 8)}/${rest}` : `${parts.slice(at - 2, at).join('/')}/${rest}`
}

interface Progress {
  reads: number
  agents: number
  step: string | null
  /** The answer text, when this line is the result. */
  result: string | null
}

/** Read one stdout line. A result line gives the answer, or throws for an error result. */
export function readLine(line: string, contextDir: string): Progress | null {
  if (!line.startsWith('{')) return null
  let o: { type?: string; is_error?: boolean; result?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } }
  try {
    o = JSON.parse(line) as typeof o
  } catch {
    return null
  }
  if (o.type === 'result') {
    const text = typeof o.result === 'string' ? o.result : ''
    if (o.is_error) throw new Error(`${toolName()} answered with an error: ${text}`)
    return { reads: 0, agents: 0, step: null, result: text }
  }
  if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) return null
  const who = typeof o.parent_tool_use_id === 'string' ? 'A subagent' : 'Claude'
  const p: Progress = { reads: 0, agents: 0, step: null, result: null }
  for (const item of o.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (item.type !== 'tool_use') continue
    const str = (k: string): string => (typeof item.input?.[k] === 'string' ? (item.input[k] as string) : '')
    if (item.name === 'Read') {
      p.reads++
      p.step = `${who} read ${shortPath(str('file_path'), contextDir)}`
    } else if (item.name === 'Grep') p.step = `${who} searched for ${str('pattern')}${str('path') ? ` in ${shortPath(str('path'), contextDir)}` : ''}`
    else if (item.name === 'Glob') p.step = `${who} listed ${str('pattern')}${str('path') ? ` in ${shortPath(str('path'), contextDir)}` : ''}`
    else if (item.name === 'Agent' || item.name === 'Task') {
      p.agents++
      p.step = `${who} started a subagent: ${str('description')}`
    } else p.step = `${who} used ${item.name}`
  }
  return p
}

// ---- Starting ----

export async function startRun(req: StartRequest): Promise<Result<AiState>> {
  const s = sessionOf(req.slug)
  if (!s) return { ok: false, error: 'The review is not loaded: open it again.' }
  const skills = await listSkills((await readAppState()).skillsFolder ?? null)
  let skill: (typeof skills)[number] | undefined
  if (req.kind === 'review') {
    skill = skills.find((k) => k.id === req.skill)
    if (!skill) return { ok: false, error: `No review skill ${req.skill} declares \`code-diff-review\`.` }
  }
  if (!isModel(req.model)) return { ok: false, error: 'model is not one of haiku, sonnet, opus, fable.' }
  if (req.effort && !isEffort(req.effort)) return { ok: false, error: 'effort is not one of low, medium, high, xhigh, max.' }
  if (s.contextStatus !== 'ready') return { ok: false, error: 'The review context is not ready yet.' }
  const unreadable = s.issues.filter((t) => t.error && !req.withoutIssues.includes(t.key))
  if (unreadable.length > 0) return { ok: false, error: unreadable.map((t) => `Cannot read ${t.key}: ${t.error}.`).join(' ') }
  if (req.kind === 'ac' && s.criteria.length === 0) return { ok: false, error: 'The issue files of this review name no acceptance criteria to validate.' }
  if (active.has(keyOf(req.slug, req.kind)))
    return { ok: false, error: req.kind === 'review' ? 'An AI review of this review runs already.' : 'An AC validation of this review runs already.' }

  const live: LiveRun = {
    skill: skill?.name ?? null,
    plugin: skill?.plugin ?? null,
    model: req.model,
    effort: req.effort ?? null,
    startedAt: new Date().toISOString(),
    commits: Object.fromEntries(s.result.mrs.map((m) => [m.key, m.snapshot.info.diffRefs.head])),
    state: 'running',
    lastStepAt: null,
    endedAt: null,
    stoppedByRestart: null,
    error: null,
    withoutIssues: req.withoutIssues.length > 0 ? req.withoutIssues : null,
    drafts: null,
    checklist: null,
    report: null,
    reads: 0,
    agents: 0,
    step: ''
  }
  const abort = new AbortController()
  active.set(keyOf(req.slug, req.kind), { live, abort })
  await save(s.root, req.slug, req.kind, live)
  void execute(s, req, live, abort, skill)
  return { ok: true, value: (await aiState(req.slug)) as AiState }
}

async function execute(
  s: Session,
  req: StartRequest,
  live: LiveRun,
  abort: AbortController,
  skill?: Awaited<ReturnType<typeof listSkills>>[number]
): Promise<void> {
  const { slug, kind } = req
  const root = s.root
  const finish = async (state: RunRecord['state'], error: string | null = null): Promise<void> => {
    live.state = state
    live.error = error
    live.endedAt = new Date().toISOString()
    active.delete(keyOf(slug, kind))
    await save(root, slug, kind, live)
  }
  try {
    if ((await llmState()) === 'missing') throw new Error(missingMessage())
    const ctx = await s.context
    // The pending comments are written again, so a point the reviewer already made is not repeated (file 04 section 4.7)
    const drafts = Object.values(await readComments(root, slug))
    await Promise.all(
      s.result.mrs.map(async (m, i) => {
        const dir = join(ctx.dir, `mr${i + 1}`)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'threads.md'), threadsMarkdown(m, drafts), 'utf8')
        if (kind === 'ac') await writeFile(join(dir, 'claude-drafts.md'), claudeDraftsMarkdown(m, drafts), 'utf8')
      })
    ).catch(() => undefined) // if the write fails, keep the files of the build

    const names = s.criteria.map((c) => c.name)
    const instructions = kind === 'review' ? REVIEW_INSTRUCTIONS : AC_INSTRUCTIONS
    let prompt =
      kind === 'review'
        ? reviewPrompt({ name: skill!.name, plugin: skill!.plugin, folder: skill!.folder, text: skill!.text }, names, req.withoutIssues)
        : acPrompt(names, req.withoutIssues)
    const first = prompt
    const dirs = [...new Set([...ctx.repoDirs, ...(skill?.folder ? [skill.folder] : [])])]
    const session = randomUUID()
    const facts = s.result.mrs.map((m) => ({ key: m.key, state: m.snapshot.info.state, diffRefs: m.snapshot.info.diffRefs, files: m.files }))
    let previous = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      let answer: string | null = null
      const stream = ask(
        {
          workingDirectory: ctx.dir,
          session,
          resume: attempt > 1 && capabilities().resume,
          model: live.model as Model,
          effort: (live.effort as Effort | null) ?? null,
          maxTurns: 150,
          tools: 'Read,Grep,Glob,Agent',
          instructions,
          extraDirectories: dirs,
          prompt: attempt > 1 && !capabilities().resume ? `${first}\n\nYour earlier answer:\n\n${previous}\n\n${prompt}` : prompt
        },
        abort.signal
      )
      for await (const line of stream) {
        const p = readLine(line, ctx.dir)
        if (!p) continue
        if (p.result !== null) answer = p.result
        live.reads += p.reads
        live.agents += p.agents
        if (p.step) {
          live.step = p.step
          live.lastStepAt = new Date().toISOString()
          await save(root, slug, kind, live)
        }
      }
      if (abort.signal.aborted) return void (await finish('stopped'))
      if (!answer) throw new Error(`${toolName()} ended before it answered.`)
      const checked = checkReviewAnswer({ mrs: facts, criteria: names, skill: kind === 'review' ? skill!.name : null, text: answer })
      if (checked.problems.length === 0) {
        if (kind === 'review') {
          for (const d of checked.drafts) await saveComment(root, slug, d) // one write at a time across all reviews
          live.drafts = checked.drafts.map((d) => d.id)
        }
        live.checklist = checked.checklist
        live.report = checked.report
        return void (await finish('done'))
      }
      if (attempt === 3) throw new Error(`The answer still had ${checked.problems.length} problem(s) after 3 answers:\n- ${checked.problems.join('\n- ')}`)
      previous = answer
      live.step = `The app sent ${checked.problems.length} problem(s) of the answer back, and the AI fixes them (answer ${attempt + 1} of 3)`
      await save(root, slug, kind, live)
      prompt = problemPrompt(checked.problems)
    }
  } catch (e) {
    if (abort.signal.aborted) return void (await finish('stopped'))
    await finish('failed', e instanceof Error ? e.message : String(e))
  }
}

/** Stop a run. A stop on a run that is not running does nothing. The process tree is killed. */
export async function stopRun(slug: string, kind: RunKind): Promise<void> {
  const a = active.get(keyOf(slug, kind))
  if (!a) return
  a.abort.abort()
  a.live.state = 'stopped'
  a.live.endedAt = new Date().toISOString()
  active.delete(keyOf(slug, kind))
  const s = sessionOf(slug)
  if (s) await save(s.root, slug, kind, a.live)
}

/** The app is closing: every run stops, so the AI tool never outlives the app and never keeps costing credit. */
export async function stopAllRuns(): Promise<void> {
  for (const [key, a] of [...active]) {
    const [slug, kind] = key.split(':') as [string, RunKind]
    a.abort.abort()
    a.live.state = 'stopped'
    a.live.stoppedByRestart = true
    a.live.endedAt = new Date().toISOString()
    active.delete(key)
    const s = sessionOf(slug)
    if (s) await save(s.root, slug, kind, a.live)
  }
}

/** At app start, a record that says `running` is rewritten as stopped by the restart: a new app runs nothing. */
export async function markStaleRecords(root: string): Promise<void> {
  let dirs: string[]
  try {
    dirs = (await readdir(reviewsDir(root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return
  }
  for (const slug of dirs) {
    for (const kind of ['review', 'ac'] as RunKind[]) {
      const rec = await readRecord(root, slug, kind)
      if (rec?.state === 'running') {
        rec.state = 'stopped'
        rec.stoppedByRestart = true
        rec.endedAt = rec.lastStepAt ?? rec.startedAt
        await atomicWrite(join(reviewDir(root, slug), FILE[kind]), JSON.stringify(record(rec), null, 2)).catch(() => undefined)
      }
    }
  }
}
