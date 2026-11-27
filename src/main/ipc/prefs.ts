import { z } from 'zod'
import { CH } from '@shared/channels'
import { readUiPrefs, setUiPref } from '../services/ui-prefs'
import { handle } from './guard'

const MAX_VALUE = 100_000

export function registerPrefsHandlers(): void {
  handle(CH.prefsGet, null, () => readUiPrefs())
  handle(
    CH.prefsSet,
    z.object({
      scope: z.string().min(1).max(200),
      key: z.string().min(1).max(100),
      value: z.unknown().refine((v) => (JSON.stringify(v) ?? '').length <= MAX_VALUE, 'The setting is too large.')
    }),
    ({ scope, key, value }) => setUiPref(scope, key, value)
  )
}
