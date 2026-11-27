/**
 * Readers for the view settings that the window saves (file ui-prefs.json). A saved value can have an old shape, because the
 * app changes between versions, so each reader takes what it knows and gives the fallback for the rest.
 */

export interface SortPref<K extends string> {
  key: K
  dir: 'asc' | 'desc'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A sort is saved as `{ key, dir }`, or as the word `none` for the order of the list. */
export function sortToPref<K extends string>(sort: SortPref<K> | null): SortPref<K> | 'none' {
  return sort ?? 'none'
}

export function parseSort<K extends string>(v: unknown, keys: readonly K[], fallback: SortPref<K> | null): SortPref<K> | null {
  if (v === 'none') return null
  if (isRecord(v) && keys.includes(v['key'] as K) && (v['dir'] === 'asc' || v['dir'] === 'desc')) return { key: v['key'] as K, dir: v['dir'] }
  return fallback
}

/** A record of toggles. A key that the saved value lacks keeps its default, and a key that the defaults lack is dropped. */
export function parseFlags<K extends string>(v: unknown, defaults: Record<K, boolean>): Record<K, boolean> {
  const saved = isRecord(v) ? v : {}
  const keys = Object.keys(defaults) as K[]
  return Object.fromEntries(keys.map((k) => [k, typeof saved[k] === 'boolean' ? saved[k] : defaults[k]])) as Record<K, boolean>
}

export function parseChoice<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

export function parseBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export function parseText(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.slice(0, 500) : fallback
}

/** A list of strings, as a set of group keys that are collapsed or of choices that are on. */
export function parseList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 2000) : []
}

/** A list of choices that are on. Only the allowed ones stay. */
export function parseChoices<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  return parseList(v).filter((x): x is T => allowed.includes(x as T))
}
