import type { Approvals, ChangeInfo, ChangeRef, ChangeSnapshot, Note, Person, PipelineJob, ReviewerState, Thread } from '@shared/provider'
import { forgeApi, forgePaged, githubAt } from './forge-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any> // GitHub answers are read field by field

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const at = githubAt

const viewers = new Map<string, string>()

export async function currentUser(host: string): Promise<string> {
  const known = viewers.get(host)
  if (known) return known
  const login = str(((await forgeApi(at({ host }), 'user', 'GET')) as J).login)
  viewers.set(host, login)
  return login
}

function addPerson(people: Record<string, Person>, u: J | null | undefined): void {
  if (!u || typeof u.login !== 'string') return
  people[u.login] = { name: u.login, avatarUrl: strOrNull(u.avatar_url ?? u.avatarUrl) }
}

/** GET pulls/{n}. GitHub has no diff_refs, so base and start are the base sha and the merge base comes from git. */
export function mapPull(ref: ChangeRef, pr: J, people: Record<string, Person>): ChangeInfo {
  addPerson(people, pr.user)
  const state = pr.merged === true || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened'
  const baseSha = str(pr.base?.sha)
  return {
    ref,
    url: str(pr.html_url),
    state,
    title: str(pr.title),
    description: str(pr.body),
    draft: pr.draft === true,
    author: str(pr.user?.login),
    sourceBranch: str(pr.head?.ref),
    targetBranch: str(pr.base?.ref),
    createdAt: str(pr.created_at),
    updatedAt: str(pr.updated_at),
    mergedAt: strOrNull(pr.merged_at),
    closedAt: state === 'closed' ? strOrNull(pr.closed_at) : null,
    autoMerge: { enabled: state === 'opened' && !!pr.auto_merge, by: strOrNull(pr.auto_merge?.enabled_by?.login) },
    diffRefs: { base: baseSha, start: baseSha, head: str(pr.head?.sha) },
    pipeline: null, // filled from the check runs of the head commit
    userNotesCount: (typeof pr.comments === 'number' ? pr.comments : 0) + (typeof pr.review_comments === 'number' ? pr.review_comments : 0)
  }
}

/** The latest review of each person counts. Approved means the latest non-comment review is APPROVED. */
export function mapReviews(
  reviews: J[],
  viewer: string,
  author: string,
  people: Record<string, Person>
): { approvals: Approvals; viewerState: ReviewerState | null } {
  const latest = new Map<string, string>()
  for (const r of [...reviews].sort((a, b) => str(a.submitted_at).localeCompare(str(b.submitted_at)))) {
    const login = str(r.user?.login)
    const s = str(r.state)
    if (!login || s === 'COMMENTED' || s === 'PENDING') continue // a plain comment does not change a person's verdict
    addPerson(people, r.user)
    latest.set(login, s)
  }
  const approvedBy = [...latest].filter(([, s]) => s === 'APPROVED').map(([l]) => l)
  const mine = latest.get(viewer)
  const viewerState: ReviewerState | null =
    mine === 'APPROVED'
      ? 'approved'
      : mine === 'CHANGES_REQUESTED'
        ? 'requested_changes'
        : mine === 'DISMISSED'
          ? 'unapproved'
          : reviews.some((r) => r.user?.login === viewer)
            ? 'reviewed'
            : null
  return {
    approvals: { approvedBy, userCanApprove: viewer !== author, userHasApproved: mine === 'APPROVED' }, // GitHub refuses a self-approval
    viewerState
  }
}

/** Check runs of the head commit stand in for pipeline jobs. */
export function mapCheckRuns(runs: J[]): PipelineJob[] {
  return [...runs]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((c) => ({
      name: str(c.name),
      stage: str(c.app?.name),
      status: c.status === 'completed' ? str(c.conclusion) || 'completed' : str(c.status),
      allowFailure: false,
      url: strOrNull(c.html_url)
    }))
}

export function overallStatus(jobs: PipelineJob[]): string | null {
  if (jobs.length === 0) return null
  if (jobs.some((j) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(j.status))) return 'failed'
  if (jobs.some((j) => ['queued', 'in_progress', 'pending', 'waiting'].includes(j.status))) return 'running'
  return 'success'
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line originalLine diffSide comments(first:100){nodes{databaseId body createdAt url author{login avatarUrl}}}}}}}}`

/** Threads come from GraphQL because REST has no resolved state. */
export function mapThreads(nodes: J[], people: Record<string, Person>): Thread[] {
  return nodes
    .filter((t) => ((t.comments?.nodes as J[] | undefined) ?? []).length > 0)
    .map((t) => {
      const comments = t.comments.nodes as J[]
      const notes: Note[] = comments.map((c) => {
        addPerson(people, c.author)
        return { id: Number(c.databaseId), author: str(c.author?.login), body: str(c.body), createdAt: str(c.createdAt) }
      })
      const line = typeof t.line === 'number' ? t.line : typeof t.originalLine === 'number' ? t.originalLine : null
      const left = t.diffSide === 'LEFT'
      return {
        id: str(t.id),
        resolvable: true,
        resolved: t.isResolved === true,
        url: str(comments[0].url),
        position: t.path ? { oldPath: str(t.path), newPath: str(t.path), oldLine: left ? line : null, newLine: left ? null : line } : null,
        notes
      }
    })
}

async function readThreads(ref: ChangeRef, people: Record<string, Person>): Promise<Thread[]> {
  const [owner, repo] = ref.project.split('/')
  const n = ref.iid
  const nodes: J[] = []
  let after: string | null = null
  for (;;) {
    // GraphQL variables go through -f (strings) and -F (typed); the query is a plain field.
    const answer = (await forgeApi(at(ref), 'graphql', 'POST', {
      fields: { query: THREADS_QUERY, owner, repo },
      // The cursor is left out on the first page, because an empty string is not a valid cursor.
      typed: after ? { n, after } : { n }
    })) as J
    const page = answer?.data?.repository?.pullRequest?.reviewThreads
    nodes.push(...((page?.nodes as J[] | undefined) ?? []))
    if (!page?.pageInfo?.hasNextPage) break
    after = str(page.pageInfo.endCursor)
  }
  return mapThreads(nodes, people)
}

export async function readPull(ref: ChangeRef): Promise<ChangeSnapshot> {
  const base = `repos/${ref.project}/pulls/${ref.iid}`
  const people: Record<string, Person> = {}
  const [viewer, pr, reviews, threads] = await Promise.all([
    currentUser(ref.host),
    forgeApi(at(ref), base, 'GET') as Promise<J>,
    forgePaged<J>(at(ref), `${base}/reviews`),
    readThreads(ref, people)
  ])
  const info = mapPull(ref, pr, people)
  const runs = await forgePaged<J>(
    at(ref),
    `repos/${ref.project}/commits/${info.diffRefs.head}/check-runs`,
    {},
    (p) => ((p as J)?.check_runs as unknown[]) ?? []
  )
  const jobs = mapCheckRuns(runs)
  const status = overallStatus(jobs)
  info.pipeline = status ? { status, url: `${info.url}/checks`, id: null, projectId: null } : null
  const { approvals, viewerState } = mapReviews(reviews, viewer, info.author, people)
  return { info, approvals, threads, viewerState, jobs, people, viewer }
}

/** The pull request itself, without reviews, threads or check runs. */
export async function readPullInfo(ref: ChangeRef): Promise<ChangeInfo> {
  const pr = (await forgeApi(at(ref), `repos/${ref.project}/pulls/${ref.iid}`, 'GET')) as J
  return mapPull(ref, pr, {})
}

export async function readPullThreads(ref: ChangeRef): Promise<{ threads: Thread[]; people: Record<string, Person> }> {
  const people: Record<string, Person> = {}
  return { threads: await readThreads(ref, people), people }
}

export async function readPullApprovals(ref: ChangeRef): Promise<{ approvals: Approvals; people: Record<string, Person> }> {
  const people: Record<string, Person> = {}
  const base = `repos/${ref.project}/pulls/${ref.iid}`
  const [viewer, pr, reviews] = await Promise.all([
    currentUser(ref.host),
    forgeApi(at(ref), base, 'GET') as Promise<J>,
    forgePaged<J>(at(ref), `${base}/reviews`)
  ])
  return { approvals: mapReviews(reviews, viewer, str(pr.user?.login), people).approvals, people }
}
