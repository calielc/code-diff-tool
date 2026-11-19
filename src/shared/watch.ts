import type { Approvals, ChangeState, Person, Thread } from './provider'

/** Events of the watch loop (file 05 section 7.3). The window compares each one with what it shows. */
export type WatchEvent =
  | { type: 'changed'; mrs: string[] }
  | { type: 'status'; mr: string; status: { state: ChangeState; draft: boolean } }
  | { type: 'approvals'; mr: string; approvals: Approvals; people: Record<string, Person> }
  | { type: 'threads'; mr: string; threads: Thread[]; people: Record<string, Person> }

export interface WatchMessage {
  slug: string
  event: WatchEvent
}
