/** A commit of a change, as the Diff tab lists it for a file. */
export interface CommitInfo {
  sha: string
  short: string
  author: string
  /** ISO 8601. */
  date: string
  subject: string
}
