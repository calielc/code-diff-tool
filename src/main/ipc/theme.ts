import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import { SYSTEM_THEME, themeById } from '@shared/themes'
import { readAppState, writeAppState } from '../services/app-state'
import { handle } from './guard'

/** The saved theme id. An id that no theme has reads as System. */
export async function currentTheme(): Promise<string> {
  const saved = (await readAppState()).theme
  return themeById(saved) ? (saved as string) : SYSTEM_THEME
}

/** Save a theme and tell every window. The menu is rebuilt by the caller. */
export async function setTheme(id: string): Promise<string> {
  const next = themeById(id) ? id : SYSTEM_THEME
  await writeAppState({ theme: next })
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CH.themeSet, next)
  return next
}

export function registerThemeHandlers(onChanged: (id: string) => void): void {
  handle(CH.themeGet, null, () => currentTheme())
  handle(CH.themeChoose, z.string().max(40), async (id) => {
    const next = await setTheme(id)
    onChanged(next)
    return next
  })
}
