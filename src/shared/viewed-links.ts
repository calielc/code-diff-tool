import { viewedId } from './sections'

export interface LinkedEntry {
  id: string
  /** The change that owns the file in Linear. Null in Stacked. */
  mrKey: string | null
  /** The changes of the part, in Stacked. */
  partMrs: string[]
  path: string
}

/** A part of the Stacked view. Its files have the id `cb:<id>|<path>`. */
export interface LinkedPart {
  id: string
  mrs: string[]
}

export const stackedId = (partId: string, path: string): string => `cb:${partId}|${path}`

/**
 * The ids to add when a file is marked as viewed, or to remove when the mark is taken away.
 * A stacked file links to the same path in every change of its part. A mark on a change alone stays on that change,
 * but its removal also removes the stacked file of every part that holds the change.
 */
export function linkedViewedIds(entry: LinkedEntry, on: boolean, parts: LinkedPart[]): string[] {
  if (entry.mrKey === null) {
    return [entry.id, ...entry.partMrs.map((mr) => viewedId(mr, entry.path))]
  }
  if (on) {
    return [entry.id]
  }
  const mrKey = entry.mrKey
  return [entry.id, ...parts.filter((p) => p.mrs.includes(mrKey)).map((p) => stackedId(p.id, entry.path))]
}
