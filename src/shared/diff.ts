// Diff data shared by main and renderer (file 03 sections 1.5 and 1.6).

export type LevelName = 'raw' | 'basic' | 'strict'
export const LEVELS: LevelName[] = ['raw', 'basic', 'strict']

/** Which MR owns a combined line, and the line number inside that MR's own diff (file 03 section 8.5). */
export interface LineTarget {
  mr: string
  o: number | null
  n: number | null
}

export interface LineObj {
  /** " " unchanged, "-" removed, "+" added. */
  t: ' ' | '-' | '+'
  o: number | null
  n: number | null
  x: string
  target?: LineTarget | null
}

export interface Level {
  hunks: LineObj[][]
  add: number
  del: number
}

export type FileStatus = 'A' | 'D' | 'M' | 'R'

export interface FileObject {
  path: string
  oldPath: string
  status: FileStatus
  binary: boolean
  generated: boolean
  levels: Record<LevelName, Level>
  /** The whole new file, cleaned. Null when binary, generated or deleted. */
  lines: string[] | null
  /** The whole old file, cleaned. Null when binary, generated, added, or when no level removes a line. */
  oldLines: string[] | null
}

export interface CombinedPart {
  repo: string
  mrs: string[]
  available: boolean
  reason: string | null
  headSha: string | null
  files: FileObject[]
}

/** `<hunk>` header text of the inline view. */
export const emptyLevel = (): Level => ({ hunks: [], add: 0, del: 0 })
