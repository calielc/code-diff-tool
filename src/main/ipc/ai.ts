import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import { SLUG_RE } from '@shared/review'
import type { Result } from '@shared/types'
import { aiState, startRun, stopRun, subscribeAi, type AiState } from '../services/ai-runs'
import { readAppState, writeAppState } from '../services/app-state'
import { onSessionChange, sessionOf } from '../services/session'
import { writePicks, readPicks } from '../services/skills'
import { handle } from './guard'

const slug = z.string().regex(SLUG_RE)
const kind = z.enum(['review', 'ac'])
const start = z.object({
  slug,
  kind,
  skill: z.string().max(300).optional(),
  model: z.string().max(20),
  effort: z.string().max(10).nullable().optional(),
  withoutIssues: z.array(z.string().max(100)).max(100)
})
const picks = z.object({
  slug,
  skill: z.string().max(300).nullable(),
  model: z.string().max(20).nullable(),
  acModel: z.string().max(20).nullable(),
  acEffort: z.string().max(10).nullable()
})

export function registerAiHandlers(): void {
  handle(CH.aiGet, slug, (s): Promise<AiState | null> => aiState(s))
  handle(CH.aiStart, start, (req): Promise<Result<AiState>> => startRun({ ...req, withoutIssues: req.withoutIssues }))
  handle(CH.aiStop, z.object({ slug, kind }), async (r): Promise<void> => stopRun(r.slug, r.kind))
  handle(CH.aiPicks, picks, async (p): Promise<AiState | null> => {
    const s = sessionOf(p.slug)
    if (s) {
      const m = (v: string | null): never | null => v as never
      await writePicks(s.root, { skill: p.skill, model: m(p.model), acModel: m(p.acModel), acEffort: m(p.acEffort) })
    }
    return aiState(p.slug)
  })
  // The folder of review skills (SKILL.md files) is chosen by the user in a main-process dialog, never by a renderer path.
  handle(CH.aiPickSkills, slug, async (s, event): Promise<AiState | null> => {
    const forced = process.env['CODEDIFF_TEST'] === '1' ? process.env['CODEDIFF_TEST_PICK_SKILLS'] : undefined
    let folder: string | undefined = forced
    if (!folder) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = { title: 'Choose the folder of review skills', properties: ['openDirectory' as const] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || r.filePaths.length === 0) return aiState(s)
      folder = r.filePaths[0]
    }
    await writeAppState({ skillsFolder: folder })
    return aiState(s, (await readAppState()).skillsFolder ?? null)
  })
  const push = (s: string): void => {
    void aiState(s).then((state) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CH.aiChanged, { slug: s, state })
    })
  }
  subscribeAi(push)
  onSessionChange(push)
  void readPicks
}
