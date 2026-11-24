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
  expect(headers).toEqual(['Name', 'Changes', 'Issues', 'Last opened', 'Summarised', ''])
  const first = page.getByTestId('review-R-1')
  await expect(first.locator('td').first()).toHaveText('Old name', { timeout: SHORT })
  await expect(first).not.toContainText('R-1')

  await page.getByLabel('Filter reviews').fill('second')
  await expect(page.getByTestId('review-R-2')).toBeVisible({ timeout: SHORT })
  await expect(page.getByTestId('review-R-1')).toHaveCount(0)
  await started.app.close()
})
