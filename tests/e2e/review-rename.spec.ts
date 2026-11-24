import { expect, test, type Page } from '@playwright/test'
import { home, launch, makeEnv, mrFixture, openReview, readReview, seedReview, SHORT, type Env } from './naming-helpers'
import type { FakeForge } from '../fakes/fake-forge'

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

/** An app with one review R-1, called "Old name", opened on its screen. */
async function open(): Promise<{ env: Env; page: Page; close: () => Promise<void> }> {
  const env = makeEnv()
  seedReview(env, 'R-1')
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)
  await openReview(page, 'R-1')
  return { env, page, close: () => started.app.close() }
}

const nameInput = (page: Page): ReturnType<Page['getByTestId']> => page.getByTestId('review-name-input')

/** Click the name and wait for the input. */
async function edit(page: Page): Promise<void> {
  await page.getByTestId('review-name').click({ timeout: SHORT })
  await expect(nameInput(page)).toBeVisible({ timeout: SHORT })
}

test('a click on the name opens an input that has focus and all the text selected', async () => {
  const { page, close } = await open()
  const name = page.getByTestId('review-name')
  await expect(name).toHaveText('Old name', { timeout: SHORT })
  await expect(name).toHaveAttribute('title', 'Click to rename')
  await edit(page)
  await expect(nameInput(page)).toBeFocused()
  await expect(nameInput(page)).toHaveAttribute('aria-label', 'Review name')
  await expect(nameInput(page)).toHaveValue('Old name')
  const selection = await nameInput(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])
  expect(selection).toEqual([0, 'Old name'.length])
  await close()
})

test('Enter saves: the header, review.json and the Home list show the new name, and a tab change keeps it', async () => {
  const { env, page, close } = await open()
  await edit(page)
  await nameInput(page).fill('Login fix')
  await nameInput(page).press('Enter')
  await expect(page.getByTestId('review-name')).toHaveText('Login fix')
  await expect(nameInput(page)).toHaveCount(0)
  await expect.poll(() => readReview(env, 'R-1').title).toBe('Login fix')
  await page.getByTestId('tab-issues').click()
  await expect(page.getByTestId('review-name')).toHaveText('Login fix')
  await page.getByRole('button', { name: '← Reviews' }).click()
  await expect(page.getByTestId('review-R-1')).toContainText('Login fix')
  await expect(page.getByTestId('review-R-1')).not.toContainText('Old name')
  await close()
})

test('the other fields of review.json stay as they were', async () => {
  const { env, page, close } = await open()
  const before = readReview(env, 'R-1')
  await edit(page)
  await nameInput(page).fill('Another')
  await nameInput(page).press('Enter')
  await expect.poll(() => readReview(env, 'R-1').title).toBe('Another')
  expect(readReview(env, 'R-1')).toEqual({ ...before, title: 'Another' })
  await close()
})

test('Escape cancels and keeps the old name', async () => {
  const { env, page, close } = await open()
  await edit(page)
  await nameInput(page).fill('Not this')
  await nameInput(page).press('Escape')
  await expect(nameInput(page)).toHaveCount(0)
  await expect(page.getByTestId('review-name')).toHaveText('Old name')
  expect(readReview(env, 'R-1').title).toBe('Old name')
  await close()
})

test('a blur saves', async () => {
  const { env, page, close } = await open()
  await edit(page)
  await nameInput(page).fill('Saved by blur')
  await page.getByTestId('subtitle').click()
  await expect(page.getByTestId('review-name')).toHaveText('Saved by blur')
  await expect.poll(() => readReview(env, 'R-1').title).toBe('Saved by blur')
  await close()
})

test('an empty value shows Enter a name. and Escape restores the old name', async () => {
  const { env, page, close } = await open()
  await edit(page)
  await nameInput(page).fill('   ')
  await nameInput(page).press('Enter')
  await expect(page.getByTestId('review-name-error')).toHaveText('Enter a name.', { timeout: SHORT })
  await expect(page.getByTestId('review-name-error')).toHaveAttribute('role', 'alert')
  await expect(nameInput(page)).toBeVisible()
  expect(readReview(env, 'R-1').title).toBe('Old name')
  await nameInput(page).press('Escape')
  await expect(nameInput(page)).toHaveCount(0)
  await expect(page.getByTestId('review-name')).toHaveText('Old name')
  expect(readReview(env, 'R-1').title).toBe('Old name')
  await close()
})

test('a value longer than 200 characters is cut to 200', async () => {
  const { env, page, close } = await open()
  await edit(page)
  await nameInput(page).fill('w'.repeat(250))
  await nameInput(page).press('Enter')
  await expect.poll(() => (readReview(env, 'R-1').title as string).length).toBe(200)
  await close()
})

test('the name takes focus with Tab, and Enter starts the edit', async () => {
  const { page, close } = await open()
  const name = page.getByTestId('review-name')
  await expect(name).toBeVisible({ timeout: SHORT })
  await page.getByRole('button', { name: '← Reviews' }).focus() // the control before the name in the header
  await page.keyboard.press('Tab')
  await expect(name).toBeFocused({ timeout: SHORT })
  await page.keyboard.press('Enter')
  await expect(nameInput(page)).toBeFocused({ timeout: SHORT })
  await close()
})

test('a pencil icon at the end of the name shows that it can be renamed, and a click on it starts the edit', async () => {
  // Arrange
  const { page, close } = await open()
  const icon = page.getByTestId('review-name-icon')

  // Act
  await expect(icon).toBeVisible({ timeout: SHORT })
  const iconBox = (await icon.boundingBox())!
  const nameBox = (await page.getByTestId('review-name').boundingBox())!
  const opacity = await icon.evaluate((el) => Number(getComputedStyle(el).opacity))

  // Assert
  await expect(icon).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByTestId('review-name')).toHaveText('Old name')
  expect(iconBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width - iconBox.width - 12)
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(nameBox.x + nameBox.width + 1)
  expect(opacity).toBeGreaterThanOrEqual(0.4)
  await icon.click()
  await expect(nameInput(page)).toBeVisible({ timeout: SHORT })
  await expect(icon).toHaveCount(0)
  await close()
})
