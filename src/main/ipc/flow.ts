import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { CH } from '@shared/channels'
import type { FlowState } from '@shared/flow'
import { SLUG_RE } from '@shared/review'
import { flowStateOf, subscribeFlow } from '../services/flow'
import { handle } from './guard'

export function registerFlowHandlers(): void {
  handle(CH.flowGet, z.string().regex(SLUG_RE), (slug): FlowState => flowStateOf(slug))
  // A change of a flow state goes to every window, so the flow arrives with no reload
  subscribeFlow((slug, state) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CH.flowState, { slug, state })
  })
}
