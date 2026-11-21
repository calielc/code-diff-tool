import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import type { SectionsState } from '@shared/sections'
import { SLUG_RE } from '@shared/review'
import { requestSections, sectionsStateOf, subscribeSections } from '../services/sections'
import { handle } from './guard'

export function registerSectionsHandlers(): void {
  handle(CH.sectionsGet, z.string().regex(SLUG_RE), (slug): SectionsState => sectionsStateOf(slug))
  // The reader opened the Summarised view. The reply comes at once, and the state arrives through the push below.
  handle(CH.sectionsStart, z.string().regex(SLUG_RE), (slug): void => {
    void requestSections(slug).catch(() => undefined)
  })
  // A change of the state goes to every window, so the page arrives with no reload
  subscribeSections((slug, state) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CH.sectionsState, { slug, state })
  })
}
