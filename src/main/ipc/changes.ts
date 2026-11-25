import { z } from 'zod'
import { CH } from '@shared/channels'
import type { MineResult } from '@shared/my-changes'
import type { ChangeSnapshot } from '@shared/provider'
import type { Result } from '@shared/types'
import { submitReview } from '../clients/writes'
import { submitByUrls } from '../clients/submit-by-url'
import { fetchMine, type MineAccess } from '../clients/my-changes'
import { snapshots } from '../clients/snapshots'
import { listAccess } from '../services/credentials'
import { handle } from './guard'

const snapshotRequest = z.object({ url: z.string().max(2048), updatedAt: z.string().max(64) })
const urlList = z.array(z.string().max(2048)).max(100)
const submitRequest = z.object({
  approve: urlList,
  unapprove: urlList,
  requestChanges: urlList,
  summaries: z.record(z.string().max(2048), z.string().max(65_536)),
  ready: urlList,
  draft: urlList
})
const dropRequest = z.object({ urls: z.array(z.string().max(2048)).max(1000) })

export function registerChangesHandlers(): void {
  // Reads the lists with the saved tokens. Only items and error texts go to the window, never a token.
  handle(CH.changesMine, null, async (): Promise<MineResult> => {
    const accesses = listAccess().filter((a): a is typeof a & { kind: MineAccess['provider'] } => a.kind !== 'jira')
    return fetchMine(accesses.map((a) => ({ provider: a.kind, host: a.host })))
  })
  // The full snapshot of one change. The window asks for each change on its own, and the main process keeps 6 reads open at most.
  handle(CH.changesSnapshot, snapshotRequest, (req): Promise<Result<ChangeSnapshot>> => snapshots.get(req.url, req.updatedAt))
  // Forgets the kept snapshots of these changes, so the next ask reads them again.
  handle(CH.changesDropSnapshots, dropRequest, (req): void => snapshots.drop(req.urls))
  // The actions of a review, for changes that are not in a review. Each url is a change, and the saved access of its host does the write.
  handle(CH.changesSubmit, submitRequest, (req): Promise<Result<Record<string, string>>> =>
    submitByUrls(
      {
        submit: (input, refs) => submitReview({ slug: '', ...input }, refs),
        hasAccess: (ref) => listAccess().some((a) => a.kind === ref.provider && a.host === ref.host),
        dropSnapshots: (urls) => snapshots.drop(urls)
      },
      req
    )
  )
}
