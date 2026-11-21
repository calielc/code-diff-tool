import type { ChangeSnapshot } from './provider'
import type { LlmConfig, ToolId, CustomTool } from './llm'
import type { ChatEvent, ChatRequest } from './chat'
import type { SectionsState } from './sections'
import type { LaunchRequest } from './launch'
import type { CommitInfo } from './commits'
import type { FileObject } from './diff'
import type { AiStateView } from './ai'
import type { PendingComment, SubmitInput, ThreadsAnswer } from './comments'
import type { WatchMessage } from './watch'
import type { BuildProgress, BuildResult, CheckResult, ReviewSummary } from './review'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export type RowId = 'git' | 'gitlab' | 'github' | 'jira' | 'ai' | 'root'
export type AccessKind = 'gitlab' | 'github' | 'jira'
export type RowState = 'ready' | 'missing' | 'too-old' | 'needs-login' | 'not-set-up'

/** One row of the Prerequisites screen (file 07 section 3.3). */
export interface PrereqRow {
  id: RowId
  name: string
  required: boolean
  /** True for GitLab and GitHub: one of the two must have a token. */
  forge?: boolean
  /** For the access rows: the saved hosts (never the tokens) and the host the form starts with. */
  /** For the AI tool row: the tool in use and the command of a custom tool. */
  ai?: { tool: ToolId; custom: CustomTool | null }
  access?: { kind: AccessKind; defaultHost: string; hosts: { host: string; email: string | null }[] }
  state: RowState
  version: string | null
  detail: string
  /** Muted extra line, for example a count of the repos found. */
  note: string | null
  /** Command shown in a code box with a Copy button. Never run by the app. */
  fixCommand: string | null
}

export interface ToolStatus {
  rows: PrereqRow[]
  workspaceRoot: string | null
  /** True when no required row has a problem (enables "Done"). */
  ready: boolean
}

export interface AppState {
  schemaVersion: number
  workspaceRoot?: string
  llm?: LlmConfig
  /** The colour theme id, or `system` (file shared/themes.ts). */
  theme?: string
  /** A folder of SKILL.md review skills, chosen by the user. */
  skillsFolder?: string
  firstRunDone: boolean
  reopenLastReview: boolean
  lastReview?: string
  recentReviews: { slug: string; openedAt: string }[]
  homeSort: { key: string; dir: 'asc' | 'desc' }
}

/** The typed api exposed on window.codeDiff by the preload script. */
export interface CodeDiffApi {
  app: {
    /** `fresh: false` may reuse a scan of the workspace that is less than 30 seconds old. */
    checkTools(fresh?: boolean): Promise<ToolStatus>
    getState(): Promise<AppState>
    findRootCandidate(): Promise<string | null>
    chooseRoot(): Promise<Result<string> | null>
    setRoot(path: string): Promise<Result<string>>
  }
  people: {
    /** A data URL for each picture url, or null when it is refused or cannot be downloaded. */
    avatars(urls: string[]): Promise<Record<string, string | null>>
  }
  reviews: {
    /** Adds changes and issues to an existing review. */
    addTo(input: { slug: string; urls: string; issues: string }): Promise<Result<{ slug: string; addedChanges: number; addedIssues: number }>>
    list(): Promise<ReviewSummary[]>
    check(input: { urls: string; issues: string; slug: string }): Promise<Result<CheckResult>>
    create(input: {
      urls: string
      issues: string
      slug: string
      title: string
      overwrite: boolean
      pick?: string
    }): Promise<Result<{ slug: string; problems: Record<string, string> }>>
    /** Remember the open time of a review (Last opened column). */
    open(slug: string): Promise<void>
    build(slug: string): Promise<Result<BuildResult>>
    cancelBuild(slug: string): Promise<void>
    onBuildProgress(cb: (p: BuildProgress) => void): () => void
    deleteInfo(slug: string): Promise<Result<{ path: string; pending: number }>>
    delete(slug: string): Promise<Result<true>>
  }
  comments: {
    list(slug: string): Promise<Record<string, PendingComment>>
    save(slug: string, comment: PendingComment): Promise<Result<true>>
    remove(slug: string, id: string): Promise<Result<true>>
    /** `draft` is true when the comment is a saved draft, which is removed after the post. */
    post(slug: string, comment: PendingComment, draft: boolean): Promise<Result<ThreadsAnswer>>
  }
  notes: { delete(slug: string, mr: string, noteId: number): Promise<Result<ThreadsAnswer>> }
  threads: { resolve(slug: string, mr: string, thread: string, resolved: boolean): Promise<Result<true>> }
  review: { submit(input: SubmitInput): Promise<Result<Record<string, string>>> }
  watch: {
    start(slug: string, heads: Record<string, string>): Promise<void>
    stop(slug: string): Promise<void>
    onEvent(cb: (m: WatchMessage) => void): () => void
  }
  issues: {
    /** The Markdown file of one issue, or the reason it cannot be given. */
    getFile(slug: string, key: string): Promise<Result<string>>
    /** Adds 1 to 20 keys or Jira URLs. Each refused value comes back with its reason. */
    add(slug: string, values: string[]): Promise<Result<{ added: string[]; problems: Record<string, string> }>>
    /** Opens the file dialog for spec files (.md, .txt, .html). The window gets a token and the names, never the paths. Null when canceled. */
    pickFiles(): Promise<{ pick: string; names: string[] } | null>
    /** Adds the files of a pick to the review as issues. */
    addFiles(slug: string, pick: string): Promise<Result<{ added: string[]; problems: Record<string, string> }>>
  }
  chat: {
    /** Starts one turn of a chat. The lines arrive through onEvent until the end message. */
    start(req: ChatRequest): Promise<Result<{ id: string }>>
    cancel(id: string): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  sections: {
    get(slug: string): Promise<SectionsState>
    onState(cb: (m: { slug: string; state: SectionsState }) => void): () => void
  }
  ai: {
    get(slug: string): Promise<AiStateView | null>
    start(req: {
      slug: string
      kind: 'review' | 'ac'
      skill?: string
      model: string
      effort?: string | null
      withoutIssues: string[]
    }): Promise<Result<AiStateView>>
    stop(slug: string, kind: 'review' | 'ac'): Promise<void>
    setPicks(p: { slug: string; skill: string | null; model: string | null; acModel: string | null; acEffort: string | null }): Promise<AiStateView | null>
    pickSkillsFolder(slug: string): Promise<AiStateView | null>
    onChanged(cb: (m: { slug: string; state: AiStateView | null }) => void): () => void
  }
  llm: {
    get(): Promise<LlmConfig>
    /** Saves the AI tool. Refuses a custom tool with no command. */
    set(config: LlmConfig): Promise<Result<true>>
  }
  access: {
    /** Checks the token against the service and saves it encrypted. Resolves with the account name. */
    save(input: { kind: AccessKind; host: string; token: string; email?: string }): Promise<Result<string>>
    remove(kind: AccessKind, host: string): Promise<void>
  }
  dev: {
    readChange(url: string): Promise<Result<ChangeSnapshot>>
  }
  theme: {
    /** The saved theme id, or `system`. */
    get(): Promise<string>
    /** Saves a theme. Resolves with the id that was saved. */
    choose(id: string): Promise<string>
    /** The theme changed, for example from the Theme menu. */
    onSet(cb: (id: string) => void): () => void
  }
  commits: {
    /** The commits of a change that touch a file, oldest first. */
    list(a: { slug: string; mr: string; path: string; oldPath: string }): Promise<Result<CommitInfo[]>>
    /** The file as one commit of the change changed it. */
    file(a: { slug: string; mr: string; path: string; oldPath: string; sha: string }): Promise<Result<FileObject>>
  }
  launch: {
    /** The request from outside the app that is waiting, if any. Taking it clears it. */
    take(): Promise<LaunchRequest | null>
    /** A request arrived while the app was open. Take it with `take`. */
    onNew(cb: () => void): () => void
  }
  events: {
    /** Developer menu item. Returns an unsubscribe function (file 05 section 9.3, push channels). */
    onOpenDev(cb: () => void): () => void
  }
  system: {
    copyText(text: string): Promise<void>
    openExternal(url: string): Promise<Result<true>>
  }
}
