import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AppState } from '@shared/types'

const schema = z.looseObject({
  schemaVersion: z.number(),
  workspaceRoot: z.string().optional(),
  theme: z.string().optional(),
  skillsFolder: z.string().optional(),
  llm: z
    .object({
      tool: z.enum(['claude', 'codex', 'custom']),
      custom: z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) }).optional(),
      codexModels: z.record(z.string(), z.string()).optional()
    })
    .optional(),
  firstRunDone: z.boolean().default(false),
  reopenLastReview: z.boolean().default(true),
  lastReview: z.string().optional(),
  recentReviews: z.array(z.object({ slug: z.string(), openedAt: z.string() })).default([]),
  homeSort: z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) }).default({ key: 'lastOpened', dir: 'desc' })
}) // unknown keys are kept (file 07 section 2.4)

const defaults = (): AppState => ({
  schemaVersion: 1,
  firstRunDone: false,
  reopenLastReview: true,
  recentReviews: [],
  homeSort: { key: 'lastOpened', dir: 'desc' }
})

const file = (): string => join(app.getPath('userData'), 'app-state.json')

/** An unreadable file counts as empty. A higher schemaVersion is ignored (file 07 section 2.4). */
export async function readAppState(): Promise<AppState> {
  try {
    const parsed = schema.parse(JSON.parse(await readFile(file(), 'utf8')))
    return parsed.schemaVersion > 1 ? defaults() : (parsed as AppState)
  } catch {
    return defaults()
  }
}

// Writes go one at a time. Each one reads the file and writes it back, so two at once would lose a change, and would
// share one temporary file.
let queue: Promise<unknown> = Promise.resolve()

/** Temporary file then rename (file 05 section 6.6). */
export function writeAppState(patch: Partial<AppState>): Promise<AppState> {
  const run = async (): Promise<AppState> => {
    const next = { ...(await readAppState()), ...patch }
    const target = file()
    await mkdir(join(target, '..'), { recursive: true })
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await rename(tmp, target)
    return next
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
