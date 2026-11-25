import { listAccess } from '../services/credentials'
import { readSnapshot } from './forge'
import { limited } from './limit'
import { createSnapshotCache } from './snapshot-cache'

/** The full snapshots that the home lists show, kept in the main process. */
export const snapshots = createSnapshotCache({
  read: readSnapshot,
  limit: limited,
  hasAccess: (ref) => listAccess().some((a) => a.kind === ref.provider && a.host === ref.host)
})
