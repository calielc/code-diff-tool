import { useMemo, useState } from 'react'
import { newCommentId, type PendingComment } from '@shared/comments'
import type { FileObject, LevelName, LineObj } from '@shared/diff'
import {
  coverageOf,
  excerptOf,
  isAccepted,
  restOf,
  sectionCommentBody,
  sectionDrafts,
  sectionFactsOf,
  sectionFiles,
  sectionProgress,
  sectionThreads,
  threadTarget,
  viewedId,
  waitingFor,
  withRest,
  type Piece,
  type RestEntry,
  type Run,
  type Section,
  type SectionFile,
  type SectionsDocument,
  type SectionsState,
  type SnippetRef
} from '@shared/sections'
import { api } from '../api'
import { codeOf, intraMapOf } from './intra-marks'
import { useReview } from './review-context'
import { CommentForm, DraftCard, ThreadCard } from './ThreadViews'

type OpenFile = (mr: string, path: string, line: number | null) => void

const iidOf = (key: string): string => key.slice(key.lastIndexOf('!') + 1)
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** The most rows that "Everything else" shows for one file. The file opens in the Linear view for the rest. */
const REST_ROWS = 60

/** The rows of some pieces of a diff, with a gap mark between two pieces. */
function PieceTable(props: { pieces: Piece[] }): React.JSX.Element {
  const marks = useMemo(() => intraMapOf(props.pieces), [props.pieces])
  return (
    <table className="diff snip">
      <tbody>
        {props.pieces.map((piece, i) => [
          i > 0 && (
            <tr key={`gap${i}`} className="hunk">
              <td colSpan={4}>⋯</td>
            </tr>
          ),
          ...piece.map((l, j) => (
            <tr key={`${i}:${j}`} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}>
              <td className="ln">{l.o ?? ''}</td>
              <td className="ln">{l.n ?? ''}</td>
              <td className="sign">{l.t === '+' ? '+' : l.t === '-' ? '−' : ''}</td>
              <td className="code">{codeOf(marks, l)}</td>
            </tr>
          ))
        ])}
      </tbody>
    </table>
  )
}

/** The code of one snippet: small excerpts of the diff of one file, at the noise level of the toolbar. */
function Snippet(props: { snippet: SnippetRef; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { snippet: sn } = props
  const file = r.mrByKey(sn.mr)?.files.find((f) => f.path === sn.path)
  const excerpt = useMemo(() => (file ? excerptOf(file.levels[props.level].hunks, sn) : null), [file, props.level, sn])
  const first = sn.side === 'old' ? null : sn.lines[0]
  return (
    <div className="snippet" data-testid="snippet">
      <button className="snippath mono" title="Open the file in the Linear view" onClick={() => props.onOpen(sn.mr, sn.path, first)}>
        {sn.path}
        <span className="muted">
          {' '}
          · {sn.side === 'old' ? 'old ' : ''}lines {sn.lines[0]}-{sn.lines[1]}
        </span>
      </button>
      {!file ? (
        <p className="note">This file is not in the review any more.</p>
      ) : file.binary ? (
        <p className="note">Binary file, no text diff.</p>
      ) : !excerpt || excerpt.pieces.length === 0 ? (
        <p className="note">No line of this range changed at this noise level. It holds noise only.</p>
      ) : (
        <PieceTable pieces={excerpt.pieces} />
      )}
      {excerpt?.truncated && <p className="note">The excerpt is cut short. Open the file to read the rest.</p>}
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

/** The pieces of the changes of "Everything else" in one file: its uncovered runs, or its whole diff. */
function restPieces(file: FileObject, entry: RestEntry, level: LevelName): { pieces: Piece[]; cut: boolean } {
  const hunks = file.levels[level].hunks
  let rows = 0
  let cut = false
  const pieces: Piece[] = []
  const add = (piece: LineObj[]): void => {
    if (rows >= REST_ROWS) return void (cut = true)
    const room = piece.slice(0, REST_ROWS - rows)
    if (room.length < piece.length) cut = true
    rows += room.length
    pieces.push(room)
  }
  if (entry.whole) for (const h of hunks) add(h)
  else
    for (const run of entry.runs) {
      const side = run.new.length > 0 ? 'new' : 'old'
      const nums: number[] = side === 'new' ? run.new : run.old
      for (const p of excerptOf(hunks, { lines: [Math.min(...nums), Math.max(...nums)], side }).pieces) add(p)
    }
  return { pieces, cut }
}

const runCount = (runs: Run[]): number => runs.length

/** One file of "Everything else": a row that opens to show the changes that the section holds. */
function RestFile(props: { doc: SectionsDocument; section: Section; entry: RestEntry; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { entry: e } = props
  const [open, setOpen] = useState(false)
  const file = r.mrByKey(e.mr)?.files.find((f) => f.path === e.path)
  const seen = r.viewed.has(viewedId(e.mr, e.path))
  const waits = waitingFor(props.doc, r.accepted, props.section.id, { mr: e.mr, path: e.path })
  const shown = useMemo(() => (open && file && !file.binary ? restPieces(file, e, props.level) : null), [open, file, e, props.level])
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
        {file?.binary ? (
          <p className="note">Binary file, no text diff.</p>
        ) : shown && shown.pieces.length === 0 ? (
          <p className="note">Nothing of this file shows at this noise level. It holds noise only.</p>
        ) : (
          shown && <PieceTable pieces={shown.pieces} />
        )}
        {shown?.cut && <p className="note">Only the start is shown here.</p>}
        <button className="link" onClick={() => props.onOpen(e.mr, e.path, null)}>
          Open the file in the Linear view
        </button>
      </div>
    </details>
  )
}

function SectionCard(props: {
  doc: SectionsDocument
  section: Section
  index: number
  level: LevelName
  rest: RestEntry[]
  onOpen: OpenFile
}): React.JSX.Element {
  const r = useReview()
  const { doc, section: s } = props
  const accepted = isAccepted(doc, r.accepted, r.viewed, s.id)
  const progress = sectionProgress(s, r.viewed)
  const files = sectionFiles(s)
  const statusOf = (f: SectionFile): string => r.mrByKey(f.mr)?.files.find((x) => x.path === f.path)?.status ?? 'M'
  const firstLine = (f: SectionFile): number | null => {
    const sn = s.snippets.find((x) => x.mr === f.mr && x.path === f.path && x.side !== 'old')
    return sn ? sn.lines[0] : null
  }
  return (
    <article className={`section ${accepted ? 'accepted' : ''} ${s.leftover ? 'leftover' : ''}`} data-testid={`section-${s.id}`} data-accepted={accepted}>
      <header className="sectionhead">
        <span className="sectionno">{props.index + 1}</span>
        <h3>{s.title}</h3>
        <span className="grow" />
        <span className="muted small" data-testid={`section-progress-${s.id}`} title="Files of this section that are marked as viewed">
          {progress.viewed} of {progress.total} {progress.total === 1 ? 'file' : 'files'} viewed
        </span>
        <button
          className={accepted ? 'acceptbtn on' : 'acceptbtn primary'}
          data-testid={`accept-${s.id}`}
          aria-pressed={accepted}
          title={accepted ? 'Take the accept back. The files of this section lose their viewed mark.' : 'Mark the files of this section as viewed'}
          onClick={() => r.setSectionAccepted(doc, s.id, !accepted)}
        >
          {accepted ? '✓ Accepted' : 'Accept'}
        </button>
      </header>
      <p className="sectiontext">{s.text || (s.leftover ? REST_TEXT : '')}</p>
      {s.snippets.map((sn, i) => (
        <Snippet key={i} snippet={sn} level={props.level} onOpen={props.onOpen} />
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
            return (
              <button
                key={`${f.mr}|${f.path}`}
                className={`filechip mono ${seen ? 'seen' : ''}`}
                data-testid={`sfile-${f.path}`}
                title={`${f.path}\n!${iidOf(f.mr)}\n${seen ? 'Viewed.' : waits.length > 0 ? `Not viewed until you accept: ${waits.map((o) => o.title).join(', ')}.` : 'Not viewed.'}\nOpen it in the Linear view.`}
                onClick={() => props.onOpen(f.mr, f.path, firstLine(f))}
              >
                <span className={`badge ${statusOf(f)}`}>{statusOf(f)}</span>
                {nameOf(f.path)}
                {seen && <span className="tick"> ✓</span>}
                {!seen && waits.length > 0 && <span className="muted"> · waits</span>}
              </button>
            )
          })}
        </footer>
      )}
      <SectionThread doc={doc} section={s} />
    </article>
  )
}

/** What the Summarised view shows while there is no page: the run, the reason for a failure, or a button to start. */
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

/**
 * The Summarised view: a page of sections in reading order. Each section has a title, one paragraph, some code, the files it involves
 * and its own thread. Accepting a section marks its files as viewed. The last section is "Everything else", which the app computes from
 * the diffs: every file and every change that no section shows.
 */
export function SectionsView(props: { doc: SectionsDocument; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const facts = useMemo(() => sectionFactsOf(r.data.mrs), [r.data])
  const rest = useMemo(() => restOf(props.doc, facts), [props.doc, facts])
  const doc = useMemo(() => withRest(props.doc, rest), [props.doc, rest])
  const cover = useMemo(() => coverageOf(props.doc, facts, rest), [props.doc, facts, rest])
  const acceptedCount = doc.sections.filter((s) => isAccepted(doc, r.accepted, r.viewed, s.id)).length
  const all = useMemo(() => {
    const seen = new Set<string>()
    for (const s of doc.sections) for (const f of sectionFiles(s)) seen.add(viewedId(f.mr, f.path))
    return [...seen]
  }, [doc])
  const viewedCount = all.filter((id) => r.viewed.has(id)).length
  const written = props.doc.sections.length
  return (
    <div className="sectionsview" data-testid="sections-view">
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
        <SectionCard key={s.id} doc={doc} section={s} index={i} level={props.level} rest={rest} onOpen={props.onOpen} />
      ))}
    </div>
  )
}
