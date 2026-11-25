import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/**
 * A fake GitLab, GitHub and Jira in one HTTP server. Fixture keys are "<METHOD> <endpoint>", without a query string.
 * Values:
 *   { json: any }      answer with this JSON
 *   { list: N }        answer with page <page> of N synthetic items, honouring per_page and page
 *   { fail: 'text' }   answer with the HTTP status named in the text (500 when none) and the rest of the text as the message
 *   { echoBody: true } answer with the JSON body that was sent
 *   { empty: true }    answer with nothing
 *   { sleepMs: N }     wait before answering (can be combined with the others)
 *   { dynamic: fn }    answer with the JSON that fn returns for the query string, the endpoint and the JSON body of the call (used by the lists of changes below)
 *   { sleepFor: fn }   wait the milliseconds that fn returns for the query string, the endpoint and the JSON body of the call
 *   { failFor: fn }    answer like `fail` when fn returns a text for the query string, the endpoint and the JSON body of the call
 *
 * A key can hold a star for one path segment, for example a star between projects/ and /merge_requests. An exact key wins over a key with a star.
 * A value can also be an array of entries: the 1st call gets item 0, the 2nd item 1, and so on. The last item repeats.
 */
export type Entry = {
  json?: unknown
  list?: number
  fail?: string
  echoBody?: boolean
  empty?: boolean
  sleepMs?: number
  dynamic?: (query: Record<string, string>, endpoint: string, body: unknown) => unknown
  sleepFor?: (query: Record<string, string>, endpoint: string, body: unknown) => number
  failFor?: (query: Record<string, string>, endpoint: string, body: unknown) => string | undefined
}
export type Fixture = Record<string, Entry | Entry[]>

export interface Call {
  method: string
  endpoint: string
  query: Record<string, string>
  body: unknown
  /** The auth header the call carried, so a test can check a token was sent. */
  auth: string | null
}

export interface FakeForge {
  url: string
  calls: Call[]
  /** The writes (calls with a body), in order. */
  bodies: Call[]
  setFixture(f: Fixture): void
  /** Starts to count the calls in flight whose endpoint matches. Call it before the calls start. `max` is the most that were open at the same time. */
  trackPeak(match: RegExp): { max: number }
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function startFakeForge(initial: Fixture = {}): Promise<FakeForge> {
  let fixture = initial
  const watchers: { re: RegExp; now: number; max: number }[] = []
  const wildcard = (key: string): RegExp =>
    new RegExp(
      `^${key
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+')}$`
    )
  const lookup = (key: string): Entry | Entry[] | undefined =>
    fixture[key] ?? Object.entries(fixture).find(([k]) => k.includes('*') && wildcard(k).test(key))?.[1]
  const counts = new Map<string, number>()
  const calls: Call[] = []
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const endpoint = url.pathname.replace(/^\//, '')
    const method = req.method ?? 'GET'
    const body = await readBody(req)
    const query = Object.fromEntries(url.searchParams)
    const auth = (req.headers['private-token'] as string | undefined) ?? (req.headers['authorization'] as string | undefined) ?? null
    calls.push({ method, endpoint, query, body, auth })
    const open = watchers.filter((w) => w.re.test(endpoint))
    for (const w of open) w.max = Math.max(w.max, ++w.now)
    res.on('close', () => open.forEach((w) => w.now--))

    const key = `${method} ${endpoint}`
    const found = lookup(key)
    const counted = fixture[key] ? key : (Object.keys(fixture).find((k) => k.includes('*') && wildcard(k).test(key)) ?? key)
    let entry = found
    if (Array.isArray(entry)) {
      const n = counts.get(counted) ?? 0
      counts.set(counted, n + 1)
      entry = entry[Math.min(n, entry.length - 1)]
    }
    const send = (status: number, text: string, type = 'application/json'): void => {
      res.writeHead(status, { 'Content-Type': type })
      res.end(text)
    }
    if (!entry) return send(404, JSON.stringify({ message: `no fixture for ${key}` }))
    const wait = (entry.sleepMs ?? 0) + (entry.sleepFor?.(query, endpoint, body) ?? 0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const failure = entry.fail ?? entry.failFor?.(query, endpoint, body)
    if (failure !== undefined) {
      const code = Number(/HTTP (\d{3})/.exec(failure)?.[1] ?? 500)
      const rest = failure.replace(/^HTTP \d{3}\s*/, '').trim()
      // A message that only repeats the status text adds nothing, so it is left out.
      return send(code, rest && rest !== STATUS_CODES[code] ? JSON.stringify({ message: rest }) : '')
    }
    if (entry.list !== undefined) {
      const per = Number(query['per_page'] ?? 100)
      const page = Number(query['page'] ?? 1)
      const items = []
      for (let n = (page - 1) * per; n < Math.min(entry.list, page * per); n++) items.push({ id: n + 1 })
      return send(200, JSON.stringify(items))
    }
    if (entry.dynamic) return send(200, JSON.stringify(entry.dynamic(query, endpoint, body)))
    if (entry.echoBody) return send(200, JSON.stringify(body ?? null))
    if (entry.json !== undefined) return send(200, JSON.stringify(entry.json))
    return send(204, '')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return {
    url,
    calls,
    get bodies() {
      return calls.filter((c) => c.body !== undefined)
    },
    trackPeak: (re) => {
      const w = { re, now: 0, max: 0 }
      watchers.push(w)
      return {
        get max() {
          return w.max
        }
      }
    },
    setFixture: (f) => {
      fixture = f
      counts.clear()
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())))
  }
}

/** The environment that points the app, or a test, at the fake server with tokens for every host used in tests. */
export function forgeEnv(url: string): Record<string, string> {
  return {
    CODEDIFF_TEST: '1',
    // A test must never reach a real claude: summaries start at every build that has issues.
    CODEDIFF_FAKE_CLAUDE: JSON.stringify(['node', join(__dirname, 'fake-claude.mjs')]),
    CODEDIFF_API_BASE_GITLAB: url,
    CODEDIFF_API_BASE_GITHUB: url,
    CODEDIFF_API_BASE_JIRA: url,
    CODEDIFF_TEST_CREDENTIALS: JSON.stringify({
      'gitlab:gitlab.com': { token: 'glpat-test' },
      'github:github.com': { token: 'ghp-test' },
      'jira:acme.atlassian.net': { token: 'jira-test', email: 'me@example.com' }
    })
  }
}

/** The id the fake GitLab gives the current user. A request for the reviewer role must carry it as `reviewer_id`. */
export const FAKE_GITLAB_USER_ID = 7

/** One change (merge request or pull request) for the lists of "Assigned to me" and "I am the reviewer". */
export interface SeedChange {
  provider: 'gitlab' | 'github'
  /** The repo path, for example `team/backend/x`. */
  project: string
  iid: number
  title: string
  /** `draft` is an open change with the draft flag. `merged` and `closed` are told apart the way each forge does it. */
  state: 'draft' | 'opened' | 'merged' | 'closed'
  author: string
  /** An ISO time. */
  updatedAt: string
  /** The user is the assignee. */
  assigned?: boolean
  /** The user is a requested reviewer. On GitHub the change is found by `review-requested:@me`. */
  reviewer?: boolean
  /** GitHub only: the user already reviewed it, so only `reviewed-by:@me` finds it. */
  reviewedBy?: boolean
  /** Other people (usernames) who are requested reviewers. On GitHub they come from `pulls/<n>` (requested_reviewers), on GitLab from the list item. */
  reviewers?: string[]
  /** Usernames that approved. On GitLab they come from `the approvals call, on GitHub they become APPROVED reviews. */
  approvedBy?: string[]
  /** GitHub only: submitted reviews in the order they were made, after the ones from `approvedBy`. A later one is newer. */
  reviews?: { user: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' }[]
  /** The full read of the change (the one a review does). The branch names default to `feat-<iid>` and `main`. A branch name has no slash. */
  sourceBranch?: string
  targetBranch?: string
  /** Commits the source branch is behind the target. 0 by default. Only an open change shows it. */
  behind?: number
  /** The pipeline of the head commit, with its jobs. A job gets the stage `build` and the status of the pipeline when `jobs` is left out. No pipeline when this is left out. */
  pipeline?: {
    status: 'success' | 'failed' | 'running' | 'pending' | 'canceled'
    jobs?: { name: string; stage: string; status: 'success' | 'failed' | 'running' | 'pending' | 'canceled'; allowFailure?: boolean }[]
  }
  /** Resolvable discussion threads: how many are open and how many are resolved. */
  threads?: { open: number; resolved: number }
  /** ISO times. The default for `createdAt` is two days before `updatedAt`. A merged change merges at `updatedAt` by default. */
  createdAt?: string
  mergedAt?: string
  /** Auto-merge is on, set by the viewer. */
  autoMerge?: boolean
  /** False when the viewer is not an eligible approver. True by default. */
  userCanApprove?: boolean
  /** Every call of the full read of this change waits this long. It wins over the option of the same name. */
  snapshotSleepMs?: number
  /** The call for the change itself (not the list) answers with HTTP 500, so the full read fails. */
  snapshotFail?: boolean
  /** The viewer has asked for changes on this change. It then shows as a reviewer in the state `requested_changes`. */
  requestedChanges?: boolean
  /**
   * Every write call of this change (approve, unapprove, title, review, draft notes, draft state) answers with this failure text, for example `HTTP 403 nope`.
   * To fail one endpoint only, spread a fixture entry such as `POST projects/<encoded path>/merge_requests/<iid>/approve` after the result of `changesFixture`.
   */
  writeFail?: string
  /** Every write call of this change waits this long before it answers. */
  writeSleepMs?: number
}

const paged = <T>(items: T[], query: Record<string, string>): T[] => {
  const per = Number(query['per_page'] ?? 100)
  const page = Number(query['page'] ?? 1)
  return items.slice((page - 1) * per, page * per)
}

export interface ChangesOptions {
  /** Display names (and avatar urls) by username. The default name is the username with a capital and " Tester" (GitLab only: GitHub shows the login). */
  people?: Record<string, { name: string; avatarUrl?: string }>
  /** Wait this long before every call of the full read of a change (the change itself, approvals, discussions, pipeline, reviews, threads). */
  snapshotSleepMs?: number
}

const VIEWER = 'me'
/** Everyone who reviews on GitLab: requested reviewers, and the viewer when it is a reviewer. */
const glReviewers = (c: SeedChange): string[] => [...new Set([...(c.reviewers ?? []), ...(c.reviewer || c.requestedChanges ? [VIEWER] : [])])]
/** The reviews of a GitHub change in time order: approvals first, then the ones given by `reviews`, and the viewer when it reviewed before. */
const ghReviews = (c: SeedChange): { user: string; state: string }[] => [
  ...(c.approvedBy ?? []).map((user) => ({ user, state: 'APPROVED' })),
  ...(c.reviewedBy ? [{ user: VIEWER, state: 'COMMENTED' }] : []),
  ...(c.reviews ?? [])
]

const nameOf = (u: string, opts: ChangesOptions): string => opts.people?.[u]?.name ?? `${u[0].toUpperCase()}${u.slice(1)} Tester`
const glUser = (u: string, opts: ChangesOptions): Record<string, unknown> => ({
  username: u,
  name: nameOf(u, opts),
  avatar_url: opts.people?.[u]?.avatarUrl ?? null
})

const gitlabItem = (c: SeedChange, opts: ChangesOptions = {}): Record<string, unknown> => ({
  id: c.iid + 1000,
  iid: c.iid,
  project_id: 1,
  title: c.title,
  web_url: `https://gitlab.com/${c.project}/-/merge_requests/${c.iid}`,
  state: c.state === 'draft' ? 'opened' : c.state,
  draft: c.state === 'draft',
  work_in_progress: c.state === 'draft',
  author: glUser(c.author, opts),
  reviewers: glReviewers(c).map((u) => glUser(u, opts)),
  updated_at: c.updatedAt,
  references: { full: `${c.project}!${c.iid}` }
})

const githubItem = (c: SeedChange): Record<string, unknown> => ({
  number: c.iid,
  title: c.title,
  html_url: `https://github.com/${c.project}/pull/${c.iid}`,
  repository_url: `https://api.github.com/repos/${c.project}`,
  state: c.state === 'draft' || c.state === 'opened' ? 'open' : 'closed',
  draft: c.state === 'draft',
  user: { login: c.author, avatar_url: null },
  updated_at: c.updatedAt,
  pull_request: { html_url: `https://github.com/${c.project}/pull/${c.iid}`, merged_at: c.state === 'merged' ? c.updatedAt : null }
})

/**
 * Fixture entries for the list endpoints of the two forges, from a list of seeded changes. They honour the query like the real ones:
 *   GitLab  GET merge_requests: scope=assigned_to_me or reviewer_id=<FAKE_GITLAB_USER_ID>, state (opened, merged, closed or all), updated_after, page, per_page
 *   GitHub  GET search/issues: q with assignee:@me, review-requested:@me or reviewed-by:@me, is:open, is:draft, is:merged, is:closed, updated:>=<date>, page, per_page
 * A call with neither role answers with an empty list. `GET user` answers for both forges. Spread the result into a fixture, and call
 * `forge.setFixture` again with a longer list to seed one more change while the app runs.
 */
export function changesFixture(seed: SeedChange[], opts: ChangesOptions = {}): Fixture {
  // The writes below change these copies, so the next read shows them and the seed of the test stays as it was.
  const changes: SeedChange[] = seed.map((c) => ({
    ...c,
    approvedBy: [...(c.approvedBy ?? [])],
    reviews: [...(c.reviews ?? [])],
    reviewers: [...(c.reviewers ?? [])]
  }))
  const since = (iso: string | undefined): number => (iso ? Date.parse(iso) : -Infinity)
  return {
    'GET user': { json: { id: FAKE_GITLAB_USER_ID, username: 'me', login: 'me' } },
    'GET merge_requests': {
      dynamic: (q) => {
        const role = q['reviewer_id'] === String(FAKE_GITLAB_USER_ID) ? 'reviewer' : q['scope'] === 'assigned_to_me' ? 'assigned' : null
        const state = q['state'] ?? 'all'
        const hits = changes
          .filter((c) => c.provider === 'gitlab')
          .filter((c) => (role === 'assigned' ? c.assigned : role === 'reviewer' ? c.reviewer : false))
          .filter((c) => state === 'all' || (state === 'opened' ? c.state === 'draft' || c.state === 'opened' : c.state === state))
          .filter((c) => Date.parse(c.updatedAt) >= since(q['updated_after']))
        return paged(
          hits.map((c) => gitlabItem(c, opts)),
          q
        )
      }
    },
    'GET search/issues': {
      dynamic: (q) => {
        const words = (q['q'] ?? '').split(/\s+/)
        const has = (w: string): boolean => words.includes(w)
        const updated = words.find((w) => w.startsWith('updated:>='))?.slice('updated:>='.length)
        const hits = changes
          .filter((c) => c.provider === 'github')
          .filter(
            (c) =>
              (has('assignee:@me') && c.assigned) || (has('review-requested:@me') && c.reviewer && !c.reviewedBy) || (has('reviewed-by:@me') && c.reviewedBy)
          )
          .filter((c) => !has('is:open') || c.state === 'draft' || c.state === 'opened')
          .filter((c) => !has('is:draft') || c.state === 'draft')
          .filter((c) => !has('is:merged') || c.state === 'merged')
          .filter((c) => !has('is:closed') || c.state === 'closed' || c.state === 'merged')
          .filter((c) => Date.parse(c.updatedAt) >= since(updated))
        return { total_count: hits.length, incomplete_results: false, items: paged(hits.map(githubItem), q) }
      }
    },
    ...fullRead(changes, opts),
    ...writes(changes)
  }
}

const DAY_MS = 86_400_000
const enc = encodeURIComponent
const headSha = (c: SeedChange): string => `head-${c.iid}`
const baseSha = (c: SeedChange): string => `base-${c.iid}`
const createdOf = (c: SeedChange): string => c.createdAt ?? new Date(Date.parse(c.updatedAt) - 2 * DAY_MS).toISOString()
const mergedOf = (c: SeedChange): string | null => (c.state === 'merged' ? (c.mergedAt ?? c.updatedAt) : null)
const sleepOf = (c: SeedChange | undefined, opts: ChangesOptions, kind: 'read' | 'write' = 'read'): number =>
  kind === 'write' ? (c?.writeSleepMs ?? 0) : (c?.snapshotSleepMs ?? opts.snapshotSleepMs ?? 0)
const failOf = (c: SeedChange | undefined): string | undefined => (c?.snapshotFail ? 'HTTP 500 boom' : undefined)
/** The jobs of a pipeline, with the stage `build` when the seed gives none. */
const jobsOf = (c: SeedChange): NonNullable<SeedChange['pipeline']>['jobs'] =>
  c.pipeline ? (c.pipeline.jobs ?? [{ name: 'build', stage: 'build', status: c.pipeline.status }]) : []
/** Threads as GitLab discussions: the open ones first. */
const glDiscussions = (c: SeedChange, opts: ChangesOptions): unknown[] =>
  threadsOf(c).map((resolved, n) => ({
    id: `d${n}`,
    notes: [
      {
        id: c.iid * 100 + n,
        system: false,
        resolvable: true,
        resolved,
        body: `Remark ${n}`,
        created_at: c.updatedAt,
        author: glUser('gus', opts),
        position: { old_path: 'f.txt', new_path: 'f.txt', old_line: null, new_line: n + 1 }
      }
    ]
  }))
const threadsOf = (c: SeedChange): boolean[] => [
  ...Array.from({ length: c.threads?.open ?? 0 }, () => false),
  ...Array.from({ length: c.threads?.resolved ?? 0 }, () => true)
]
const ghRun = (j: NonNullable<ReturnType<typeof jobsOf>>[number], id: number): Record<string, unknown> => {
  const done: Record<string, string> = { success: 'success', failed: 'failure', canceled: 'cancelled' }
  return {
    id,
    name: j.name,
    app: { name: j.stage },
    status: j.status in done ? 'completed' : j.status === 'running' ? 'in_progress' : 'queued',
    conclusion: done[j.status] ?? null,
    html_url: `https://github.com/checks/${id}`
  }
}

/** The calls of the full read of one change, the one a review does: the same endpoints as `readMr` and `readPull`. */
function fullRead(changes: SeedChange[], opts: ChangesOptions): Fixture {
  const gitlab = changes.filter((c) => c.provider === 'gitlab')
  // `projects/<encoded path>/merge_requests/<iid>/...`
  const glOf = (endpoint: string): SeedChange | undefined => {
    const [, project, , iid] = endpoint.split('/')
    return gitlab.find((x) => x.iid === Number(iid) && enc(x.project) === project)
  }
  // `repos/<owner>/<repo>/pulls/<n>/...`
  const ghOf = (endpoint: string): SeedChange | undefined => {
    const [, owner, repo, , n] = endpoint.split('/')
    return changes.find((x) => x.provider === 'github' && x.iid === Number(n) && x.project === `${owner}/${repo}`)
  }
  // The pipeline id is 5000 plus the place of the change in the seed, and its project is 1.
  const pipelineId = (c: SeedChange): number => 5000 + changes.indexOf(c)
  const byPipeline = (endpoint: string): SeedChange | undefined => changes[Number(endpoint.split('/')[3]) - 5000]
  const glSleep = (_q: Record<string, string>, endpoint: string): number => sleepOf(glOf(endpoint), opts)
  const glJobs = (_q: Record<string, string>, endpoint: string, kind: 'jobs' | 'bridges'): unknown[] => {
    const c = byPipeline(endpoint)
    if (kind === 'bridges' || !c) return []
    return (jobsOf(c) ?? []).map((j, n) => ({
      id: n + 1,
      name: j.name,
      stage: j.stage,
      status: j.status,
      allow_failure: j.allowFailure === true,
      web_url: `https://gitlab.com/jobs/${c.iid}-${n}`
    }))
  }
  return {
    'GET projects/*/merge_requests/*': {
      sleepFor: glSleep,
      failFor: (_q, endpoint) => failOf(glOf(endpoint)),
      dynamic: (_q, endpoint) => {
        const c = glOf(endpoint)
        if (!c) return {}
        const merged = c.state === 'merged'
        return {
          ...gitlabItem(c, opts),
          // GitLab keeps the draft state in the title, so the title of the change itself has the prefix. The lists keep the plain title.
          title: c.state === 'draft' ? `Draft: ${c.title}` : c.title,
          description: '',
          source_branch: c.sourceBranch ?? `feat-${c.iid}`,
          target_branch: c.targetBranch ?? 'main',
          created_at: createdOf(c),
          merged_at: mergedOf(c),
          closed_at: c.state === 'closed' ? c.updatedAt : null,
          merge_when_pipeline_succeeds: c.autoMerge === true,
          merge_user: c.autoMerge ? { username: VIEWER } : null,
          diff_refs: { base_sha: baseSha(c), start_sha: baseSha(c), head_sha: headSha(c) },
          head_pipeline: c.pipeline
            ? { status: c.pipeline.status, web_url: `https://gitlab.com/${c.project}/-/pipelines/${pipelineId(c)}`, id: pipelineId(c), project_id: 1 }
            : null,
          user_notes_count: threadsOf(c).length,
          diverged_commits_count: merged ? 0 : (c.behind ?? 0)
        }
      }
    },
    'GET projects/*/merge_requests/*/approvals': {
      sleepFor: glSleep,
      dynamic: (_q, endpoint) => {
        const c = glOf(endpoint)
        return {
          approved_by: (c?.approvedBy ?? []).map((u) => ({ user: glUser(u, opts) })),
          user_can_approve: c?.userCanApprove !== false,
          user_has_approved: (c?.approvedBy ?? []).includes(VIEWER)
        }
      }
    },
    'GET projects/*/merge_requests/*/discussions': {
      sleepFor: glSleep,
      dynamic: (q, endpoint) => {
        const c = glOf(endpoint)
        return paged(c ? glDiscussions(c, opts) : [], q)
      }
    },
    'GET projects/*/merge_requests/*/reviewers': {
      sleepFor: glSleep,
      dynamic: (_q, endpoint) => {
        const c = glOf(endpoint)
        return (c ? glReviewers(c) : []).map((u) => ({
          user: glUser(u, opts),
          state: u === VIEWER && c?.requestedChanges ? 'requested_changes' : 'unreviewed'
        }))
      }
    },
    'GET projects/*/pipelines/*/jobs': {
      sleepFor: (_q, endpoint) => sleepOf(byPipeline(endpoint), opts),
      dynamic: (q, endpoint) => paged(glJobs(q, endpoint, 'jobs'), q)
    },
    'GET projects/*/pipelines/*/bridges': {
      sleepFor: (_q, endpoint) => sleepOf(byPipeline(endpoint), opts),
      dynamic: (q, endpoint) => paged(glJobs(q, endpoint, 'bridges'), q)
    },
    'GET repos/*/*/pulls/*': {
      sleepFor: (_q, endpoint) => sleepOf(ghOf(endpoint), opts),
      failFor: (_q, endpoint) => failOf(ghOf(endpoint)),
      dynamic: (_q, endpoint) => {
        const c = ghOf(endpoint)
        if (!c) return {}
        const requested = [...new Set([...(c.reviewers ?? []), ...(c.reviewer && !c.reviewedBy ? [VIEWER] : [])])]
        return {
          ...githubItem(c),
          node_id: nodeId(c),
          body: '',
          merged: c.state === 'merged',
          merged_at: mergedOf(c),
          closed_at: c.state === 'closed' ? c.updatedAt : null,
          created_at: createdOf(c),
          head: { ref: c.sourceBranch ?? `feat-${c.iid}`, sha: headSha(c) },
          base: { ref: c.targetBranch ?? 'main', sha: baseSha(c) },
          comments: 0,
          review_comments: threadsOf(c).length,
          auto_merge: c.autoMerge ? { enabled_by: { login: VIEWER } } : null,
          requested_reviewers: requested.map((login) => ({ login, avatar_url: null }))
        }
      }
    },
    'GET repos/*/*/pulls/*/reviews': {
      sleepFor: (_q, endpoint) => sleepOf(ghOf(endpoint), opts),
      dynamic: (_q, endpoint) => {
        const c = ghOf(endpoint)
        // One second apart and in order, so a later review is newer
        return (c ? ghReviews(c) : []).map((r, i) => ({
          id: i + 1,
          user: { login: r.user, avatar_url: null },
          state: r.state,
          submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
        }))
      }
    },
    // The threads of a pull request come from GraphQL. The body names the repo and the number.
    'POST graphql': {
      sleepFor: (_q, _endpoint, body) => sleepOf(mutated(changes, body), { snapshotSleepMs: 0 }, 'write'),
      failFor: (_q, _endpoint, body) => mutated(changes, body)?.writeFail,
      dynamic: (_q, _endpoint, body) => {
        const m = mutated(changes, body)
        if (m) {
          const to = (body as { query: string }).query
          m.state = to.includes('markPullRequestReadyForReview') ? 'opened' : 'draft'
          return { data: {} }
        }
        const v = (body as { variables?: { owner?: string; repo?: string; n?: number } } | undefined)?.variables
        const c = changes.find((x) => x.provider === 'github' && x.iid === v?.n && x.project === `${v?.owner}/${v?.repo}`)
        const nodes = threadsOf(c ?? ({} as SeedChange)).map((resolved, n) => ({
          id: `t${n}`,
          isResolved: resolved,
          path: 'f.txt',
          line: n + 1,
          originalLine: n + 1,
          diffSide: 'RIGHT',
          comments: {
            nodes: [
              {
                databaseId: (c?.iid ?? 0) * 100 + n,
                body: `Remark ${n}`,
                createdAt: c?.updatedAt ?? '',
                url: `https://github.com/x#r${n}`,
                author: { login: 'gus', avatarUrl: null }
              }
            ]
          }
        }))
        return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }
      }
    },
    'GET repos/*/*/compare/*': {
      dynamic: (_q, endpoint) => {
        const head = endpoint.split('...')[1]
        const c = changes.find((x) => x.provider === 'github' && headSha(x) === head)
        return { behind_by: c?.behind ?? 0 }
      }
    },
    'GET repos/*/*/commits/*/check-runs': {
      dynamic: (q, endpoint) => {
        const head = endpoint.split('/')[4]
        const c = changes.find((x) => x.provider === 'github' && headSha(x) === head)
        const runs = (c ? (jobsOf(c) ?? []) : []).map((j, n) => ghRun(j, (c?.iid ?? 0) * 100 + n + 1))
        return { total_count: runs.length, check_runs: paged(runs, q) }
      }
    }
  }
}

const nodeId = (c: SeedChange): string => `PR_${c.project}#${c.iid}`
/** The GitHub change that a draft-state mutation names, or undefined for any other GraphQL call. */
function mutated(changes: SeedChange[], body: unknown): SeedChange | undefined {
  const b = body as { query?: string; variables?: { id?: string } } | undefined
  if (!b?.query?.includes('PullRequest') || !b.query.startsWith('mutation')) return undefined
  return changes.find((c) => c.provider === 'github' && nodeId(c) === b.variables?.id)
}
const DRAFT_PREFIX = /^(?:(?:\[draft\]|\(draft\)|draft:)\s*)+/i

/**
 * The write endpoints of every seeded change, as the real forges take them. Each write changes the live copy of the change, so the next read shows it:
 *   GitLab  POST .../approve and .../unapprove add and remove the viewer in approvedBy. PUT <change> with a title sets the state to draft when the title starts with `Draft:`
 *           and to opened when it does not, and keeps the title without the prefix. POST .../draft_notes and .../draft_notes/bulk_publish take a review comment, and
 *           bulk_publish with reviewer_state requested_changes marks the viewer as having asked for changes. GET .../draft_notes is an empty list.
 *   GitHub  POST .../reviews with the event APPROVE, REQUEST_CHANGES or COMMENT adds a review of the viewer. PUT .../reviews/<id>/dismissals withdraws the approval of the viewer.
 *           POST graphql with the mutation markPullRequestReadyForReview or convertPullRequestToDraft sets the state to opened or draft.
 * A change with `writeFail` answers every one of these with that failure, and `writeSleepMs` makes each wait. The updated time never changes, so a test can tell a read
 * that the app asked for again from one that the updated time made.
 */
function writes(changes: SeedChange[]): Fixture {
  const gl = (endpoint: string): SeedChange | undefined => {
    const [, project, , iid] = endpoint.split('/')
    return changes.find((x) => x.provider === 'gitlab' && x.iid === Number(iid) && enc(x.project) === project)
  }
  const gh = (endpoint: string): SeedChange | undefined => {
    const [, owner, repo, , n] = endpoint.split('/')
    return changes.find((x) => x.provider === 'github' && x.iid === Number(n) && x.project === `${owner}/${repo}`)
  }
  const failGl = (_q: Record<string, string>, endpoint: string): string | undefined => gl(endpoint)?.writeFail
  const sleepGl = (_q: Record<string, string>, endpoint: string): number => gl(endpoint)?.writeSleepMs ?? 0
  const failGh = (_q: Record<string, string>, endpoint: string): string | undefined => gh(endpoint)?.writeFail
  const sleepGh = (_q: Record<string, string>, endpoint: string): number => gh(endpoint)?.writeSleepMs ?? 0
  const without = (c: SeedChange): void => {
    c.approvedBy = (c.approvedBy ?? []).filter((u) => u !== VIEWER)
    c.reviews = (c.reviews ?? []).filter((r) => !(r.user === VIEWER && r.state === 'APPROVED'))
  }
  return {
    'POST projects/*/merge_requests/*/approve': {
      sleepFor: sleepGl,
      failFor: failGl,
      dynamic: (_q, endpoint) => {
        const c = gl(endpoint)
        if (c && !(c.approvedBy ?? []).includes(VIEWER)) c.approvedBy = [...(c.approvedBy ?? []), VIEWER]
        return {}
      }
    },
    'POST projects/*/merge_requests/*/unapprove': {
      sleepFor: sleepGl,
      failFor: failGl,
      dynamic: (_q, endpoint) => {
        const c = gl(endpoint)
        if (c) without(c)
        return {}
      }
    },
    'PUT projects/*/merge_requests/*': {
      sleepFor: sleepGl,
      failFor: failGl,
      dynamic: (_q, endpoint, body) => {
        const c = gl(endpoint)
        const title = String((body as { title?: string } | undefined)?.title ?? '')
        if (c) {
          c.state = DRAFT_PREFIX.test(title) ? 'draft' : 'opened'
          c.title = title.replace(DRAFT_PREFIX, '')
        }
        return {}
      }
    },
    'GET projects/*/merge_requests/*/draft_notes': { sleepFor: sleepGl, failFor: failGl, json: [] },
    'POST projects/*/merge_requests/*/draft_notes': { sleepFor: sleepGl, failFor: failGl, empty: true },
    'POST projects/*/merge_requests/*/draft_notes/bulk_publish': {
      sleepFor: sleepGl,
      failFor: failGl,
      dynamic: (_q, endpoint, body) => {
        const c = gl(endpoint)
        if (c && (body as { reviewer_state?: string } | undefined)?.reviewer_state === 'requested_changes') c.requestedChanges = true
        return {}
      }
    },
    'POST repos/*/*/pulls/*/reviews': {
      sleepFor: sleepGh,
      failFor: failGh,
      dynamic: (_q, endpoint, body) => {
        const c = gh(endpoint)
        const event = (body as { event?: string } | undefined)?.event
        const state = event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'
        if (c) c.reviews = [...(c.reviews ?? []), { user: VIEWER, state }]
        return {}
      }
    },
    'PUT repos/*/*/pulls/*/reviews/*/dismissals': {
      sleepFor: sleepGh,
      failFor: failGh,
      dynamic: (_q, endpoint) => {
        const c = gh(endpoint)
        if (c) without(c)
        return {}
      }
    }
  }
}
