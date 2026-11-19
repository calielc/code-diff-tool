import { useEffect, useMemo, useState } from 'react'
import { newCommentId, type PendingComment } from '@shared/comments'
import type { FileObject, LevelName, LineObj } from '@shared/diff'
import type { DiffRefs } from '@shared/provider'
import type { BuildResult } from '@shared/review'
import { draftAtLine, fileThreads, isFileDraft, positionMatchesLine, threadCounts, threadOnFile, threadsAtLine } from '@shared/threads'
import { useReview } from './review-context'
import { SubmitDialog, reviewable } from './SubmitDialog'
import { FlowView } from './FlowView'
import { LineChat } from './LineChat'
import { CommentForm, DraftCard, ThreadCard } from './ThreadViews'

type ViewName = 'mr' | 'combined' | 'flow'

/** The three noise buttons. The ids are the internal level names (file 02 section 2). */
const NOISE: { id: LevelName; label: string; hint: string }[] = [
  { id: 'strict', label: 'Code only', hint: 'Hides blank lines, whitespace, imports, comments and mechanical modifiers' },
  { id: 'basic', label: 'Keep mechanical', hint: 'Hides blank lines, whitespace, imports and moved namespaces' },
  { id: 'raw', label: 'Everything', hint: "Follows git's own diff" }
]

const STATUS_WORD = { A: 'New', M: 'Modified', D: 'Deleted', R: 'Renamed' } as const

/** One file of the current view. */
interface Entry {
  id: string
  repo: string
  /** The MR row or part row under the repo. */
  groupKey: string
  groupLabel: string
  groupTip: string
  file: FileObject
  scope: string
  /** The change that owns the file in By MR. Null in Combined, where each line has its own target. */
  mrKey: string | null
  /** The changes of the part, in Combined. */
  partMrs: string[]
  /** The change and the commit whose code the line chat reads. */
  chatMr: string
  chatSha: string
}

interface TreeNode {
  key: string
  kind: 'repo' | 'group' | 'folder' | 'file'
  name: string
  tip?: string
  children: TreeNode[]
  entry?: Entry
}

function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage can be blocked */
  }
}

const iidOf = (key: string): string => key.slice(key.lastIndexOf('!') + 1)

function entriesOf(result: BuildResult, view: ViewName): Entry[] {
  if (view === 'mr' || view === 'flow') {
    return result.mrs.flatMap((m) =>
      m.files.map((file) => ({
        id: `mr:${m.key}|${file.path}`,
        repo: m.repo,
        groupKey: m.key,
        groupLabel: `!${m.snapshot.info.ref.iid}`,
        groupTip: m.snapshot.info.title,
        file,
        scope: `${m.key} · ${m.repo}`,
        mrKey: m.key,
        partMrs: [],
        chatMr: m.key,
        chatSha: m.snapshot.info.diffRefs.head
      }))
    )
  }
  const partNo = new Map<string, number>()
  return result.combined.flatMap((p) => {
    const n = (partNo.get(p.repo) ?? 0) + 1
    partNo.set(p.repo, n)
    const nums = p.mrs.map((k) => `!${iidOf(k)}`)
    const label = p.mrs.length > 3 ? `${nums[0]} … (${p.mrs.length} MRs)` : nums.join(', ')
    return p.files.map((file) => ({
      id: `cb:${p.repo}~${n}|${file.path}`,
      repo: p.repo,
      groupKey: `${p.repo}~${n}`,
      groupLabel: `Part ${n} · ${label}`,
      groupTip: p.reason ?? 'The first part',
      file,
      scope: `combined · ${p.repo} · ${nums.join(', ')}`,
      mrKey: null,
      partMrs: p.mrs,
      chatMr: p.mrs[0],
      chatSha: p.headSha ?? ''
    }))
  })
}

/** Repo, then MR or part, then folders, then files. A folder with one child folder joins it (file 02 section 5.4). */
function buildTree(entries: Entry[]): TreeNode[] {
  const repos: TreeNode[] = []
  for (const e of entries) {
    let repo = repos.find((r) => r.name === e.repo)
    if (!repo) repos.push((repo = { key: `r:${e.repo}`, kind: 'repo', name: e.repo, children: [] }))
    let group = repo.children.find((g) => g.key === `g:${e.groupKey}`)
    if (!group) repo.children.push((group = { key: `g:${e.groupKey}`, kind: 'group', name: e.groupLabel, tip: e.groupTip, children: [] }))
    const parts = e.file.path.split('/')
    let level = group.children
    let prefix = `${e.groupKey}`
    for (const seg of parts.slice(0, -1)) {
      prefix += `/${seg}`
      let folder = level.find((n) => n.kind === 'folder' && n.name === seg)
      if (!folder) level.push((folder = { key: `f:${prefix}`, kind: 'folder', name: seg, children: [] }))
      level = folder.children
    }
    level.push({ key: e.id, kind: 'file', name: parts[parts.length - 1], tip: e.file.path, children: [], entry: e })
  }
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)) // subfolders before files
    nodes.forEach((n) => sortNodes(n.children))
  }
  const join = (n: TreeNode): void => {
    n.children.forEach(join)
    while (n.kind === 'folder' && n.children.length === 1 && n.children[0].kind === 'folder') {
      const c = n.children[0]
      n.name = `${n.name}/${c.name}`
      n.key = c.key
      n.children = c.children
    }
  }
  repos.forEach((r) => sortNodes(r.children))
  repos.forEach(join)
  return repos
}

const filesOf = (n: TreeNode): Entry[] => (n.entry ? [n.entry] : n.children.flatMap(filesOf))

export function DiffTab(): React.JSX.Element {
  const r = useReview()
  const result = r.data
  const hasCombined = result.combined.length > 0
  const [view, setView] = useState<ViewName>(() => (store<ViewName>('codediff:view', 'mr') === 'combined' && hasCombined ? 'combined' : 'mr'))
  const [level, setLevel] = useState<LevelName>(() => store<LevelName>('codediff:noise', 'strict'))
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [showGenerated, setShowGenerated] = useState<Set<string>>(new Set())
  const [viewed, setViewed] = useState<Set<string>>(() => new Set(store<string[]>(`codediff:viewed:${r.slug}`, [])))
  const [noiseOpen, setNoiseOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)

  useEffect(() => save('codediff:view', view), [view])
  useEffect(() => save('codediff:noise', level), [level])
  useEffect(() => save(`codediff:viewed:${r.slug}`, [...viewed]), [r.slug, viewed])

  // The flow view shows no tree. Leaving it returns to the By MR view, and a flow that went away does the same.
  useEffect(() => {
    if (view === 'flow' && !r.flow.flow) setView('mr')
  }, [view, r.flow.flow])
  const all = useMemo(() => entriesOf(result, view), [result, view])
  // A file is noise at a level when it is not binary and has no hunk at that level (file 02 section 2.1).
  const isNoise = (e: Entry): boolean => !e.file.binary && e.file.levels[level].hunks.length === 0
  const shown = useMemo(() => all.filter((e) => !isNoise(e)), [all, level]) // eslint-disable-line react-hooks/exhaustive-deps
  const noise = useMemo(() => all.filter(isNoise), [all, level]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? shown.filter((e) => e.file.path.toLowerCase().includes(q)) : shown
  }, [shown, filter])
  const tree = useMemo(() => buildTree(visible), [visible])

  // Keep the open file when the view changes, else open the first shown file.
  useEffect(() => {
    if (selected && visible.some((e) => e.id === selected)) return
    const path = selected?.split('|').slice(1).join('|')
    setSelected((path && visible.find((e) => e.file.path === path)?.id) ?? visible[0]?.id ?? null)
  }, [visible, selected])

  const current = visible.find((e) => e.id === selected) ?? null
  const [focusLine, setFocusLine] = useState<number | null>(null)

  // The review chat knows which file the reviewer looks at now.
  useEffect(() => {
    if (!current) return r.setScreen(null)
    r.setScreen({ path: current.file.path, where: current.mrKey ? `MR !${iidOf(current.mrKey)} (${current.repo})` : `the combined view of ${current.repo}` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  // An Open card: switch to By MR, show the file and scroll to the line. A hidden line switches the noise level to Everything.
  useEffect(() => {
    const n = r.nav
    if (!n) return
    setView('mr')
    setFilter('')
    const entry = entriesOf(result, 'mr').find((e) => e.mrKey === n.mr && (e.file.path === n.path || e.file.oldPath === n.path))
    if (!entry) return
    if (n.line !== null && !entry.file.levels[level].hunks.flat().some((l) => l.n === n.line)) setLevel('raw')
    setSelected(entry.id)
    setFocusLine(n.line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.nav?.nonce])

  // A Mark viewed card
  useEffect(() => {
    const v = r.viewedRequest
    if (!v) return
    const ids = entriesOf(result, 'mr')
      .filter((e) => e.mrKey === v.mr && (v.paths.includes(e.file.path) || v.paths.includes(e.file.oldPath)))
      .map((e) => e.id)
    setViewed((old) => new Set([...old, ...ids]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.viewedRequest?.nonce])
  const doneCount = shown.filter((e) => viewed.has(e.id)).length
  const draftCount = Object.keys(r.drafts).length
  const canReview = reviewable(result.mrs, r.viewer)

  const toggleViewed = (entries: Entry[], on: boolean): void =>
    setViewed((v) => {
      const n = new Set(v)
      for (const e of entries) {
        if (on) n.add(e.id)
        else n.delete(e.id)
      }
      return n
    })

  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const entries = filesOf(n)
    const add = entries.reduce((s, e) => s + e.file.levels[level].add, 0)
    const del = entries.reduce((s, e) => s + e.file.levels[level].del, 0)
    const allViewed = entries.length > 0 && entries.every((e) => viewed.has(e.id))
    const someViewed = entries.some((e) => viewed.has(e.id))
    const isOpen = filter.trim() !== '' || !closed.has(n.key) // a typed filter opens every folder
    const pad = { paddingLeft: 8 + 14 * depth }
    if (n.kind === 'file' && n.entry) {
      const f = n.entry.file
      const mr = n.entry.mrKey ? r.mrByKey(n.entry.mrKey) : undefined
      const tc = mr ? threadCounts(mr.snapshot.threads, f.path, f.oldPath) : { open: 0, total: 0 }
      const drafts = n.entry.mrKey ? Object.values(r.drafts).filter((d) => d.mr === n.entry!.mrKey && d.path === f.path).length : 0
      return (
        <li key={n.key}>
          <div
            className={`trow file ${n.entry.id === selected ? 'current' : ''} ${viewed.has(n.entry.id) ? 'viewed' : ''}`}
            style={pad}
            title={n.tip}
            onClick={() => setSelected(n.entry!.id)}
            data-testid={`file-${f.path}`}
          >
            <input
              type="checkbox"
              title="Viewed"
              checked={viewed.has(n.entry.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => toggleViewed([n.entry!], e.target.checked)}
            />
            <span className={`badge ${f.status}`} title={STATUS_WORD[f.status]}>
              {f.status}
            </span>
            <span className="tname">{n.name}</span>
            {tc.total > 0 && (
              <span className={`chip ${tc.open > 0 ? 'openchip' : 'resolved'}`} title={`${tc.open} open of ${tc.total} thread(s)`} data-testid="thread-chip">
                💬 {tc.open}/{tc.total}
              </span>
            )}
            {drafts > 0 && (
              <span className="chip draftchip" title="Your drafts, not posted yet">
                {drafts}
              </span>
            )}
            <span className="counts">
              <span className="plus">+{f.levels[level].add}</span> <span className="minus">−{f.levels[level].del}</span>
            </span>
          </div>
        </li>
      )
    }
    return (
      <li key={n.key}>
        <div className={`trow ${n.kind}`} style={pad} title={n.tip}>
          <input
            type="checkbox"
            title="Mark everything here as viewed"
            checked={allViewed}
            ref={(el) => {
              if (el) el.indeterminate = !allViewed && someViewed
            }}
            onChange={(e) => toggleViewed(entries, e.target.checked)}
          />
          <button
            className="chev"
            aria-label={isOpen ? 'Fold' : 'Open'}
            onClick={() => setClosed((c) => (c.has(n.key) ? new Set([...c].filter((k) => k !== n.key)) : new Set(c).add(n.key)))}
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <span className={`tname ${n.kind === 'group' ? 'mono lead' : ''}`}>{n.name}</span>
          <span className="counts">
            <span className="plus">+{add}</span> <span className="minus">−{del}</span>
          </span>
          <span className="count" title={`${entries.length} file(s)`}>
            {entries.length}
          </span>
        </div>
        {isOpen && <ul>{n.children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    )
  }

  const partsBadge = result.combined.length > 0 && new Set(result.combined.map((p) => p.repo)).size < result.combined.length
  const combinedTip = !hasCombined
    ? 'Combined needs 2+ MRs in the same repo'
    : [...result.combined.filter((p) => p.reason).map((p) => `${p.repo}: a part ${p.reason}`), 'Each part combines the MRs that merge cleanly in order.'].join(
        '\n'
      )

  return (
    <div className="difftab" data-testid="diff-tab">
      <div className="difftoolbar">
        <span className="group" role="group" aria-label="View">
          <span className="glabel">View</span>
          <button
            className={view === 'flow' ? 'on' : ''}
            disabled={!r.flow.flow}
            data-testid="view-flow"
            title={r.flow.pending ? 'The AI is writing Critical thinking' : r.flow.flow ? 'The chain to follow, and what to skip' : 'No Critical thinking yet'}
            onClick={() => setView('flow')}
          >
            {r.flow.pending && <span className="spin">◐ </span>}Critical thinking
          </button>
          <button className={view === 'mr' ? 'on' : ''} onClick={() => setView('mr')}>
            By MR
          </button>
          <button className={view === 'combined' ? 'on' : ''} disabled={!hasCombined} title={combinedTip} onClick={() => setView('combined')}>
            Combined
            {partsBadge && <span className="parts"> {result.combined.length} parts</span>}
          </button>
        </span>
        <span className="group" role="group" aria-label="Noise">
          <span className="glabel">Noise</span>
          {NOISE.map((n) => (
            <button key={n.id} className={level === n.id ? 'on' : ''} title={n.hint} onClick={() => setLevel(n.id)}>
              {n.label}
            </button>
          ))}
        </span>
        <span className="group muted">Layout: Inline</span>
        <label className="group small">
          <input type="checkbox" checked={r.hideResolved} onChange={(e) => r.setHideResolved(e.target.checked)} /> Hide resolved threads
        </label>
      </div>
      {view === 'flow' && r.flow.flow ? (
        <FlowView
          flow={r.flow.flow}
          onOpen={(mr, path, line) => {
            setView('mr')
            r.requestOpen(mr, path, line)
          }}
        />
      ) : (
        <div className="split">
          <aside className="filetree">
            <input aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="progress" title={`${doneCount} of ${shown.length} files viewed`}>
              <div className="bar6">
                <div style={{ width: `${shown.length ? Math.round((doneCount / shown.length) * 100) : 0}%` }} />
              </div>
              <span className="muted">
                {doneCount} of {shown.length} viewed
              </span>
            </div>
            <ul className="tree" data-testid="tree">
              {tree.map((n) => row(n, 0))}
            </ul>
            {noise.length > 0 && (
              <div className="noiseblock">
                <button className="link" onClick={() => setNoiseOpen((o) => !o)}>
                  {noise.length} {noise.length === 1 ? 'file' : 'files'} hidden: noise only at this level
                </button>
                {noiseOpen && (
                  <ul>
                    {noise.map((e) => (
                      <li key={e.id} className="muted" title={e.file.path}>
                        {e.file.path}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </aside>
          <section className="filepanel">
            {current ? (
              <FileBody
                key={current.id}
                entry={current}
                level={level}
                generatedShown={showGenerated.has(current.id)}
                onShowGenerated={() => setShowGenerated((s) => new Set(s).add(current.id))}
                viewed={viewed.has(current.id)}
                onViewed={(on) => toggleViewed([current], on)}
                focusLine={focusLine}
              />
            ) : (
              <p className="muted center" data-testid="no-files">
                {all.length === 0 ? 'No changed files.' : 'No file to show at this noise level.'}
              </p>
            )}
          </section>
        </div>
      )}
      <div className="reviewbar" data-testid="review-bar">
        <span className="muted small grow" data-testid="review-bar-text">
          {draftCount > 0
            ? `${draftCount} ${draftCount === 1 ? 'draft' : 'drafts'} not posted yet. Post or delete each one.`
            : 'Hover a line and press + to comment. A comment is posted at once.'}
        </span>
        <button
          className="primary"
          data-testid="open-submit"
          disabled={canReview.length === 0}
          title={canReview.length === 0 ? 'No open change by someone else' : undefined}
          onClick={() => setSubmitOpen(true)}
        >
          Submit review
        </button>
      </div>
      {submitOpen && <SubmitDialog mrs={canReview} onClose={() => setSubmitOpen(false)} />}
    </div>
  )
}

/** Where a comment on a line goes. */
interface Target {
  mr: string
  path: string | null
  oldPath: string | null
  oldLine: number | null
  newLine: number | null
  diffRefs: DiffRefs
}

function FileBody(props: {
  entry: Entry
  level: LevelName
  generatedShown: boolean
  onShowGenerated: () => void
  viewed: boolean
  onViewed: (on: boolean) => void
  focusLine: number | null
}): React.JSX.Element {
  const r = useReview()
  const { entry, level } = props
  const { file } = entry
  const lv = file.levels[level]
  const [formAt, setFormAt] = useState<string | null>(null)
  const [chatAt, setChatAt] = useState<string | null>(null) // one line chat is open at a time

  // An Open card with a line: scroll to it and flash it.
  useEffect(() => {
    if (props.focusLine === null) return
    const row = document.querySelector(`tr[data-new-line="${props.focusLine}"]`)
    row?.scrollIntoView({ block: 'center' })
    row?.classList.add('flash')
    const t = setTimeout(() => row?.classList.remove('flash'), 1500)
    return () => clearTimeout(t)
  }, [props.focusLine, props.entry.id])
  const [chosen, setChosen] = useState<string>('')

  /** The target of a line (file 03 section 10.1), or null when the line takes no comment, or 'choose' in Combined with no owner. */
  const targetOf = (l: LineObj): Target | null | 'choose' => {
    const own = (key: string): { mr: NonNullable<ReturnType<typeof r.mrByKey>>; path: string; oldPath: string } | null => {
      const mr = r.mrByKey(key)
      if (!mr) return null
      const f = mr.files.find((x) => x.path === file.path || x.oldPath === file.oldPath)
      return { mr, path: f?.path ?? file.path, oldPath: f?.oldPath ?? file.oldPath }
    }
    if (entry.mrKey) {
      const o = own(entry.mrKey)
      if (!o || o.mr.snapshot.info.state !== 'opened') return null // a merged change takes no comment
      return {
        mr: entry.mrKey,
        path: file.path,
        oldPath: file.oldPath,
        oldLine: l.t === '+' ? null : l.o,
        newLine: l.t === '-' ? null : l.n,
        diffRefs: o.mr.snapshot.info.diffRefs
      }
    }
    if (l.target) {
      const o = own(l.target.mr)
      if (!o || o.mr.snapshot.info.state !== 'opened') return null
      return { mr: l.target.mr, path: o.path, oldPath: o.oldPath, oldLine: l.target.o, newLine: l.target.n, diffRefs: o.mr.snapshot.info.diffRefs }
    }
    return entry.partMrs.some((k) => r.mrByKey(k)?.snapshot.info.state === 'opened') ? 'choose' : null
  }

  const openMrsOfPart = entry.partMrs.filter((k) => r.mrByKey(k)?.snapshot.info.state === 'opened')

  const post = async (t: Target, body: string): Promise<string | null> => {
    const c: PendingComment = {
      id: newCommentId(),
      mr: t.mr,
      diffRefs: t.diffRefs,
      path: t.path,
      oldPath: t.oldPath,
      oldLine: t.oldLine,
      newLine: t.newLine,
      body,
      view: entry.mrKey ? 'mr' : 'combined'
    }
    const err = await r.post(c, false)
    if (!err) setFormAt(null)
    return err
  }

  const visibleThreads = (mrKey: string, path: string, oldPath: string, line: { o: number | null; n: number | null }): ReturnType<typeof threadsAtLine> => {
    const m = r.mrByKey(mrKey)
    return m ? threadsAtLine(m.snapshot.threads, path, oldPath, line).filter((t) => !(r.hideResolved && t.resolved)) : []
  }

  // Threads on lines that the noise level hides, and threads on the whole file (file 02 section 8.1).
  const mr = entry.mrKey ? r.mrByKey(entry.mrKey) : undefined
  const shownLines = lv.hunks.flat()
  const fileThreadsAll = mr ? mr.snapshot.threads.filter((t) => threadOnFile(t, file.path, file.oldPath)) : []
  const hidden = fileThreadsAll.filter((t) => !shownLines.some((l) => positionMatchesLine(t.position!, l)) && !(r.hideResolved && t.resolved))
  const wholeFile = mr ? fileThreads(mr.snapshot.threads, file.path).filter((t) => !(r.hideResolved && t.resolved)) : []
  const wholeFileDrafts = entry.mrKey ? Object.values(r.drafts).filter((d) => isFileDraft(d, entry.mrKey!, file.path)) : []

  const header = `${STATUS_WORD[file.status]}${file.status === 'R' ? ` · renamed from ${file.oldPath}` : ''} · ${entry.scope}`
  let body: React.ReactNode
  if (file.binary) body = <p className="note">Binary file, no text diff.</p>
  else if (file.generated && !props.generatedShown) {
    body = (
      <p className="note">
        Generated file. The build or a tool writes it, so it is folded. <button onClick={props.onShowGenerated}>Show the diff</button>
      </p>
    )
  } else if (lv.hunks.length === 0) body = <p className="note">No line of this file changed at this noise level.</p>
  else {
    body = (
      <table className="diff" data-testid="diff-table">
        <tbody>
          {lv.hunks.map((h, i) => {
            const firstOld = h.find((l) => l.o !== null)?.o
            const firstNew = h.find((l) => l.n !== null)?.n
            return [
              <tr key={`h${i}`} className="hunk">
                <td colSpan={4}>
                  @@ old {firstOld ?? '–'} · new {firstNew ?? '–'} @@
                </td>
              </tr>,
              ...h.flatMap((l, j) => {
                const id = `${i}:${j}`
                const target = targetOf(l)
                const t = target && target !== 'choose' ? target : null
                const threads = t ? visibleThreads(t.mr, t.path ?? file.path, t.oldPath ?? file.oldPath, { o: t.oldLine, n: t.newLine }) : []
                const drafts = t ? Object.values(r.drafts).filter((d) => draftAtLine(d, t.mr, t.path ?? file.path, { o: t.oldLine, n: t.newLine })) : []
                const rows: React.ReactNode[] = [
                  <tr key={`l${id}`} data-new-line={l.n ?? undefined} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}>
                    <td className="ln">
                      {target ? (
                        <button
                          className="plusbtn"
                          aria-label="Comment on this line"
                          title="Comment on this line"
                          onClick={() => (setFormAt(id), setChosen(openMrsOfPart[0] ?? ''))}
                        >
                          +
                        </button>
                      ) : (
                        <span className="stripe" role="img" aria-label="Read-only: merged MR" title="Read-only: merged MR" />
                      )}
                      {entry.chatSha && (
                        <button
                          className="askbtn"
                          aria-label="Ask the AI about this line"
                          title="Ask the AI about this line"
                          onClick={() => setChatAt(chatAt === id ? null : id)}
                        >
                          ✦
                        </button>
                      )}
                      {l.o ?? ''}
                    </td>
                    <td className="ln">{l.n ?? ''}</td>
                    <td className="sign">{l.t === '+' ? '+' : l.t === '-' ? '−' : ''}</td>
                    <td className="code">{l.x}</td>
                  </tr>
                ]
                if (chatAt === id && entry.chatSha) {
                  const keys = entry.mrKey ? [entry.mrKey] : entry.partMrs
                  rows.push(
                    <tr key={`c${id}`} className="extra">
                      <td colSpan={4}>
                        <LineChat
                          slug={r.slug}
                          file={file}
                          line={l}
                          mrs={keys.map((k) => ({
                            iid: r.mrByKey(k)?.snapshot.info.ref.iid ?? 0,
                            title: r.mrByKey(k)?.snapshot.info.title ?? '',
                            description: r.mrByKey(k)?.snapshot.info.description ?? '',
                            merged: r.mrByKey(k)?.snapshot.info.state === 'merged'
                          }))}
                          combined={!entry.mrKey}
                          chatMr={entry.chatMr}
                          chatSha={entry.chatSha}
                          onClose={() => setChatAt(null)}
                        />
                      </td>
                    </tr>
                  )
                }
                if (formAt === id && target) {
                  const choose = target === 'choose'
                  rows.push(
                    <tr key={`f${id}`} className="extra">
                      <td colSpan={4}>
                        <CommentForm
                          submitLabel="Comment"
                          hint={t ? `Goes to !${iidOf(t.mr)}, ${t.newLine !== null ? `line ${t.newLine}` : `old line ${t.oldLine}`}` : undefined}
                          select={
                            choose
                              ? {
                                  label: 'No single MR changed this line. Post it as a general comment on',
                                  value: chosen,
                                  onChange: setChosen,
                                  options: openMrsOfPart.map((k) => ({
                                    value: k,
                                    label: `!${iidOf(k)} ${(r.mrByKey(k)?.snapshot.info.title ?? '').slice(0, 50)}`
                                  }))
                                }
                              : undefined
                          }
                          onCancel={() => setFormAt(null)}
                          onSubmit={(text) => {
                            if (t) return post(t, text)
                            // No owner: a file comment on the chosen change, with that change's own path
                            const m = r.mrByKey(chosen)
                            const f = m?.files.find((x) => x.path === file.path || x.oldPath === file.oldPath)
                            return post(
                              {
                                mr: chosen,
                                path: f?.path ?? file.path,
                                oldPath: f?.oldPath ?? file.oldPath,
                                oldLine: null,
                                newLine: null,
                                diffRefs: m!.snapshot.info.diffRefs
                              },
                              text
                            )
                          }}
                        />
                      </td>
                    </tr>
                  )
                }
                if (threads.length > 0 || drafts.length > 0) {
                  rows.push(
                    <tr key={`t${id}`} className="extra">
                      <td colSpan={4}>
                        {threads.map((th) => (
                          <ThreadCard key={th.id} mrKey={t!.mr} thread={th} mrOpen={r.mrByKey(t!.mr)?.snapshot.info.state === 'opened'} />
                        ))}
                        {drafts.map((d) => (
                          <DraftCard key={d.id} draft={d} />
                        ))}
                      </td>
                    </tr>
                  )
                }
                return rows
              })
            ]
          })}
        </tbody>
      </table>
    )
  }

  return (
    <div>
      <div className="fileheader">
        <strong className="mono">{file.path}</strong>
        <span className={`badge ${file.status}`}>{file.status}</span>
        <span className="counts">
          <span className="plus">+{lv.add}</span> <span className="minus">−{lv.del}</span>
        </span>
        <span className="muted small grow" data-testid="file-scope">
          {header}
        </span>
        <label>
          <input type="checkbox" checked={props.viewed} onChange={(e) => props.onViewed(e.target.checked)} /> Viewed
        </label>
      </div>
      {(wholeFile.length > 0 || wholeFileDrafts.length > 0) && (
        <div className="wholefile" data-testid="whole-file">
          <div className="muted small">On the whole file</div>
          {wholeFile.map((th) => (
            <ThreadCard key={th.id} mrKey={entry.mrKey!} thread={th} mrOpen={mr?.snapshot.info.state === 'opened'} />
          ))}
          {wholeFileDrafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
      )}
      {hidden.length > 0 && (
        <details className="wholefile" data-testid="hidden-threads">
          <summary>
            {hidden.length} {hidden.length === 1 ? 'thread' : 'threads'} on lines hidden by the noise filter
          </summary>
          {hidden.map((th) => (
            <div key={th.id}>
              <span className="muted small">line {th.position!.newLine ?? th.position!.oldLine}</span>
              <ThreadCard mrKey={entry.mrKey!} thread={th} mrOpen={mr?.snapshot.info.state === 'opened'} />
            </div>
          ))}
        </details>
      )}
      {body}
    </div>
  )
}
