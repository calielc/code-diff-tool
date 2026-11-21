import { useSyncExternalStore } from 'react'

/** The switch of the syntax colours. It is saved in the browser storage of the window, like the other choices of the Diff tab. */
const KEY = 'codediff:syntax'
const listeners = new Set<() => void>()

export function syntaxColoursOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

export function setSyntaxColours(on: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(on))
  } catch {
    /* storage can be blocked */
  }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** True when the syntax colours are on. The colours are on until the reader turns them off. */
export const useSyntaxColours = (): boolean => useSyncExternalStore(subscribe, syntaxColoursOn)
