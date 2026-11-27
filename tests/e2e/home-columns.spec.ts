import { expect, test } from '@playwright/test'
import { home, launch, makeEnv, mrFixture, seedReview, SHORT } from './naming-helpers'
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
  expect(headers).toEqual(['Name', 'Change requests', 'Issues', 'Last opened', 'Summarised', ''])
  const first = page.getByTestId('review-R-1')
  await expect(first.locator('td').first()).toHaveText('Old name', { timeout: SHORT })
  await expect(first).not.toContainText('R-1')

  await page.getByLabel('Filter reviews').fill('second')
  await expect(page.getByTestId('review-R-2')).toBeVisible({ timeout: SHORT })
  await expect(page.getByTestId('review-R-1')).toHaveCount(0)
  await started.app.close()
})

test('the filter box sits in the same row as the Summarised pills, at the left, and the pills at the right', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1')
  seedReview(env, 'R-2', { title: 'Second review' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)

  // Act
  const input = await page.getByLabel('Filter reviews').boundingBox()
  const pills = await page.getByRole('group', { name: 'Show reviews by summarised state' }).boundingBox()

  // Assert: the same row (the middles are close), with the box to the left of the pills, and the page has no heading with the name of the tab
  expect(input).not.toBeNull()
  expect(pills).not.toBeNull()
  expect(Math.abs(input!.y + input!.height / 2 - (pills!.y + pills!.height / 2))).toBeLessThan(8)
  expect(input!.x + input!.width).toBeLessThanOrEqual(pills!.x)
  const table = await page.locator('table.reviews').boundingBox()
  expect(Math.abs(input!.x - table!.x)).toBeLessThan(4)
  await expect(page.getByRole('heading', { name: 'Reviews' })).toHaveCount(0)

  // The count of the reviews shows once, in the footer of the grid, and not under the heading
  await expect(page.getByTestId('showing')).toHaveText('Showing 2 of 2 reviews')
  await expect(page.getByText(/^\d+ reviews?$/)).toHaveCount(0)
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

test('the summarised filter is a group of toggle pills at the top right of the grid, like the pills of the MR list', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1', { title: 'Ready one' }, { 'sections.json': '{}' })
  seedReview(env, 'R-2', { title: 'Failed one' }, { 'sections-error.txt': 'boom' })
  seedReview(env, 'R-3', { title: 'Plain one' })
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)
  const group = page.getByRole('group', { name: 'Show reviews by summarised state' })

  // Assert: no dropdown any more, four pills, all on, each with its count
  await expect(group).toBeVisible({ timeout: SHORT })
  await expect(page.getByLabel('Summarised state', { exact: true })).toHaveCount(0)
  await expect(group).toHaveClass(/seg/)
  await expect(group.getByRole('button')).toHaveCount(4)
  for (const name of ['Writing', 'Failed', 'Ready', 'Not written']) {
    await expect(group.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(group.getByRole('button', { name: /^Ready/ })).toContainText('1')
  await expect(group.getByRole('button', { name: /^Failed/ })).toContainText('1')
  await expect(group.getByRole('button', { name: /^Not written/ })).toContainText('1')
  await expect(group.getByRole('button', { name: /^Writing/ })).toContainText('0')

  // Assert: the pills sit above the grid, at its right edge
  const table = await page.locator('table.reviews').boundingBox()
  const pills = await group.boundingBox()
  expect(pills!.y + pills!.height).toBeLessThanOrEqual(table!.y)
  expect(Math.abs(pills!.x + pills!.width - (table!.x + table!.width))).toBeLessThanOrEqual(12)

  // Act and assert: a pill that is turned off hides its reviews and a second click shows them again
  await group.getByRole('button', { name: /^Failed/ }).click()
  await expect(group.getByRole('button', { name: /^Failed/ })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('review-R-2')).toHaveCount(0)
  await expect(page.getByTestId('review-R-1')).toBeVisible()
  await expect(page.getByTestId('review-R-3')).toBeVisible()
  await expect(page.getByTestId('showing')).toContainText('Showing 2 of 3')
  await group.getByRole('button', { name: /^Failed/ }).click()
  await expect(page.getByTestId('review-R-2')).toBeVisible()
  await started.app.close()
})
