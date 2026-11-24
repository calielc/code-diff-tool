import type { Approvals, ChangeInfo, ChangeRef, ChangeSnapshot, Note, Person, PipelineJob, ReviewerState, Thread } from '@shared/provider'
import { forgeApi, forgePaged, gitlabAt } from './forge-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any> // GitLab answers are read field by field, so a loose shape is the honest type here

const enc = (p: string): string => encodeURIComponent(p) // "a/b/c" -> "a%2Fb%2Fc" (file 05 section 2.1 rule 2)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const gl = gitlabAt

const viewers = new Map<string, string>()

/** Call 1. Read once per app run (file 05 section 2.4). */
export async function currentUser(host: string): Promise<string> {
  const known = viewers.get(host)
  if (known) return known
  const u = (await forgeApi(gl({ host }), 'user', 'GET')) as J
  viewers.set(host, str(u.username))
  return str(u.username)
}
export const resetViewerCache = (): void => viewers.clear()

function addPerson(people: Record<string, Person>, u: J | null | undefined): void {
  if (!u || typeof u.username !== 'string') return
  people[u.username] = { name: str(u.name) || u.username, avatarUrl: strOrNull(u.avatar_url) }
}

/** Call 2 mapping (file 05 section 2.5). */
export function mapMr(ref: ChangeRef, mr: J, people: Record<string, Person>): ChangeInfo {
  addPerson(people, mr.author)
  const state = mr.state === 'opened' || mr.state === 'closed' || mr.state === 'merged' || mr.state === 'locked' ? mr.state : 'opened'
  const d = mr.diff_refs ?? {}
  const hp = mr.head_pipeline
  return {
    ref,
    url: str(mr.web_url),
    state,
    title: str(mr.title),
    description: str(mr.description),
    draft: mr.draft === true, // counts only when it is the JSON value true
    author: str(mr.author?.username),
    sourceBranch: str(mr.source_branch),
    targetBranch: str(mr.target_branch),
    createdAt: str(mr.created_at),
    updatedAt: str(mr.updated_at),
    mergedAt: strOrNull(mr.merged_at),
    closedAt: state === 'closed' ? strOrNull(mr.closed_at) : null, // kept only for a closed MR
    autoMerge: {
      enabled: state === 'opened' && mr.merge_when_pipeline_succeeds === true, // GitLab keeps the flag on a merged MR
      by: mr.merge_when_pipeline_succeeds === true ? str(mr.merge_user?.username) || 'unknown' : null
    },
    diffRefs: { base: str(d.base_sha), start: str(d.start_sha), head: str(d.head_sha) },
    pipeline: hp ? { status: str(hp.status), url: strOrNull(hp.web_url), id: hp.id ?? null, projectId: hp.project_id ?? null } : null,
    userNotesCount: typeof mr.user_notes_count === 'number' ? mr.user_notes_count : 0,
    behindTarget: state === 'opened' && typeof mr.diverged_commits_count === 'number' ? mr.diverged_commits_count : null
  }
}

/** Call 3 mapping (file 05 section 2.6). */
export function mapApprovals(a: J, people: Record<string, Person>): Approvals {
  const approvedBy: string[] = []
  for (const item of (a.approved_by as J[] | undefined) ?? []) {
    addPerson(people, item.user)
    if (typeof item.user?.username === 'string') approvedBy.push(item.user.username)
  }
  return { approvedBy, userCanApprove: a.user_can_approve === true, userHasApproved: a.user_has_approved === true }
}

/** Call 4 mapping (file 05 section 2.7). System notes are dropped. */
export function mapDiscussions(webUrl: string, discussions: J[], people: Record<string, Person>): Thread[] {
  const threads: Thread[] = []
  for (const d of discussions) {
    const kept = ((d.notes as J[] | undefined) ?? []).filter((n) => n.system !== true)
    if (kept.length === 0) continue // a thread of system notes only is dropped
    const resolvableNotes = kept.filter((n) => n.resolvable === true)
    const first = kept[0]
    const p = first.position
    const notes: Note[] = kept.map((n) => {
      addPerson(people, n.author)
      return { id: Number(n.id), author: str(n.author?.username), body: str(n.body), createdAt: str(n.created_at) }
    })
    threads.push({
      id: str(d.id),
      resolvable: resolvableNotes.length > 0,
      resolved: resolvableNotes.length > 0 && resolvableNotes.every((n) => n.resolved === true),
      url: `${webUrl}#note_${first.id}`,
      position: p
        ? {
            oldPath: strOrNull(p.old_path),
            newPath: strOrNull(p.new_path),
            oldLine: typeof p.old_line === 'number' ? p.old_line : null,
            newLine: typeof p.new_line === 'number' ? p.new_line : null
          }
        : null,
      notes
    })
  }
  return threads
}

/** Call 5 mapping (file 05 section 2.8). */
export function mapViewerState(reviewers: J[], viewer: string): ReviewerState | null {
  const mine = reviewers.find((r) => r.user?.username === viewer)
  return mine && typeof mine.state === 'string' ? (mine.state as ReviewerState) : null
}

/** Calls 6 and 7 mapping: joined, oldest first, trigger jobs link to the downstream pipeline. */
export function mapJobs(jobs: J[], bridges: J[]): PipelineJob[] {
  const all = [...jobs, ...bridges].sort((a, b) => Number(a.id) - Number(b.id))
  return all.map((j) => ({
    name: str(j.name),
    stage: str(j.stage),
    status: str(j.status),
    allowFailure: j.allow_failure === true,
    url: strOrNull(j.downstream_pipeline?.web_url) ?? strOrNull(j.web_url)
  }))
}

/** Read one MR: calls 2 to 5 at the same time, then 6 and 7 when there is a head pipeline (file 05 section 2.8). */
export async function readMr(ref: ChangeRef): Promise<ChangeSnapshot> {
  const p = enc(ref.project)
  const base = `projects/${p}/merge_requests/${ref.iid}`
  const people: Record<string, Person> = {}
  const [viewer, mr, approvals, discussions, reviewers] = await Promise.all([
    currentUser(ref.host),
    // GitLab leaves diverged_commits_count out of the MR unless the request asks for it.
    forgeApi(gl(ref), base, 'GET', { fields: { include_diverged_commits_count: 'true' } }) as Promise<J>,
    forgeApi(gl(ref), `${base}/approvals`, 'GET') as Promise<J>,
    forgePaged<J>(gl(ref), `${base}/discussions`),
    forgePaged<J>(gl(ref), `${base}/reviewers`)
  ])
  const info = mapMr(ref, mr, people)
  let jobs: PipelineJob[] = []
  if (info.pipeline && info.pipeline.id !== null && info.pipeline.projectId !== null) {
    // A pipeline can run in another project than the MR (a fork), so the numeric id comes from the MR.
    const pp = `projects/${info.pipeline.projectId}/pipelines/${info.pipeline.id}`
    const [j, b] = await Promise.all([forgePaged<J>(gl(ref), `${pp}/jobs`), forgePaged<J>(gl(ref), `${pp}/bridges`)])
    jobs = mapJobs(j, b)
  }
  return {
    info,
    approvals: mapApprovals(approvals, people),
    threads: mapDiscussions(info.url, discussions, people),
    viewerState: mapViewerState(reviewers, viewer),
    jobs,
    people,
    viewer
  }
}

/** Call 2 only. Used by the New review check, which needs the title and state but not the threads. */
export async function readMrInfo(ref: ChangeRef): Promise<ChangeInfo> {
  const mr = (await forgeApi(gl(ref), `projects/${enc(ref.project)}/merge_requests/${ref.iid}`, 'GET')) as J
  return mapMr(ref, mr, {})
}

/** Threads and the people behind them, for the read-back after a write and for the watcher (calls 2 and 4). */
export async function readMrThreads(ref: ChangeRef): Promise<{ threads: Thread[]; people: Record<string, Person> }> {
  const base = `projects/${enc(ref.project)}/merge_requests/${ref.iid}`
  const people: Record<string, Person> = {}
  const [mr, discussions] = await Promise.all([forgeApi(gl(ref), base, 'GET') as Promise<J>, forgePaged<J>(gl(ref), `${base}/discussions`)])
  return { threads: mapDiscussions(str(mr.web_url), discussions, people), people }
}

/** Approvals (call 3) for an open MR. */
export async function readMrApprovals(ref: ChangeRef): Promise<{ approvals: Approvals; people: Record<string, Person> }> {
  const people: Record<string, Person> = {}
  const a = (await forgeApi(gl(ref), `projects/${enc(ref.project)}/merge_requests/${ref.iid}/approvals`, 'GET')) as J
  return { approvals: mapApprovals(a, people), people }
}
