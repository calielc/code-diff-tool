const fs = require('fs')
const edit = (f, pairs) => {
  let s = fs.readFileSync(f, 'utf8')
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error('missing in ' + f + ': ' + a.slice(0, 70))
    s = s.replace(a, b)
  }
  fs.writeFileSync(f, s)
}
// MrsScreen: the issues and the changes sit in a card; the changes card has a summary line
edit('src/renderer/features/MrsScreen.tsx', [
  ["          {tab === 'issues' && <IssuesTab />}", "          {tab === 'issues' && (\n            <div className=\"panelcard\">\n              <IssuesTab />\n            </div>\n          )}"],
  [
    "          {tab === 'mrs' && (\n            <>\n              <table className=\"reviews\">",
    `          {tab === 'mrs' && (
            <div className="panelcard">
              <div className="cardhead" data-testid="mrs-summary">
                <strong>Code changes</strong>
                <span className="muted">
                  {stateCount('draft')} draft · {stateCount('opened')} open · {stateCount('merged')} merged · {stateCount('closed')} closed
                  {data.skipped.length > 0 && \` · \${data.skipped.length} hidden\`}
                </span>
              </div>
              <table className="reviews">`
  ],
  ["            </>\n          )}\n        </div>\n      )}\n      <ReviewChat />", "            </div>\n          )}\n        </div>\n      )}\n      <ReviewChat />"],
  [
    '  const repoCount =',
    "  const stateCount = (k: 'draft' | 'opened' | 'merged' | 'closed'): number =>\n    data.mrs.filter((m) => (k === 'draft' ? m.snapshot.info.draft : !m.snapshot.info.draft && m.snapshot.info.state === k)).length\n  const repoCount ="
  ]
])
// file header scope: `Modified · !104 · repo`
edit('src/renderer/features/DiffTab.tsx', [
  [
    "  const header = `${STATUS_WORD[file.status]}${file.status === 'R' ? ` · renamed from ${file.oldPath}` : ''} · ${entry.scope}`",
    "  const header = `${STATUS_WORD[file.status]}${file.status === 'R' ? ` · renamed from ${file.oldPath}` : ''} · ${entry.mrKey ? `!${iidOf(entry.mrKey)} · ${entry.repo}` : entry.scope}`"
  ]
])
// AI pill text
edit('src/renderer/features/AiPanel.tsx', [
  [
    "        {run?.state === 'running' && <span className=\"spin\">◐ </span>}✦ AI review · <span data-testid=\"ai-words\">{gathering ? 'gathering context…' : words}</span> ▾",
    `        {(run?.state === 'running' || gathering) && <span className="spin">◐ </span>}
        {!gathering && !run && unreadable.length === 0 && ai.context !== 'failed' ? '✦ ' : ''}
        <span className="pilltext">
          {run || gathering || unreadable.length > 0 || ai.context === 'failed' ? (gathering ? '' : 'AI review · ') : ''}
          <span data-testid="ai-words">{gathering ? 'Gathering context…' : !run && words === 'ready' ? 'Start AI review' : words}</span>
        </span>
        <span className="caret">▾</span>`
  ]
])
