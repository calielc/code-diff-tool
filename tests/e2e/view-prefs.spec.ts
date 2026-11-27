import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeForge } from '../fakes/fake-forge'
import { home, launch, makeEnv, mrFixture, openReview, seedReview, SHORT, type Env } from './naming-helpers'

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

const names = async (page: Page): Promise<string[]> =>
  (await page.locator('table.reviews tbody tr').evaluateAll((rows) => rows.map((r) => r.querySelector('td')?.textContent ?? ''))).map((t) => t.trim())

const savedScopes = (env: Env): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(join(env.ud, 'ui-prefs.json'), 'utf8')).scopes

function seed(): Env {
  const env = makeEnv()
  seedReview(env, 'R-1', { title: 'Alpha' })
  seedReview(env, 'R-2', { title: 'Beta' })
  seedReview(env, 'R-3', { title: 'Gamma' })
  return env
}

/** Starts the app on the env, and starts it again after `act` has run in the first window. */
async function restartAfter(env: Env, act: (page: Page) => Promise<void>): Promise<Page> {
  const fixture = mrFixture('team/backend/x', 12, env.shas.a, env.shas.b)
  const first = await launch(env, fixture)
  await act(await home(first.app))
  await first.app.close()
  await first.forge.close()
  const second = await launch(env, fixture)
  forge = second.forge
  // The window can open on a list tab, which has no Reviews heading, so wait for the tabs.
  const page = await second.app.firstWindow()
  await expect(page.getByTestId('home-tab-reviews')).toBeVisible()
  return page
}

test('the sort of the Reviews tab is kept when the app starts again', async () => {
  // Arrange
  const env = seed()

  // Act
  const page = await restartAfter(env, async (p) => {
    await p.getByRole('button', { name: /^Name/ }).click()
    await p.getByRole('button', { name: /^Name/ }).click()
    await expect(p.getByRole('button', { name: 'Name ▼' })).toBeVisible({ timeout: SHORT })
  })

  // Assert
  await expect(page.getByRole('button', { name: 'Name ▼' })).toBeVisible({ timeout: SHORT })
  expect(await names(page)).toEqual(['Gamma', 'Beta', 'Alpha'])
})

test('the search text of the Reviews tab is kept when the app starts again', async () => {
  // Arrange
  const env = seed()

  // Act
  const page = await restartAfter(env, async (p) => {
    await p.getByLabel('Filter reviews').fill('et')
    await expect(p.getByTestId('review-R-1')).toHaveCount(0, { timeout: SHORT })
  })

  // Assert
  await expect(page.getByLabel('Filter reviews')).toHaveValue('et')
  expect(await names(page)).toEqual(['Beta'])
  expect(savedScopes(env)['home']?.['reviewsSearch']).toBe('et')
})

test('the open tab of the home screen is kept when the app starts again', async () => {
  // Arrange
  const env = seed()

  // Act
  const page = await restartAfter(env, async (p) => {
    await p.getByTestId('home-tab-reviewer').click()
    await expect(p.getByTestId('home-tab-reviewer')).toHaveAttribute('aria-selected', 'true')
  })

  // Assert
  await expect(page.getByTestId('home-tab-reviewer')).toHaveAttribute('aria-selected', 'true', { timeout: SHORT })
  await expect(page.getByTestId('home-tab-reviews')).toHaveAttribute('aria-selected', 'false')
})

test('the settings of a review are kept for that review only, in the settings file', async () => {
  // Arrange
  const env = seed()
  const fixture = mrFixture('team/backend/x', 12, env.shas.a, env.shas.b)
  const first = await launch(env, fixture)
  forge = first.forge
  const page = await home(first.app)
  await openReview(page, 'R-1')

  // Act: open the Issues tab of R-1, then go back to the home screen and open R-2
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('tab-issues')).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await openReview(await home(first.app), 'R-2')

  // Assert: R-2 opens on Code changes, and the file holds the tab of R-1 only
  await expect(page.getByTestId('tab-mrs')).toHaveAttribute('aria-selected', 'true', { timeout: SHORT })
  expect(savedScopes(env)['review:R-1']?.['tab']).toBe('issues')
  expect(savedScopes(env)['review:R-2']?.['tab']).toBeUndefined()
  await first.app.close()
})

test('a saved setting that the app does not know is ignored, and the defaults show', async () => {
  // Arrange
  const env = seed()
  const fixture = mrFixture('team/backend/x', 12, env.shas.a, env.shas.b)
  writeFileSync(
    join(env.ud, 'ui-prefs.json'),
    JSON.stringify({
      schemaVersion: 1,
      scopes: { home: { reviewsSort: { key: 'branch', dir: 'up' }, tab: 'nowhere', reviewsSummarised: 'yes' }, 'review:R-1': 7 }
    })
  )

  // Act
  const started = await launch(env, fixture)
  forge = started.forge
  const page = await home(started.app)

  // Assert: the Reviews tab with the default sort, which is Last opened, newest first
  await expect(page.getByTestId('home-tab-reviews')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Last opened ▼' })).toBeVisible({ timeout: SHORT })
  expect(await names(page)).toHaveLength(3)
  await started.app.close()
})
