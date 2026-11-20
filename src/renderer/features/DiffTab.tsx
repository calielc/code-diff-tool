import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CommitInfo } from '@shared/commits'
import { FILE_KINDS, fileKind, type FileKind } from '@shared/file-kinds'
import { newCommentId, type PendingComment } from '@shared/comments'
import type { FileObject, LevelName, LineObj } from '@shared/diff'
import type { DiffRefs } from '@shared/provider'
import type { BuildResult } from '@shared/review'
import { draftAtLine, fileThreads, isFileDraft, positionMatchesLine, threadCounts, threadOnFile, threadsAtLine } from '@shared/threads'
import { api } from '../api'
import { useReview } from './review-context'
import { SubmitDialog, reviewable } from './SubmitDialog'
import { FlowView } from './FlowView'
import { LineChat } from './LineChat'
import { CommentForm, DraftCard, ThreadCard } from './ThreadViews'

type ViewName = 'mr' | 'combined' | 'flow'
type LayoutName = 'inline' | 'side' | 'full'

const STATE_CHIP: Record<string, string> = { merged: 'Merged · read-only', closed: 'Closed · read-only', opened: 'Open', locked: 'Locked' }
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

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
  /** The state of the owning change, for the chip of its group. */
  stateChip?: string
}

interface TreeNode {
  key: string
  kind: 'repo' | 'group' | 'folder' | 'file'
  name: string
  tip?: string
  /** The state of the change of a group, for its chip. */
  chip?: string
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
        chatSha: m.snapshot.info.diffRefs.head,
        stateChip: ({ merged: 'Merged', closed: 'Closed', opened: 'Open', locked: 'Locked' } as Record<string, string>)[m.snapshot.info.state]
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
    if (!group) repo.children.push((group = { key: `g:${e.groupKey}`, kind: 'group', name: e.groupLabel, tip: e.groupTip, chip: e.stateChip, children: [] }))
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
  const { viewed, setViewed } = r
  const [noiseOpen, setNoiseOpen] = useState(false)
  const [layout, setLayout] = useState<LayoutName>(() => store<LayoutName>('codediff:layout', 'inline'))
  const [statuses, setStatuses] = useState<Set<'A' | 'M' | 'D'>>(new Set(['A', 'M', 'D']))
  const [kinds, setKinds] = useState<Set<FileKind>>(new Set(FILE_KINDS.map((k) => k.id)))
  const [hideViewed, setHideViewed] = useState(false)
  const [onlyComments, setOnlyComments] = useState(false)
  // The commit chosen in the open file. It belongs to that file only.
  const [commitSel, setCommitSel] = useState<{ id: string; sha: string } | null>(null)
  useEffect(() => save('codediff:layout', layout), [layout])
  const [submitOpen, setSubmitOpen] = useState(false)

  useEffect(() => save('codediff:view', view), [view])
  useEffect(() => save('codediff:noise', level), [level])

  // The flow view shows no tree. Leaving it returns to the By MR view, and a flow that went away does the same.
  useEffect(() => {
    if (view === 'flow' && !r.flow.flow) setView('mr')
  }, [view, r.flow.flow])
  const all = useMemo(() => entriesOf(result, view), [result, view])
  // A file is noise at a level when it is not binary and has no hunk at that level (file 02 section 2.1).
  const isNoise = (e: Entry): boolean => !e.file.binary && e.file.levels[level].hunks.length === 0
  const shown = useMemo(() => all.filter((e) => !isNoise(e)), [all, level]) // eslint-disable-line react-hooks/exhaustive-deps
  const noise = useMemo(() => all.filter(isNoise), [all, level]) // eslint-disable-line react-hooks/exhaustive-deps
  // The Files and Types filters, Hide viewed and Only files with comments narrow the shown files
  const statusOf = (e: Entry): 'A' | 'M' | 'D' => (e.file.status === 'R' ? 'M' : e.file.status)
  const hasComments = (e: Entry): boolean => {
    const mr = e.mrKey ? r.mrByKey(e.mrKey) : undefined
    const threads = mr ? threadCounts(mr.snapshot.threads, e.file.path, e.file.oldPath).total : 0
    return threads > 0 || (e.mrKey !== null && Object.values(r.drafts).some((d) => d.mr === e.mrKey && d.path === e.file.path))
  }
  const facetted = useMemo(
    () =>
      shown.filter(
        (e) => statuses.has(statusOf(e)) && kinds.has(fileKind(e.file.path)) && !(hideViewed && viewed.has(e.id)) && (!onlyComments || hasComments(e))
      ),
    [shown, statuses, kinds, hideViewed, onlyComments, viewed, r.drafts, result] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const statusCount = (st: 'A' | 'M' | 'D'): number => shown.filter((e) => statusOf(e) === st).length
  const kindCount = (k: FileKind): number => shown.filter((e) => fileKind(e.file.path) === k).length
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? facetted.filter((e) => e.file.path.toLowerCase().includes(q)) : facetted
  }, [facetted, filter])
  const tree = useMemo(() => buildTree(visible), [visible])

  // Keep the open file when the view changes, else open the first shown file.
  useEffect(() => {
    if (selected && visible.some((e) => e.id === selected)) return
    const path = selected?.split('|').slice(1).join('|')
    setSelected((path && visible.find((e) => e.file.path === path)?.id) ?? visible[0]?.id ?? null)
  }, [visible, selected])

  const current = visible.find((e) => e.id === selected) ?? null
  const commit = commitSel && current && commitSel.id === current.id ? commitSel.sha : null
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

  // ---- keyboard in the file tree ----
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const isOpenNode = (n: TreeNode): boolean => filter.trim() !== '' || !closed.has(n.key) // a typed filter opens every folder
  /** The rows that show now, from top to bottom, with the key of the parent of each. */
  const flat = useMemo(() => {
    const out: { node: TreeNode; parent: string | null }[] = []
    const walk = (nodes: TreeNode[], parent: string | null): void => {
      for (const n of nodes) {
        out.push({ node: n, parent })
        if (n.kind !== 'file' && isOpenNode(n)) walk(n.children, n.key)
      }
    }
    walk(tree, null)
    return out
  }, [tree, closed, filter]) // eslint-disable-line react-hooks/exhaustive-deps
  // The focus follows the open file, so a click, Previous and Next keep it in step
  useEffect(() => {
    const at = flat.find((x) => x.node.entry?.id === selected)
    if (at) setFocusKey(at.node.key)
  }, [selected, flat])
  const focusRow = (x: { node: TreeNode }): void => {
    setFocusKey(x.node.key)
    if (x.node.kind === 'file' && x.node.entry) setSelected(x.node.entry.id)
    requestAnimationFrame(() => document.querySelector(`[data-treekey="${CSS.escape(x.node.key)}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  const setOpen = (keys: string[], open: boolean): void =>
    setClosed((c) => {
      const n = new Set(c)
      for (const k of keys) {
        if (open) n.delete(k)
        else n.add(k)
      }
      return n
    })
  /** The keys of a folder and of every folder below it. */
  const foldersBelow = (n: TreeNode): string[] => (n.kind === 'file' ? [] : [n.key, ...n.children.flatMap(foldersBelow)])
  useEffect(() => {
    if (view === 'flow') return
    const on = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (t?.closest('input, textarea, select, [contenteditable], .rightcard, .modal-back, .chatpanel, .aibox')) return
      const i = flat.findIndex((x) => x.node.key === focusKey)
      const here = i < 0 ? null : flat[i]
      let handled = true
      if (e.key === 'ArrowDown') {
        const next = flat[Math.min(flat.length - 1, i + 1)]
        if (next) focusRow(next)
      } else if (e.key === 'ArrowUp') {
        const prev = flat[Math.max(0, i < 0 ? 0 : i - 1)]
        if (prev) focusRow(prev)
      } else if (e.key === 'ArrowLeft' && here) {
        if (here.node.kind !== 'file' && isOpenNode(here.node) && filter.trim() === '') setOpen([here.node.key], false)
        else if (here.parent) {
          const parent = flat.find((x) => x.node.key === here.parent)
          if (parent) focusRow(parent)
        }
      } else if (e.key === 'ArrowRight' && here && here.node.kind !== 'file') {
        if (!isOpenNode(here.node)) setOpen([here.node.key], true)
        else if (here.node.children[0]) focusRow({ node: here.node.children[0] })
      } else if (e.key === '*' && here) {
        // everything below the focused node opens
        setOpen(foldersBelow(here.node), true)
      } else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [flat, focusKey, filter, view]) // eslint-disable-line react-hooks/exhaustive-deps

  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const entries = filesOf(n)
    const add = entries.reduce((s, e) => s + e.file.levels[level].add, 0)
    const del = entries.reduce((s, e) => s + e.file.levels[level].del, 0)
    const allViewed = entries.length > 0 && entries.every((e) => viewed.has(e.id))
    const someViewed = entries.some((e) => viewed.has(e.id))
    const isOpen = isOpenNode(n)
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
            data-treekey={n.key}
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
        <div
          className={`trow ${n.kind} ${focusKey === n.key ? 'focused' : ''}`}
          data-treekey={n.key}
          style={pad}
          title={n.tip}
          onClick={() => setFocusKey(n.key)}
        >
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
          {n.chip && <span className="statechip small">{n.chip}</span>}
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

  // The files in the order of the tree, which is the order the reviewer sees: folders first, each folder from top to bottom.
  const orderedFiles = useMemo(() => {
    const out: { entry: Entry; ancestors: string[] }[] = []
    const walk = (nodes: TreeNode[], up: string[]): void => {
      for (const n of nodes) {
        if (n.kind === 'file' && n.entry) out.push({ entry: n.entry, ancestors: up })
        else walk(n.children, [...up, n.key])
      }
    }
    walk(tree, [])
    return out
  }, [tree])
  /** Open a file by its place in the tree order, and unfold the folders around it. */
  const goTo = useCallback(
    (to: { entry: Entry; ancestors: string[] } | undefined) => {
      if (!to) return
      setClosed((c) => (to.ancestors.some((k) => c.has(k)) ? new Set([...c].filter((k) => !to.ancestors.includes(k))) : c))
      setSelected(to.entry.id)
    },
    [setClosed]
  )
  const move = useCallback(
    (delta: number) => {
      const i = orderedFiles.findIndex((x) => x.entry.id === selected)
      goTo(orderedFiles[Math.min(orderedFiles.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))])
    },
    [orderedFiles, selected, goTo]
  )
  /** Scroll to the next or the previous comment card in the open file. */
  const walk = useCallback((dir: 1 | -1) => {
    const box = document.querySelector('.rightscroll')
    if (!box) return
    const top = box.getBoundingClientRect().top
    const cards = [...box.querySelectorAll('.thread, .draft')].map((el) => ({ el, y: el.getBoundingClientRect().top - top }))
    const pick = dir > 0 ? cards.find((c) => c.y > 60) : [...cards].reverse().find((c) => c.y < -10)
    pick?.el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'p') move(-1)
      else if (e.key === 'n') move(1)
      else if (e.key === 'c') walk(1)
      else if (e.key === 'v' && current && commit) {
        // With a commit chosen, v marks that commit only, and stays on it
        setViewed((o) => new Set(o).add(current.id + '@' + commit))
      } else if (e.key === 'V' && current && commit) {
        setViewed((o) => new Set([...o].filter((k) => k !== current.id + '@' + commit)))
      } else if (e.key === 'v' && current) {
        // v marks the open file as viewed and goes to the next file. Shift+V takes the mark away and stays on the file.
        const i = orderedFiles.findIndex((x) => x.entry.id === current.id)
        toggleViewed([current], true)
        goTo(orderedFiles[i + 1])
      } else if (e.key === 'V' && current) toggleViewed([current], false)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [move, walk, goTo, orderedFiles, current, viewed, commit]) // eslint-disable-line react-hooks/exhaustive-deps

  const partsBadge = result.combined.length > 0 && new Set(result.combined.map((p) => p.repo)).size < result.combined.length
  const combinedTip = !hasCombined
    ? 'Combined needs 2+ MRs in the same repo'
    : [...result.combined.filter((p) => p.reason).map((p) => `${p.repo}: a part ${p.reason}`), 'Each part combines the MRs that merge cleanly in order.'].join(
        '\n'
      )

  return (
    <div className="difftab" data-testid="diff-tab">
      <div className="difftoolbar">
        <div className="fgroup" role="group" aria-label="View">
          <span className="glabel">View</span>
          <span className="seg">
            <button
              className={view === 'flow' ? 'on' : ''}
              disabled={!r.flow.flow}
              data-testid="view-flow"
              title={
                r.flow.pending ? 'The AI is writing Critical thinking' : r.flow.flow ? 'The chain to follow, and what to skip' : 'No Critical thinking yet'
              }
              onClick={() => setView('flow')}
            >
              {r.flow.pending && <span className="spin">◐ </span>}Critical thinking
            </button>
            <button className={view === 'mr' ? 'on' : ''} onClick={() => setView('mr')}>
              By MR
            </button>
            <button className={view === 'combined' ? 'on' : ''} disabled={!hasCombined} title={combinedTip} onClick={() => setView('combined')}>
              Combined per repo
              {partsBadge && <span className="parts"> {result.combined.length} parts</span>}
            </button>
          </span>
        </div>
        <div className="fgroup" role="group" aria-label="Noise">
          <span className="glabel">Noise</span>
          <span className="seg">
            {NOISE.map((n) => (
              <button key={n.id} className={level === n.id ? 'on' : ''} title={n.hint} onClick={() => setLevel(n.id)}>
                {n.label}
              </button>
            ))}
          </span>
        </div>
        <div className="fgroup" role="group" aria-label="Layout">
          <span className="glabel">Layout</span>
          <span className="seg">
            {(
              [
                ['inline', 'Inline'],
                ['side', 'Side by side'],
                ['full', 'Full file']
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={layout === id ? 'on' : ''} data-testid={'layout-' + id} onClick={() => setLayout(id)}>
                {label}
              </button>
            ))}
          </span>
        </div>
        <div className="fgroup" role="group" aria-label="Files">
          <span className="glabel">Files</span>
          <span className="seg toggles">
            {(
              [
                ['A', 'New'],
                ['M', 'Modified'],
                ['D', 'Deleted']
              ] as const
            ).map(([st, label]) => (
              <button
                key={st}
                className={statuses.has(st) ? 'on' : ''}
                aria-pressed={statuses.has(st)}
                data-testid={'status-' + st}
                onClick={() => setStatuses((o) => (o.has(st) ? new Set([...o].filter((x) => x !== st)) : new Set(o).add(st)))}
              >
                {label} <small>{statusCount(st)}</small>
              </button>
            ))}
          </span>
        </div>
        <div className="fgroup" role="group" aria-label="Types">
          <span className="glabel">Types</span>
          <span className="seg toggles">
            {FILE_KINDS.map((k) => (
              <button
                key={k.id}
                className={kinds.has(k.id) ? 'on' : ''}
                aria-pressed={kinds.has(k.id)}
                data-testid={'kind-' + k.id}
                onClick={() => setKinds((o) => (o.has(k.id) ? new Set([...o].filter((x) => x !== k.id)) : new Set(o).add(k.id)))}
              >
                {k.label} <small>{kindCount(k.id)}</small>
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="checkrow">
        <label>
          <input type="checkbox" data-testid="hide-viewed" checked={hideViewed} onChange={(e) => setHideViewed(e.target.checked)} /> Hide viewed
        </label>
        <label>
          <input type="checkbox" checked={r.hideResolved} onChange={(e) => r.setHideResolved(e.target.checked)} /> Hide resolved threads
        </label>
        <label>
          <input type="checkbox" data-testid="only-comments" checked={onlyComments} onChange={(e) => setOnlyComments(e.target.checked)} /> Only files with
          comments
        </label>
      </div>
      <div className="difflayout">
        <aside className="filetree" hidden={view === 'flow'}>
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

        <section className="rightcard">
          <div className="rightscroll">
            {view === 'flow' && r.flow.flow ? (
              <FlowView
                flow={r.flow.flow}
                onOpen={(mr, path, line) => {
                  setView('mr')
                  r.requestOpen(mr, path, line)
                }}
              />
            ) : (
              <div className="filepanel">
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
                    layout={layout}
                    commit={commit}
                    onCommit={(sha) => setCommitSel(sha && current ? { id: current.id, sha } : null)}
                  />
                ) : (
                  <p className="muted center" data-testid="no-files">
                    {all.length === 0 ? 'No changed files.' : 'No file to show at this noise level.'}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="reviewbar" data-testid="review-bar">
            <span className="muted small grow" data-testid="review-bar-text">
              {draftCount > 0
                ? `${draftCount} ${draftCount === 1 ? 'draft' : 'drafts'} not posted yet. Post or delete each one.`
                : 'Hover a line and press + to comment. A comment is posted at once.'}
            </span>
            <button data-testid="prev-file" disabled={visible.length < 2} onClick={() => move(-1)}>
              Previous <kbd>p</kbd>
            </button>
            <button data-testid="next-file" disabled={visible.length < 2} onClick={() => move(1)}>
              Next <kbd>n</kbd>
            </button>
            <button data-testid="prev-comment" onClick={() => walk(-1)}>
              ↑ Comment <kbd> </kbd>
            </button>
            <button data-testid="next-comment" onClick={() => walk(1)}>
              ↓ Comment <kbd>c</kbd>
            </button>
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
        </section>
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
  layout: LayoutName
  /** The commit whose change to the file is shown, or null for HEAD. */
  commit: string | null
  onCommit(sha: string | null): void
}): React.JSX.Element {
  const r = useReview()
  const { entry, level } = props
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const { commit, onCommit: setCommit } = props // null is HEAD, the whole change
  const [atCommit, setAtCommit] = useState<{ sha: string; file: FileObject | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!entry.mrKey) return
    let live = true
    void api.commits
      .list({ slug: r.slug, mr: entry.mrKey, path: entry.file.path, oldPath: entry.file.oldPath })
      .then((res) => live && setCommits(res.ok ? res.value : []))
    return () => {
      live = false
    }
  }, [entry.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!commit || !entry.mrKey) return
    let live = true
    void api.commits.file({ slug: r.slug, mr: entry.mrKey, path: entry.file.path, oldPath: entry.file.oldPath, sha: commit }).then((res) => {
      if (live) setAtCommit({ sha: commit, file: res.ok ? res.value : null, error: res.ok ? null : res.error })
    })
    return () => {
      live = false
    }
  }, [commit]) // eslint-disable-line react-hooks/exhaustive-deps
  const commitReady = commit !== null && atCommit?.sha === commit && atCommit.file !== null
  // The file as the chosen commit changed it, or the whole change at HEAD
  const file = commitReady ? atCommit.file! : entry.file
  const lv = file.levels[level]
  // A commit is viewed by its own mark, or because HEAD is: marking HEAD flags every commit before it
  const commitKey = (sha: string): string => entry.id + '@' + sha
  const commitViewed = (sha: string): boolean => props.viewed || r.viewed.has(commitKey(sha))
  const toggleCommitViewed = (sha: string, on: boolean): void =>
    r.setViewed((v) => {
      const n = new Set(v)
      if (on) n.add(commitKey(sha))
      else n.delete(commitKey(sha))
      return n
    })
  const viewedNow = commit ? commitViewed(commit) : props.viewed
  const setViewedNow = (on: boolean): void => (commit ? toggleCommitViewed(commit, on) : props.onViewed(on))
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

  /** Where the threads of a line are looked up, for any state of the change. */
  const shownTarget = (l: LineObj): { mr: string; path: string | null; oldPath: string | null; oldLine: number | null; newLine: number | null } | null => {
    if (entry.mrKey) return { mr: entry.mrKey, path: file.path, oldPath: file.oldPath, oldLine: l.t === '+' ? null : l.o, newLine: l.t === '-' ? null : l.n }
    if (!l.target) return null
    const m = r.mrByKey(l.target.mr)
    const f = m?.files.find((x) => x.path === file.path || x.oldPath === file.oldPath)
    return { mr: l.target.mr, path: f?.path ?? file.path, oldPath: f?.oldPath ?? file.oldPath, oldLine: l.target.o, newLine: l.target.n }
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

  const header = `${STATUS_WORD[file.status]}${file.status === 'R' ? ` · renamed from ${file.oldPath}` : ''} · ${entry.mrKey ? `!${iidOf(entry.mrKey)} · ${entry.repo}` : entry.scope}`
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
    /** The rows under a line: its line chat, its comment form, its threads and its drafts. */
    const extraRows = (l: LineObj, id: string, span: number): React.ReactNode[] => {
      if (commit) return [] // the lines of one commit are not the lines of HEAD, where comments go
      const target = targetOf(l)
      const t = target && target !== 'choose' ? target : null
      // Threads show on a merged change too, where the line takes no new comment
      const at = t ?? shownTarget(l)
      const threads = at ? visibleThreads(at.mr, at.path ?? file.path, at.oldPath ?? file.oldPath, { o: at.oldLine, n: at.newLine }) : []
      const drafts = at ? Object.values(r.drafts).filter((d) => draftAtLine(d, at.mr, at.path ?? file.path, { o: at.oldLine, n: at.newLine })) : []
      const rows: React.ReactNode[] = []
      if (chatAt === id && entry.chatSha) {
        const keys = entry.mrKey ? [entry.mrKey] : entry.partMrs
        rows.push(
          <tr key={'c' + id} className="extra">
            <td colSpan={span}>
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
          <tr key={'f' + id} className="extra">
            <td colSpan={span}>
              <CommentForm
                submitLabel="Comment"
                hint={t ? 'Goes to !' + iidOf(t.mr) + ', ' + (t.newLine !== null ? 'line ' + t.newLine : 'old line ' + t.oldLine) : undefined}
                select={
                  choose
                    ? {
                        label: 'No single MR changed this line. Post it as a general comment on',
                        value: chosen,
                        onChange: setChosen,
                        options: openMrsOfPart.map((k) => ({
                          value: k,
                          label: '!' + iidOf(k) + ' ' + (r.mrByKey(k)?.snapshot.info.title ?? '').slice(0, 50)
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
      if (at && (threads.length > 0 || drafts.length > 0)) {
        rows.push(
          <tr key={'t' + id} className="extra">
            <td colSpan={span}>
              {threads.map((th) => (
                <ThreadCard key={th.id} mrKey={at.mr} thread={th} mrOpen={r.mrByKey(at.mr)?.snapshot.info.state === 'opened'} />
              ))}
              {drafts.map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
            </td>
          </tr>
        )
      }
      return rows
    }

    /** The buttons at the start of a line: comment, and ask the AI. A merged change shows a stripe in place of the comment button. */
    const gutter = (l: LineObj, id: string): React.ReactNode => {
      if (commit) return null
      const target = targetOf(l)
      return (
        <>
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
        </>
      )
    }
    const rowClass = (l: LineObj): string => (l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx')
    const hunkRow = (key: string, h: LineObj[], span: number): React.ReactNode => {
      const firstOld = h.find((l) => l.o !== null)?.o
      const firstNew = h.find((l) => l.n !== null)?.n
      return (
        <tr key={key} className="hunk">
          <td colSpan={span}>
            @@ old {firstOld ?? '–'} · new {firstNew ?? '–'} @@
          </td>
        </tr>
      )
    }

    if (props.layout === 'side') {
      // Side by side: a run of removed lines sits beside the run of added lines that follows it.
      body = (
        <table className="diff side" data-testid="diff-table">
          <tbody>
            {lv.hunks.map((h, i) => {
              const rows: React.ReactNode[] = [hunkRow('h' + i, h, 5)]
              let j = 0
              while (j < h.length) {
                if (h[j].t === ' ') {
                  const l = h[j]
                  const id = i + ':' + j
                  rows.push(
                    <tr key={'l' + id} data-new-line={l.n ?? undefined} className="ctx">
                      <td className="ln">{l.o}</td>
                      <td className="code">{l.x}</td>
                      <td className="ln">
                        {gutter(l, id)}
                        {l.n}
                      </td>
                      <td className="sign" />
                      <td className="code">{l.x}</td>
                    </tr>,
                    ...extraRows(l, id, 5)
                  )
                  j++
                  continue
                }
                const del: { l: LineObj; j: number }[] = []
                const add: { l: LineObj; j: number }[] = []
                while (j < h.length && h[j].t === '-') del.push({ l: h[j], j: j++ })
                while (j < h.length && h[j].t === '+') add.push({ l: h[j], j: j++ })
                for (let k = 0; k < Math.max(del.length, add.length); k++) {
                  const a = del[k]
                  const b = add[k]
                  const idA = a ? i + ':' + a.j : ''
                  const idB = b ? i + ':' + b.j : ''
                  rows.push(
                    <tr key={'p' + i + ':' + (a?.j ?? 'x') + ':' + (b?.j ?? 'x')} data-new-line={b?.l.n ?? undefined} className="pair">
                      <td className="ln">
                        {a && gutter(a.l, idA)}
                        {a?.l.o}
                      </td>
                      <td className={'code' + (a ? ' del' : ' empty')}>{a?.l.x}</td>
                      <td className="ln">
                        {b && gutter(b.l, idB)}
                        {b?.l.n}
                      </td>
                      <td className="sign">{b ? '+' : ''}</td>
                      <td className={'code' + (b ? ' add' : ' empty')}>{b?.l.x}</td>
                    </tr>
                  )
                  if (a) rows.push(...extraRows(a.l, idA, 5))
                  if (b) rows.push(...extraRows(b.l, idB, 5))
                }
              }
              return rows
            })}
          </tbody>
        </table>
      )
    } else if (props.layout === 'full' && file.lines) {
      // Full file: the new file from its first line to its last, with the added lines marked. Removed lines are not in it.
      const inHunk = new Map<number, LineObj>()
      let offset = 0
      const offsetAt = new Map<number, number>()
      for (const l of lv.hunks.flat()) {
        if (l.n !== null) {
          inHunk.set(l.n, l)
          if (l.o !== null) offset = l.n - l.o
          offsetAt.set(l.n, offset)
        }
      }
      let lastOffset = 0
      body = (
        <table className="diff full" data-testid="diff-table">
          <tbody>
            {file.lines.map((text, idx) => {
              const n = idx + 1
              const known = inHunk.get(n)
              if (known) lastOffset = offsetAt.get(n) ?? lastOffset
              const l: LineObj = known ?? { t: ' ', o: n - lastOffset, n, x: text }
              const id = 'full:' + n
              return [
                <tr key={id} data-new-line={n} className={rowClass(l)}>
                  <td className="ln">{gutter(l, id)}</td>
                  <td className="ln">{n}</td>
                  <td className="sign">{l.t === '+' ? '+' : ''}</td>
                  <td className="code">{text}</td>
                </tr>,
                ...extraRows(l, id, 4)
              ]
            })}
          </tbody>
        </table>
      )
    } else {
      body = (
        <table className="diff" data-testid="diff-table">
          <tbody>
            {lv.hunks.map((h, i) => [
              hunkRow('h' + i, h, 4),
              ...h.flatMap((l, j) => {
                const id = i + ':' + j
                return [
                  <tr key={'l' + id} data-new-line={l.n ?? undefined} className={rowClass(l)}>
                    <td className="ln">
                      {gutter(l, id)}
                      {l.o ?? ''}
                    </td>
                    <td className="ln">{l.n ?? ''}</td>
                    <td className="sign">{l.t === '+' ? '+' : l.t === '-' ? '−' : ''}</td>
                    <td className="code">{l.x}</td>
                  </tr>,
                  ...extraRows(l, id, 4)
                ]
              })
            ])}
          </tbody>
        </table>
      )
    }
  }

  return (
    <div>
      <div className="fileheader" data-testid="file-header">
        <div className="fh1">
          <span className="fpath mono">
            <span className="fdir">{dirOf(file.path)}</span>
            <strong>{nameOf(file.path)}</strong>
          </span>
          <span className="grow" />
          {entry.mrKey && (
            <span className="commits" data-testid="commit-chips">
              {commits.length > 3 && (
                <select
                  className="morecommits mono"
                  aria-label="Older commits"
                  value=""
                  data-testid="more-commits"
                  onChange={(e) => e.target.value && setCommit(e.target.value)}
                >
                  <option value="">+{commits.length - 3} more</option>
                  {commits.slice(0, -3).map((c) => (
                    <option key={c.sha} value={c.sha}>
                      {c.short} {c.subject}
                    </option>
                  ))}
                </select>
              )}
              {commits.slice(-3).map((c) => (
                <label
                  key={c.sha}
                  className={`commitchip mono ${commit === c.sha ? 'on' : ''}`}
                  title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}`}
                  data-testid={`commit-${c.short}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Commit ${c.short} viewed`}
                    checked={commitViewed(c.sha)}
                    onChange={(e) => toggleCommitViewed(c.sha, e.target.checked)}
                  />
                  <button className="chipbtn mono" onClick={() => setCommit(commit === c.sha ? null : c.sha)}>
                    {c.short}
                  </button>
                </label>
              ))}
              <button className={`headchip ${commit === null ? 'on' : ''}`} data-testid="head-chip" title="The whole change" onClick={() => setCommit(null)}>
                HEAD
              </button>
            </span>
          )}
        </div>
        <div className="fh2">
          <span className="muted" data-testid="file-scope">
            {header}
          </span>
          {mr && <span className="statechip">{STATE_CHIP[mr.snapshot.info.state] ?? mr.snapshot.info.state}</span>}
          {commit && <span className="statechip commitonly">commit {commit.slice(0, 7)} only</span>}
          <span className="grow" />
          <span className="counts">
            <span className="plus">+{lv.add}</span> <span className="minus">−{lv.del}</span>
          </span>
          <label className="viewedbtn">
            <input type="checkbox" data-testid="viewed-now" checked={viewedNow} onChange={(e) => setViewedNow(e.target.checked)} /> Viewed
            {commit ? ' ' + commit.slice(0, 7) : ''} <kbd>v</kbd>
          </label>
        </div>
      </div>
      {commit && (
        <div className="banner warn commitbanner" data-testid="commit-banner">
          {atCommit?.sha === commit && atCommit.error
            ? atCommit.error
            : `Only the change of commit ${commit.slice(0, 7)} to this file. Choose HEAD to comment: comments go on HEAD.`}
        </div>
      )}
      {!commit && (wholeFile.length > 0 || wholeFileDrafts.length > 0) && (
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
      {!commit && hidden.length > 0 && (
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
