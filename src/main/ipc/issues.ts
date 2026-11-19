import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import { SLUG_RE } from '@shared/review'
import type { Result } from '@shared/types'
import { readAppState } from '../services/app-state'
import { addIssues, addSpecFiles, getIssueFile, type AddIssuesResult } from '../services/issues'
import { handle } from './guard'

const slug = z.string().regex(SLUG_RE)

async function root(): Promise<Result<string>> {
  const r = (await readAppState()).workspaceRoot
  return r ? { ok: true, value: r } : { ok: false, error: 'No workspace root is set. Open Prerequisites.' }
}

/**
 * The files the user picked in the dialog, by a one-time token. The window never holds a path, and it cannot ask the app
 * to read a path it did not pick, so a spec file can only come from the dialog.
 */
const picks = new Map<string, string[]>()

/** Take the paths of a pick. A token works once. */
export function takePick(token: string | undefined): string[] {
  if (!token) return []
  const paths = picks.get(token) ?? []
  picks.delete(token)
  return paths
}

export function registerIssueHandlers(): void {
  handle(CH.issuesGetFile, z.object({ slug, key: z.string().min(1).max(120) }), async ({ slug: s, key }): Promise<Result<string>> => {
    const r = await root()
    return r.ok ? getIssueFile(r.value, s, key) : r
  })

  handle(CH.issuesAdd, z.object({ slug, values: z.array(z.string().max(500)).max(200) }), async ({ slug: s, values }): Promise<Result<AddIssuesResult>> => {
    const r = await root()
    return r.ok ? addIssues(r.value, s, values) : r
  })

  /** Open the file dialog. Resolves with a token and the file names, or null when the user cancels. */
  handle(CH.issuesPickFiles, null, async (_a, event): Promise<{ pick: string; names: string[] } | null> => {
    // Tests choose files without the native dialog. The variable is ignored unless CODEDIFF_TEST is 1.
    const forced = process.env['CODEDIFF_TEST'] === '1' ? process.env['CODEDIFF_TEST_PICK_FILES'] : undefined
    let paths: string[]
    if (forced) paths = JSON.parse(forced) as string[]
    else {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: 'Add spec files',
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: 'Spec files', extensions: ['md', 'txt', 'html', 'htm'] }]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || r.filePaths.length === 0) return null
      paths = r.filePaths
    }
    const pick = randomUUID()
    picks.set(pick, paths)
    return { pick, names: paths.map((p) => basename(p)) }
  })

  handle(CH.issuesAddFiles, z.object({ slug, pick: z.string().uuid() }), async ({ slug: s, pick }): Promise<Result<AddIssuesResult>> => {
    const r = await root()
    if (!r.ok) return r
    const paths = takePick(pick)
    return paths.length > 0 ? addSpecFiles(r.value, s, paths) : { ok: false, error: 'These files were not picked in the file dialog.' }
  })
}
