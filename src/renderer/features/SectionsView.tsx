import { useMemo, useState } from 'react'
import { newCommentId, type PendingComment } from '@shared/comments'
import type { LevelName } from '@shared/diff'
import {
  excerptOf,
  isAccepted,
  sectionCommentBody,
  sectionDrafts,
  sectionFactsOf,
  sectionFiles,
  sectionProgress,
  sectionThreads,
  threadTarget,
  uncoveredFiles,
  viewedId,
  waitingFor,
  type Section,
  type SectionFile,
  type SectionsDocument,
  type SnippetRef
} from '@shared/sections'
import { codeOf, intraMapOf } from './intra-marks'
import { useReview } from './review-context'
import { CommentForm, DraftCard, ThreadCard } from './ThreadViews'

type OpenFile = (mr: string, path: string, line: number | null) => void

const iidOf = (key: string): string => key.slice(key.lastIndexOf('!') + 1)
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** The code of one snippet: small excerpts of the diff of one file, at the noise level of the toolbar. */
function Snippet(props: { snippet: SnippetRef; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { snippet: sn } = props
  const file = r.mrByKey(sn.mr)?.files.find((f) => f.path === sn.path)
  const excerpt = useMemo(() => (file ? excerptOf(file.levels[props.level].hunks, sn) : null), [file, props.level, sn])
  const marks = useMemo(() => intraMapOf(excerpt?.pieces ?? []), [excerpt])
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
        <table className="diff snip">
          <tbody>
            {excerpt.pieces.map((piece, i) => [
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

function SectionCard(props: { doc: SectionsDocument; section: Section; index: number; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
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
    <article className={`section ${accepted ? 'accepted' : ''}`} data-testid={`section-${s.id}`} data-accepted={accepted}>
      <header className="sectionhead">
        <span className="sectionno">{props.index + 1}</span>
        <h3>{s.title}</h3>
        {s.leftover && <span className="tag">Everything else</span>}
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
      <p className="sectiontext">{s.text}</p>
      {s.snippets.map((sn, i) => (
        <Snippet key={i} snippet={sn} level={props.level} onOpen={props.onOpen} />
      ))}
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
      <SectionThread doc={doc} section={s} />
    </article>
  )
}

/**
 * The Summarised view: a page of sections in reading order. Each section has a title, one paragraph, some code, the files it involves
 * and its own thread. Accepting a section marks its files as viewed.
 */
export function SectionsView(props: { doc: SectionsDocument; level: LevelName; onOpen: OpenFile }): React.JSX.Element {
  const r = useReview()
  const { doc } = props
  const acceptedCount = doc.sections.filter((s) => isAccepted(doc, r.accepted, r.viewed, s.id)).length
  const all = useMemo(() => {
    const seen = new Set<string>()
    for (const s of doc.sections) for (const f of sectionFiles(s)) seen.add(viewedId(f.mr, f.path))
    return [...seen]
  }, [doc])
  const viewedCount = all.filter((id) => r.viewed.has(id)).length
  const missing = useMemo(() => uncoveredFiles(doc, sectionFactsOf(r.data.mrs)), [doc, r.data])
  const total = r.data.mrs.reduce((n, m) => n + (m.noDiff ? 0 : m.files.length), 0)
  return (
    <div className="sectionsview" data-testid="sections-view">
      <p className="sectionsummary" data-testid="sections-summary">
        {doc.summary}
      </p>
      <div className="sectionsbar" data-testid="sections-progress">
        <div className="bar6">
          <div style={{ width: `${doc.sections.length ? Math.round((acceptedCount / doc.sections.length) * 100) : 0}%` }} />
        </div>
        <span className="muted small">
          {acceptedCount} of {doc.sections.length} sections accepted · {viewedCount} of {all.length} files viewed
        </span>
      </div>
      {missing.length > 0 ? (
        <div className="banner warn" data-testid="sections-uncovered">
          {missing.length} changed {missing.length === 1 ? 'file is' : 'files are'} in no section:{' '}
          {missing.map((f) => (
            <button key={`${f.mr}|${f.path}`} className="link mono" onClick={() => props.onOpen(f.mr, f.path, null)}>
              {f.path}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small" data-testid="sections-coverage">
          All {total} changed {total === 1 ? 'file is' : 'files are'} in a section.
        </p>
      )}
      {doc.sections.map((s, i) => (
        <SectionCard key={s.id} doc={doc} section={s} index={i} level={props.level} onOpen={props.onOpen} />
      ))}
    </div>
  )
}
