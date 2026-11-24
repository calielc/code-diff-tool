import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')

/** How long a check on a new element waits. The element does not exist yet in the old UI, so a miss must fail fast. */
export const SHORT = 3000

export interface Env {
  root: string
  ud: string
  shas: { a: string; b: string }
}

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** A workspace with one real clone (two commits, origin on gitlab.com) and an app data folder that skips the first run. */
export function makeEnv(): Env {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e-name-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'x')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:team/backend/x.git')
  writeFileSync(join(dir, 'f.txt'), '1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'one')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'f.txt'), '2\n')
  git(dir, 'commit', '-qam', 'two')
  const b = git(dir, 'rev-parse', 'HEAD')
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  return { root, ud, shas: { a, b } }
}

/** The fake forge answers for one opened change of the clone above. */
export function mrFixture(project: string, iid: number, base: string, head: string): Record<string, unknown> {
  const k = `projects/${encodeURIComponent(project)}/merge_requests/${iid}`
  return {
    'GET user': { json: { username: 'me' } },
    [`GET ${k}`]: {
      json: {
        web_url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
        state: 'opened',
        title: `Title ${iid}`,
        author: { username: 'ann' },
        source_branch: 'feat',
        target_branch: 'main',
        diff_refs: { base_sha: base, start_sha: base, head_sha: head }
      }
    },
    [`GET ${k}/approvals`]: { json: { approved_by: [], user_can_approve: true, user_has_approved: false } },
    [`GET ${k}/discussions`]: { json: [] },
    [`GET ${k}/reviewers`]: { json: [] }
  }
}

export async function launch(env: Env, fixture: Record<string, unknown>): Promise<{ app: ElectronApplication; forge: FakeForge }> {
  const forge = await startFakeForge(fixture as Record<string, any>)
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: env.ud, ...forgeEnv(forge.url) } as Record<string, string> })
  return { app, forge }
}

export async function home(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  return page
}

export const reviewsPath = (env: Env): string => join(env.root, '.code-diff', 'reviews')
export const reviewFile = (env: Env, slug: string): string => join(reviewsPath(env), slug, 'review.json')
export const readReview = (env: Env, slug: string): Record<string, unknown> => JSON.parse(readFileSync(reviewFile(env, slug), 'utf8'))
export const reviewFolders = (env: Env): string[] => {
  try {
    return readdirSync(reviewsPath(env)).sort()
  } catch {
    return []
  }
}

/** A review on disk that points at the change of the clone. */
export function seedReview(env: Env, slug: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}): void {
  const dir = join(reviewsPath(env), slug)
  mkdirSync(dir, { recursive: true })
  const content = {
    title: 'Old name',
    mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid: 12 }],
    skipped: [],
    issues: [],
    ...extra
  }
  writeFileSync(join(dir, 'review.json'), JSON.stringify(content))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

/** Open a seeded review from Home and wait for its screen. */
export async function openReview(page: Page, slug: string): Promise<void> {
  await page.getByTestId(`review-${slug}`).dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
}
