import { useCallback, useRef, useState } from 'react'
import type { UiPrefs } from '@shared/types'
import { api } from './api'

/** The scope of the home page. A review has the scope `review:<slug>`, and `global` holds what every screen shares. */
export const HOME = 'home'
export const GLOBAL = 'global'
export const reviewScope = (slug: string): string => `review:${slug}`

// The saved settings, read once when the window opens. A change goes into this copy at once and to the file after it, so a screen
// that opens later reads the new value without a second trip to the main process.
let cache: UiPrefs = {}

export async function loadPrefs(): Promise<void> {
  try {
    cache = await api.prefs.get()
  } catch {
    cache = {}
  }
}

/** The saved value of a setting, read by `parse`. Nothing saved gives the fallback. */
export function readPref<T>(scope: string, key: string, parse: (v: unknown) => T): T {
  return parse(cache[scope]?.[key])
}

export function savePref(scope: string, key: string, value: unknown): void {
  cache = { ...cache, [scope]: { ...cache[scope], [key]: value } }
  void api.prefs.set(scope, key, value).catch(() => undefined)
}

/**
 * A setting that is kept in the file. `parse` turns the saved value, or undefined, into the setting. `toPref` turns the setting
 * into JSON when it is not JSON already, such as a Set.
 */
export function usePref<T>(
  scope: string,
  key: string,
  parse: (v: unknown) => T,
  toPref: (v: T) => unknown = (v) => v
): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(scope, key, parse))
  // The latest value, so that two changes in one event, each built on the one before, both count.
  const latest = useRef(value)
  const set = useCallback(
    (next: T | ((previous: T) => T)): void => {
      const v = typeof next === 'function' ? (next as (previous: T) => T)(latest.current) : next
      latest.current = v
      setValue(v)
      savePref(scope, key, toPref(v))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, key]
  )
  return [value, set]
}
