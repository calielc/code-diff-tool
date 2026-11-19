import { useEffect, useState } from 'react'
import type { BuildResult } from '@shared/review'
import { conversationThreads } from '@shared/threads'
import { api } from '../api'
import { DiffTab } from './DiffTab'
import { ReviewChat } from './ReviewChat'
import { ReviewProvider, useReview } from './review-context'
import { SubmitDialog } from './SubmitDialog'
import { DraftCard, ThreadCard } from './ThreadViews'
import { IssuesTab } from './IssuesTab'
import { AcTab } from './AcTab'
import { AddChanges } from './AddChanges'
import { AiPanel } from './AiPanel'

type Tab = 'mrs' | 'diff' | 'issues' | 'ac'
// The tab of each review, kept while the review is built again, so a reload does not lose your place.
const lastTab = new Map<string, Tab>()

const STATE_WORD: Record<string, string> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'locked' }

/** The review after a build: the MRs tab and the Diff tab, with live data from the watcher. */
export function MrsScreen(props: { result: BuildResult; slug: string; onHome: () => void; onReload: () => void }): React.JSX.Element {
  return (
    <ReviewProvider slug={props.slug} result={props.result} onReload={props.onReload}>
      <Screen onHome={props.onHome} />
    </ReviewProvider>
  )
}

function Screen(props: { onHome: () => void }): React.JSX.Element {
  const r = useReview()
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(r.slug) ?? 'mrs')
  const setTab = (t: Tab): void => (lastTab.set(r.slug, t), setTabState(t))
  const [submitFor, setSubmitFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const { data } = r
  const draftCount = Object.keys(r.drafts).length
  // An Open card of the review chat shows the Diff tab.
  useEffect(() => {
    if (r.nav) setTab('diff')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.nav?.nonce])

  return (
    <div className="page wide" data-testid="mrs-tab">
      {adding && (
        <AddChanges
          slug={r.slug}
          onClose={() => setAdding(false)}
          onAdded={() => {
            // The review is built again with what it holds now. Unsent comments are drafts on disk, so they stay.
            setAdding(false)
            r.reload()
          }}
        />
      )}
      <header>
        <button onClick={props.onHome}>← Reviews</button>
        <h1>{data.title}</h1>
        <AiPanel />
        <button data-testid="add-changes" onClick={() => setAdding(true)}>
          + Add changes
        </button>
        <button onClick={r.reload}>Reload</button>
      </header>
      <p className="muted">
        {data.mrs.length} {data.mrs.length === 1 ? 'change' : 'changes'} · signed in as {data.viewer}
        {data.issues.length > 0 && ` · ${data.issues.map((t) => t.key).join(', ')}`}
      </p>
      {r.refreshBanner && (
        <div className="banner warn" data-testid="refresh-banner">
          New commits on {r.refreshBanner.map((k) => `!${k.slice(k.lastIndexOf('!') + 1)}`).join(', ')}. <button onClick={r.reload}>Refresh</button>
        </div>
      )}
      {(r.flow.pending || r.flow.error) && (
        <div className="banner warn" data-testid="flow-banner" title={r.flow.error ?? undefined}>
          {r.flow.error
            ? 'The AI could not write Critical thinking. Reload the review to try again.'
            : r.flow.problems.length > 0
              ? `Critical thinking is out of date: the MRs changed since it was written (${r.flow.problems.length} problem(s)). The AI is writing it again.`
              : r.flow.context === 'gathering'
                ? 'Gathering context for Critical thinking…'
                : 'The AI is writing Critical thinking…'}
        </div>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'mrs'} className={tab === 'mrs' ? 'on' : ''} onClick={() => setTab('mrs')}>
          Code changes
        </button>
        <button role="tab" aria-selected={tab === 'issues'} className={tab === 'issues' ? 'on' : ''} data-testid="tab-issues" onClick={() => setTab('issues')}>
          Issues ({data.issues.length})
        </button>
        <button role="tab" aria-selected={tab === 'ac'} className={tab === 'ac' ? 'on' : ''} data-testid="tab-ac" onClick={() => setTab('ac')}>
          Acceptance criteria
        </button>
        <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'on' : ''} data-testid="tab-diff" onClick={() => setTab('diff')}>
          Diff{draftCount > 0 ? ` (${draftCount})` : ''}
        </button>
      </div>

      {tab === 'diff' && <DiffTab />}
      {tab === 'issues' && <IssuesTab />}
      {tab === 'ac' && <AcTab />}
      {tab === 'mrs' && (
        <>
          <table className="reviews">
            <thead>
              <tr>
                <th>Change</th>
                <th>Title</th>
                <th>State</th>
                <th>Author</th>
                <th>Branches</th>
                <th>Approved by</th>
                <th className="num">Threads</th>
                <th>Checks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.mrs.map((m) => {
                const i = m.snapshot.info
                const open = m.snapshot.threads.filter((t) => t.resolvable && !t.resolved).length
                const canReview = i.state === 'opened' && i.author !== r.viewer
                const conversation = conversationThreads(m.snapshot.threads).filter((t) => !(r.hideResolved && t.resolved))
                const drafts = Object.values(r.drafts).filter((d) => d.mr === m.key && d.path === null)
                return [
                  <tr key={m.key} data-testid={`mr-${m.key}`}>
                    <td className="mono strong">
                      <a href={i.url} onClick={(e) => (e.preventDefault(), void api.system.openExternal(i.url))}>
                        {m.key}
                      </a>
                    </td>
                    <td className="cut" title={i.title}>
                      {i.title}
                    </td>
                    <td data-testid={`state-${m.key}`}>
                      {STATE_WORD[i.state]}
                      {i.draft ? ', draft' : ''}
                      {m.noDiff ? ' (no diff)' : ''}
                    </td>
                    <td>{i.author}</td>
                    <td className="mono">
                      {i.sourceBranch} → {i.targetBranch}
                    </td>
                    <td data-testid={`approvals-${m.key}`}>{m.snapshot.approvals.approvedBy.join(', ') || '–'}</td>
                    <td className="num">
                      {open} / {m.snapshot.threads.length}
                    </td>
                    <td>{i.pipeline?.status ?? '–'}</td>
                    <td>
                      <button
                        data-testid={`submit-${m.key}`}
                        disabled={!canReview}
                        title={canReview ? undefined : 'Only an open change by someone else can take a review'}
                        onClick={() => setSubmitFor(m.key)}
                      >
                        Submit review
                      </button>
                    </td>
                  </tr>,
                  (conversation.length > 0 || drafts.length > 0) && (
                    <tr key={`${m.key}-conv`} className="extra">
                      <td colSpan={9}>
                        {conversation.map((t) => (
                          <ThreadCard key={t.id} mrKey={m.key} thread={t} mrOpen={i.state === 'opened'} />
                        ))}
                        {drafts.map((d) => (
                          <DraftCard key={d.id} draft={d} />
                        ))}
                      </td>
                    </tr>
                  )
                ]
              })}
            </tbody>
          </table>
          {data.skipped.length > 0 && (
            <>
              <h3>Skipped</h3>
              <ul className="checklist mono">
                {data.skipped.map((s) => (
                  <li key={s.key} className="muted">
                    – {s.key} ({s.reason}) {s.title}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <ReviewChat />
      {submitFor && r.mrByKey(submitFor) && <SubmitDialog mrs={[r.mrByKey(submitFor)!]} onClose={() => setSubmitFor(null)} />}
    </div>
  )
}
