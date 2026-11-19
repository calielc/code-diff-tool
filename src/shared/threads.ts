import type { PendingComment } from './comments'
import type { Thread, ThreadPosition } from './provider'

/** A thread belongs to a line when its position names the file and the line (file 02 section 8.1). */
export function positionMatchesLine(p: ThreadPosition, line: { o: number | null; n: number | null }): boolean {
  if (p.newLine !== null) return p.newLine === line.n
  return line.n === null && p.oldLine !== null && p.oldLine === line.o
}

export function threadOnFile(t: Thread, path: string, oldPath: string): boolean {
  const p = t.position
  return !!p && (p.newPath === path || p.oldPath === oldPath)
}

export function threadsAtLine(threads: Thread[], path: string, oldPath: string, line: { o: number | null; n: number | null }): Thread[] {
  return threads.filter((t) => threadOnFile(t, path, oldPath) && positionMatchesLine(t.position as ThreadPosition, line))
}

/** The way a file comment, or a comment the forge could not place, starts: `` `<path>`: `` or `` `<path>`, line `` */
const FILE_COMMENT = /^`([^`]+)`(?::| *, line )/

/** Threads with no position that name a file in their first words. */
export function fileThreads(threads: Thread[], path: string): Thread[] {
  return threads.filter((t) => !t.position && FILE_COMMENT.exec(t.notes[0]?.body ?? '')?.[1] === path)
}

/** Threads with no position and no file: the conversation of the change itself. */
export function conversationThreads(threads: Thread[]): Thread[] {
  return threads.filter((t) => !t.position && !FILE_COMMENT.test(t.notes[0]?.body ?? ''))
}

/** Open and total resolvable threads of a file, for the chips of the tree. */
export function threadCounts(threads: Thread[], path: string, oldPath: string): { open: number; total: number } {
  const own = threads.filter((t) => t.resolvable && (threadOnFile(t, path, oldPath) || fileThreads([t], path).length > 0))
  return { open: own.filter((t) => !t.resolved).length, total: own.length }
}

export function draftAtLine(d: PendingComment, mr: string, path: string, line: { o: number | null; n: number | null }): boolean {
  if (d.mr !== mr || d.path !== path) return false
  if (d.newLine !== null) return d.newLine === line.n
  return d.oldLine !== null && line.n === null && d.oldLine === line.o
}

/** A draft with a path and no lines is a comment on the whole file. */
export const isFileDraft = (d: PendingComment, mr: string, path: string): boolean => d.mr === mr && d.path === path && d.oldLine === null && d.newLine === null
