import { expect, test, type Page } from '@playwright/test'
import { home, launch, makeEnv, mrFixture, readReview, reviewFolders, SHORT, type Env } from './naming-helpers'
import type { FakeForge } from '../fakes/fake-forge'

const URL_X = 'https://gitlab.com/team/backend/x/-/merge_requests/12'

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

async function start(): Promise<{ env: Env; page: Page; close: () => Promise<void> }> {
  const env = makeEnv()
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)
  await page.getByTestId('new-review').click()
  return { env, page, close: () => started.app.close() }
}

/** Fill the boxes, press Check and Create, and wait for the review screen. */
async function createFrom(page: Page, fields: { name?: string; issues?: string; urls?: string }): Promise<void> {
  await expect(page.getByTestId('name')).toBeVisible({ timeout: SHORT })
  if (fields.name !== undefined) await page.getByTestId('name').fill(fields.name)
  if (fields.issues !== undefined) await page.getByTestId('issues').fill(fields.issues)
  await page.getByTestId('urls').fill(fields.urls ?? URL_X)
  await page.getByTestId('check').click()
  await page.getByTestId('create').click()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
}

test('the fields are Name, Jira issues and MR URLs in that order, with the Name focused and no Slug or Title', async () => {
  const { page, close } = await start()
  await expect(page.getByTestId('name')).toBeVisible({ timeout: SHORT })
  await expect(page.getByTestId('name')).toBeFocused()
  const order = await page
    .locator('[data-testid="name"], [data-testid="issues"], [data-testid="urls"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  expect(order).toEqual(['name', 'issues', 'urls'])
  await expect(page.getByTestId('slug')).toHaveCount(0)
  await expect(page.getByTestId('title')).toHaveCount(0)
  await expect(page.getByText('Slug', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Title (optional)')).toHaveCount(0)
  await expect(page.getByText('Name', { exact: true }).first()).toBeVisible({ timeout: SHORT })
  await close()
})

test('with only an MR URL the placeholder and the created review use <repo>-<number>', async () => {
  const { env, page, close } = await start()
  await page.getByTestId('urls').fill(URL_X)
  await expect(page.getByTestId('name')).toHaveAttribute('placeholder', 'Defaults to x-12', { timeout: SHORT })
  await createFrom(page, {})
  expect(reviewFolders(env)).toEqual(['x-12'])
  expect(readReview(env, 'x-12').title).toBe('x-12')
  await close()
})

test('with no URL and no key the placeholder asks for a name', async () => {
  const { page, close } = await start()
  await expect(page.getByTestId('name')).toHaveAttribute('placeholder', 'Name of the review', { timeout: SHORT })
  await close()
})

test('a Jira key gives the name, even with an MR URL', async () => {
  const { env, page, close } = await start()
  await page.getByTestId('issues').fill('lx2813')
  await expect(page.getByTestId('name')).toHaveAttribute('placeholder', 'Defaults to LX-2813', { timeout: SHORT })
  await createFrom(page, { issues: 'lx2813' })
  expect(reviewFolders(env)).toEqual(['LX-2813'])
  expect(readReview(env, 'LX-2813').title).toBe('LX-2813')
  await close()
})

test('a typed name wins over the key and the change', async () => {
  const { env, page, close } = await start()
  await createFrom(page, { name: 'Hand-picked', issues: 'LX-2813' })
  expect(reviewFolders(env)).toEqual(['Hand-picked'])
  expect(readReview(env, 'Hand-picked').title).toBe('Hand-picked')
  await close()
})

test('a typed name with spaces and a slash makes a slug and keeps the typed text as the title', async () => {
  const { env, page, close } = await start()
  await createFrom(page, { name: '  Fix a/b login!  ' })
  expect(reviewFolders(env)).toEqual(['Fix-a-b-login'])
  expect(readReview(env, 'Fix-a-b-login').title).toBe('Fix a/b login!')
  await close()
})

test('a second review with the same name gets -2 and leaves the first alone', async () => {
  const { env, page, close } = await start()
  await createFrom(page, { name: 'Same name' })
  const first = JSON.stringify(readReview(env, 'Same-name'))
  await page.getByRole('button', { name: '← Reviews' }).click()
  await page.getByTestId('new-review').click()
  await createFrom(page, { name: 'Same name' })
  expect(reviewFolders(env)).toEqual(['Same-name', 'Same-name-2'])
  expect(JSON.stringify(readReview(env, 'Same-name'))).toBe(first)
  expect(readReview(env, 'Same-name-2').title).toBe('Same name')
  await close()
})

test('an empty Name with nothing else shows the name error and runs no check', async () => {
  const { page, close } = await start()
  await page.getByTestId('check').click()
  await expect(page.getByTestId('name-error')).toHaveText('Enter a name, or add an issue or a change.', { timeout: SHORT })
  await expect(page.getByTestId('check-list')).toHaveCount(0)
  await close()
})
