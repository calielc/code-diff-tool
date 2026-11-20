import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PendingComment, ThreadsAnswer } from '@shared/comments'
import type { Person } from '@shared/provider'
import type { BuildResult, BuiltMr } from '@shared/review'
import type { FlowState } from '@shared/flow'
import type { AiStateView } from '@shared/ai'
import type { WatchEvent } from '@shared/watch'
import { api } from '../api'

/** What every part of the review screen reads and changes: the live data, the drafts and the toast. */
export interface ReviewCtx {
  slug: string
  viewer: string
  data: BuildResult
  people: Record<string, Person>
  drafts: Record<string, PendingComment>
  hideResolved: boolean
  setHideResolved(v: boolean): void
  mrByKey(key: string): BuiltMr | undefined
  toast(text: string): void
  applyThreads(key: string, answer: ThreadsAnswer): void
  setThreadResolved(key: string, threadId: string, resolved: boolean): void
  saveDraft(c: PendingComment): Promise<void>
  removeDraft(id: string): Promise<void>
  /** Post a typed comment or a saved draft. Resolves with an error text, or null on success. */
  post(c: PendingComment, isDraft: boolean): Promise<string | null>
  deleteNote(mr: string, noteId: number): Promise<string | null>
  resolve(mr: string, threadId: string, resolved: boolean): Promise<string | null>
  reload(): void
  refreshBanner: string[] | null
  /** The file the reviewer looks at now, for the review chat. */
  screen: { path: string; where: string } | null
  setScreen(s: { path: string; where: string } | null): void
  /** Requests from an action card. The Diff tab acts on them. */
  nav: { mr: string; path: string; line: number | null; nonce: number } | null
  requestOpen(mr: string, path: string, line: number | null): void
  viewedRequest: { mr: string; paths: string[]; nonce: number } | null
  requestViewed(mr: string, paths: string[]): void
  /** The Critical thinking flow. The saved flow is withheld while a run is pending. */
  flow: FlowState
  /** The AI review and the acceptance criteria check. Null until the first answer. */
  ai: AiStateView | null
  /** The files marked as viewed, by entry id. Kept on this machine for each review. */
  viewed: Set<string>
  setViewed: React.Dispatch<React.SetStateAction<Set<string>>>
}

const Ctx = createContext<ReviewCtx | null>(null)
export const useReview = (): ReviewCtx => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useReview needs a ReviewProvider')
  return c
}

export function ReviewProvider(props: { slug: string; result: BuildResult; onReload: () => void; children: React.ReactNode }): React.JSX.Element {
  const { slug } = props
  const [data, setData] = useState<BuildResult>(props.result)
  const [livePeople, setLivePeople] = useState<Record<string, Person>>({})
  const [drafts, setDrafts] = useState<Record<string, PendingComment>>({})
  const [hideResolved, setHideResolved] = useState(false)
  const [toastText, setToastText] = useState<string | null>(null)
  const [banner, setBanner] = useState<string[] | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [screen, setScreen] = useState<{ path: string; where: string } | null>(null)
  const [nav, setNav] = useState<ReviewCtx['nav']>(null)
  const [viewedRequest, setViewedRequest] = useState<ReviewCtx['viewedRequest']>(null)
  const nonce = useRef(0)
  const [flow, setFlow] = useState<FlowState>({ pending: false, context: null, error: null, flow: null, problems: [] })

  // The flow arrives with no reload, because a reload loses chats and unsent comments.
  useEffect(() => {
    void api.flow.get(slug).then(setFlow)
    return api.flow.onState((m) => m.slug === slug && setFlow(m.state))
  }, [slug, props.result])

  const [viewed, setViewed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`codediff:viewed:${slug}`) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`codediff:viewed:${slug}`, JSON.stringify([...viewed]))
    } catch {
      /* storage can be blocked: the marks then last until the window closes */
    }
  }, [slug, viewed])
  const [ai, setAi] = useState<AiStateView | null>(null)
  const announced = useRef<string | null>(null)
  useEffect(() => {
    void api.ai.get(slug).then(setAi)
    return api.ai.onChanged((m) => m.slug === slug && setAi(m.state))
  }, [slug, props.result])
  // Drafts of a finished AI review join the pending comments once, with a toast (file 04 section 7.9)
  useEffect(() => {
    const run = ai?.review
    if (!run || run.state !== 'done' || !run.drafts || announced.current === run.startedAt) return
    announced.current = run.startedAt
    void api.comments.list(slug).then((all) => {
      setDrafts(all)
      const n = (run.drafts ?? []).filter((id) => all[id]).length
      if (n > 0) toast(`${n} AI draft(s) arrived, not posted yet. Press c on the Diff tab to walk the comments.`)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai?.review?.state, ai?.review?.startedAt])

  useEffect(() => {
    setData(props.result)
    setBanner(null)
  }, [props.result])

  useEffect(() => {
    void api.comments.list(slug).then(setDrafts)
  }, [slug, props.result])

  const toast = useCallback((text: string) => {
    setToastText(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastText(null), 6000)
  }, [])

  const updateMr = useCallback((key: string, fn: (m: BuiltMr) => BuiltMr) => setData((d) => ({ ...d, mrs: d.mrs.map((m) => (m.key === key ? fn(m) : m)) })), [])

  // The watcher starts after the build, with the head commit of each change (file 05 section 7.1).
  useEffect(() => {
    const heads = Object.fromEntries(props.result.mrs.filter((m) => !m.noDiff).map((m) => [m.key, m.snapshot.info.diffRefs.head]))
    void api.watch.start(slug, heads)
    const off = api.watch.onEvent((msg) => {
      if (msg.slug !== slug) return
      const e: WatchEvent = msg.event
      if (e.type === 'changed') setBanner(e.mrs)
      else if (e.type === 'status')
        updateMr(e.mr, (m) => ({ ...m, snapshot: { ...m.snapshot, info: { ...m.snapshot.info, state: e.status.state, draft: e.status.draft } } }))
      else if (e.type === 'approvals') {
        updateMr(e.mr, (m) => ({ ...m, snapshot: { ...m.snapshot, approvals: e.approvals } }))
        setLivePeople((p) => ({ ...p, ...e.people }))
      } else if (e.type === 'threads') {
        updateMr(e.mr, (m) => ({ ...m, snapshot: { ...m.snapshot, threads: e.threads } }))
        setLivePeople((p) => ({ ...p, ...e.people }))
      }
    })
    return () => {
      off()
      void api.watch.stop(slug)
    }
  }, [slug, props.result, updateMr])

  const people = useMemo(() => Object.assign({}, ...data.mrs.map((m) => m.snapshot.people), livePeople) as Record<string, Person>, [data, livePeople])

  const applyThreads = useCallback(
    (key: string, a: ThreadsAnswer) => {
      if (!a.readBack) return
      updateMr(key, (m) => ({ ...m, snapshot: { ...m.snapshot, threads: a.threads } }))
      setLivePeople((p) => ({ ...p, ...a.people }))
    },
    [updateMr]
  )

  const ctx: ReviewCtx = {
    slug,
    viewer: data.viewer,
    data,
    people,
    drafts,
    hideResolved,
    setHideResolved,
    mrByKey: (key) => data.mrs.find((m) => m.key === key),
    toast,
    applyThreads,
    setThreadResolved: (key, id, resolved) =>
      updateMr(key, (m) => ({ ...m, snapshot: { ...m.snapshot, threads: m.snapshot.threads.map((t) => (t.id === id ? { ...t, resolved } : t)) } })),
    saveDraft: async (c) => {
      const r = await api.comments.save(slug, c)
      if (r.ok) setDrafts((d) => ({ ...d, [c.id]: c }))
    },
    removeDraft: async (id) => {
      setDrafts((d) => {
        const n = { ...d }
        delete n[id]
        return n
      })
      await api.comments.remove(slug, id)
    },
    post: async (c, isDraft) => {
      const r = await api.comments.post(slug, c, isDraft)
      if (!r.ok) return r.error
      if (isDraft) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => id !== c.id)))
      const iid = c.mr.slice(c.mr.lastIndexOf('!') + 1)
      if (r.value.readBack) {
        applyThreads(c.mr, r.value)
        toast(`Posted on !${iid}.`)
      } else toast(`Posted on !${iid}. Refresh the review to see it.`)
      return null
    },
    deleteNote: async (mr, noteId) => {
      const r = await api.notes.delete(slug, mr, noteId)
      if (!r.ok) return r.error
      applyThreads(mr, r.value)
      return null
    },
    resolve: async (mr, id, resolved) => {
      const r = await api.threads.resolve(slug, mr, id, resolved)
      if (!r.ok) return r.error
      return null
    },
    reload: props.onReload,
    refreshBanner: banner,
    screen,
    setScreen,
    nav,
    requestOpen: (mr, path, line) => setNav({ mr, path, line, nonce: ++nonce.current }),
    viewedRequest,
    requestViewed: (mr, paths) => setViewedRequest({ mr, paths, nonce: ++nonce.current }),
    flow,
    ai,
    viewed,
    setViewed
  }

  return (
    <Ctx.Provider value={ctx}>
      {props.children}
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </Ctx.Provider>
  )
}
