import { expect, test, type Page } from '@playwright/test'
import { SECTIONS_PROMPT_VERSION } from '../../src/shared/sections'
import { home, launch, makeEnv, mrFixture, openReview, seedReview, SHORT, type Env } from './naming-helpers'
import type { FakeForge } from '../fakes/fake-forge'

const KEY = 'backend/x!12'
const IDS = ['tab-mrs', 'tab-summarised', 'tab-diff', 'tab-issues', 'tab-ac']
const LABELS = ['Code changes', 'Summarised', 'Diff', 'Issues', 'Acceptance criteria']

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

/** A saved Summarised page whose snippet points at the one changed file of the clone, so no AI tool has to run. */
function savedPage(env: Env): Record<string, string> {
  const page = {
    summary: 'The change flips one line of the only file.',
    sections: [{ id: 'flip', title: 'The line flips', text: 'The file changes from one to two.', snippets: [{ mr: KEY, path: 'f.txt', lines: [1, 1] }] }],
    restText: ''
  }
  return {
    'sections.json': JSON.stringify(page),
    'sections-basis.json': JSON.stringify({ issues: [], heads: { [KEY]: env.shas.b }, version: SECTIONS_PROMPT_VERSION })
  }
}

async function open(options: { saved?: boolean; before?: (page: Page) => Promise<void> } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const env = makeEnv()
  seedReview(env, 'R-1', {}, options.saved ? savedPage(env) : {})
  const started = await launch(env, mrFixture('team/backend/x', 12, env.shas.a, env.shas.b))
  forge = started.forge
  const page = await home(started.app)
  if (options.before) {
    await options.before(page)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  }
  await openReview(page, 'R-1')
  return { page, close: () => started.app.close() }
}

const selected = (page: Page): Promise<string[]> =>
  page.locator('[role=tab][aria-selected=true]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))

test('the tabs are in the order Code changes, Summarised, Diff, Issues, Acceptance criteria', async () => {
  const { page, close } = await open()
  await expect(page.getByTestId('tab-summarised')).toBeVisible({ timeout: SHORT })
  expect(await page.locator('[role=tab]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual(IDS)
  const texts = await page.locator('[role=tab]').evaluateAll((els) => els.map((el) => el.querySelector('span')?.textContent ?? ''))
  expect(texts).toEqual(LABELS)
  await close()
})

test('a new review opens on Code changes', async () => {
  const { page, close } = await open()
  await expect(page.getByTestId('tab-summarised')).toBeVisible({ timeout: SHORT })
  expect(await selected(page)).toEqual(['tab-mrs'])
  await close()
})

test('the keys 1 to 5 select the tabs in that order', async () => {
  const { page, close } = await open()
  await expect(page.getByTestId('tab-summarised')).toBeVisible({ timeout: SHORT })
  for (const [i, id] of IDS.entries()) {
    await page.keyboard.press(String(i + 1))
    await expect(page.getByTestId(id)).toHaveAttribute('aria-selected', 'true', { timeout: SHORT })
  }
  await close()
})

test('Ctrl+Tab walks the tabs in order and goes from the last back to the first', async () => {
  const { page, close } = await open()
  await expect(page.getByTestId('tab-summarised')).toBeVisible({ timeout: SHORT })
  for (const id of IDS.slice(1)) {
    await page.keyboard.press('Control+Tab')
    await expect(page.getByTestId(id)).toHaveAttribute('aria-selected', 'true', { timeout: SHORT })
  }
  await page.keyboard.press('Control+Tab')
  await expect(page.getByTestId('tab-mrs')).toHaveAttribute('aria-selected', 'true')
  await close()
})

test('the Summarised tab shows the saved page of sections, and the Diff tab does not', async () => {
  const { page, close } = await open({ saved: true })
  await page.getByTestId('tab-summarised').click({ timeout: SHORT })
  await expect(page.getByTestId('sections-view')).toBeVisible({ timeout: SHORT })
  await expect(page.getByTestId('section-flip')).toBeVisible()
  await expect(page.getByTestId('section-index')).toBeVisible()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('sections-view')).toHaveCount(0)
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  await page.getByTestId('tab-summarised').click()
  await expect(page.getByTestId('sections-view')).toBeVisible()
  await close()
})

test('the Diff tab has no Summarised button, and keeps Linear and Stacked', async () => {
  const { page, close } = await open()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByRole('button', { name: 'Linear', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stacked' })).toBeVisible()
  await expect(page.getByTestId('view-summarised')).toHaveCount(0, { timeout: SHORT })
  await close()
})

test('a saved view of summarised opens the Diff tab on Linear, not on the sections', async () => {
  const { page, close } = await open({
    saved: true,
    before: (p) => p.evaluate(() => window.codeDiff.prefs.set('review:R-1', 'diff.view', 'summarised'))
  })
  await page.getByTestId('tab-diff').click()
  await expect(page.getByRole('button', { name: 'Linear', exact: true })).toHaveClass(/on/, { timeout: SHORT })
  await expect(page.getByTestId('sections-view')).toHaveCount(0)
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  await close()
})
