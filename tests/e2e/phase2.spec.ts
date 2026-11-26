import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

// The fake GitLab, GitHub and Jira of the current test. It is closed after each test.
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

const SHA = (c: string): string => c.repeat(40)

const gitlabFixture = {
  'GET user': { json: { username: 'me' } },
  'GET projects/g%2Fr/merge_requests/7': {
    json: {
      web_url: 'https://gitlab.com/g/r/-/merge_requests/7',
      state: 'opened',
      title: 'Add the thing',
      description: 'body',
      draft: false,
      author: { username: 'ann', name: 'Ann', avatar_url: null },
      source_branch: 'feat',
      target_branch: 'main',
      created_at: '2026-11-01T10:00:00Z',
      updated_at: '2026-11-02T10:00:00Z',
      diff_refs: { base_sha: SHA('a'), start_sha: SHA('b'), head_sha: SHA('c') },
      head_pipeline: { id: 55, project_id: 9, status: 'success', web_url: 'https://gitlab.com/p/55' },
      user_notes_count: 2
    }
  },
  'GET projects/g%2Fr/merge_requests/7/approvals': {
    json: { approved_by: [{ user: { username: 'bob', name: 'Bob' } }], user_can_approve: true, user_has_approved: false }
  },
  'GET projects/g%2Fr/merge_requests/7/discussions': {
    json: [
      {
        id: SHA('d'),
        notes: [{ id: 11, body: 'nit', resolvable: true, resolved: false, author: { username: 'bob' }, position: { new_path: 'a.ts', new_line: 4 } }]
      },
      { id: SHA('e'), notes: [{ id: 12, system: true, body: 'added 1 commit' }] }
    ]
  },
  'GET projects/g%2Fr/merge_requests/7/reviewers': { json: [{ user: { username: 'me' }, state: 'reviewed' }] },
  'GET projects/9/pipelines/55/jobs': { json: [{ id: 2, name: 'build', stage: 'build', status: 'success', web_url: 'j' }] },
  'GET projects/9/pipelines/55/bridges': { json: [] }
}

const githubFixture = {
  'GET user': { json: { login: 'me' } },
  'GET repos/o/r/pulls/3': {
    json: {
      html_url: 'https://github.com/o/r/pull/3',
      state: 'open',
      title: 'Fix the bug',
      body: 'why',
      draft: true,
      user: { login: 'ann' },
      head: { ref: 'fix', sha: SHA('c') },
      base: { ref: 'main', sha: SHA('a') },
      created_at: '2026-11-01T10:00:00Z',
      updated_at: '2026-11-02T10:00:00Z'
    }
  },
  'GET repos/o/r/pulls/3/reviews': { json: [{ user: { login: 'bob' }, state: 'APPROVED', submitted_at: '1' }] },
  'POST graphql': {
    json: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'PRRT_abcdef123',
                  isResolved: false,
                  path: 'a.ts',
                  line: 4,
                  diffSide: 'RIGHT',
                  comments: { nodes: [{ databaseId: 1, body: 'nit', createdAt: 't', url: 'https://github.com/o/r/pull/3#r1', author: { login: 'bob' } }] }
                }
              ]
            }
          }
        }
      }
    }
  },
  [`GET repos/o/r/commits/${SHA('c')}/check-runs`]: { json: { check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: 'h' }] } }
}

async function launch(fixture: Record<string, any>): Promise<ElectronApplication> {
  const dir = mkdtempSync(join(tmpdir(), 'codediff-e2e-'))
  forge = await startFakeForge(fixture)
  return electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: join(dir, 'ud'), ...forgeEnv(forge.url) } as Record<string, string> })
}

async function openDev(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  // Wait until the app has mounted and subscribed to the menu event.
  await expect(page.getByTestId('row-git').or(page.getByText('Reviews'))).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:openDev'))
  await expect(page.getByRole('heading', { name: 'Developer: read a change' })).toBeVisible()
  return page
}

test('reads a GitLab MR: details, threads, approvals, jobs', async () => {
  const app = await launch(gitlabFixture)
  const page = await openDev(app)
  await page.getByTestId('dev-url').fill('https://gitlab.com/g/r/-/merge_requests/7')
  await page.getByTestId('dev-read').click()
  await expect(page.getByTestId('dev-title')).toContainText('Add the thing')
  const raw = JSON.parse((await page.getByTestId('dev-raw').textContent()) ?? '{}')
  expect(raw.threads).toHaveLength(1) // the system note thread is dropped
  expect(raw.approvals.approvedBy).toEqual(['bob'])
  expect(raw.viewerState).toBe('reviewed')
  expect(raw.jobs).toHaveLength(1)
  expect(raw.info.diffRefs.head).toBe(SHA('c'))
  await app.close()
})

test('reads a GitHub PR the same way', async () => {
  const app = await launch(githubFixture)
  const page = await openDev(app)
  await page.getByTestId('dev-url').fill('https://github.com/o/r/pull/3')
  await page.getByTestId('dev-read').click()
  await expect(page.getByTestId('dev-title')).toContainText('Fix the bug')
  const raw = JSON.parse((await page.getByTestId('dev-raw').textContent()) ?? '{}')
  expect(raw.info.draft).toBe(true)
  expect(raw.info.ref.provider).toBe('github')
  expect(raw.threads[0]).toMatchObject({ id: 'PRRT_abcdef123', resolved: false })
  expect(raw.approvals.approvedBy).toEqual(['bob'])
  expect(raw.info.pipeline.status).toBe('success')
  await app.close()
})

test('a failed call shows its error text and a bad URL is refused', async () => {
  // the other reads answer slowly, so the 401 of the user call is the first error
  const slow = { sleepMs: 800, json: {} }
  const mrBase = 'projects/g%2Fr/merge_requests/7'
  const app = await launch({
    'GET user': { fail: 'HTTP 401 Unauthorized' },
    [`GET ${mrBase}`]: slow,
    [`GET ${mrBase}/approvals`]: slow,
    [`GET ${mrBase}/discussions`]: slow,
    [`GET ${mrBase}/reviewers`]: slow
  })
  const page = await openDev(app)
  await page.getByTestId('dev-url').fill('https://example.com/nope')
  await page.getByTestId('dev-read').click()
  await expect(page.getByTestId('dev-error')).toHaveText('This is not a change request URL.')
  await page.getByTestId('dev-url').fill('https://gitlab.com/g/r/-/merge_requests/7')
  await page.getByTestId('dev-read').click()
  await expect(page.getByTestId('dev-error')).toContainText('HTTP 401 Unauthorized')
  await app.close()
})
