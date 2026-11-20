// Provider-neutral model shared by main and renderer. Types and pure helpers only.
// The spec describes GitLab. GitHub is added behind the same shapes.

export type Provider = 'gitlab' | 'github'

/** A merge request (GitLab) or pull request (GitHub). */
export interface ChangeRef {
  provider: Provider
  host: string
  /** GitLab: full project path, for example "group/sub/repo". GitHub: "owner/repo". */
  project: string
  /** MR number (GitLab iid) or PR number (GitHub). */
  iid: number
}

/** "<project>!<iid>", the MR key of the spec (file 05 section 9.4), used for both providers. */
export const changeKey = (r: Pick<ChangeRef, 'project' | 'iid'>): string => `${r.project}!${r.iid}`

const GITLAB_RE = /^https:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i
const GITHUB_RE = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i

/** Read an MR or PR URL. github.com is GitHub. Every other host with /-/merge_requests/ is GitLab. */
export function parseChangeUrl(url: string): ChangeRef | null {
  const trimmed = url.trim()
  const hub = GITHUB_RE.exec(trimmed)
  if (hub && hub[1].toLowerCase() === 'github.com') {
    return { provider: 'github', host: 'github.com', project: `${hub[2]}/${hub[3]}`, iid: Number(hub[4]) }
  }
  const gl = GITLAB_RE.exec(trimmed)
  if (gl) return { provider: 'gitlab', host: gl[1].toLowerCase(), project: gl[2], iid: Number(gl[3]) }
  return null
}

export interface Person {
  name: string
  avatarUrl: string | null
}

export type ChangeState = 'opened' | 'closed' | 'merged' | 'locked'

export interface DiffRefs {
  base: string
  start: string
  head: string
}

export interface PipelineJob {
  name: string
  stage: string
  status: string
  allowFailure: boolean
  url: string | null
}

export interface ChangeInfo {
  ref: ChangeRef
  url: string
  state: ChangeState
  title: string
  description: string
  draft: boolean
  author: string
  sourceBranch: string
  targetBranch: string
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
  autoMerge: { enabled: boolean; by: string | null }
  /** GitLab: diff_refs. GitHub: base = base sha, start = base sha, head = head sha. The merge base is read from git. */
  diffRefs: DiffRefs
  pipeline: { status: string; url: string | null; id: string | number | null; projectId: string | number | null } | null
  userNotesCount: number
  /** Commits that the target branch has and the source branch does not. null: unknown, or the change is merged or closed. */
  behindTarget: number | null
}

export interface Approvals {
  approvedBy: string[]
  userCanApprove: boolean
  userHasApproved: boolean
}

export interface ThreadPosition {
  oldPath: string | null
  newPath: string | null
  oldLine: number | null
  newLine: number | null
}

export interface Note {
  id: number
  author: string
  body: string
  createdAt: string
}

export interface Thread {
  /** GitLab: 40 hex characters. GitHub: the GraphQL node id of the review thread. */
  id: string
  resolvable: boolean
  resolved: boolean
  url: string
  position: ThreadPosition | null
  notes: Note[]
}

export type ReviewerState = 'unreviewed' | 'review_started' | 'reviewed' | 'requested_changes' | 'approved' | 'unapproved'

/** Everything one read of a change returns (file 05 section 2.8, "read order for one MR"). */
export interface ChangeSnapshot {
  info: ChangeInfo
  approvals: Approvals
  threads: Thread[]
  /** The viewer's own review state, null when the viewer is not a reviewer. */
  viewerState: ReviewerState | null
  jobs: PipelineJob[]
  people: Record<string, Person>
  viewer: string
}

/** Thread-id rule per provider. The spec fixes GitLab ids at 40 lowercase hex characters. */
export function isValidThreadId(provider: Provider, id: string): boolean {
  return provider === 'gitlab' ? /^[0-9a-f]{40}$/.test(id) : /^[A-Za-z0-9_=-]{8,200}$/.test(id)
}
