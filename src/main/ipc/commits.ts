import { z } from 'zod'
import { CH } from '@shared/channels'
import { SLUG_RE } from '@shared/review'
import { commitsOfFile, fileAtCommit } from '../services/commits'
import { handle } from './guard'

const base = { slug: z.string().regex(SLUG_RE), mr: z.string().max(500), path: z.string().max(2000), oldPath: z.string().max(2000) }

export function registerCommitHandlers(): void {
  handle(CH.commitsList, z.object(base), (a) => commitsOfFile(a.slug, a.mr, a.path, a.oldPath))
  handle(CH.commitsFile, z.object({ ...base, sha: z.string().regex(/^[0-9a-f]{40}$/) }), (a) => fileAtCommit(a.slug, a.mr, a.sha, a.path, a.oldPath))
}
