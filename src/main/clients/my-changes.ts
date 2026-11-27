import { mergeMine, mineWanted, MINE_WINDOW_MS, type MineItem, type MineResult, type MineRole, type MineScope, type MineState } from '@shared/my-changes'
import type { Person } from '@shared/provider'
import { forgeApi, forgePaged, githubAt, gitlabAt } from './forge-api'
import { currentUser } from './github'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any> // forge answers are read field by field

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export interface MineAccess {
  provider: 'gitlab' | 'github'
  host: string
}

function gitlabState(mr: J): MineState {
  if (mr.state === 'merged') return 'merged'
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed'
  return mr.draft === true || mr.work_in_progress === true ? 'draft' : 'opened'
}

/** The author and the reviewers of a GitLab list item, by username. */
function gitlabPeople(mr: J): Record<string, Person> {
  const people: Record<string, Person> = {}
  for (const u of [mr.author, ...((mr.reviewers as J[] | undefined) ?? [])]) {
    if (typeof u?.username === 'string') people[u.username] = { name: str(u.name) || u.username, avatarUrl: strOrNull(u.avatar_url) }
  }
  return people
}

function gitlabItem(host: string, mr: J, role: MineRole): MineItem {
  const url = str(mr.web_url)
  const full = str(mr.references?.full)
  const fromUrl = url.includes('/-/merge_requests/') ? new URL(url).pathname.slice(1).split('/-/merge_requests/')[0] : ''
  return {
    provider: 'gitlab',
    host,
    project: full.includes('!') ? full.slice(0, full.lastIndexOf('!')) : fromUrl,
    iid: Number(mr.iid),
    url,
    title: str(mr.title),
    author: str(mr.author?.username),
    state: gitlabState(mr),
    updatedAt: str(mr.updated_at),
    roles: [role],
    people: gitlabPeople(mr),
    reviewers: ((mr.reviewers as J[] | undefined) ?? []).map((u) => str(u.username)).filter(Boolean),
    approvedBy: null
  }
}

/** GitLab: the changes assigned to the user and the ones that name the user as reviewer. Open ones always, the others only from the last 30 days. */
async function gitlabMine(host: string, since: string, scope: MineScope): Promise<{ items: MineItem[]; viewer: string }> {
  const target = gitlabAt({ host })
  const user = (await forgeApi(target, 'user', 'GET')) as J
  const userId = Number(user.id)
  const calls: [MineRole, Record<string, string | number>][] = []
  for (const [role, who] of [
    ['assigned', { scope: 'assigned_to_me' }],
    ['reviewer', { scope: 'all', reviewer_id: userId }]
  ] as const) {
    if (scope !== 'closed') calls.push([role, { ...who, state: 'opened' }])
    if (scope !== 'open') calls.push([role, { ...who, state: 'all', updated_after: since }])
  }
  const lists = await Promise.all(
    calls.map(async ([role, fields]) => {
      const found = await forgePaged<J>(target, 'merge_requests', fields)
      // The "all" call also returns open changes. The "opened" call already has them.
      return found.filter((mr) => fields['state'] === 'opened' || mr.state !== 'opened').map((mr) => gitlabItem(host, mr, role))
    })
  )
  return { items: mergeMine(lists), viewer: str(user.username) }
}

function githubItem(host: string, pr: J, role: MineRole): MineItem {
  const repo = str(pr.repository_url).match(/\/repos\/(.+)$/)?.[1] ?? ''
  const state: MineState = pr.pull_request?.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft === true ? 'draft' : 'opened'
  return {
    provider: 'github',
    host,
    project: repo,
    iid: Number(pr.number),
    url: str(pr.html_url),
    title: str(pr.title),
    author: str(pr.user?.login),
    state,
    updatedAt: str(pr.updated_at),
    roles: [role],
    people: { [str(pr.user?.login)]: { name: str(pr.user?.login), avatarUrl: strOrNull(pr.user?.avatar_url) } },
    reviewers: [],
    approvedBy: null
  }
}

/** GitHub: one search for each way the user is involved, open and closed (merged ones are closed too). */
async function githubMine(host: string, since: string, scope: MineScope): Promise<{ items: MineItem[]; viewer: string }> {
  const target = githubAt({ host })
  const day = since.slice(0, 10)
  const ways: [MineRole, string][] = [
    ['assigned', 'assignee:@me'],
    ['reviewer', 'review-requested:@me'],
    ['reviewer', 'reviewed-by:@me']
  ]
  const lists = await Promise.all(
    ways.flatMap(([role, way]) =>
      [scope !== 'closed' ? `is:pr ${way} is:open` : '', scope !== 'open' ? `is:pr ${way} is:closed updated:>=${day}` : ''].filter(Boolean).map(async (q) => {
        const found = await forgePaged<J>(target, 'search/issues', { q }, (p) => (Array.isArray((p as J)?.items) ? (p as J).items : []))
        return found.map((pr) => githubItem(host, pr, role))
      })
    )
  )
  return { items: mergeMine(lists), viewer: await currentUser(host) }
}

/**
 * The changes of every given access. One host that fails gives one error line, and the other hosts still show. The token is never in an error.
 * The scope tells which part to read. The open part is small, and the merged and closed part of the last 30 days can be long, so the window reads them in two calls.
 */
export async function fetchMine(accesses: MineAccess[], now = Date.now(), scope: MineScope = 'all'): Promise<MineResult> {
  const since = new Date(now - MINE_WINDOW_MS).toISOString()
  const errors: MineResult['errors'] = []
  const viewers: Record<string, string> = {}
  const lists = await Promise.all(
    accesses.map(async (a) => {
      try {
        const found = a.provider === 'gitlab' ? await gitlabMine(a.host, since, scope) : await githubMine(a.host, since, scope)
        viewers[a.host] = found.viewer
        return found.items
      } catch (e) {
        errors.push({ host: a.host, error: e instanceof Error ? e.message : String(e) })
        return []
      }
    })
  )
  return { items: mergeMine(lists).filter((i) => mineWanted(i, now)), errors, viewers, hasAccess: accesses.length > 0 }
}
