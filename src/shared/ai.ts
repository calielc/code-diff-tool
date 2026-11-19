import type { ChecklistEntry } from './review-answer'

/** What the window sees of the AI features of a review (file 04 section 7.9). Mirrors the main-process state. */
export interface RunView {
  skill: string | null
  plugin: string | null
  model: string
  effort: string | null
  startedAt: string
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
  reads: number
  agents: number
  step: string
}

export interface AiStateView {
  context: 'gathering' | 'ready' | 'failed' | null
  contextError: string | null
  unreadable: Record<string, string>
  criteria: { name: string; text: string }[]
  skills: { id: string; name: string; plugin: string; description: string; model: string | null; default: boolean }[]
  picks: { skill: string | null; model: string | null; acModel: string | null; acEffort: string | null }
  review: RunView | null
  ac: RunView | null
  tool: string
}
