import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IssueData } from '../src/shared/issues'
import { issueText, startSummaries, summariesOf } from '../src/main/services/summaries'

const fake = resolve(__dirname, 'fakes/fake-claude.mjs')
let dir: string
let log: string

const issue = (key: string, o: Partial<IssueData> = {}): IssueData => ({
  source: 'jira',
  key,
  url: null,
  type: 'Story',
  title: `Title of ${key}`,
  status: null,
  assignee: null,
  description: 'Do the thing.',
  criteria: ['First', 'Second'],
  error: null,
  updated: '2026-11-10T10:00:00.000+0100',
  comments: [{ author: 'Bob', created: '2026-11-11', body: 'Looks right' }],
  attachments: [],
  ...o
})
const calls = (): { args: string[]; cwd: string }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.includes('"args"'))
    .map((l) => JSON.parse(l))
const cache = (): Record<string, { updated: string; format: number; summary: string }> => JSON.parse(readFileSync(join(dir, 'issue-briefs.json'), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codediff-sum-'))
  log = join(dir, 'claude.log')
  writeFileSync(log, '')
  process.env.CODEDIFF_TEST = '1'
  process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['node', fake])
  process.env.FAKE_CLAUDE_LOG = log
})
afterEach(() => {
  for (const k of [
    'CODEDIFF_TEST',
    'CODEDIFF_FAKE_CLAUDE',
    'FAKE_CLAUDE_LOG',
    'FAKE_CLAUDE_MODE',
    'FAKE_CLAUDE_LOGIN',
    'FAKE_CLAUDE_SLEEP_MS',
    'CODEDIFF_SUMMARY_TIMEOUT_MS'
  ])
    delete process.env[k]
})

describe('the ticket text for the prompt (file 04 section 9.4)', () => {
  it('lists the criteria, the attachment files, the description and the comments', () => {
    expect(issueText(issue('LX-1'), ['5-a.png'])).toBe(
      '# LX-1: Title of LX-1\n\n## The acceptance criteria\n\n- AC1: First\n- AC2: Second\n\n## Attachment files\n\n- `5-a.png`\n\n## Description\n\nDo the thing.\n\n## Comments\n\n### Bob, 2026-11-11\n\nLooks right'
    )
  })
  it('says None. and No comments. when there are none', () => {
    const t = issueText(issue('LX-1', { criteria: [], comments: [], description: '' }), [])
    expect(t).toContain('## The acceptance criteria\n\nNone.')
    expect(t).toContain('## Attachment files\n\nNone.')
    expect(t).toContain('## Description\n\nNo description.')
    expect(t).toContain('## Comments\n\nNo comments.')
  })
})

describe('summary runs (file 04 section 9)', () => {
  it('runs haiku at low effort, read-only, in the issue folder, with a new session each, and caches the result', async () => {
    startSummaries(dir, 'R', [issue('LX-1'), issue('LX-2')])
    const found = await summariesOf('R')
    expect(found.get('LX-1')?.summary).toContain('## What it does')
    const c = calls()
    expect(c).toHaveLength(2)
    for (const call of c) {
      const a = call.args
      expect(a[a.indexOf('--model') + 1]).toBe('haiku')
      expect(a[a.indexOf('--effort') + 1]).toBe('low')
      expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
      expect(a[a.indexOf('--max-turns') + 1]).toBe('2') // no attachment files, plus 2
      expect(a).toContain('--session-id')
      expect(a).not.toContain('--resume')
      expect(a).toContain('--safe-mode')
      expect(a.at(-1)).toContain('# LX-')
    }
    expect(new Set(c.map((x) => x.args[x.args.indexOf('--session-id') + 1])).size).toBe(2)
    expect(c.map((x) => x.cwd.split(/[\\/]/).pop()).sort()).toEqual(['LX-1', 'LX-2'])
    expect(Object.keys(cache()).sort()).toEqual(['LX-1', 'LX-2'])
    expect(cache()['LX-1']).toMatchObject({ updated: '2026-11-10T10:00:00.000+0100', format: 2 })
  })

  it('does not start claude again when the issue is unchanged, and runs again when it changed (acceptance check 2)', async () => {
    startSummaries(dir, 'R', [issue('LX-1')])
    await summariesOf('R')
    expect(calls()).toHaveLength(1)
    startSummaries(dir, 'R', [issue('LX-1')]) // the same updated text
    await summariesOf('R')
    expect(calls()).toHaveLength(1)
    startSummaries(dir, 'R', [issue('LX-1', { updated: '2026-11-12T10:00:00.000+0100' })])
    await summariesOf('R')
    expect(calls()).toHaveLength(2)
  })

  it('treats an entry of another format, and an issue with no updated value, as not cached', async () => {
    writeFileSync(join(dir, 'issue-briefs.json'), JSON.stringify({ 'LX-1': { updated: '2026-11-10T10:00:00.000+0100', format: 1, summary: 'old shape' } }))
    startSummaries(dir, 'R', [issue('LX-1'), issue('LX-2', { updated: null })])
    await summariesOf('R')
    expect(calls()).toHaveLength(2)
    expect(Object.keys(cache())).toEqual(['LX-1']) // LX-2 has no updated value, so it is never cached
  })

  it('starts no claude when every readable issue is cached, and skips an unreadable one', async () => {
    writeFileSync(join(dir, 'issue-briefs.json'), JSON.stringify({ 'LX-1': { updated: '2026-11-10T10:00:00.000+0100', format: 2, summary: 'cached text' } }))
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz']) // not even checked
    startSummaries(dir, 'R', [issue('LX-1'), issue('LX-9', { error: 'HTTP 404' })])
    const found = await summariesOf('R')
    expect(found.get('LX-1')).toEqual({ summary: 'cached text' })
    expect(found.has('LX-9')).toBe(false)
  })

  it('reports a failure without caching it, so the next build tries again', async () => {
    process.env.FAKE_CLAUDE_MODE = 'crash'
    startSummaries(dir, 'R', [issue('LX-1')])
    expect((await summariesOf('R')).get('LX-1')).toEqual({ reason: 'boom' })
    expect(Object.keys(existsSync(join(dir, 'issue-briefs.json')) ? cache() : {})).toEqual([]) // nothing was cached
  })

  it('gives the time-out reason when claude takes too long', async () => {
    process.env.FAKE_CLAUDE_MODE = 'long'
    process.env.CODEDIFF_SUMMARY_TIMEOUT_MS = '600'
    startSummaries(dir, 'R', [issue('LX-1')])
    expect((await summariesOf('R')).get('LX-1')).toEqual({ reason: 'claude took longer than 3 minutes' })
  })

  it('gives the install message when claude is missing and the login message when it is logged out', async () => {
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    startSummaries(dir, 'R', [issue('LX-1')])
    expect((await summariesOf('R')).get('LX-1')?.reason).toMatch(/^'claude' not found — install it first/)
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['node', fake])
    process.env.FAKE_CLAUDE_LOGIN = 'no'
    startSummaries(dir, 'R2', [issue('LX-1')])
    expect((await summariesOf('R2')).get('LX-1')).toEqual({ reason: 'The AI tool is not logged in. Run `claude` once in a terminal and log in' })
  })

  it('runs at most 4 summaries at the same time (acceptance check 6)', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '700'
    const t0 = Date.now()
    startSummaries(
      dir,
      'R',
      Array.from({ length: 6 }, (_, i) => issue(`LX-${i + 1}`))
    )
    await summariesOf('R')
    expect(calls()).toHaveLength(6)
    // six runs of 0.7 s in groups of four need two rounds, so the whole step takes at least 1.4 s
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1300)
  })
})
