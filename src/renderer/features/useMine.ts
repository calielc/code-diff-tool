import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { combineMine, keepFailedHosts, MINE_POLL_MS, type MineItem, type MineResult, type MineScope } from '@shared/my-changes'
import type { ChangeSnapshot } from '@shared/provider'
import { api } from '../api'

/** The answer for one change, with the updated time it was read for. A null snapshot is a failed read. */
export type Answer = { updatedAt: string; snapshot: ChangeSnapshot | null }

export interface Mine {
  data: MineResult | null
  /** The newest answer for each url. */
  answers: Record<string, Answer>
  loading: boolean
  reload: () => Promise<void>
  /** Reads the full snapshot of these changes, once for each updated time. The cells fill in as the answers arrive. */
  request: (items: MineItem[]) => void
  /** Makes the main process forget the snapshots of these changes, and reads them again once each. The old answers stay until the new ones arrive. */
  refresh: (items: MineItem[]) => void
  /** Reads these changes again, once each, after a write that already made the main process drop their snapshots. The old answers stay until the new ones arrive. Resolves when every read has ended. */
  reread: (items: MineItem[]) => Promise<void>
}

/** Reads the lists while a list tab is shown. They load at once, again every 60 seconds and again when the window gains focus. */
export function useMine(active: boolean): Mine {
  // The open changes and the merged and closed ones come in two calls. The open part is small and shows first.
  const [parts, setParts] = useState<Record<'open' | 'closed', MineResult | null>>({ open: null, closed: null })
  const result = useMemo(() => combineMine(parts.open, parts.closed), [parts])
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)
  const asked = useRef(new Set<string>())

  const load = useCallback((visible: boolean): Promise<void> => {
    const n = ++latest.current
    if (visible) setLoading(true)
    const part = (scope: Exclude<MineScope, 'all'>, done?: () => void): Promise<void> =>
      api.changes
        .mine(scope)
        .then((next) => {
          if (n === latest.current) setParts((p) => ({ ...p, [scope]: keepFailedHosts(p[scope], next) }))
        })
        .catch(() => undefined)
        .finally(done)
    // The list stops showing as loading when the open part is there. The merged and closed part goes on in the background.
    const stop = (): void => {
      if (visible && n === latest.current) setLoading(false)
    }
    return Promise.all([part('open', stop), part('closed')]).then(() => undefined)
  }, [])

  useEffect(() => {
    if (!active) return
    const reload = (): void => void load(true)
    void load(true)
    const timer = setInterval(() => void load(false), MINE_POLL_MS)
    window.addEventListener('focus', reload)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', reload)
    }
  }, [active, load])

  const read = useCallback((i: MineItem): Promise<void> => {
    asked.current.add(`${i.url} ${i.updatedAt}`)
    return api.changes
      .snapshot({ url: i.url, updatedAt: i.updatedAt })
      .then((r) => (r.ok ? r.value : null))
      .catch(() => null)
      .then((snapshot) =>
        setAnswers((a) => {
          const known = a[i.url]
          // An answer for an older updated time does not replace a newer one. A failed read does not replace a snapshot that is on screen.
          if (known && Date.parse(known.updatedAt) > Date.parse(i.updatedAt)) return a
          if (known?.snapshot && !snapshot) return a
          return { ...a, [i.url]: { updatedAt: i.updatedAt, snapshot } }
        })
      )
  }, [])

  const request = useCallback(
    (items: MineItem[]) => {
      for (const i of items) if (!asked.current.has(`${i.url} ${i.updatedAt}`)) void read(i)
    },
    [read]
  )

  const refresh = useCallback(
    (items: MineItem[]) => {
      void api.changes
        .dropSnapshots(items.map((i) => i.url))
        .catch(() => undefined)
        .then(() => {
          for (const i of items) asked.current.delete(`${i.url} ${i.updatedAt}`)
          request(items)
        })
    },
    [request]
  )

  const reread = useCallback(
    async (items: MineItem[]): Promise<void> => {
      await Promise.all(items.map(read))
    },
    [read]
  )

  return { data: result, answers, loading, reload: () => load(true), request, refresh, reread }
}
