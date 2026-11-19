import { BrowserWindow, clipboard, dialog, shell } from 'electron'
import { homedir } from 'node:os'
import { z } from 'zod'
import { CH } from '@shared/channels'
import type { Result } from '@shared/types'
import { readAppState, writeAppState } from '../services/app-state'
import { checkTools, findRootCandidate } from '../services/tools'
import { isDirectory, scanClones } from '../services/workspace'
import { handle } from './guard'

/** A folder is a valid workspace root when it exists and holds at least one git repo with an origin remote. */
async function validateRoot(path: string): Promise<Result<string>> {
  if (!(await isDirectory(path))) return { ok: false, error: `The folder ${path} was not found.` }
  const clones = await scanClones(path, true)
  if (clones.length === 0) {
    return { ok: false, error: `No git repositories with an origin remote were found in ${path}.` }
  }
  return { ok: true, value: path }
}

export function registerAppHandlers(): void {
  handle(CH.checkTools, null, async () => checkTools((await readAppState()).workspaceRoot))
  handle(CH.getState, null, () => readAppState())
  handle(CH.findRootCandidate, null, () => findRootCandidate())

  handle(CH.chooseRoot, null, async (_a, event): Promise<Result<string> | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const state = await readAppState()
    const opts = {
      title: 'Choose the workspace root',
      defaultPath: state.workspaceRoot ?? (await findRootCandidate()) ?? homedir(),
      properties: ['openDirectory' as const]
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths[0]) return null
    const path = picked.filePaths[0]
    const ok = await validateRoot(path)
    if (!ok.ok) return ok // shown in red, nothing is saved
    await writeAppState({ workspaceRoot: path })
    return ok
  })

  handle(CH.setRoot, z.string().min(1), async (path): Promise<Result<string>> => {
    const ok = await validateRoot(path)
    if (ok.ok) await writeAppState({ workspaceRoot: path })
    return ok
  })

  handle(CH.copyText, z.string().max(10_000), (text) => clipboard.writeText(text))

  // Only https links leave the app (file 05 section 8, rule 4).
  handle(CH.openExternal, z.string().url(), async (url): Promise<Result<true>> => {
    if (!url.startsWith('https://')) return { ok: false, error: 'Only https links can be opened.' }
    await shell.openExternal(url)
    return { ok: true, value: true }
  })
}
