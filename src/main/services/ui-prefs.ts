import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { UiPrefs } from '@shared/types'

const file = (): string => join(app.getPath('userData'), 'ui-prefs.json')

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

async function load(): Promise<UiPrefs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    const scopes = isRecord(parsed) && isRecord(parsed['scopes']) ? parsed['scopes'] : {}
    return Object.fromEntries(Object.entries(scopes).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1])))
  } catch {
    return {}
  }
}

// Writes go one at a time. Each one reads the file and writes it back, so two at once would lose a change.
let queue: Promise<unknown> = Promise.resolve()

/** The saved settings. A read waits for the writes that are open, so it never misses a change that was just made. An unreadable file, or a part of it that has the wrong shape, counts as empty. */
export async function readUiPrefs(): Promise<UiPrefs> {
  await queue
  return load()
}

function write(change: (prefs: UiPrefs) => void): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await load()
    change(prefs)
    const target = file()
    await mkdir(join(target, '..'), { recursive: true })
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ schemaVersion: 1, scopes: prefs }, null, 2), 'utf8')
    await rename(tmp, target)
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

/** Saves one setting of a scope. */
export function setUiPref(scope: string, key: string, value: unknown): Promise<void> {
  return write((prefs) => {
    prefs[scope] = { ...prefs[scope], [key]: value }
  })
}

/** Forgets every setting of a scope, for a review that is deleted. */
export function dropUiPrefs(scope: string): Promise<void> {
  return write((prefs) => {
    delete prefs[scope]
  })
}
