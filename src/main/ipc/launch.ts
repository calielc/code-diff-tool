import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { LaunchRequest } from '@shared/launch'
import { handle } from './guard'

let pending: LaunchRequest | null = null

/** Keep a request from outside the app and tell the windows. The window takes it when it is ready. */
export function receiveLaunch(request: LaunchRequest | null): void {
  if (!request) return
  pending = request
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CH.launchNew)
}

export function registerLaunchHandlers(): void {
  handle(CH.launchTake, null, (): LaunchRequest | null => {
    const r = pending
    pending = null
    return r
  })
}
