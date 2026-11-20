import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PrereqRow, RowState, ToolStatus } from '@shared/types'
import { getLlmConfig, llmState, loginCommand, missingMessage } from '../processes/llm'
import { run, timeoutMessage, type RunResult } from '../processes/run'
import { TOOL_NAMES } from '@shared/llm'
import { listAccess } from './credentials'
import { findRepoDirs, isDirectory, scanClones, type Clone } from './workspace'

const CHECK_TIMEOUT_MS = 30_000
const win = (): boolean => process.platform === 'win32'

/** "git version 2.39.5 (Apple Git-154)" -> 2.39. Only the first numbers count (file 05 section 1.1). */
export function parseVersion(text: string): { major: number; minor: number; text: string } | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), text: m[3] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}` }
}

export function atLeast(v: { major: number; minor: number }, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor)
}

const R = 'press "Check again"'

const INSTALL = {
  git: {
    cmd: (): string => (win() ? 'winget install -e --id Git.Git' : 'xcode-select --install (or `brew install git`)'),
    fix: (): string => (win() ? 'winget install -e --id Git.Git' : 'xcode-select --install')
  },
  claude: {
    cmd: (): string =>
      win()
        ? 'irm https://claude.ai/install.ps1 | iex, or `winget install Anthropic.ClaudeCode`'
        : 'curl -fsSL https://claude.ai/install.sh | bash, or `brew install --cask claude-code`',
    fix: (): string => (win() ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash')
  }
} as const

type Tool = keyof typeof INSTALL

const missing = (tool: Tool): { detail: string; fixCommand: string } => ({
  detail: `'${tool}' not found — install it first (${INSTALL[tool].cmd()}), then ${R}.`,
  fixCommand: INSTALL[tool].fix()
})

function row(p: Partial<PrereqRow> & Pick<PrereqRow, 'id' | 'name' | 'required' | 'state'>): PrereqRow {
  return { version: null, detail: '', note: null, fixCommand: null, ...p }
}

const firstLine = (r: RunResult): string =>
  (r.stderr || r.stdout)
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() || 'The check failed.'

type Base = Pick<PrereqRow, 'id' | 'name' | 'required' | 'forge' | 'access' | 'ai'>

/** Run `<tool> <versionArgs>`. Returns a finished row when the tool is missing or fails, otherwise its output. */
async function probe(base: Base, tool: Tool, versionArgs: string[]): Promise<{ row: PrereqRow } | { stdout: string }> {
  const r = await run(tool, versionArgs, { timeoutMs: CHECK_TIMEOUT_MS })
  if (r.timedOut) {
    return { row: row({ ...base, state: 'missing', detail: timeoutMessage(`${tool} ${versionArgs.join(' ')}`, CHECK_TIMEOUT_MS) }) }
  }
  if (r.launchError) return { row: row({ ...base, state: 'missing', ...missing(tool) }) }
  if (r.code !== 0) return { row: row({ ...base, state: 'missing', detail: firstLine(r) }) }
  return { stdout: r.stdout }
}

async function checkGit(cwd: string | null): Promise<PrereqRow> {
  const base: Base = { id: 'git', name: 'Git', required: true }
  const p = await probe(base, 'git', ['--version'])
  if ('row' in p) return p.row
  const v = parseVersion(p.stdout)
  if (!v) return row({ ...base, state: 'missing', detail: 'The check failed.' })
  if (!atLeast(v, 2, 40)) {
    return row({
      ...base,
      state: 'too-old',
      version: v.text,
      detail: `git 2.40 or later is required, and this machine has ${v.text}. Update git, then ${R}.`
    })
  }
  if (cwd) {
    const id = await run('git', ['config', 'user.name'], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
    if (id.code !== 0 || !id.stdout.trim()) {
      return row({
        ...base,
        state: 'not-set-up',
        version: `git ${v.text}`,
        detail: `git's user.name isn't configured — run \`git config --global user.name "Your Name"\` (and user.email) first.`,
        fixCommand: 'git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'
      })
    }
  }
  return row({ ...base, state: 'ready', version: `git ${v.text}`, detail: `git ${v.text}` })
}

/**
 * GitLab, GitHub and Jira are reached over their web APIs with a personal access token. A row is ready when at
 * least one host has a saved token. The token itself is checked when it is saved, not at every start.
 */
function accessRow(kind: 'gitlab' | 'github' | 'jira'): PrereqRow {
  const about = {
    gitlab: { name: 'GitLab', what: 'a GitLab host and a personal access token with the `api` scope', defaultHost: 'gitlab.com' },
    github: { name: 'GitHub', what: 'a personal access token with the `repo` scope', defaultHost: 'github.com' },
    jira: { name: 'Jira', what: 'your Jira site, your account email and an API token', defaultHost: '' }
  }[kind]
  const hosts = listAccess().filter((a) => a.kind === kind)
  const base: Base = {
    id: kind,
    name: about.name,
    required: false,
    forge: kind !== 'jira',
    access: { kind, defaultHost: about.defaultHost, hosts: hosts.map((h) => ({ host: h.host, email: h.email ?? null })) }
  }
  if (hosts.length === 0) {
    return row({ ...base, state: 'not-set-up', detail: `No ${about.name} access is set up. Add ${about.what}.` })
  }
  return row({ ...base, state: 'ready', detail: `Access to ${hosts.map((h) => h.host).join(', ')}` })
}

/** The AI tool in use: Claude Code, Codex or a command the user set. It is optional, and the AI features are off without it. */
async function checkAi(): Promise<PrereqRow> {
  const cfg = getLlmConfig()
  const label = cfg.tool === 'custom' ? cfg.custom?.name || 'The AI tool' : TOOL_NAMES[cfg.tool]
  const base: Base = { id: 'ai', name: 'AI tool', required: false, ai: { tool: cfg.tool, custom: cfg.custom ?? null } }
  const state = await llmState()
  if (state === 'missing') {
    const fix = cfg.tool === 'claude' ? INSTALL.claude.fix() : cfg.tool === 'codex' ? 'npm install -g @openai/codex' : null
    return row({ ...base, state: 'missing', detail: missingMessage().replace('then reopen the review.', `then ${R}.`), fixCommand: fix })
  }
  if (state === 'nologin') {
    return row({
      ...base,
      state: 'needs-login',
      detail: `${label} is installed, but it has no login. Run \`${loginCommand()}\` once in a terminal and log in, then ${R}.`,
      fixCommand: loginCommand()
    })
  }
  let version = label
  if (cfg.tool !== 'custom') {
    const v = await run(cfg.tool, ['--version'], { timeoutMs: CHECK_TIMEOUT_MS })
    const parsed = parseVersion(v.stdout)
    if (parsed) version = `${cfg.tool} ${parsed.text}`
  }
  return row({ ...base, state: 'ready', version, detail: version })
}

async function checkRoot(root: string | undefined, fresh: boolean): Promise<{ row: PrereqRow; clones: Clone[] }> {
  const base: Base = { id: 'root', name: 'Workspace root', required: true }
  const choose = 'Choose the folder that holds your repo clones.'
  if (!root) {
    return { row: row({ ...base, state: 'not-set-up', detail: `No workspace root is set. ${choose}` }), clones: [] }
  }
  if (!(await isDirectory(root))) {
    return { row: row({ ...base, state: 'missing', detail: `The workspace root ${root} was not found. ${choose}` }), clones: [] }
  }
  const clones = await scanClones(root, fresh)
  if (clones.length === 0) {
    return {
      row: row({ ...base, state: 'not-set-up', detail: `No git repositories with an origin remote were found in ${root}. ${choose}` }),
      clones
    }
  }
  return {
    row: row({ ...base, state: 'ready', version: root, detail: root, note: `Found ${clones.length} ${clones.length === 1 ? 'repo' : 'repos'}.` }),
    clones
  }
}

/** Run every check at the same time (file 07 section 3.5). */
export async function checkTools(root: string | undefined, fresh = true): Promise<ToolStatus> {
  const rootCheck = await checkRoot(root, fresh)
  const cwd = rootCheck.clones[0]?.dir ?? null // the git identity is checked in the first clone
  const [git, ai] = await Promise.all([checkGit(cwd), checkAi()])
  const rows = [git, accessRow('gitlab'), accessRow('github'), accessRow('jira'), ai, rootCheck.row]
  const ok = (s: RowState): boolean => s === 'ready'
  return {
    rows,
    workspaceRoot: root ?? null,
    // git and the root are required. Of GitLab and GitHub, at least one must have a token.
    ready: rows.filter((r) => r.required).every((r) => ok(r.state)) && rows.some((r) => r.forge && ok(r.state))
  }
}

/** First common code folder in the home folder that holds a git repo, offered at first run. */
export async function findRootCandidate(): Promise<string | null> {
  const home = homedir()
  for (const c of [join(home, 'code'), join(home, 'Projects', 'code'), join(home, 'Projects'), join(home, 'dev'), join(home, 'src'), join(home, 'repos')]) {
    if ((await isDirectory(c)) && (await findRepoDirs(c)).length > 0) return c
  }
  return null
}
