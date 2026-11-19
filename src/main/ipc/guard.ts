import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'

/** URL prefixes of the app's own page. Set by the window code. */
let appOrigins: string[] = []
export function setAppOrigins(origins: string[]): void {
  appOrigins = origins
}

export function isAppUrl(url: string | undefined): boolean {
  return !!url && appOrigins.some((o) => url === o || url.startsWith(o))
}

/**
 * Register one invoke channel. The sender frame must be the app's own page
 * (file 05 section 8, rule 3) and the argument must pass its schema (rule 6).
 */
export function handle<A, R>(channel: string, schema: ZodType<A> | null, fn: (arg: A, event: IpcMainInvokeEvent) => Promise<R> | R): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error(`Refused: ${channel} was called from an unknown page.`)
    const arg = schema ? schema.parse(raw) : (undefined as A)
    return fn(arg, event)
  })
}
