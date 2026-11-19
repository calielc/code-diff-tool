import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { COMMENT_ID_RE, type PendingComment } from '@shared/comments'
import { atomicWrite, reviewDir } from './reviews'

const sha = z.string().regex(/^[0-9a-f]{40}$/)
export const pendingSchema = z.object({
  id: z.string().regex(COMMENT_ID_RE),
  mr: z.string().min(1).max(500),
  diffRefs: z.object({ base: sha, start: sha, head: sha }),
  path: z.string().nullable(),
  oldPath: z.string().nullable(),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
  body: z.string().max(65_536),
  view: z.enum(['mr', 'combined']).optional(),
  combinedPath: z.string().nullable().optional(),
  lineText: z.string().optional(),
  claude: z.object({ skill: z.string().nullable(), lens: z.string(), severity: z.enum(['blocking', 'suggestion']), ac: z.string().optional() }).optional()
})

// One lock across all reviews, so two writes never interleave (file 05 section 5.3).
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const file = (root: string, slug: string): string => join(reviewDir(root, slug), 'comments.json')

/** A file that cannot be read counts as empty. A comment that fails its schema is dropped. */
export async function readComments(root: string, slug: string): Promise<Record<string, PendingComment>> {
  try {
    const raw = JSON.parse(await readFile(file(root, slug), 'utf8')) as Record<string, unknown>
    const out: Record<string, PendingComment> = {}
    for (const [id, v] of Object.entries(raw)) {
      const p = pendingSchema.safeParse(v)
      if (p.success && p.data.id === id) out[id] = p.data as PendingComment
    }
    return out
  } catch {
    return {}
  }
}

const write = (root: string, slug: string, data: Record<string, PendingComment>): Promise<void> => atomicWrite(file(root, slug), JSON.stringify(data, null, 2))

export const saveComment = (root: string, slug: string, c: PendingComment): Promise<void> =>
  locked(async () => {
    const all = await readComments(root, slug)
    all[c.id] = c
    await write(root, slug, all)
  })

export const removeComment = (root: string, slug: string, id: string): Promise<void> =>
  locked(async () => {
    const all = await readComments(root, slug)
    if (id in all) {
      delete all[id]
      await write(root, slug, all)
    }
  })
