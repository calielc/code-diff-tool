import { expect, test, type Locator } from '@playwright/test'
import { home, launch, makeEnv, mrFixture, seedReview, SHORT, type Env } from './naming-helpers'
import type { FakeForge } from '../fakes/fake-forge'

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

test('the list of reviews has a Name column and no Slug column, and the filter works on the name', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1')
  seedReview(env, 'R-2', { title: 'Second review' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)

  // Act
  const headers = (await page.locator('table.reviews thead th').allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())

  // Assert
  expect(headers).toEqual(['Name', 'Issues', 'Last opened', 'Approved', 'Comments', 'Pipelines', ''])
  const first = page.getByTestId('review-R-1')
  await expect(first.locator('td').first()).toHaveText('Old name', { timeout: SHORT })
  await expect(first).not.toContainText('R-1')

  await page.getByLabel('Filter reviews').fill('second')
  await expect(page.getByTestId('review-R-2')).toBeVisible({ timeout: SHORT })
  await expect(page.getByTestId('review-R-1')).toHaveCount(0)
  await started.app.close()
})

test('the filter box sits at the left above the grid, and the page has no heading and no count under it', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1')
  seedReview(env, 'R-2', { title: 'Second review' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)

  // Act
  const input = await page.getByLabel('Filter reviews').boundingBox()
  const table = await page.locator('table.reviews').boundingBox()

  // Assert: the box is above the grid, at its left edge
  expect(input).not.toBeNull()
  expect(input!.y + input!.height).toBeLessThanOrEqual(table!.y)
  expect(Math.abs(input!.x - table!.x)).toBeLessThan(4)
  await expect(page.getByRole('heading', { name: 'Reviews' })).toHaveCount(0)

  // The count of the reviews shows once, in the footer of the grid, and not under the heading
  await expect(page.getByTestId('showing')).toHaveText('Showing 2 of 2 reviews')
  await expect(page.getByText(/^\d+ reviews?$/)).toHaveCount(0)
  await started.app.close()
})

test('the name of a review has no tooltip', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1', { title: 'A review with a long name' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)

  // Act and assert
  await expect(page.getByTestId('review-R-1').locator('td').first()).toHaveText('A review with a long name', { timeout: SHORT })
  await expect(page.getByTestId('review-R-1').locator('td').first()).not.toHaveAttribute('title', /.+/)
  await started.app.close()
})

test('the Open and Delete buttons of every review are visible and clickable without a hover', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1')
  seedReview(env, 'R-2', { title: 'Second review' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)

  // Act
  const second = page.getByTestId('review-R-2')

  // Assert: no hover and no selection of that row
  await expect(second.getByRole('button', { name: 'Open' })).toBeVisible({ timeout: SHORT })
  await expect(second.getByRole('button', { name: 'Delete review R-2' })).toBeVisible()
  await second.getByRole('button', { name: 'Delete review R-2' }).click()
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: SHORT })
  await started.app.close()
})

/** One open thread, as GitLab answers the discussions of a change. */
const openThread = [
  {
    id: 'a'.repeat(40),
    notes: [
      { id: 1, body: 'Why?', resolvable: true, resolved: false, author: { username: 'bob', name: 'Bob' }, created_at: '2026-01-03T10:00:00Z', position: null }
    ]
  }
]

/** A change with the given approvals, discussions and pipeline status. Its pipeline has no jobs. */
function change(env: Env, iid: number, over: { approvedBy?: string[]; discussions?: unknown[]; pipeline?: string; state?: string }): Record<string, unknown> {
  const base = mrFixture('team/backend/x', iid, env.shas.a, env.shas.b)
  const k = `projects/${encodeURIComponent('team/backend/x')}/merge_requests/${iid}`
  const info = (base[`GET ${k}`] as { json: Record<string, unknown> }).json
  return {
    ...base,
    [`GET ${k}`]: {
      json: {
        ...info,
        state: over.state ?? 'opened',
        head_pipeline: over.pipeline ? { id: iid, project_id: 1, status: over.pipeline, web_url: 'https://gitlab.com/p' } : null
      }
    },
    [`GET ${k}/approvals`]: {
      json: { approved_by: (over.approvedBy ?? []).map((username) => ({ user: { username } })), user_can_approve: true, user_has_approved: false }
    },
    [`GET ${k}/discussions`]: { json: over.discussions ?? [] },
    [`GET projects/1/pipelines/${iid}/jobs`]: { json: [] },
    [`GET projects/1/pipelines/${iid}/bridges`]: { json: [] }
  }
}

const mr = (iid: number): Record<string, unknown> => ({ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/x', iid })

test('a review row shows how many changes are approved, the open comments and the pipelines, summed over its changes', async () => {
  // Arrange: R-1 has a failing change with an open comment, R-2 has one green change, R-3 has a change that cannot be read
  const env = makeEnv()
  seedReview(env, 'R-1', { title: 'Failing one', mrs: [mr(12), mr(13)] })
  seedReview(env, 'R-2', { title: 'Green one', mrs: [mr(14)] })
  seedReview(env, 'R-3', { title: 'Unreadable one', mrs: [mr(99)] })
  const fixture = {
    ...change(env, 12, { approvedBy: ['ann'], discussions: openThread, pipeline: 'failed' }),
    ...change(env, 13, { pipeline: 'success' }),
    ...change(env, 14, { approvedBy: ['ann', 'cy'], pipeline: 'success' })
  }
  const started = await launch(env, fixture)
  forge = started.forge
  const page = await home(started.app)
  const cell = (slug: string, which: 'approved' | 'comments' | 'pipeline'): Locator => page.getByTestId(`review-${slug}`).getByTestId(`status-${which}`)

  // Assert: R-1 has 1 of 2 approved, 1 open comment and 1 failing pipeline
  await expect(cell('R-1', 'approved')).toHaveText('1 of 2', { timeout: 10_000 })
  await expect(cell('R-1', 'comments')).toHaveText('1 open')
  await expect(cell('R-1', 'pipeline')).toHaveText('1 failing')

  // Assert: R-2 is approved, has no open comment and all its pipelines are green
  await expect(cell('R-2', 'approved')).toHaveText('1 of 1')
  await expect(cell('R-2', 'comments')).toHaveText('none open')
  await expect(cell('R-2', 'pipeline')).toHaveText('all green')

  // Assert: a review whose changes cannot be read shows dashes
  await expect(page.getByTestId('review-R-3').locator('td').nth(3)).toHaveText('–')
  await started.app.close()
})

test('the Approved, Comments and Pipelines headers sort the reviews, and the Summarised column and pills are gone', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1', { title: 'Failing one', mrs: [mr(12)] })
  seedReview(env, 'R-2', { title: 'Green one', mrs: [mr(14)] })
  const fixture = { ...change(env, 12, { discussions: openThread, pipeline: 'failed' }), ...change(env, 14, { approvedBy: ['ann'], pipeline: 'success' }) }
  const started = await launch(env, fixture)
  forge = started.forge
  const page = await home(started.app)
  await expect(page.getByTestId('review-R-2').getByTestId('status-pipeline')).toHaveText('all green', { timeout: 10_000 })
  await expect(page.getByTestId('review-R-1').getByTestId('status-pipeline')).toHaveText('1 failing')
  const names = async (): Promise<string[]> => (await page.locator('table.reviews tbody tr td:first-child').allTextContents()).map((t) => t.trim())

  // Act and assert: ascending puts the review with the worst pipeline first, and descending the best first
  await page.getByRole('button', { name: /^Pipelines/ }).click()
  expect(await names()).toEqual(['Failing one', 'Green one'])
  await page.getByRole('button', { name: /^Pipelines/ }).click()
  expect(await names()).toEqual(['Green one', 'Failing one'])

  // Act and assert: the most open comments come last when ascending
  await page.getByRole('button', { name: /^Comments/ }).click()
  expect(await names()).toEqual(['Green one', 'Failing one'])

  // Act and assert: the review with the most approved changes comes last when ascending
  await page.getByRole('button', { name: /^Approved/ }).click()
  expect(await names()).toEqual(['Failing one', 'Green one'])

  // The old status is gone
  await expect(page.getByRole('button', { name: /^Summarised/ })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Show reviews by summarised state' })).toHaveCount(0)
  await started.app.close()
})
