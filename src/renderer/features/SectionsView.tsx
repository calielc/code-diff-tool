import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { newCommentId, type PendingComment } from '@shared/comments'
import type { FileObject, LevelName, LineObj } from '@shared/diff'
import {
  collapseOnAcceptChange,
  coverageOf,
  discussionOf,
  changeKey,
  pageExcerpts,
  rowsOf,
  isAccepted,
  isCollapsed,
  parseCollapsed,
  restOf,
  sectionCommentBody,
  sectionDrafts,
  sectionFactsOf,
  sectionFiles,
  sectionProgress,
  sectionState,
  setAllCollapsed,
  sectionThreads,
  threadTarget,
  viewedId,
  waitingFor,
  withRest,
  type CollapsedState,
  type Row,
  type RestEntry,
  type Run,
  type Section,
  type SectionFile,
  type SectionState,
  type SectionsDocument,
  type SectionsState,
  type ChangeLine,
  type FileExcerpt
} from '@shared/sections'
import { api } from '../api'
import { Code } from '../highlight/Code'
import { useFileHighlight, type FileHighlight } from '../highlight/useFileHighlight'
import { intraMapOf } from './intra-marks'
import { useReview } from './review-context'
import { CommentForm, DraftCard, ThreadCard } from './ThreadViews'

type OpenFile = (mr: string, path: string, line: number | null) => void

const iidOf = (key: string): string => key.slice(key.lastIndexOf('!') + 1)
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** The most rows that a compact excerpt shows before "Show N more lines". A fold counts as one row. */
const SNIPPET_ROWS = 24

type Item = { kind: 'gap'; key: string } | { kind: 'row'; key: string; row: Row }

/**
 * The rows of a compact excerpt, with one number for each line, the new line number or the old one for a removed line. Unchanged lines
 * that are out of view sit in a fold that opens on a click and folds again. A long excerpt shows its first rows and a row that opens the rest.
 */
function RowsTable(props: { groups: Row[][]; hl: FileHighlight }): React.JSX.Element {
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [all, setAll] = useState(false)
  const marks = useMemo(() => intraMapOf(props.groups.map((g) => g.flatMap((x) => (x.kind === 'line' ? [x.line] : x.lines)))), [props.groups])
  const items = useMemo(() => {
    const out: Item[] = []
    props.groups.forEach((g, gi) => {
      if (gi > 0) out.push({ kind: 'gap', key: `gap${gi}` })
      g.forEach((row, ri) => out.push({ kind: 'row', key: `${gi}:${ri}`, row }))
    })
    return out
  }, [props.groups])
  const rowItems = items.filter((x) => x.kind === 'row')
  const cut = !all && rowItems.length > SNIPPET_ROWS ? items.indexOf(rowItems[SNIPPET_ROWS]) : items.length
  const hiddenRows = rowItems.length - rowItems.filter((x) => items.indexOf(x) < cut).length
  const flip = (key: string): void =>
    setOpened((o) => {
      const n = new Set(o)
      if (!n.delete(key)) n.add(key)
      return n
    })
  const line = (l: LineObj, key: string): React.ReactNode => (
    <tr key={key} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}>
      <td className="ln">{l.t === '-' ? l.o : (l.n ?? l.o)}</td>
      <td className="sign">{l.t === '+' ? '+' : l.t === '-' ? '−' : ''}</td>
      <td className="code">
        <Code text={l.x} tokens={props.hl.line(l)} segs={marks.get(l)} />
      </td>
    </tr>
  )
  return (
    <table className="diff snip">
      <tbody>
        {items.slice(0, cut).map((it) => {
          if (it.kind === 'gap')
            return (
              <tr key={it.key} className="hunk">
                <td colSpan={3}>⋯</td>
              </tr>
            )
          const row = it.row
          if (row.kind === 'line') return line(row.line, it.key)
          const open = opened.has(it.key)
          const n = row.lines.length
          return [
            <tr key={it.key} className="foldrow">
              <td colSpan={3}>
                <button className="foldbtn" aria-expanded={open} onClick={() => flip(it.key)}>
                  {open ? '▾' : '⋯'} {n}{' '}
                  {row.changed ? (n === 1 ? 'line not in this section' : 'lines not in this section') : n === 1 ? 'unchanged line' : 'unchanged lines'}
                </button>
              </td>
            </tr>,
            ...(open ? row.lines.map((l, i) => line(l, `${it.key}:${i}`)) : [])
          ]
        })}
        {cut < items.length && (
          <tr className="foldrow">
            <td colSpan={3}>
              <button className="foldbtn" data-testid="show-more" onClick={() => setAll(true)}>
                Show {hiddenRows} more {hiddenRows === 1 ? 'line' : 'lines'}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

/** The rows of a file in a section, with the syntax colours of the file. It exists only for a file of the review, so the hook always has a file. */
function ExcerptCode(props: { file: FileObject; excerpt: FileExcerpt; level: LevelName }): React.JSX.Element {
  const hl = useFileHighlight(props.file, props.file.levels[props.level])
  return <RowsTable groups={props.excerpt.groups} hl={hl} />
}

const rangesText = (ranges: FileExcerpt['ranges']): string =>
  ranges.map((r) => `${r.side === 'old' ? 'old ' : ''}${r.lines[0] === r.lines[1] ? r.lines[0] : `${r.lines[0]}-${r.lines[1]}`}`).join(', ')

/**
 * The code that a section shows for one file: one header with all the ranges, in the order of the file, and one block of rows, at the
 * noise level of the toolbar. A change that an earlier section draws is not drawn again.
 */
function FileExcerptView(props: { excerpt: FileExcerpt; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { excerpt: e } = props
  const file = r.mrByKey(e.mr)?.files.find((f) => f.path === e.path)
  const firstNew = e.ranges.find((x) => x.side !== 'old')
  return (
    <div className="snippet" data-testid="snippet">
      <button
        className="snippath"
        title={`${e.path}\nOpen the file in the Linear view`}
        onClick={() => props.onOpen(e.mr, e.path, firstNew ? firstNew.lines[0] : null)}
      >
        <span className="mono">
          <span className="fdir">{e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : ''}</span>
          {nameOf(e.path)}
        </span>
        <span className="muted small">lines {rangesText(e.ranges)}</span>
      </button>
      {!file ? (
        <p className="note">This file is not in the review any more.</p>
      ) : file.binary ? (
        <p className="note">Binary file, no text diff.</p>
      ) : e.shownIn !== null ? (
        <p className="note" data-testid="shown-above">
          These changes are shown in section {e.shownIn}.
        </p>
      ) : e.groups.length === 0 ? (
        <p className="note">No line of this range changed at this noise level. It holds noise only.</p>
      ) : (
        <ExcerptCode file={file} excerpt={e} level={props.level} />
      )}
    </div>
  )
}

/** The thread of a section: the comments on the change that name it, the drafts, and the form for a new comment. */
function SectionThread(props: { doc: SectionsDocument; section: Section }): React.JSX.Element {
  const r = useReview()
  const { section: s } = props
  const [writing, setWriting] = useState(false)
  const threads = sectionThreads(
    s.title,
    r.data.mrs.map((m) => ({ key: m.key, threads: m.snapshot.threads }))
  )
  const drafts = sectionDrafts(s.title, Object.values(r.drafts))
  const target = threadTarget(s, (k) => r.mrByKey(k)?.snapshot.info.state === 'opened')
  const comment = (body: string): PendingComment | null => {
    const m = target ? r.mrByKey(target) : undefined
    if (!target || !m) return null
    return {
      id: newCommentId(),
      mr: target,
      diffRefs: m.snapshot.info.diffRefs,
      path: null,
      oldPath: null,
      oldLine: null,
      newLine: null,
      body: sectionCommentBody(s.title, body),
      view: 'mr'
    }
  }
  return (
    <div className="sectionthread" data-testid={`section-thread-${s.id}`}>
      {threads.map(({ mr, thread }) => (
        <ThreadCard key={thread.id} mrKey={mr} thread={thread} mrOpen={r.mrByKey(mr)?.snapshot.info.state === 'opened'} />
      ))}
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} />
      ))}
      {writing && target ? (
        <CommentForm
          submitLabel="Comment"
          hint={`Goes to !${iidOf(target)} as a comment on the change, and starts with the name of this section.`}
          onCancel={() => setWriting(false)}
          onSubmit={async (text) => {
            const c = comment(text)
            const err = c ? await r.post(c, false) : 'No open change takes this comment.'
            if (!err) setWriting(false)
            return err
          }}
          onSaveDraft={async (text) => {
            const c = comment(text)
            if (!c) return 'No open change takes this comment.'
            await r.saveDraft(c)
            setWriting(false)
            return null
          }}
        />
      ) : target ? (
        <button data-testid={`section-comment-${s.id}`} onClick={() => setWriting(true)}>
          Comment on this section
        </button>
      ) : (
        <span className="muted small">No open change takes a comment on this section.</span>
      )}
    </div>
  )
}

const REST_TEXT =
  'The changes that the sections above leave out: boilerplate, mechanical changes and what needs no thought. Look through the list, then accept.'

const runCount = (runs: Run[]): number => runs.length

/** The changes of one file of "Everything else", with the syntax colours of the file. It is drawn when the file opens. */
function RestCode(props: { file: FileObject; entry: RestEntry; level: LevelName }): React.JSX.Element {
  const { file, entry } = props
  const hunks = file.levels[props.level].hunks
  // A whole file draws every change. A file that is only partly left over draws the changed lines that no snippet picks, and nothing else.
  const groups = useMemo(() => {
    const keys = new Set(entry.keys ?? [])
    return rowsOf(hunks, (run) => run.map((l) => entry.whole || keys.has(changeKey(l))))
  }, [hunks, entry])
  const hl = useFileHighlight(file, file.levels[props.level])
  return groups.length === 0 ? (
    <p className="note">Nothing of this file shows at this noise level. It holds noise only.</p>
  ) : (
    <RowsTable groups={groups} hl={hl} />
  )
}

/** One file of "Everything else": a row that opens to show the changes that the section holds. */
function RestFile(props: { doc: SectionsDocument; section: Section; entry: RestEntry; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { entry: e } = props
  const [open, setOpen] = useState(false)
  const file = r.mrByKey(e.mr)?.files.find((f) => f.path === e.path)
  const seen = r.viewed.has(viewedId(e.mr, e.path))
  const waits = waitingFor(props.doc, r.accepted, props.section.id, { mr: e.mr, path: e.path })
  return (
    <details className="restfile" data-testid={`rest-file-${e.path}`} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary title={`${e.path}\n!${iidOf(e.mr)}`}>
        <span className={`badge ${file?.status ?? 'M'}`}>{file?.status ?? 'M'}</span>
        <span className="mono restpath">{e.path}</span>
        <span className="muted small">
          {e.whole ? 'the whole file' : `${runCount(e.runs)} ${runCount(e.runs) === 1 ? 'change' : 'changes'} that no section shows`}
        </span>
        <span className="grow" />
        {file && (
          <span className="counts">
            <span className="plus">+{file.levels[props.level].add}</span> <span className="minus">−{file.levels[props.level].del}</span>
          </span>
        )}
        {seen ? (
          <span className="tick" title="Viewed">
            ✓
          </span>
        ) : (
          waits.length > 0 && (
            <span className="muted small" title={`Not viewed until you accept: ${waits.map((o) => o.title).join(', ')}.`}>
              waits
            </span>
          )
        )}
      </summary>
      <div className="restbody">
        {file?.binary ? <p className="note">Binary file, no text diff.</p> : open && file && <RestCode file={file} entry={e} level={props.level} />}
        <button className="link" onClick={() => props.onOpen(e.mr, e.path, null)}>
          Open the file in the Linear view
        </button>
      </div>
    </details>
  )
}

/**
 * A guard for development builds: a changed line is drawn once on the page. If two rows of two sections have the same key, the code that
 * cuts the excerpts is wrong, so it is logged. It changes nothing on the screen, and a production build never runs it.
 */
function reportRepeatedRows(excerpts: Record<string, FileExcerpt[]>): void {
  const seen = new Map<string, string>()
  for (const [section, files] of Object.entries(excerpts)) {
    for (const e of files) {
      for (const g of e.groups) {
        for (const row of g) {
          if (row.kind !== 'line' || row.line.t === ' ') continue
          const key = `${e.mr}|${e.path}|${changeKey(row.line as ChangeLine)}`
          const first = seen.get(key)
          if (first !== undefined) console.error(`The Summarised page draws the row ${key} twice, in the sections ${first} and ${section}.`)
          else seen.set(key, section)
        }
      }
    }
  }
}

/** What the Summarised tab shows while there is no page: the run, the reason for a failure, or a button to start. */
export function SectionsStatus(props: { state: SectionsState }): React.JSX.Element {
  const r = useReview()
  const s = props.state
  const start = (): void => void api.sections.start(r.slug)
  return (
    <div className="sectionsstatus" data-testid="sections-status">
      {s.pending ? (
        <>
          <p>
            <span className="spin">◐ </span>
            {s.context === 'gathering' ? 'Gathering the context for the Summarised page…' : 'The AI is writing the Summarised page…'}
          </p>
          <p className="muted small">It takes a few minutes. It goes on if you leave this view, and the page waits here when you come back.</p>
          {s.problems.length > 0 && <p className="muted small">The page that was saved is out of date, so it is not shown: {s.problems[0]}</p>}
        </>
      ) : s.error ? (
        <>
          <p className="bad-text" data-testid="sections-error">
            The AI could not write the Summarised page.
          </p>
          <pre className="mono-box">{s.error}</pre>
          <button className="primary" data-testid="sections-retry" onClick={start}>
            Try again
          </button>
        </>
      ) : (
        <>
          <p>{s.problems.length > 0 ? 'The saved Summarised page is out of date.' : 'The Summarised page is not written yet.'}</p>
          <button className="primary" data-testid="sections-write" onClick={start}>
            Write the page
          </button>
        </>
      )}
    </div>
  )
}

const STATE_MARK: Record<SectionState, { mark: string; word: string }> = {
  accepted: { mark: '✓', word: 'Accepted' },
  waiting: { mark: '◐', word: 'Accepted, and a file waits for another section' },
  open: { mark: '○', word: 'Not accepted' }
}

/** The open threads and the drafts of a section, as two small marks. A collapsed section shows them, so the collapse hides nothing. */
function useDiscussion(section: Section): { open: number; drafts: number } {
  const r = useReview()
  return discussionOf(
    section.title,
    r.data.mrs.map((m) => ({ key: m.key, threads: m.snapshot.threads })),
    Object.values(r.drafts)
  )
}

function DiscussionMarks(props: { open: number; drafts: number }): React.JSX.Element | null {
  if (props.open === 0 && props.drafts === 0) return null
  return (
    <>
      {props.open > 0 && (
        <span className="chip openchip" title={`${props.open} open ${props.open === 1 ? 'thread' : 'threads'}`} data-testid="mark-thread">
          💬 {props.open}
        </span>
      )}
      {props.drafts > 0 && (
        <span className="chip draftchip" title={`${props.drafts} ${props.drafts === 1 ? 'draft' : 'drafts'}, not posted yet`} data-testid="mark-draft">
          ✎ {props.drafts}
        </span>
      )}
    </>
  )
}

function SectionCard(props: {
  doc: SectionsDocument
  section: Section
  index: number
  level: LevelName
  rest: RestEntry[]
  /** What the page draws for the files of this section. A change that an earlier section draws is not drawn again. */
  excerpts: FileExcerpt[]
  collapsed: boolean
  onToggle(): void
  /** The reader pressed the Accept button of this section: `on` is the new state. */
  onAccept(on: boolean): void
  onOpen: OpenFile
}): React.JSX.Element {
  const r = useReview()
  const { doc, section: s, collapsed } = props
  const accepted = isAccepted(doc, r.accepted, r.viewed, s.id)
  const progress = sectionProgress(s, r.viewed)
  const files = sectionFiles(s)
  const talk = useDiscussion(s)
  // A mirror is a file with no snippet here: its change repeats a change that the snippets show
  const shownKeys = new Set(s.snippets.map((x) => `${x.mr}|${x.path}`))
  const mirrorKeys = new Set((s.mirrors ?? []).map((x) => `${x.mr}|${x.path}`).filter((k) => !shownKeys.has(k)))
  const statusOf = (f: SectionFile): string => r.mrByKey(f.mr)?.files.find((x) => x.path === f.path)?.status ?? 'M'
  const firstLine = (f: SectionFile): number | null => {
    const sn = s.snippets.find((x) => x.mr === f.mr && x.path === f.path && x.side !== 'old')
    return sn ? sn.lines[0] : null
  }
  return (
    <article
      className={`section ${accepted ? 'accepted' : ''} ${s.leftover ? 'leftover' : ''} ${collapsed ? 'collapsed' : ''}`}
      data-testid={`section-${s.id}`}
      data-section-id={s.id}
      data-accepted={accepted}
      data-collapsed={collapsed}
      tabIndex={-1}
    >
      <header className="sectionhead">
        <button
          className="chevbtn"
          data-testid={`toggle-${s.id}`}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : `section-body-${s.id}`}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} the section ${s.title}`}
          title={collapsed ? 'Expand the section' : 'Collapse the section to its title'}
          onClick={props.onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="sectionno">{props.index + 1}</span>
        <h3>{s.title}</h3>
        {collapsed && <DiscussionMarks {...talk} />}
        <span className="grow" />
        <span className="muted small" data-testid={`section-progress-${s.id}`} title="Files of this section that are marked as viewed">
          {progress.viewed} of {progress.total} {progress.total === 1 ? 'file' : 'files'} viewed
        </span>
        <button
          className={accepted ? 'acceptbtn on' : 'acceptbtn primary'}
          data-testid={`accept-${s.id}`}
          aria-pressed={accepted}
          title={accepted ? 'Take the accept back. The files of this section lose their viewed mark.' : 'Mark the files of this section as viewed'}
          onClick={() => props.onAccept(!accepted)}
        >
          {accepted ? '✓ Accepted' : 'Accept'}
        </button>
      </header>
      {!collapsed && (
        <div className="sectionbody" id={`section-body-${s.id}`}>
          <p className="sectiontext">{s.text || (s.leftover ? REST_TEXT : '')}</p>
          {props.excerpts.map((e) => (
            <FileExcerptView key={`${e.mr}|${e.path}`} excerpt={e} level={props.level} onOpen={props.onOpen} />
          ))}
          {s.leftover ? (
            <div className="restlist" data-testid="rest-list">
              {props.rest.map((e) => (
                <RestFile key={`${e.mr}|${e.path}`} doc={doc} section={s} entry={e} level={props.level} onOpen={props.onOpen} />
              ))}
            </div>
          ) : (
            <footer className="sectionfoot" data-testid={`section-files-${s.id}`}>
              <span className="muted small">Files</span>
              {files.map((f) => {
                const seen = r.viewed.has(viewedId(f.mr, f.path))
                const waits = waitingFor(doc, r.accepted, s.id, f)
                const mirror = mirrorKeys.has(`${f.mr}|${f.path}`)
                return (
                  <button
                    key={`${f.mr}|${f.path}`}
                    className={`filechip mono ${seen ? 'seen' : ''} ${mirror ? 'mirror' : ''}`}
                    data-testid={`sfile-${f.path}`}
                    title={`${f.path}\n!${iidOf(f.mr)}\n${mirror ? 'Mirrors a change that this section shows, so it has no excerpt here.\n' : ''}${seen ? 'Viewed.' : waits.length > 0 ? `Not viewed until you accept: ${waits.map((o) => o.title).join(', ')}.` : 'Not viewed.'}\nOpen it in the Linear view.`}
                    onClick={() => props.onOpen(f.mr, f.path, firstLine(f))}
                  >
                    <span className={`badge ${statusOf(f)}`}>{statusOf(f)}</span>
                    {nameOf(f.path)}
                    {seen && <span className="tick"> ✓</span>}
                    {mirror && <span className="muted"> · mirrors</span>}
                    {!seen && waits.length > 0 && <span className="muted"> · waits</span>}
                  </button>
                )
              })}
            </footer>
          )}
          <SectionThread doc={doc} section={s} />
        </div>
      )}
    </article>
  )
}

/** One row of the index. */
function IndexRow(props: { doc: SectionsDocument; section: Section; index: number; active: boolean; onGo(): void }): React.JSX.Element {
  const r = useReview()
  const { section: s } = props
  const state = sectionState(props.doc, r.accepted, r.viewed, s.id)
  const progress = sectionProgress(s, r.viewed)
  const talk = useDiscussion(s)
  return (
    <li>
      <button
        className={`indexrow ${props.active ? 'current' : ''}`}
        data-testid={`index-${s.id}`}
        data-state={state}
        aria-current={props.active ? 'true' : undefined}
        title={`${s.title}\n${STATE_MARK[state].word}`}
        onClick={props.onGo}
      >
        <span className={`statemark ${state}`} role="img" aria-label={STATE_MARK[state].word}>
          {STATE_MARK[state].mark}
        </span>
        <span className="sectionno small">{props.index + 1}</span>
        <span className="tname">{s.title}</span>
        <DiscussionMarks {...talk} />
        <span className="count" title={`${progress.viewed} of ${progress.total} files viewed`}>
          {progress.viewed}/{progress.total}
        </span>
      </button>
    </li>
  )
}

/**
 * The index in the left column: the progress, and one row for each section in order, "Everything else" last. A click goes to the section.
 * The Up and Down keys walk the rows, Home and End go to the first and the last, and Enter goes to the section.
 */
function SectionsIndex(props: { doc: SectionsDocument; activeId: string | null; onGo(id: string): void }): React.JSX.Element {
  const r = useReview()
  const { doc } = props
  const acceptedCount = doc.sections.filter((s) => isAccepted(doc, r.accepted, r.viewed, s.id)).length
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.indexrow')]
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
    e.preventDefault()
    rows[to]?.focus()
    rows[to]?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div className="sectionindex" data-testid="section-index">
      <div className="progress" data-testid="index-progress" title="The sections that you accepted">
        <div className="bar6">
          <div style={{ width: `${doc.sections.length ? Math.round((acceptedCount / doc.sections.length) * 100) : 0}%` }} />
        </div>
        <span className="muted">
          {acceptedCount} of {doc.sections.length} accepted
        </span>
      </div>
      <ul className="tree indexlist" aria-label="Sections" onKeyDown={onKey}>
        {doc.sections.map((s, i) => (
          <IndexRow key={s.id} doc={doc} section={s} index={i} active={props.activeId === s.id} onGo={() => props.onGo(s.id)} />
        ))}
      </ul>
    </div>
  )
}

/**
 * The Summarised tab: a page of sections in reading order. Each section has a title, one paragraph, some code, the files it involves
 * and its own thread. Accepting a section marks its files as viewed and collapses it. The last section is "Everything else", which the
 * app computes from the diffs: every file and every change that no section shows. The index of the sections goes to the left column.
 */
export function SectionsView(props: { doc: SectionsDocument; level: LevelName; indexHost: HTMLElement | null; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const facts = useMemo(() => sectionFactsOf(r.data.mrs), [r.data])
  const rest = useMemo(() => restOf(props.doc, facts), [props.doc, facts])
  const doc = useMemo(() => withRest(props.doc, rest), [props.doc, rest])
  const excerpts = useMemo(
    () =>
      pageExcerpts(doc.sections, (mr, path) => {
        const file = r.mrByKey(mr)?.files.find((x) => x.path === path)
        return file && !file.binary ? file.levels[props.level].hunks : null
      }),
    [doc, props.level, r.data] // eslint-disable-line react-hooks/exhaustive-deps
  )
  useEffect(() => {
    if (import.meta.env.DEV) reportRepeatedRows(excerpts)
  }, [excerpts])
  const cover = useMemo(() => coverageOf(props.doc, facts, rest), [props.doc, facts, rest])
  const acceptedIds = useMemo(
    () => new Set(doc.sections.filter((s) => isAccepted(doc, r.accepted, r.viewed, s.id)).map((s) => s.id)),
    [doc, r.accepted, r.viewed]
  )
  const acceptedCount = acceptedIds.size
  const all = useMemo(() => {
    const seen = new Set<string>()
    for (const s of doc.sections) for (const f of sectionFiles(s)) seen.add(viewedId(f.mr, f.path))
    return [...seen]
  }, [doc])
  const viewedCount = all.filter((id) => r.viewed.has(id)).length
  const written = props.doc.sections.length

  // Collapse. The state is kept for each review. A section with no saved state is open, unless it is accepted.
  const storeKey = `codediff:collapsed:${r.slug}`
  const [collapsed, setCollapsed] = useState<CollapsedState>(() => {
    try {
      return parseCollapsed(localStorage.getItem(storeKey))
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(collapsed))
    } catch {
      /* storage can be blocked */
    }
  }, [storeKey, collapsed])
  // Accept collapses a section and un-accept opens it. The same holds for a change in the tree that accepts or un-accepts a section.
  // The accepted sections that the page saw last are kept too, so a change made while the view was closed, as a mark removed in the tree,
  // still opens or collapses the section when the view opens again.
  const seenKey = `codediff:accepted-seen:${r.slug}`
  const before = useRef<ReadonlySet<string> | null>(null)
  if (before.current === null) {
    try {
      const saved = localStorage.getItem(seenKey)
      before.current = saved ? new Set(JSON.parse(saved) as string[]) : acceptedIds
    } catch {
      before.current = acceptedIds
    }
  }
  useLayoutEffect(() => {
    const was = before.current ?? acceptedIds
    before.current = acceptedIds
    setCollapsed((c) => collapseOnAcceptChange(was, acceptedIds, c))
    try {
      localStorage.setItem(seenKey, JSON.stringify([...acceptedIds]))
    } catch {
      /* storage can be blocked */
    }
  }, [acceptedIds, seenKey])
  const isShut = (id: string): boolean => isCollapsed(collapsed, id, acceptedIds.has(id))
  const ids = doc.sections.map((s) => s.id)
  const toggle = (id: string): void => setCollapsed((c) => ({ ...c, [id]: !isCollapsed(c, id, acceptedIds.has(id)) }))

  // The index follows the page: the section in view is the last one whose top has passed the top of the page
  const viewRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null)
  useEffect(() => {
    const root = viewRef.current?.closest<HTMLElement>('.rightscroll')
    if (!root) return
    const spy = (): void => {
      const edge = root.getBoundingClientRect().top
      const top = edge + 60 // the header of a section is about this high, and it stays at the top of the page
      const cards = [...(viewRef.current?.querySelectorAll<HTMLElement>('article.section') ?? [])]
      let at = cards[0]?.dataset.sectionId ?? null
      for (const c of cards) {
        const box = c.getBoundingClientRect()
        if (box.top <= top) at = c.dataset.sectionId ?? at
        // the header is stuck while the section starts above the page and its end is still below the header
        c.classList.toggle('stuck', box.top < edge - 1 && box.bottom > edge + 48)
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && cards.length > 0) at = cards[cards.length - 1].dataset.sectionId ?? at
      setActiveId(at)
    }
    root.addEventListener('scroll', spy, { passive: true })
    spy()
    return () => root.removeEventListener('scroll', spy)
  }, [doc, collapsed])
  // Accept by a click on the button of a section keeps the reader's place. The collapse changes the height of the page above the reader,
  // so after the change is laid out, an Accept goes on to the next section that is not accepted (the end of the page when none follows),
  // and an un-accept keeps its header where it was on the screen. A section accepted in another way, as by the tree, scrolls nothing.
  const latest = useRef({ acceptedIds, ids })
  latest.current = { acceptedIds, ids }
  const plan = useRef<{ kind: 'next'; id: string } | { kind: 'keep'; id: string; top: number } | null>(null)
  const cardOf = (id: string): HTMLElement | null | undefined =>
    viewRef.current?.querySelector<HTMLElement>(`article.section[data-section-id="${CSS.escape(id)}"]`)
  const runPlan = (): void => {
    const p = plan.current
    plan.current = null
    const root = viewRef.current?.closest<HTMLElement>('.rightscroll')
    if (!p || !root) return
    if (p.kind === 'keep') {
      const card = cardOf(p.id)
      const delta = card ? card.getBoundingClientRect().top - root.getBoundingClientRect().top - p.top : 0
      if (Math.abs(delta) > 0.5) root.scrollTop += delta
      return
    }
    const { acceptedIds: done, ids: order } = latest.current
    const next = order.slice(order.indexOf(p.id) + 1).find((x) => !done.has(x))
    if (!next) {
      root.scrollTop = root.scrollHeight
      return
    }
    setActiveId(next)
    const el = cardOf(next)
    el?.scrollIntoView({ block: 'start' })
    el?.focus({ preventScroll: true })
  }
  const accept = (id: string, on: boolean): void => {
    const root = viewRef.current?.closest<HTMLElement>('.rightscroll')
    const card = cardOf(id)
    plan.current = on ? { kind: 'next', id } : { kind: 'keep', id, top: card && root ? card.getBoundingClientRect().top - root.getBoundingClientRect().top : 0 }
    r.setSectionAccepted(doc, id, on)
    requestAnimationFrame(runPlan) // the state and the collapse are laid out by then
  }
  const go = (id: string): void => {
    if (isShut(id)) setCollapsed((c) => ({ ...c, [id]: false }))
    setActiveId(id)
    requestAnimationFrame(() => {
      const el = viewRef.current?.querySelector<HTMLElement>(`article.section[data-section-id="${CSS.escape(id)}"]`)
      el?.scrollIntoView({ block: 'start' })
      el?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="sectionsview" data-testid="sections-view" ref={viewRef}>
      {props.indexHost && createPortal(<SectionsIndex doc={doc} activeId={activeId} onGo={go} />, props.indexHost)}
      {props.doc.summary && (
        <p className="sectionsummary" data-testid="sections-summary">
          {props.doc.summary}
        </p>
      )}
      <div className="sectionsbar" data-testid="sections-progress">
        <div className="bar6">
          <div style={{ width: `${doc.sections.length ? Math.round((acceptedCount / doc.sections.length) * 100) : 0}%` }} />
        </div>
        <span className="muted small">
          {acceptedCount} of {doc.sections.length} {doc.sections.length === 1 ? 'section' : 'sections'} accepted · {viewedCount} of {all.length}{' '}
          {all.length === 1 ? 'file' : 'files'} viewed
        </span>
        <span className="grow" />
        <button className="small" data-testid="collapse-all" onClick={() => setCollapsed(setAllCollapsed(ids, true))}>
          Collapse all
        </button>
        <button className="small" data-testid="expand-all" onClick={() => setCollapsed(setAllCollapsed(ids, false))}>
          Expand all
        </button>
      </div>
      <p className="muted small" data-testid="sections-coverage">
        {cover.total === 0
          ? 'This review has no changed file.'
          : written === 0
            ? `No change needs a section of its own. All ${cover.total} changed ${cover.total === 1 ? 'file is' : 'files are'} in Everything else.`
            : `${cover.inSections} of ${cover.total} changed ${cover.total === 1 ? 'file is' : 'files are'} in the sections.` +
              (cover.inRest > 0
                ? ` Everything else holds ${cover.inRest} ${cover.inRest === 1 ? 'file' : 'files'}${cover.inBoth > 0 ? `, ${cover.inBoth} of them with changes that a section also shows` : ''}.`
                : ' Nothing is left out.')}
      </p>
      {doc.sections.map((s, i) => (
        <SectionCard
          key={s.id}
          doc={doc}
          section={s}
          index={i}
          level={props.level}
          rest={rest}
          excerpts={excerpts[s.id] ?? []}
          collapsed={isShut(s.id)}
          onToggle={() => toggle(s.id)}
          onAccept={(on) => accept(s.id, on)}
          onOpen={props.onOpen}
        />
      ))}
    </div>
  )
}
