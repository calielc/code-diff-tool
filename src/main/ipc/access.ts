import { z } from 'zod'
import { CH } from '@shared/channels'
import type { Result } from '@shared/types'
import { removeAccess, saveAccess } from '../services/credentials'
import { handle } from './guard'

const kind = z.enum(['gitlab', 'github', 'jira'])

export function registerAccessHandlers(): void {
  // The token is checked against the service and saved encrypted. It never comes back to the window.
  handle(
    CH.accessSave,
    z.object({ kind, host: z.string().min(1).max(253), token: z.string().min(1).max(4096), email: z.string().max(320).optional() }),
    async (i): Promise<Result<string>> => {
      const r = await saveAccess(i.kind, i.host, { token: i.token, email: i.email })
      return r.ok ? { ok: true, value: r.user } : r
    }
  )
  handle(CH.accessRemove, z.object({ kind, host: z.string().max(253) }), (i) => removeAccess(i.kind, i.host))
}
