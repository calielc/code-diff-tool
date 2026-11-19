import type { ChangeRef } from '@shared/provider'
import { STAGE_LABELS, reviewTitle, type BuildProgress, type BuildResult, type BuildStage, type BuiltMr, type StageId, type StageState } from '@shared/review'
import type { Result } from '@shared/types'
import { fetchHeads, hasCommit, mergeBase, type BlobCache } from '../clients/git'
import { buildCombined, type CombinedMr } from '../diff/combined'
import { buildFiles, mapLimit } from '../diff/mr-files'
import type { CombinedPart, FileObject } from '@shared/diff'
import { readSnapshot, viewerOf } from '../clients/forge'
import { cancelScope } from '../processes/run'
import { withLock } from './lock'
import { readReviewFile } from './reviews'
import { readIssues, rememberIssues, toRow } from './issues'
import { startSession } from './session'
import { findClone, scanClones, type Clone } from './workspace'

type Emit = (p: BuildProgress) => void

interface Job {
  root: string
  slug: string
  ac: AbortController
  progress: BuildProgress
  emit: Emit
  promise: Promise<Result<BuildResult>>
  resolve: (r: Result<BuildResult>) => void
}

const queue: Job[] = []
let running: Job | null = null

/** True while a build of this review runs or waits (the delete check uses it). */
export const isBuilding = (slug: string): boolean => running?.slug === slug || queue.some((j) => j.slug === slug)

const ORDER: StageId[] = ['clones', 'login', 'issues', 'reading', 'fetching', 'diffing', 'preparing']

function newProgress(slug: string): BuildProgress {
  const stages: BuildStage[] = ORDER.map((id) => ({ id, label: STAGE_LABELS[id], state: 'waiting' as StageState, detail: null }))
  return { slug, queued: 0, stages, fraction: 0, startedAt: Date.now() }
}

/** The bar fill: finished stages over all shown stages, plus the fraction inside the running stage. */
function recompute(p: BuildProgress, inner = 0): void {
  const shown = p.stages.length
  const finished = p.stages.filter((s) => s.state === 'done' || s.state === 'skipped').length
  p.fraction = Math.min(1, (finished + inner) / shown)
}

function setStage(job: Job, id: StageId, state: StageState, detail: string | null = null, inner = 0): void {
  const s = job.progress.stages.find((x) => x.id === id)
  if (s) {
    s.state = state
    s.detail = detail
  }
  recompute(job.progress, inner)
  job.emit({ ...job.progress, stages: job.progress.stages.map((x) => ({ ...x })) })
}

/**
 * Start a build, or join the one of this review that is queued or running. Only one build runs at a time
 * across all reviews, so two builds never fetch in the same clone (file 05 section 5.3).
 */
export function startBuild(root: string, slug: string, emit: Emit): Promise<Result<BuildResult>> {
  const existing = running?.slug === slug ? running : queue.find((j) => j.slug === slug)
  if (existing) return existing.promise
  let resolve!: (r: Result<BuildResult>) => void
  const promise = new Promise<Result<BuildResult>>((r) => (resolve = r))
  const job: Job = { root, slug, ac: new AbortController(), progress: newProgress(slug), emit, promise, resolve }
  queue.push(job)
  announceQueue()
  void pump()
  return promise
}

function announceQueue(): void {
  queue.forEach((j, i) => {
    j.progress.queued = i + 1
    j.emit({ ...j.progress })
  })
}

async function pump(): Promise<void> {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = job
  job.progress.queued = 0
  job.progress.startedAt = Date.now()
  announceQueue()
  try {
    // Every process started below is killed with its children when the build is canceled.
    const result = await withLock(() => cancelScope.run(job.ac.signal, () => runBuild(job)))
    job.resolve(job.ac.signal.aborted ? { ok: false, error: 'Canceled.' } : result)
  } catch (e) {
    job.resolve({ ok: false, error: job.ac.signal.aborted ? 'Canceled.' : e instanceof Error ? e.message : String(e) })
  } finally {
    running = null
    void pump()
  }
}

/** Cancel a queued or running build. A queued build leaves the queue at once. */
export function cancelBuild(slug: string): boolean {
  const queued = queue.findIndex((j) => j.slug === slug)
  if (queued >= 0) {
    const [job] = queue.splice(queued, 1)
    job.resolve({ ok: false, error: 'Canceled.' })
    announceQueue()
    return true
  }
  if (running?.slug === slug) {
    running.ac.abort()
    return true
  }
  return false
}

class BuildError extends Error {
  constructor(
    message: string,
    readonly stage: StageId
  ) {
    super(message)
  }
}

async function runBuild(job: Job): Promise<Result<BuildResult>> {
  const { root, slug } = job
  const stage = (id: StageId, state: StageState, detail: string | null = null, inner = 0): void => setStage(job, id, state, detail, inner)
  let current: StageId = 'clones'
  try {
    // 1. Review file and local clones
    stage('clones', 'running')
    const review = await readReviewFile(root, slug)
    if (!review.ok) return review
    const clones = await scanClones(root, true)
    const located: { ref: ChangeRef; clone: Clone }[] = []
    for (const m of review.value.mrs) {
      const ref: ChangeRef = { provider: m.provider, host: m.host, project: m.projectPath, iid: m.iid }
      const clone = findClone(clones, ref)
      if (!clone) {
        throw new BuildError(`${ref.project} has no local clone in ${root}. Clone it there, then retry.`, 'clones')
      }
      located.push({ ref, clone })
    }
    stage('clones', 'done')

    // 2. Login of each forge in use
    current = 'login'
    stage('login', 'running')
    const viewers = new Set<string>()
    const hosts = new Map(located.map((l) => [`${l.ref.provider}|${l.ref.host}`, l.ref]))
    for (const ref of hosts.values()) viewers.add(await viewerOf(ref)) // one check per forge host
    stage('login', 'done')

    // 3. Read the issues and every change at the same time. Each read starts its own calls at the same time.
    const issueKeys = review.value.issues
    if (issueKeys.length === 0) {
      job.progress.stages = job.progress.stages.filter((x) => x.id !== 'issues') // the stage shows only for a review with issues
    } else stage('issues', 'running', `${issueKeys.length} ${issueKeys.length === 1 ? 'issue' : 'issues'}`)
    const issuesP = readIssues(root, slug, issueKeys)
    current = 'reading'
    let done = 0
    stage('reading', 'running', `0 of ${located.length}`)
    const snaps = await Promise.all(
      located.map(async (l) => {
        const snap = await readSnapshot(l.ref)
        stage('reading', 'running', `${++done} of ${located.length}`, done / located.length)
        return snap
      })
    )
    stage('reading', 'done', `${located.length} of ${located.length}`)
    const issueData = await issuesP
    rememberIssues(slug, issueData)
    if (issueKeys.length > 0) stage('issues', 'done', `${issueKeys.length} ${issueKeys.length === 1 ? 'issue' : 'issues'}`)

    // 4. Fetch missing commits, one fetch per repo, and only when a commit is missing (file 05 section 6.3)
    current = 'fetching'
    const live = located.map((l, i) => ({ ...l, snap: snaps[i] })).filter((x) => x.snap.info.state !== 'closed')
    const byRepo = new Map<string, typeof live>()
    for (const x of live) byRepo.set(x.clone.dir, [...(byRepo.get(x.clone.dir) ?? []), x])
    const needFetch: string[] = []
    for (const [dir, list] of byRepo) {
      const present = await Promise.all(list.flatMap((x) => [hasCommit(dir, x.snap.info.diffRefs.base), hasCommit(dir, x.snap.info.diffRefs.head)]))
      if (present.some((p) => !p)) needFetch.push(dir)
    }
    if (needFetch.length === 0) stage('fetching', 'skipped', 'skipped')
    else {
      stage('fetching', 'running', `0 of ${needFetch.length}`)
      let fetched = 0
      await Promise.all(
        needFetch.map(async (dir) => {
          const list = byRepo.get(dir) ?? []
          const provider = list[0].ref.provider
          await fetchHeads(
            dir,
            provider,
            list.map((x) => x.ref.iid),
            [...new Set(list.map((x) => x.snap.info.targetBranch))]
          )
          stage('fetching', 'running', `${++fetched} of ${needFetch.length}`, fetched / needFetch.length)
        })
      )
      for (const [dir, list] of byRepo) {
        for (const x of list) {
          for (const sha of [x.snap.info.diffRefs.base, x.snap.info.diffRefs.head]) {
            if (!(await hasCommit(dir, sha))) {
              throw new BuildError(
                `Commit ${sha} of ${x.clone.name}!${x.ref.iid} is not in ${dir}, even after a fetch of the change and its target branch.`,
                'fetching'
              )
            }
          }
        }
      }
      stage('fetching', 'done', `${needFetch.length} of ${needFetch.length}`)
    }

    // GitHub reports the tip of the base branch. The diff base is the merge base, which git knows.
    for (const x of live) {
      if (x.ref.provider === 'github') {
        const mb = await mergeBase(x.clone.dir, x.snap.info.diffRefs.base, x.snap.info.diffRefs.head)
        if (mb) x.snap.info.diffRefs.base = mb
      }
    }

    // 5. Diff every live change, then build the combined view of each repo (file 03 sections 3, 8 and 9)
    current = 'diffing'
    const filesByKey = new Map<string, FileObject[]>()
    const caches = new Map<string, BlobCache>()
    const cacheOf = (dir: string): BlobCache => caches.get(dir) ?? caches.set(dir, new Map()).get(dir)!
    let diffed = 0
    stage('diffing', live.length === 0 ? 'skipped' : 'running', live.length === 0 ? null : `0 of ${live.length}`)
    await mapLimit(live, 4, async (x) => {
      const key = `${x.clone.name}!${x.ref.iid}`
      const r = x.snap.info.diffRefs
      filesByKey.set(key, await buildFiles(x.clone.dir, r.base, r.head, cacheOf(x.clone.dir)))
      stage('diffing', 'running', `${++diffed} of ${live.length}`, diffed / live.length)
    })
    const combined: CombinedPart[] = []
    for (const [dir, list] of byRepo) {
      const mrsOfRepo: CombinedMr[] = list.map((x) => {
        const key = `${x.clone.name}!${x.ref.iid}`
        return {
          key,
          iid: x.ref.iid,
          base: x.snap.info.diffRefs.base,
          head: x.snap.info.diffRefs.head,
          mergedAt: x.snap.info.mergedAt,
          createdAt: x.snap.info.createdAt,
          draft: x.snap.info.draft,
          files: filesByKey.get(key) ?? []
        }
      })
      combined.push(...(await buildCombined(dir, list[0].clone.name, mrsOfRepo, cacheOf(dir))))
    }
    if (live.length > 0) stage('diffing', 'done', `${live.length} of ${live.length}`)

    // 6. Assemble the result
    current = 'preparing'
    stage('preparing', 'running')
    const mrs: BuiltMr[] = located.map((l, i) => ({
      key: `${l.clone.name}!${l.ref.iid}`,
      repo: l.clone.name,
      snapshot: snaps[i],
      noDiff: snaps[i].info.state === 'closed',
      files: filesByKey.get(`${l.clone.name}!${l.ref.iid}`) ?? []
    }))
    stage('preparing', 'done')
    const built: BuildResult = {
      generatedAt: new Date().toISOString(),
      title: reviewTitle(slug, review.value),
      viewer: [...viewers][0] ?? '',
      mrs,
      combined,
      skipped: review.value.skipped,
      issues: issueData.map(toRow)
    }
    // The summaries and the review context are written in the background. The window does not wait for them.
    startSession(root, slug, built, new Map(located.map((l) => [`${l.clone.name}!${l.ref.iid}`, l.clone])), issueData)
    return { ok: true, value: built }
  } catch (e) {
    if (job.ac.signal.aborted) return { ok: false, error: 'Canceled.' }
    stage(e instanceof BuildError ? e.stage : current, 'failed')
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
