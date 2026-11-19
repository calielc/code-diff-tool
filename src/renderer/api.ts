import type { CodeDiffApi } from '@shared/types'

declare global {
  interface Window {
    codeDiff: CodeDiffApi
  }
}

/** Typed wrapper around window.codeDiff (file 05 section 9.2). */
export const api: CodeDiffApi = window.codeDiff
