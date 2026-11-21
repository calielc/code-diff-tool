import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setLlmConfig } from '../src/main/processes/llm'
import { startBuild } from '../src/main/services/build'
import {
  SECTIONS_EFFORT,
  SECTIONS_MAX_TURNS,
  SECTIONS_MODEL,
  SECTIONS_TRIES,
  loadSections,
  requestSections,
  resetSectionsMemory,
  sectionsStateOf,
  setSectionsTimeoutForTests
} from '../src/main/services/sections'
import { reviewDir } from '../src/main/services/reviews'
import { sessionOf } from '../src/main/services/session'
import { resetWorkspaceCache } from '../src/main/services/workspace'
import { SECTIONS_PROMPT_VERSION } from '../src/shared/sections'
import type { FakeForge } from './fakes/fake-forge'
import { stopFakeForge, useFakeForge } from './fakes/use-fake-forge'

const fakeClaude = resolve(__dirname, 'fakes/fake-claude.mjs')
const P = encodeURIComponent('team/backend/x')
let root: string
let forge: FakeForge
let log: string
let dir: string
let head: string

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const calls = (): { args: string[]; cwd: string }[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args)
const arg = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]

/** A page that passes the checker for the one changed file: line 2 holds the change. */
const GOOD = JSON.stringify({
  summary: 'A user sees the change.',
  sections: [{ id: 's1', title: 'The change', text: 'It changes line two.', snippets: [{ mr: 'backend/x!12', path: 'a.txt', lines: [2, 2] }] }]
})

const waitDone = async (): Promise<void> => {
  await expect.poll(() => sectionsStateOf('R-1').pending, { timeout: 20_000 }).toBe(false)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codediff-sections-'))
  const repo = join(root, 'backend', 'x')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'T')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const a = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  git(repo, 'commit', '-qam', 'change')
  const b = git(repo, 'rev-parse', 'HEAD')
  head = b
  forge = await useFakeForge({
    'GET user': { json: { username: 'me' } },
    [`GET projects/${P}/merge_requests/12`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/x/-/merge_requests/12',
        state: 'opened',
        title: 'Fix',
        author: { username: 'ann' },
        source_branch: 'f',
        target_branch: 'main',
        diff_refs: { base_sha: a, start_sha: a, head_sha: b }
      }
    },
    [`GET projects/${P}/merge_requests/12/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET projects/${P}/merge_requests/12/discussions`]: { json: [] },
    [`GET projects/${P}/merge_requests/12/reviewers`]: { json: [] }
  })
  log = join(root, 'claude.log')
  writeFileSync(log, '')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['node', fakeClaude])
  process.env.FAKE_CLAUDE_ANSWER = GOOD
  setLlmConfig({ tool: 'claude' })
  resetWorkspaceCache()
  resetSectionsMemory()
  dir = reviewDir(root, 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({ title: 'Review', mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }], skipped: [], issues: [] })
  )
  const r = await startBuild(root, 'R-1', () => undefined)
  if (!r.ok) throw new Error(r.error)
})
afterEach(async () => {
  for (const k of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_ANSWER', 'FAKE_CLAUDE_BAD_FIRST', 'FAKE_CLAUDE_SLEEP_MS']) delete process.env[k]
  setSectionsTimeoutForTests()
  await stopFakeForge(forge)
})

/** Start a run and wait until it is going. A valid saved page starts no run, so the tests of that call requestSections alone. */
const begin = async (): Promise<void> => {
  void requestSections('R-1')
  await expect.poll(() => sectionsStateOf('R-1').pending, { timeout: 10_000 }).toBe(true)
}

describe('a build', () => {
  it('never starts the AI tool, with or without a saved page, and leaves the page unwritten', async () => {
    await loadSections(sessionOf('R-1')!)
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, error: null, document: null, problems: [] })
    expect(calls()).toHaveLength(0)
    expect(existsSync(join(dir, 'sections.json'))).toBe(false)
  })

  it('shows a saved page that still matches, and holds back one that is out of date, with no run in both cases', async () => {
    writeFileSync(join(dir, 'sections.json'), GOOD)
    writeFileSync(join(dir, 'sections-basis.json'), JSON.stringify({ version: SECTIONS_PROMPT_VERSION, issues: [], heads: { 'backend/x!12': head } }))
    await loadSections(sessionOf('R-1')!)
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, problems: [] })
    expect(sectionsStateOf('R-1').document?.sections).toHaveLength(1)
    writeFileSync(join(dir, 'sections-basis.json'), JSON.stringify({ version: SECTIONS_PROMPT_VERSION, issues: [], heads: { 'backend/x!12': '0'.repeat(40) } }))
    await loadSections(sessionOf('R-1')!)
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, document: null, problems: ['backend/x!12 has new commits since the page was written.'] })
    expect(calls()).toHaveLength(0)
  })
})

describe('opening the Summarised view', () => {
  it('writes sections.json and its basis, with opus at medium effort and 80 turns in the context folder', async () => {
    await requestSections('R-1')
    expect(sectionsStateOf('R-1').document?.summary).toBe('A user sees the change.')
    expect(JSON.parse(readFileSync(join(dir, 'sections.json'), 'utf8')).sections[0].id).toBe('s1')
    expect(JSON.parse(readFileSync(join(dir, 'sections-basis.json'), 'utf8'))).toEqual({
      version: SECTIONS_PROMPT_VERSION,
      issues: [],
      heads: { 'backend/x!12': head }
    })
    const c = calls()[0]
    expect([SECTIONS_MODEL, SECTIONS_EFFORT, SECTIONS_MAX_TURNS, SECTIONS_TRIES]).toEqual(['sonnet', 'medium', 80, 3]) // the choice of the owner, named in one place
    expect(arg(c.args, '--model')).toBe('sonnet')
    expect(arg(c.args, '--effort')).toBe('medium')
    expect(arg(c.args, '--max-turns')).toBe('80')
    expect(c.args).toContain('--add-dir')
    expect(c.cwd.replace(/\\/g, '/')).toMatch(/context\/\d{8}-\d{6}-\d{3}$/)
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/^You write the Summarised page/)
  })

  it('withholds the page while a run is pending', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '600'
    await begin()
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: true, document: null })
    await waitDone()
    expect(sectionsStateOf('R-1').document).not.toBeNull()
  })

  it('never starts a second run while one is in progress, also when the view is opened twice at once', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '600'
    void requestSections('R-1')
    void requestSections('R-1')
    void requestSections('R-1')
    await expect.poll(() => sectionsStateOf('R-1').pending, { timeout: 10_000 }).toBe(true)
    await requestSections('R-1') // a request in the middle of the run returns at once
    await waitDone()
    expect(calls()).toHaveLength(1)
  })

  it('goes on when the reader leaves the view, and the page is there when the reader comes back', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '500'
    await begin()
    // Leaving the view tells the main process nothing, so the run ends by itself and saves the page
    await waitDone()
    expect(existsSync(join(dir, 'sections.json'))).toBe(true)
    await requestSections('R-1') // coming back: the saved page is used, and no second run starts
    expect(sectionsStateOf('R-1').document).not.toBeNull()
    expect(calls()).toHaveLength(1)
  })

  it('sends the problems back in the same session with the exact prompt, then accepts the good answer', async () => {
    process.env.FAKE_CLAUDE_BAD_FIRST = '1'
    await requestSections('R-1')
    expect(calls()).toHaveLength(2)
    const [first, second] = calls()
    expect(second.args).toContain('--resume')
    expect(arg(second.args, '--resume')).toBe(arg(first.args, '--session-id'))
    expect(second.args.at(-1)).toBe(
      'The answer has these problems. Fix every one, and answer with the whole JSON document again, nothing else:\n- The answer holds no JSON object.'
    )
    expect(sectionsStateOf('R-1').document).not.toBeNull()
  })

  it('accepts a page with no section, and a page that shows only one change of the review', async () => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({ summary: 'Nothing needs thought.', sections: [] })
    await requestSections('R-1')
    expect(sectionsStateOf('R-1').document).toEqual({ summary: 'Nothing needs thought.', sections: [] })
    expect(calls()).toHaveLength(1) // the checker did not send a problem back for the file that no section shows
  })

  it('fails after three bad answers, writes sections-error.txt, leaves sections.json alone, and a second request tries again', async () => {
    process.env.FAKE_CLAUDE_ANSWER = 'no json here'
    await requestSections('R-1')
    expect(calls()).toHaveLength(3)
    const message = 'The answer still had 1 problem(s) after 3 answers:\nThe answer holds no JSON object.'
    expect(readFileSync(join(dir, 'sections-error.txt'), 'utf8')).toBe(message)
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, error: message, document: null })
    expect(existsSync(join(dir, 'sections.json'))).toBe(false)
    // Try again: the error goes, and a good answer ends it
    process.env.FAKE_CLAUDE_ANSWER = GOOD
    await requestSections('R-1')
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, error: null })
    expect(sectionsStateOf('R-1').document).not.toBeNull()
    expect(existsSync(join(dir, 'sections-error.txt'))).toBe(false)
  })

  it('stops a try that gives no answer in time, and fails with the reason, and a second request can try again', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
    setSectionsTimeoutForTests(500)
    await requestSections('R-1')
    expect(sectionsStateOf('R-1')).toMatchObject({
      pending: false,
      document: null,
      error: 'The AI tool gave no answer in 0.5 seconds, so the run was stopped.'
    })
    expect(calls()).toHaveLength(1) // no second try after a timeout
    expect(readFileSync(join(dir, 'sections-error.txt'), 'utf8')).toMatch(/gave no answer/)
    // the review is free again: the next request starts a new run
    delete process.env.FAKE_CLAUDE_SLEEP_MS
    setSectionsTimeoutForTests()
    await requestSections('R-1')
    expect(sectionsStateOf('R-1').document).not.toBeNull()
  })

  it('keeps the first 9 sections when the tool still writes too many after the last try, and says so in the page', async () => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({
      summary: 'Many points.',
      sections: Array.from({ length: 11 }, (_, i) => ({
        id: 's' + i,
        title: 'Idea ' + (i + 1),
        text: 'It changes line two.',
        snippets: [{ mr: 'backend/x!12', path: 'a.txt', lines: [2, 2] }]
      }))
    })
    await requestSections('R-1')
    expect(calls()).toHaveLength(3) // the problem went back to the tool twice
    expect(calls()[1].args.at(-1)).toContain('The page has 11 sections, and the limit is 9')
    const doc = sectionsStateOf('R-1').document!
    expect(sectionsStateOf('R-1').error).toBeNull()
    expect(doc.sections).toHaveLength(9)
    expect(doc.restText).toContain('The tool wrote 11 points, and the page keeps the first 9.')
    expect(JSON.parse(readFileSync(join(dir, 'sections.json'), 'utf8')).sections).toHaveLength(9)
  })

  it('accepts 9 sections at once', async () => {
    process.env.FAKE_CLAUDE_ANSWER = JSON.stringify({
      summary: 'Many points.',
      sections: Array.from({ length: 9 }, (_, i) => ({
        id: 's' + i,
        title: 'Idea ' + (i + 1),
        text: 'It changes line two.',
        snippets: [{ mr: 'backend/x!12', path: 'a.txt', lines: [2, 2] }]
      }))
    })
    await requestSections('R-1')
    expect(calls()).toHaveLength(1)
    expect(sectionsStateOf('R-1').document?.sections).toHaveLength(9)
  })

  it('writes the install message when the tool is missing', async () => {
    process.env.CODEDIFF_FAKE_CLAUDE = JSON.stringify(['definitely-not-a-real-program-xyz'])
    await requestSections('R-1')
    expect(sectionsStateOf('R-1').error).toMatch(/^'claude' not found — install it first/)
    expect(readFileSync(join(dir, 'sections-error.txt'), 'utf8')).toMatch(/^'claude' not found/)
  })
})

describe('a saved page, when the view is opened', () => {
  const save = (
    page: unknown,
    basis: { version?: number; issues: string[]; heads: Record<string, string> } = {
      version: SECTIONS_PROMPT_VERSION,
      issues: [],
      heads: { 'backend/x!12': head }
    }
  ): void => {
    writeFileSync(join(dir, 'sections.json'), JSON.stringify(page))
    writeFileSync(join(dir, 'sections-basis.json'), JSON.stringify(basis))
  }

  it('is used as it is when it still matches, and no run starts', async () => {
    save(JSON.parse(GOOD))
    await requestSections('R-1')
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: false, problems: [] })
    expect(sectionsStateOf('R-1').document?.sections).toHaveLength(1)
    expect(calls()).toHaveLength(0)
  })

  it('is replaced by a new run when a snippet no longer holds a change, and the old one is not shown', async () => {
    const stale = JSON.parse(GOOD)
    stale.sections[0].snippets[0].lines = [99, 99] // the change is no longer on that line
    save(stale)
    process.env.FAKE_CLAUDE_SLEEP_MS = '500'
    await begin()
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: true, document: null })
    expect(sectionsStateOf('R-1').problems).toEqual(["section 's1': lines 99-99 of a.txt on the new side hold no change. The changed lines on that side are 2"])
    await waitDone()
    expect(sectionsStateOf('R-1').document?.sections[0].snippets[0].lines).toEqual([2, 2])
  })

  it('is replaced when the change got new commits, even when every line still matches', async () => {
    save(JSON.parse(GOOD), { version: SECTIONS_PROMPT_VERSION, issues: [], heads: { 'backend/x!12': '0'.repeat(40) } })
    process.env.FAKE_CLAUDE_SLEEP_MS = '500'
    await begin()
    expect(sectionsStateOf('R-1')).toMatchObject({ pending: true, document: null, problems: ['backend/x!12 has new commits since the page was written.'] })
    await waitDone()
    expect(JSON.parse(readFileSync(join(dir, 'sections-basis.json'), 'utf8')).heads).toEqual({ 'backend/x!12': head })
  })

  it('is replaced when the issues of the review changed', async () => {
    save(JSON.parse(GOOD), { version: SECTIONS_PROMPT_VERSION, issues: ['LX-1'], heads: { 'backend/x!12': head } })
    await requestSections('R-1')
    expect(calls()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'sections-basis.json'), 'utf8')).issues).toEqual([])
  })

  it('is replaced when it was written with an older version of the prompt, so the owner gets the new rules at once', async () => {
    save(JSON.parse(GOOD), { version: SECTIONS_PROMPT_VERSION - 1, issues: [], heads: { 'backend/x!12': head } })
    process.env.FAKE_CLAUDE_SLEEP_MS = '500'
    await begin()
    expect(sectionsStateOf('R-1').problems).toEqual(['The page was written with an older version of the rules, so it is written again.'])
    await waitDone()
    expect(JSON.parse(readFileSync(join(dir, 'sections-basis.json'), 'utf8')).version).toBe(SECTIONS_PROMPT_VERSION)
  })

  it('is replaced when it has no basis, as a page of an older version has none', async () => {
    writeFileSync(join(dir, 'sections.json'), GOOD)
    await requestSections('R-1')
    expect(calls()).toHaveLength(1)
  })
})
