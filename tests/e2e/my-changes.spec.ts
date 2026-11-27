import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEnv, seedReview, SHORT, type Env } from './naming-helpers'
import { changesFixture, FAKE_GITLAB_USER_ID, forgeEnv, startFakeForge, type Call, type FakeForge, type Fixture, type SeedChange } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const DAY = 86_400_000
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()

let forge: FakeForge | undefined
let app: ElectronApplication | undefined
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  await forge?.close()
  app = undefined
  forge = undefined
})

const GL = 'team/backend/x'
const GH = 'acme/web'
const glUrl = (iid: number): string => `https://gitlab.com/${GL}/-/merge_requests/${iid}`
const ghUrl = (iid: number): string => `https://github.com/${GH}/pull/${iid}`

/**
 * Titles are single distinct words, so a text filter on one title never matches another row.
 * Assigned to the user: Aspen, Birch, Cedar, Dogwood, Elm, Fir, Hazel, Juniper (8 shown, Ginkgo is merged and too old).
 * Reviewer: Linden, Elm, Maple, Nettle, Oak, Juniper (6). Elm and Juniper have both roles, so 12 different changes in all.
 */
const SEED: SeedChange[] = [
  { provider: 'gitlab', project: GL, iid: 1, title: 'Aspen', state: 'opened', author: 'ann', updatedAt: ago(1), assigned: true },
  { provider: 'github', project: GH, iid: 21, title: 'Birch', state: 'opened', author: 'bob', updatedAt: ago(1.5), assigned: true },
  { provider: 'gitlab', project: GL, iid: 2, title: 'Cedar', state: 'draft', author: 'ann', updatedAt: ago(2), assigned: true },
  { provider: 'gitlab', project: GL, iid: 7, title: 'Dogwood', state: 'opened', author: 'cy', updatedAt: ago(3), assigned: true },
  { provider: 'gitlab', project: GL, iid: 3, title: 'Elm', state: 'opened', author: 'dee', updatedAt: ago(4), assigned: true, reviewer: true },
  { provider: 'gitlab', project: GL, iid: 4, title: 'Fir', state: 'merged', author: 'ann', updatedAt: ago(5), assigned: true },
  { provider: 'gitlab', project: GL, iid: 5, title: 'Ginkgo', state: 'merged', author: 'ann', updatedAt: ago(45), assigned: true },
  { provider: 'github', project: GH, iid: 22, title: 'Hazel', state: 'closed', author: 'eve', updatedAt: ago(6), assigned: true },
  { provider: 'github', project: GH, iid: 24, title: 'Juniper', state: 'draft', author: 'fay', updatedAt: ago(7), assigned: true, reviewer: true },
  { provider: 'gitlab', project: GL, iid: 6, title: 'Kauri', state: 'opened', author: 'ann', updatedAt: ago(90), assigned: true },
  { provider: 'gitlab', project: GL, iid: 8, title: 'Linden', state: 'opened', author: 'gus', updatedAt: ago(3.5), reviewer: true },
  { provider: 'gitlab', project: GL, iid: 9, title: 'Maple', state: 'closed', author: 'hal', updatedAt: ago(10), reviewer: true },
  { provider: 'github', project: GH, iid: 23, title: 'Nettle', state: 'opened', author: 'ivy', updatedAt: ago(2.5), reviewer: true },
  { provider: 'github', project: GH, iid: 25, title: 'Oak', state: 'merged', author: 'jon', updatedAt: ago(8), reviewer: true, reviewedBy: true },
  { provider: 'gitlab', project: GL, iid: 10, title: 'Pine', state: 'opened', author: 'kim', updatedAt: ago(1) }
]
// Ginkgo is merged 45 days ago and so hidden. Kauri is open 90 days ago and so shown. Pine has no role for the user.
const ASSIGNED_FLAT = ['Aspen', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Hazel', 'Juniper', 'Kauri'] // updated, newest first
const REVIEWER_FLAT = ['Nettle', 'Linden', 'Elm', 'Juniper', 'Oak', 'Maple']

/** Start the app on the fake forge with a token for gitlab.com and github.com (or none), and go to the main screen. */
async function start(
  fixture: Fixture,
  opts: { env?: Env; tokens?: boolean; root?: boolean; clock?: boolean } = {}
): Promise<{ page: Page; env: Env; forge: FakeForge }> {
  const env = opts.env ?? makeEnv()
  // Without a workspace root the Prerequisites are not ready, so Home is blocked.
  if (opts.root === false) writeFileSync(join(env.ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, firstRunDone: true }))
  forge = await startFakeForge(fixture)
  const vars: Record<string, string | undefined> = { ...process.env, CODEDIFF_USER_DATA: env.ud, ...forgeEnv(forge.url) }
  if (opts.tokens === false) delete vars['CODEDIFF_TEST_CREDENTIALS']
  app = await electron.launch({ args: [main], env: vars as Record<string, string> })
  const page = await app.firstWindow()
  // A fake clock lets a test move the 60 second poll without waiting. Time still runs on its own after the install.
  if (opts.clock) await page.clock.install()
  // With no token or no root the Prerequisites screen shows first.
  if (opts.tokens === false || opts.root === false) await page.getByTestId('continue-anyway').click()
  await expect(page.getByTestId('home-tab-reviews')).toBeVisible({ timeout: SHORT })
  return { page, env, forge }
}

/** Every row of the table has the test id `mr-<url>`. */
const ROWS = 'tr[data-testid^="mr-"]'
const rows = (page: Page): Locator => page.locator(ROWS)
const row = (page: Page, title: string): Locator => rows(page).filter({ hasText: title })
/** The 15 columns, left to right: the checkbox column has no header text. */
const HEADERS = [
  '',
  'Repository',
  'Change request',
  'Stack',
  'Title',
  'Pipeline',
  'Author',
  'Reviewers',
  'Approved by',
  'Your review',
  'Comments',
  'Created',
  'Updated',
  'Merged',
  'State'
]
const SORT_KEYS = [
  'repo',
  'mr',
  'stack',
  'title',
  'pipeline',
  'author',
  'reviewers',
  'approved',
  'review',
  'comments',
  'created',
  'updated',
  'merged',
  'state'
] as const
/** The cells that only a snapshot can fill. A stub row shows the placeholder in them. */
const SNAPSHOT_ONLY = ['Stack', 'Pipeline', 'Your review', 'Comments', 'Created', 'Merged'] as const
const cellAt = (r: Locator, header: string): Locator => r.locator('td').nth(HEADERS.indexOf(header))
const headerTexts = async (page: Page): Promise<string[]> =>
  (await page.locator('table.reviews thead th').allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())
const pill = (page: Page, name: string): Locator =>
  page.getByRole('group', { name: 'Show change requests by state' }).getByRole('button', { name: new RegExp(`^${name}`) })
const modeBtn = (page: Page, name: 'No group' | 'Repository' | 'State' | 'Approval' | 'Updated'): Locator =>
  page.getByRole('group', { name: 'Group the list' }).getByRole('button', { name, exact: true })
const tab = (page: Page, which: 'reviews' | 'assigned' | 'reviewer'): Locator => page.getByTestId(`home-tab-${which}`)

async function openTab(page: Page, which: 'assigned' | 'reviewer'): Promise<void> {
  await tab(page, which).click()
  await expect(tab(page, which)).toHaveAttribute('aria-selected', 'true')
  await expect(rows(page).first()).toBeVisible({ timeout: SHORT })
}

/** Turns the Draft, Merged and Closed pills on, so every state shows (Open is on from the start). */
async function showAll(page: Page): Promise<void> {
  for (const name of ['Draft', 'Merged', 'Closed']) await pill(page, name).click()
  for (const name of ['Draft', 'Open', 'Merged', 'Closed']) await expect(pill(page, name)).toHaveAttribute('aria-pressed', 'true')
}

const MINE_CALLS = new Set(['merge_requests', 'search/issues'])
const mineCalls = (f: FakeForge): number => f.calls.filter((c) => MINE_CALLS.has(c.endpoint)).length
/** Real time to wait before a check that nothing happened. */
const QUIET_MS = 1_000

const baseFixture = (changes: SeedChange[] = SEED): Fixture => changesFixture(changes)

test('the main screen has the three tabs, Reviews is the default and shows the table of reviews as before', async () => {
  // Arrange
  const env = makeEnv()
  seedReview(env, 'R-1')
  seedReview(env, 'R-2', { title: 'Second review' })

  // Act
  const { page } = await start(baseFixture(), { env })

  // Assert
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: SHORT })
  await expect(page.getByRole('tab')).toHaveText([/^Reviews/, /^Owned by me/, /^I am the reviewer/])
  await expect(tab(page, 'reviews')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'assigned')).toHaveAttribute('aria-selected', 'false')
  await expect(tab(page, 'reviewer')).toHaveAttribute('aria-selected', 'false')
  const headers = (await page.locator('table.reviews thead th').allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())
  expect(headers).toEqual(['Name', 'Change requests', 'Issues', 'Last opened', 'Summarised', ''])
  await expect(page.getByTestId('review-R-1')).toBeVisible()
  await expect(page.getByTestId('review-R-2')).toBeVisible()
  await expect(page.getByTestId('new-review')).toBeEnabled()
  await expect(rows(page)).toHaveCount(0)
})

test('Owned by me lists only the changes assigned to the user, from GitLab and GitHub, with the columns of the MR list', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'assigned')
  await showAll(page)

  // Assert: the 9 assigned changes (Ginkgo is too old, Pine and the reviewer-only ones are not assigned)
  await expect(rows(page)).toHaveCount(ASSIGNED_FLAT.length)
  for (const t of ASSIGNED_FLAT) await expect(row(page, t)).toHaveCount(1)
  for (const t of ['Linden', 'Maple', 'Nettle', 'Oak', 'Pine', 'Ginkgo']) await expect(row(page, t)).toHaveCount(0)
  await expect(row(page, 'Aspen')).toHaveAttribute('data-url', glUrl(1))
  await expect(row(page, 'Birch')).toHaveAttribute('data-url', ghUrl(21))
  expect(await headerTexts(page)).toEqual(HEADERS)
  await expect(row(page, 'Aspen').locator('.statepill')).toHaveText('Open')
  await expect(row(page, 'Cedar').locator('.statepill')).toHaveText('Draft')
  await expect(row(page, 'Fir').locator('.statepill')).toHaveText('Merged')
  await expect(row(page, 'Hazel').locator('.statepill')).toHaveText('Closed')
  await expect(row(page, 'Aspen')).toContainText(GL)
  await expect(cellAt(row(page, 'Aspen'), 'Author').locator('.avatar')).toHaveAttribute('data-user', 'ann')
  await expect(row(page, 'Birch')).toContainText(GH)
  await expect(cellAt(row(page, 'Birch'), 'Author').locator('.avatar')).toHaveAttribute('data-user', 'bob')
})

test('I am the reviewer lists only the changes with the user as reviewer, found by review-requested and by reviewed-by on GitHub', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'reviewer')
  await showAll(page)

  // Assert: Oak is found only by reviewed-by:@me, Nettle only by review-requested:@me
  await expect(rows(page)).toHaveCount(REVIEWER_FLAT.length)
  for (const t of REVIEWER_FLAT) await expect(row(page, t)).toHaveCount(1)
  for (const t of ['Aspen', 'Birch', 'Cedar', 'Dogwood', 'Fir', 'Hazel', 'Kauri', 'Pine']) await expect(row(page, t)).toHaveCount(0)
  await expect(row(page, 'Oak')).toHaveAttribute('data-url', ghUrl(25))
  await expect(row(page, 'Oak').locator('.statepill')).toHaveText('Merged')
  await expect(row(page, 'Linden')).toHaveAttribute('data-url', glUrl(8))
})

test('a change with both roles shows in both tabs', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'assigned')
  const inAssigned = await row(page, 'Elm').count()
  await openTab(page, 'reviewer')
  const inReviewer = await row(page, 'Elm').count()

  // Assert
  expect([inAssigned, inReviewer]).toEqual([1, 1])
})

test('the state pills show the counts of all loaded changes, only Open is on at the start and each pill hides and shows its changes', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  const group = page.getByRole('group', { name: 'Show change requests by state' })

  // Assert: counts of the 9 assigned changes are the real ones, also for the pills that are off
  await expect(group).toHaveClass(/seg/)
  await expect(group.getByRole('button')).toHaveCount(4)
  await expect(pill(page, 'Draft')).toContainText('2')
  await expect(pill(page, 'Open')).toContainText('5')
  await expect(pill(page, 'Merged')).toContainText('1')
  await expect(pill(page, 'Closed')).toContainText('1')
  await expect(rows(page)).toHaveCount(5)

  // Act and assert: turn Open off and Draft on
  await pill(page, 'Open').click()
  await pill(page, 'Draft').click()
  await expect(pill(page, 'Open')).toHaveAttribute('aria-pressed', 'false')
  await expect(pill(page, 'Draft')).toHaveAttribute('aria-pressed', 'true')
  await expect(row(page, 'Aspen')).toHaveCount(0)
  await expect(row(page, 'Kauri')).toHaveCount(0)
  await expect(row(page, 'Cedar')).toHaveCount(1)
  await expect(rows(page)).toHaveCount(2)
  await expect(pill(page, 'Open')).toContainText('5')

  // Act and assert: turn Open on and Draft off, and Closed on
  await pill(page, 'Open').click()
  await pill(page, 'Draft').click()
  await pill(page, 'Closed').click()
  await expect(row(page, 'Aspen')).toHaveCount(1)
  await expect(row(page, 'Cedar')).toHaveCount(0)
  await expect(row(page, 'Hazel')).toHaveCount(1)
  await expect(rows(page)).toHaveCount(6)
})

test('on both tabs only the Open pill is on at the start, and the other pills still count every loaded change', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'assigned')

  // Assert: Owned by me
  await expect(pill(page, 'Open')).toHaveAttribute('aria-pressed', 'true')
  for (const name of ['Draft', 'Merged', 'Closed']) await expect(pill(page, name)).toHaveAttribute('aria-pressed', 'false')
  await expect(rows(page)).toHaveCount(5)
  for (const t of ['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri']) await expect(row(page, t)).toHaveCount(1)
  for (const t of ['Cedar', 'Juniper', 'Fir', 'Hazel']) await expect(row(page, t)).toHaveCount(0)
  await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*5$/])

  // Act
  await openTab(page, 'reviewer')

  // Assert: I am the reviewer, the counts are the real ones: Juniper draft, Nettle, Linden and Elm open, Oak merged, Maple closed
  await expect(pill(page, 'Open')).toHaveAttribute('aria-pressed', 'true')
  for (const name of ['Draft', 'Merged', 'Closed']) await expect(pill(page, name)).toHaveAttribute('aria-pressed', 'false')
  await expect(pill(page, 'Draft')).toContainText('1')
  await expect(pill(page, 'Open')).toContainText('3')
  await expect(pill(page, 'Merged')).toContainText('1')
  await expect(pill(page, 'Closed')).toContainText('1')
  await expect(rows(page)).toHaveCount(3)
  for (const t of ['Nettle', 'Linden', 'Elm']) await expect(row(page, t)).toHaveCount(1)
  for (const t of ['Juniper', 'Oak', 'Maple']) await expect(row(page, t)).toHaveCount(0)
})

test('turning the Draft pill on shows the draft changes under a Draft header with their count', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*5$/])

  // Act
  await pill(page, 'Draft').click()

  // Assert: Draft comes before Open, Cedar and Juniper are the two drafts
  await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Draft\s*·\s*2$/, /^[▴▾]?\s*Open\s*·\s*5$/])
  await expect(row(page, 'Cedar')).toHaveCount(1)
  await expect(row(page, 'Juniper')).toHaveCount(1)
  await expect(rows(page)).toHaveCount(7)
  await expect(row(page, 'Fir')).toHaveCount(0)
})

test('a ticked change that a pill hides stays ticked and still counts in Start review', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  await pill(page, 'Draft').click()
  await page.getByRole('checkbox', { name: 'Select Cedar' }).check()
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

  // Act
  await pill(page, 'Draft').click()

  // Assert: Cedar is hidden but still counted
  await expect(row(page, 'Cedar')).toHaveCount(0)
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

  // Act and assert: it is still ticked when it shows again
  await pill(page, 'Draft').click()
  await expect(page.getByRole('checkbox', { name: 'Select Cedar' })).toBeChecked()
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')
})

test('the pills count the reviewer tab by its own changes', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'reviewer')

  // Assert: Juniper draft, Nettle, Linden and Elm open, Oak merged, Maple closed
  await expect(pill(page, 'Draft')).toContainText('1')
  await expect(pill(page, 'Open')).toContainText('3')
  await expect(pill(page, 'Merged')).toContainText('1')
  await expect(pill(page, 'Closed')).toContainText('1')
})

test('with the group mode State, the rows sit under a header for each state with its count, in the order Draft, Open, Merged, Closed', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'assigned')
  await showAll(page)

  // Assert
  await expect(modeBtn(page, 'State')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('group-row')).toHaveText([
    /^[▴▾]?\s*Draft\s*·\s*2$/,
    /^[▴▾]?\s*Open\s*·\s*5$/,
    /^[▴▾]?\s*Merged\s*·\s*1$/,
    /^[▴▾]?\s*Closed\s*·\s*1$/
  ])
  // The rows follow their headers, each group newest first
  const order = await page
    .locator(`[data-testid="group-row"], ${ROWS}`)
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'group-row' ? 'G' : (e.textContent ?? ''))))
  const names = order.map((t) => ['Aspen', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Hazel', 'Juniper', 'Kauri'].find((n) => t.includes(n)) ?? t)
  expect(names).toEqual(['G', 'Cedar', 'Juniper', 'G', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'G', 'Fir', 'G', 'Hazel'])
})

test('the group mode is a four-way choice None, Repo, State, Approval in one group, and State is pressed at the start', async () => {
  // Arrange
  const { page } = await start(baseFixture())

  // Act
  await openTab(page, 'assigned')

  // Assert
  const modes = page.getByTestId('group-mode')
  await expect(modes).toHaveAttribute('role', 'group')
  await expect(modes).toHaveAttribute('aria-label', 'Group the list')
  await expect(modes.getByRole('button')).toHaveText(['No group', 'Repository', 'State', 'Approval', 'Updated'])
  await expect(modeBtn(page, 'No group')).toHaveAttribute('aria-pressed', 'false')
  await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'false')
  await expect(modeBtn(page, 'State')).toHaveAttribute('aria-pressed', 'true')
  await expect(modeBtn(page, 'Approval')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*5$/])
  await expect(page.getByRole('button', { name: 'Group by state' })).toHaveCount(0)
})

test('a group with no rows has no header, and turning its pill off removes the header too', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  await showAll(page)

  // Act
  await pill(page, 'Merged').click()
  await pill(page, 'Draft').click()

  // Assert
  await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*5$/, /^[▴▾]?\s*Closed\s*·\s*1$/])
})

test('with the group mode No group, one flat list shows, newest update first, without headers', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  await showAll(page)

  // Act
  await modeBtn(page, 'No group').click()

  // Assert
  await expect(modeBtn(page, 'No group')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('group-row')).toHaveCount(0)
  // Updated: Aspen 1d, Birch 1.5d, Cedar 2d, Dogwood 3d, Elm 4d, Fir 5d, Hazel 6d, Juniper 7d, Kauri 90d
  const found = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-url')))
  expect(found).toEqual([glUrl(1), ghUrl(21), glUrl(2), glUrl(7), glUrl(3), glUrl(4), ghUrl(22), ghUrl(24), glUrl(6)])
})

test('the 30-day rule hides a merged change that is older and keeps an old open one, and the app asks the forges in the way the rule needs', async () => {
  // Arrange
  const started = await start(baseFixture())
  const { page } = started

  // Act
  await openTab(page, 'assigned')
  await pill(page, 'Merged').click()
  await pill(page, 'Closed').click()

  // Assert: Ginkgo (merged 45 days ago) is not shown, Fir (merged 5 days ago) and Kauri (open 90 days ago) are, and Hazel (closed 6 days ago) is
  await expect(row(page, 'Ginkgo')).toHaveCount(0)
  await expect(row(page, 'Fir')).toHaveCount(1)
  await expect(row(page, 'Kauri')).toHaveCount(1)
  await expect(row(page, 'Hazel')).toHaveCount(1)
  await expect(pill(page, 'Merged')).toContainText('1')

  // Assert: the requests are the REST list calls that were agreed, with the token of each host
  const gitlab = started.forge.calls.filter((c) => c.endpoint === 'merge_requests')
  const github = started.forge.calls.filter((c) => c.endpoint === 'search/issues')
  expect(gitlab.some((c) => c.query['scope'] === 'assigned_to_me' && c.query['state'] === 'opened')).toBe(true)
  expect(gitlab.some((c) => c.query['reviewer_id'] === String(FAKE_GITLAB_USER_ID) && c.query['state'] === 'opened')).toBe(true)
  expect(gitlab.some((c) => c.query['scope'] === 'assigned_to_me' && !!c.query['updated_after'] && c.query['state'] !== 'opened')).toBe(true)
  expect(gitlab.every((c) => c.method === 'GET' && c.auth === 'glpat-test')).toBe(true)
  const q = github.map((c) => c.query['q'] ?? '')
  for (const need of ['assignee:@me', 'review-requested:@me', 'reviewed-by:@me']) expect(q.some((t) => t.split(/\s+/).includes(need))).toBe(true)
  expect(q.every((t) => t.split(/\s+/).includes('is:pr'))).toBe(true)
  expect(github.every((c) => c.method === 'GET' && !!c.auth?.includes('ghp-test'))).toBe(true)
})

test('Refresh reads the lists again and shows a change that was seeded after the start', async () => {
  // Arrange
  const { page, forge: f } = await start(baseFixture())
  await openTab(page, 'assigned')
  await expect(row(page, 'Quince')).toHaveCount(0)
  const added: SeedChange = { provider: 'github', project: GH, iid: 40, title: 'Quince', state: 'opened', author: 'lee', updatedAt: ago(0.1), assigned: true }
  f.setFixture(baseFixture([...SEED, added]))

  // Act
  await page.getByTestId('mine-refresh').click()

  // Assert
  await expect(row(page, 'Quince')).toHaveCount(1)
  await expect(row(page, 'Quince')).toHaveAttribute('data-url', ghUrl(40))
  await expect(pill(page, 'Open')).toContainText('6')
})

test('the lists are read again when the window gains focus', async () => {
  // Arrange
  const { page, forge: f } = await start(baseFixture())
  await openTab(page, 'reviewer')
  await expect(row(page, 'Rowan')).toHaveCount(0)
  const added: SeedChange = { provider: 'gitlab', project: GL, iid: 41, title: 'Rowan', state: 'opened', author: 'lee', updatedAt: ago(0.1), reviewer: true }
  f.setFixture(baseFixture([...SEED, added]))

  // Act
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // Assert
  await expect(row(page, 'Rowan')).toHaveCount(1)
})

test('a host that fails shows one error line with its name and the other host still shows its changes', async () => {
  // Arrange: GitHub answers with an error
  const { page } = await start({ ...baseFixture(), 'GET search/issues': { fail: 'HTTP 500 search is down' } })

  // Act
  await openTab(page, 'assigned')

  // Assert
  await expect(page.getByTestId('mine-error')).toHaveCount(1)
  await expect(page.getByTestId('mine-error')).toContainText('github.com')
  await expect(row(page, 'Aspen')).toHaveCount(1)
  await expect(row(page, 'Birch')).toHaveCount(0)
  // Open only: Aspen, Dogwood, Elm and Kauri (Cedar is a draft and Fir is merged, so both are hidden)
  await expect(rows(page)).toHaveCount(4)
})

test('when GitLab fails the GitHub changes still show', async () => {
  // Arrange
  const { page } = await start({ ...baseFixture(), 'GET merge_requests': { fail: 'HTTP 503 maintenance' } })

  // Act
  await tab(page, 'reviewer').click()
  await pill(page, 'Merged').click()

  // Assert
  await expect(page.getByTestId('mine-error')).toHaveCount(1)
  await expect(page.getByTestId('mine-error')).toContainText('gitlab.com')
  await expect(row(page, 'Nettle')).toHaveCount(1)
  await expect(row(page, 'Oak')).toHaveCount(1)
  await expect(row(page, 'Linden')).toHaveCount(0)
})

test('two failing hosts give two error lines, one for each host', async () => {
  // Arrange
  const { page } = await start({ ...baseFixture(), 'GET merge_requests': { fail: 'HTTP 503 maintenance' }, 'GET search/issues': { fail: 'HTTP 500 down' } })

  // Act
  await tab(page, 'assigned').click()

  // Assert
  await expect(page.getByTestId('mine-error')).toHaveCount(2)
  await expect(page.getByTestId('mine-error').filter({ hasText: 'gitlab.com' })).toHaveCount(1)
  await expect(page.getByTestId('mine-error').filter({ hasText: 'github.com' })).toHaveCount(1)
  await expect(rows(page)).toHaveCount(0)
})

test('with no GitLab or GitHub access the tabs show the empty state with a button to the Prerequisites', async () => {
  // Arrange
  const { page } = await start(baseFixture(), { tokens: false })

  // Act
  await tab(page, 'assigned').click()

  // Assert
  await expect(page.getByTestId('mine-empty')).toContainText('No GitLab or GitHub access yet')
  await expect(rows(page)).toHaveCount(0)
  await tab(page, 'reviewer').click()
  await expect(page.getByTestId('mine-empty')).toContainText('No GitLab or GitHub access yet')
  await page.getByTestId('mine-empty').getByRole('button', { name: 'Open Prerequisites' }).click()
  await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
})

test('New review shows the count of the ticked changes, and stays on with none ticked', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  const start_ = page.getByTestId('new-review')

  // Assert: nothing ticked
  await expect(start_).toHaveText('New review')
  await expect(row(page, 'Aspen').getByRole('checkbox', { name: 'Select Aspen' })).not.toBeChecked()

  // Act and assert
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()
  await expect(start_).toBeEnabled()
  await expect(start_).toHaveText('New review (1)')
  await page.getByRole('checkbox', { name: 'Select Birch' }).check()
  await expect(start_).toHaveText('New review (2)')
  await page.getByRole('checkbox', { name: 'Select Aspen' }).uncheck()
  await expect(start_).toHaveText('New review (1)')
  await page.getByRole('checkbox', { name: 'Select Birch' }).uncheck()
  await expect(start_).toHaveText('New review')
})

test('the selection is shared by the two tabs, survives a change of tab, and a change with both roles counts once', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()
  await page.getByRole('checkbox', { name: 'Select Elm' }).check()
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

  // Act
  await openTab(page, 'reviewer')

  // Assert: the button is on this tab too, Elm is already ticked here, and it counts once
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')
  await expect(page.getByRole('checkbox', { name: 'Select Elm' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select Linden' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: 'Select Linden' }).check()
  await expect(page.getByTestId('new-review')).toHaveText('New review (3)')

  // Act and assert: back on the first tab, every tick is still there
  await openTab(page, 'assigned')
  await expect(page.getByRole('checkbox', { name: 'Select Aspen' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select Elm' })).toBeChecked()
  await expect(page.getByTestId('new-review')).toHaveText('New review (3)')

  // Act and assert: unticking Elm here unticks it in the other tab too
  await page.getByRole('checkbox', { name: 'Select Elm' }).uncheck()
  await openTab(page, 'reviewer')
  await expect(page.getByRole('checkbox', { name: 'Select Elm' })).not.toBeChecked()
  await expect(page.getByTestId('new-review')).toHaveText('New review (2)')
})

test('New review opens the form with the urls of every ticked change from both tabs and runs the check, and the ticks clear when the form closes', async () => {
  // Arrange
  const { page, forge: f } = await start(baseFixture())
  await openTab(page, 'assigned')
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()
  await page.getByRole('checkbox', { name: 'Select Elm' }).check()
  await openTab(page, 'reviewer')
  await page.getByRole('checkbox', { name: 'Select Nettle' }).check()
  await expect(page.getByTestId('new-review')).toHaveText('New review (3)')

  // Act
  await page.getByTestId('new-review').click()

  // Assert: the form has the three urls, each once
  const dialog = page.getByRole('dialog', { name: 'New review' })
  await expect(dialog).toBeVisible({ timeout: SHORT })
  const typed = (await page.getByTestId('urls').inputValue())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  expect([...typed].sort()).toEqual([glUrl(1), glUrl(3), ghUrl(23)].sort())
  // The form waits for the reviewer: no check runs, and the fields stay, so a name and issues can be typed
  await page.waitForTimeout(1500)
  expect(await readCount(f, glUrl(1))).toBe(1) // only the read of the shown row
  await expect(page.getByTestId('check-list')).toHaveCount(0)
  await page.getByTestId('name').fill('My review')
  await page.getByTestId('issues').fill('LX-1')
  await expect(page.getByTestId('name')).toHaveValue('My review')
  // The review is made only when the user presses Create
  expect(f.bodies.filter((c) => c.method === 'POST' && c.endpoint !== 'graphql')).toHaveLength(0)

  // Act: close the form
  await dialog.getByRole('button', { name: 'Close' }).click()
  const discard = page.getByRole('button', { name: 'Discard' })
  if (await discard.isVisible().catch(() => false)) await discard.click()
  await expect(dialog).toHaveCount(0)

  // Assert: nothing is ticked any more, in either tab
  await expect(page.getByTestId('new-review')).toHaveText('New review')
  await expect(page.getByRole('checkbox', { name: 'Select Nettle' })).not.toBeChecked()
  await openTab(page, 'assigned')
  await expect(page.getByRole('checkbox', { name: 'Select Aspen' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select Elm' })).not.toBeChecked()
})

test('New review with nothing ticked opens an empty form, and does not run the check', async () => {
  // Arrange
  const { page } = await start(baseFixture())
  await openTab(page, 'assigned')

  // Act
  await page.getByTestId('new-review').click()

  // Assert
  const dialog = page.getByRole('dialog', { name: 'New review' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('textarea').first()).toHaveValue('')
})

test('the New review form with ticked changes stays open while the lists poll and the window gains focus', async () => {
  // Arrange
  const { page } = await start(baseFixture(), { clock: true })
  await openTab(page, 'assigned')
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()
  await page.getByRole('checkbox', { name: 'Select Elm' }).check()
  await page.getByTestId('new-review').click()
  const dialog = page.getByRole('dialog', { name: 'New review' })
  await expect(dialog).toBeVisible({ timeout: SHORT })

  // Act: the window gains focus and the poll runs
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.clock.fastForward(61_000)
  await page.waitForTimeout(1500)

  // Assert
  await expect(dialog).toBeVisible()
})

test('New review is off while the Prerequisites are not ready', async () => {
  // Arrange: tokens are saved, but the workspace root is not set, so Home is blocked
  const { page } = await start(baseFixture(), { root: false })
  await expect(page.getByTestId('blocked-strip')).toBeVisible({ timeout: SHORT })
  await openTab(page, 'assigned')

  // Act
  await page.getByRole('checkbox', { name: 'Select Aspen' }).check()

  // Assert
  await expect(page.getByTestId('new-review')).toBeDisabled()
  await expect(page.getByTestId('new-review')).toHaveAttribute('title', 'Fix the Prerequisites first')
  await expect(page.getByTestId('new-review')).toBeDisabled()
})

test.describe('the lists reload by themselves while a list tab is shown', () => {
  test('a poll runs every 60 seconds: none at 50 seconds, one round at 60, and the second round at 120', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const afterLoad = mineCalls(f)
    const callsAfterLoad = f.calls.length

    // Act and assert: 50 seconds is too early
    await page.clock.fastForward(50_000)
    await page.waitForTimeout(QUIET_MS)
    expect(mineCalls(f)).toBe(afterLoad)

    // Act and assert: at 60 seconds one round of calls comes, for both forges
    await page.clock.fastForward(10_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(afterLoad)
    await page.waitForTimeout(QUIET_MS)
    const afterFirstPoll = mineCalls(f)
    expect(afterFirstPoll - afterLoad).toBe(afterLoad)
    expect(f.calls.slice(callsAfterLoad).some((c) => c.endpoint === 'merge_requests')).toBe(true)
    expect(f.calls.slice(callsAfterLoad).some((c) => c.endpoint === 'search/issues')).toBe(true)

    // Act and assert: the next round is 60 seconds later
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(afterFirstPoll)
  })

  test('the poll also runs on the reviewer tab', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'reviewer')
    const afterLoad = mineCalls(f)

    // Act
    await page.clock.fastForward(60_000)

    // Assert
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(afterLoad)
  })

  test('no poll runs on the Reviews tab', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    const before = f.calls.length

    // Act
    await page.clock.fastForward(180_000)
    await page.waitForTimeout(QUIET_MS)

    // Assert
    expect(f.calls.length).toBe(before)
    expect(mineCalls(f)).toBe(0)
  })

  test('the poll stops when the tab is left, and starts again with an immediate load when a list tab is shown again', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    await tab(page, 'reviews').click()
    await expect(tab(page, 'reviews')).toHaveAttribute('aria-selected', 'true')
    await page.waitForTimeout(QUIET_MS)
    const whenLeft = f.calls.length

    // Act and assert: no poll while Reviews is shown
    await page.clock.fastForward(180_000)
    await page.waitForTimeout(QUIET_MS)
    expect(f.calls.length).toBe(whenLeft)

    // Act and assert: showing the tab again loads at once, without moving the clock
    await tab(page, 'assigned').click()
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(0)
    await page.waitForTimeout(QUIET_MS)
    const afterReturn = mineCalls(f)
    expect(afterReturn).toBeGreaterThan(whenLeft - f.calls.filter((c) => !MINE_CALLS.has(c.endpoint)).length)

    // Act and assert: the poll runs again 60 seconds later
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(afterReturn)
  })

  test('no poll runs while another screen is shown, here the Prerequisites', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:openPrereq')) // the Settings menu item
    await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
    await page.waitForTimeout(QUIET_MS)
    const before = f.calls.length

    // Act
    await page.clock.fastForward(180_000)
    await page.waitForTimeout(QUIET_MS)

    // Assert
    expect(f.calls.length).toBe(before)
  })

  test('a poll shows a change seeded after the start, and keeps the ticks, the pills and the group mode', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await pill(page, 'Draft').click()
    await pill(page, 'Open').click()
    await modeBtn(page, 'No group').click()
    await page.getByRole('checkbox', { name: 'Select Cedar' }).check()
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
    const afterLoad = mineCalls(f)
    const added: SeedChange = { provider: 'github', project: GH, iid: 42, title: 'Quince', state: 'draft', author: 'lee', updatedAt: ago(0.1), assigned: true }
    f.setFixture(baseFixture([...SEED, added]))

    // Act
    await page.clock.fastForward(60_000)

    // Assert: the new draft shows, and nothing the user set was reset
    await expect(row(page, 'Quince')).toHaveCount(1)
    expect(mineCalls(f)).toBeGreaterThan(afterLoad)
    await expect(page.getByRole('checkbox', { name: 'Select Cedar' })).toBeChecked()
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
    await expect(pill(page, 'Draft')).toHaveAttribute('aria-pressed', 'true')
    await expect(pill(page, 'Open')).toHaveAttribute('aria-pressed', 'false')
    await expect(pill(page, 'Draft')).toContainText('3')
    await expect(modeBtn(page, 'No group')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveCount(0)
  })

  test('the old rows stay on screen while a poll waits for its answer', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    const afterLoad = mineCalls(f)
    const slow = baseFixture()
    f.setFixture({ ...slow, 'GET merge_requests': { ...(slow['GET merge_requests'] as object), sleepMs: 2_000 } })

    // Act
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(afterLoad)

    // Assert: while the slow answer is on its way, the rows are all there and no loading text shows
    for (let n = 0; n < 6; n++) {
      await expect(rows(page)).toHaveCount(5, { timeout: 100 })
      await expect(page.getByText('Reading changes…')).toHaveCount(0)
      await page.waitForTimeout(200)
    }
  })

  test('a failed poll keeps the old rows and shows the error lines', async () => {
    // Arrange
    const { page } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await expect(page.getByTestId('mine-error')).toHaveCount(0)
    forge?.setFixture({ ...baseFixture(), 'GET merge_requests': { fail: 'HTTP 503 maintenance' }, 'GET search/issues': { fail: 'HTTP 500 down' } })

    // Act
    await page.clock.fastForward(60_000)

    // Assert
    await expect(page.getByTestId('mine-error')).toHaveCount(2)
    await expect(page.getByTestId('mine-error').filter({ hasText: 'gitlab.com' })).toHaveCount(1)
    await expect(page.getByTestId('mine-error').filter({ hasText: 'github.com' })).toHaveCount(1)
    for (const t of ['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri']) await expect(row(page, t)).toHaveCount(1)
    await expect(rows(page)).toHaveCount(5)
  })
})

type SortKey = (typeof SORT_KEYS)[number]
const sortBtn = (page: Page, key: SortKey): Locator => page.getByTestId(`sort-${key}`)
const titles = (page: Page): Promise<string[]> => page.locator(`${ROWS} td.titlecell > div:first-child`).allTextContents()
/** The order of headers (G) and rows, with each row as its title. */
const layout = (page: Page): Promise<string[]> =>
  page
    .locator(`[data-testid="group-row"], ${ROWS}`)
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'group-row' ? 'G' : (e.querySelector('td.titlecell > div')?.textContent ?? ''))))

test.describe('sorting the list', () => {
  test('the columns are the 14 of the MR list after the checkbox, each one but the checkbox is a sort button, and Updated is sorted newest first at the start', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    expect(await headerTexts(page)).toEqual(HEADERS)
    for (const key of SORT_KEYS) await expect(sortBtn(page, key)).toHaveClass(/link/)
    await expect(page.locator('table thead th').first().locator('button')).toHaveCount(0)
    await expect(sortBtn(page, 'updated')).toHaveText('Updated ▼')
    await expect(sortBtn(page, 'updated').locator('xpath=..')).toHaveAttribute('aria-sort', 'descending')
    for (const key of SORT_KEYS.filter((k) => k !== 'updated')) {
      await expect(sortBtn(page, key)).not.toContainText(/[▲▼]/)
      await expect(sortBtn(page, key).locator('xpath=..')).toHaveAttribute('aria-sort', 'none')
    }
    await expect(rows(page).first().locator('td').nth(1)).toContainText(GL)
  })

  // With grouping off and every pill on the 9 changes are in one list. Repos: acme/web has Birch, Hazel, Juniper, team/backend/x has the rest.
  // Updated: Aspen 1d, Birch 1.5d, Cedar 2d, Dogwood 3d, Elm 4d, Fir 5d, Hazel 6d, Juniper 7d, Kauri 90d. The tie-break (newest first) does not flip.
  const FLAT_ORDERS: [SortKey, string[], string[]][] = [
    [
      'repo',
      ['Birch', 'Hazel', 'Juniper', 'Aspen', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Kauri'],
      ['Aspen', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Kauri', 'Birch', 'Hazel', 'Juniper']
    ],
    [
      'state',
      ['Cedar', 'Juniper', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'Fir', 'Hazel'],
      ['Hazel', 'Fir', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'Cedar', 'Juniper']
    ],
    [
      'title',
      ['Aspen', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Hazel', 'Juniper', 'Kauri'],
      ['Kauri', 'Juniper', 'Hazel', 'Fir', 'Elm', 'Dogwood', 'Cedar', 'Birch', 'Aspen']
    ],
    [
      'author',
      ['Aspen', 'Cedar', 'Fir', 'Kauri', 'Birch', 'Dogwood', 'Elm', 'Hazel', 'Juniper'],
      ['Juniper', 'Hazel', 'Elm', 'Dogwood', 'Birch', 'Aspen', 'Cedar', 'Fir', 'Kauri']
    ],
    [
      'updated',
      ['Kauri', 'Juniper', 'Hazel', 'Fir', 'Elm', 'Dogwood', 'Cedar', 'Birch', 'Aspen'],
      ['Aspen', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Hazel', 'Juniper', 'Kauri']
    ]
  ]
  for (const [key, asc, desc] of FLAT_ORDERS) {
    test(`a click on ${key} sorts the flat list ascending, a second click descending, a third ascending again`, async () => {
      // Arrange
      const { page } = await start(baseFixture())
      await openTab(page, 'assigned')
      await showAll(page)
      await modeBtn(page, 'No group').click()
      // Updated is sorted at the start, so a click on it is the second click of its own cycle: go through another column first
      if (key === 'updated') await sortBtn(page, 'title').click()

      // Act and assert: first click, ascending
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▲')
      await expect(sortBtn(page, key).locator('xpath=..')).toHaveAttribute('aria-sort', 'ascending')
      expect(await titles(page)).toEqual(asc)

      // Act and assert: second click, descending
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▼')
      await expect(sortBtn(page, key).locator('xpath=..')).toHaveAttribute('aria-sort', 'descending')
      expect(await titles(page)).toEqual(desc)

      // Act and assert: third click, ascending again
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▲')
      expect(await titles(page)).toEqual(asc)
      // Only one column carries an arrow
      await expect(page.locator('[data-testid^="sort-"]').filter({ hasText: /[▲▼]/ })).toHaveCount(1)
    })
  }

  test('a click on Updated at the start sorts it oldest first', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')

    // Act
    await sortBtn(page, 'updated').click()

    // Assert: Open only is on, so Aspen, Birch, Dogwood, Elm and Kauri
    await expect(sortBtn(page, 'updated')).toContainText('▲')
    expect(await titles(page)).toEqual(['Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen'])
  })

  test('with grouping on the sort works inside each group, and the group order stays Draft, Open, Merged, Closed', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await showAll(page)

    // Act and assert: Title ascending
    await sortBtn(page, 'title').click()
    expect(await layout(page)).toEqual(['G', 'Cedar', 'Juniper', 'G', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'G', 'Fir', 'G', 'Hazel'])

    // Act and assert: Title descending, the groups do not move
    await sortBtn(page, 'title').click()
    expect(await layout(page)).toEqual(['G', 'Juniper', 'Cedar', 'G', 'Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen', 'G', 'Fir', 'G', 'Hazel'])
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Draft/, /^[▴▾]?\s*Open/, /^[▴▾]?\s*Merged/, /^[▴▾]?\s*Closed/])

    // Act and assert: Repo descending puts team/backend/x before acme/web inside a group (Birch and Juniper are acme/web)
    await sortBtn(page, 'repo').click()
    await sortBtn(page, 'repo').click()
    expect(await layout(page)).toEqual(['G', 'Cedar', 'Juniper', 'G', 'Aspen', 'Dogwood', 'Elm', 'Kauri', 'Birch', 'G', 'Fir', 'G', 'Hazel'])
  })

  test('sorting by State with grouping on still shows the arrow, and inside a group only the tie-break orders the rows', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await showAll(page)

    // Act
    await sortBtn(page, 'state').click()
    await sortBtn(page, 'state').click()

    // Assert: descending, but the groups and the newest-first order inside them are as at the start
    await expect(sortBtn(page, 'state')).toContainText('▼')
    expect(await layout(page)).toEqual(['G', 'Cedar', 'Juniper', 'G', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'G', 'Fir', 'G', 'Hazel'])
  })

  test('each list tab has its own sort, and a tab shows its own sort again when it is shown again', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await sortBtn(page, 'title').click()
    await sortBtn(page, 'title').click()
    expect(await titles(page)).toEqual(['Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen'])

    // Act
    await openTab(page, 'reviewer')

    // Assert: the reviewer tab starts with its own default sort, Updated, newest first
    await expect(sortBtn(page, 'updated')).toContainText('▼')
    await expect(sortBtn(page, 'title')).not.toContainText(/[▲▼]/)

    // Act and assert: a sort in the reviewer tab does not change the first tab, which shows its own sort again
    await sortBtn(page, 'title').click()
    expect(await titles(page)).toEqual(['Elm', 'Linden', 'Nettle'])
    await openTab(page, 'assigned')
    await expect(sortBtn(page, 'title')).toContainText('▼')
    expect(await titles(page)).toEqual(['Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen'])
  })

  test('the sort is kept across a refresh and across a poll', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await sortBtn(page, 'title').click()
    expect(await titles(page)).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])
    const apple: SeedChange = { provider: 'gitlab', project: GL, iid: 50, title: 'Apple', state: 'opened', author: 'lee', updatedAt: ago(30), assigned: true }
    f.setFixture(baseFixture([...SEED, apple]))

    // Act and assert: Refresh
    await page.getByTestId('mine-refresh').click()
    await expect(row(page, 'Apple')).toHaveCount(1)
    expect(await titles(page)).toEqual(['Apple', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])

    // Act and assert: poll, with one more change
    const pear: SeedChange = { provider: 'gitlab', project: GL, iid: 51, title: 'Pear', state: 'opened', author: 'lee', updatedAt: ago(0.2), assigned: true }
    f.setFixture(baseFixture([...SEED, apple, pear]))
    await page.clock.fastForward(60_000)
    await expect(row(page, 'Pear')).toHaveCount(1)
    expect(await titles(page)).toEqual(['Apple', 'Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri', 'Pear'])
    await expect(sortBtn(page, 'title')).toContainText('▲')
  })

  test('the sort is kept when the app starts again', async () => {
    // Arrange
    const env = makeEnv()
    const first = await start(baseFixture(), { env })
    await openTab(first.page, 'assigned')
    await sortBtn(first.page, 'title').click()
    await expect(sortBtn(first.page, 'title')).toContainText('▲')
    await app?.close()
    await forge?.close()

    // Act
    const { page } = await start(baseFixture(), { env })
    await openTab(page, 'assigned')

    // Assert
    await expect(sortBtn(page, 'title')).toContainText('▲')
    await expect(sortBtn(page, 'updated')).not.toContainText(/[▲▼]/)
  })
})

// People on the grid. Everyone here is open, so the default pills show all the rows.
// GitLab names come from the fixture (ann is "Zoe Alder" so that the order by display name differs from the order by username). GitHub shows the login.
const PEOPLE = { ann: { name: 'Zoe Alder' }, bob: { name: 'Bob Builder' }, cy: { name: 'Cy Young' }, dee: { name: 'Dee Dee' } }
const PEOPLE_SEED: SeedChange[] = [
  {
    provider: 'gitlab',
    project: GL,
    iid: 101,
    title: 'Alder',
    state: 'opened',
    author: 'ann',
    updatedAt: ago(1),
    assigned: true,
    reviewers: ['bob', 'cy'],
    approvedBy: ['cy']
  },
  { provider: 'gitlab', project: GL, iid: 102, title: 'Beech', state: 'opened', author: 'ann', updatedAt: ago(2), assigned: true },
  {
    provider: 'gitlab',
    project: GL,
    iid: 103,
    title: 'Cypress',
    state: 'opened',
    author: 'dee',
    updatedAt: ago(3),
    assigned: true,
    reviewer: true,
    approvedBy: ['bob', 'me']
  },
  {
    provider: 'github',
    project: GH,
    iid: 201,
    title: 'Dune',
    state: 'opened',
    author: 'eve',
    updatedAt: ago(4),
    assigned: true,
    reviewers: ['fay'],
    // gus approves. ivy only comments. hal approves and then asks for changes, so the approval is gone. jon approves and then comments, so it stays.
    // kim asks for changes and then approves. zed has a pending review, which is not a review yet. eve is the author.
    reviews: [
      { user: 'gus', state: 'APPROVED' },
      { user: 'ivy', state: 'COMMENTED' },
      { user: 'hal', state: 'APPROVED' },
      { user: 'hal', state: 'CHANGES_REQUESTED' },
      { user: 'jon', state: 'APPROVED' },
      { user: 'jon', state: 'COMMENTED' },
      { user: 'kim', state: 'CHANGES_REQUESTED' },
      { user: 'kim', state: 'APPROVED' },
      { user: 'zed', state: 'PENDING' },
      { user: 'eve', state: 'COMMENTED' }
    ]
  },
  { provider: 'github', project: GH, iid: 202, title: 'Elder', state: 'opened', author: 'eve', updatedAt: ago(5), assigned: true }
]
const peopleFixture = (extra: { snapshotSleepMs?: number } = {}): Fixture => changesFixture(PEOPLE_SEED, { people: PEOPLE, ...extra })
const PEOPLE_HEADER = { author: 'Author', reviewers: 'Reviewers', approvals: 'Approved by' } as const
const cellOf = (page: Page, title: string, which: keyof typeof PEOPLE_HEADER): Locator => cellAt(row(page, title), PEOPLE_HEADER[which])
const usersIn = (cell: Locator): Promise<string[]> => cell.locator('.avatar').evaluateAll((els) => els.map((e) => e.getAttribute('data-user') ?? ''))
/** Waits until no cell of a row shows the quiet placeholder any more, so every snapshot has answered or failed. */
const snapshotsLoaded = (page: Page): Promise<void> => expect(page.locator(`${ROWS} td`).filter({ hasText: '…' })).toHaveCount(0, { timeout: 2 * SHORT })
/** The calls that read one change itself: the first call of a full read. GitLab `projects/<path>/merge_requests/<iid>`, GitHub `repos/<repo>/pulls/<n>`. */
const GL_READ = /^projects\/([^/]+)\/merge_requests\/(\d+)$/
const GH_READ = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/
const readUrls = (f: FakeForge): string[] =>
  f.calls.flatMap((c) => {
    const gl = GL_READ.exec(c.endpoint)
    if (gl) return [`https://gitlab.com/${decodeURIComponent(gl[1])}/-/merge_requests/${gl[2]}`]
    const gh = GH_READ.exec(c.endpoint)
    return gh ? [`https://github.com/${gh[1]}/pull/${gh[2]}`] : []
  })
const readCount = (f: FakeForge, url: string): number => readUrls(f).filter((u) => u === url).length

test.describe('people on the grid', () => {
  test('the author cell shows one avatar with the display name and the username in the tooltip, on GitLab and GitHub', async () => {
    // Arrange
    const { page } = await start(peopleFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    await expect(cellOf(page, 'Alder', 'author').locator('.avatar')).toHaveCount(1)
    await expect(cellOf(page, 'Alder', 'author').locator('.avatar')).toHaveAttribute('title', 'Zoe Alder (@ann)')
    await expect(cellOf(page, 'Alder', 'author').locator('.avatar')).toHaveAttribute('data-user', 'ann')
    await expect(cellOf(page, 'Dune', 'author').locator('.avatar')).toHaveAttribute('title', 'eve (@eve)')
  })

  test('the reviewers and approvals cells show the people with their names in the tooltip, and a dash when there is nobody', async () => {
    // Arrange
    const { page } = await start(peopleFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert: Alder has two reviewers and one approval
    expect(await usersIn(cellOf(page, 'Alder', 'reviewers'))).toEqual(['bob', 'cy'])
    await expect(cellOf(page, 'Alder', 'reviewers').locator('.avatar').first()).toHaveAttribute('title', 'Bob Builder (@bob)')
    await expect(cellOf(page, 'Alder', 'reviewers').locator('.avatar').nth(1)).toHaveAttribute('title', 'Cy Young (@cy)')
    expect(await usersIn(cellOf(page, 'Alder', 'approvals'))).toEqual(['cy'])
    await expect(cellOf(page, 'Alder', 'approvals').locator('.avatar')).toHaveAttribute('title', 'Cy Young (@cy)')
    // Beech has nobody
    await expect(cellOf(page, 'Beech', 'reviewers')).toHaveText('–')
    await expect(cellOf(page, 'Beech', 'approvals')).toHaveText('–')
    await expect(cellOf(page, 'Beech', 'reviewers').locator('.avatar')).toHaveCount(0)
    // The viewer carries ", you" in the tooltip
    await expect(cellOf(page, 'Cypress', 'reviewers').locator('.avatar')).toHaveAttribute('title', 'Me Tester (@me), you')
    expect((await usersIn(cellOf(page, 'Cypress', 'approvals'))).sort()).toEqual(['bob', 'me'])
    await expect(cellOf(page, 'Cypress', 'approvals').locator('.avatar[data-user="me"]')).toHaveAttribute('title', 'Me Tester (@me), you')
    await expect(cellOf(page, 'Cypress', 'approvals').locator('.avatar[data-user="bob"]')).toHaveAttribute('title', 'Bob Builder (@bob)')
  })

  test('on GitHub the reviewers are the requested ones and everyone who reviewed, and the approvals are the latest verdicts', async () => {
    // Arrange
    const { page, forge: f } = await start(peopleFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert: requested fay first, then reviewers in the order of their first review. Not zed (pending) and not eve (the author).
    expect(await usersIn(cellOf(page, 'Dune', 'reviewers'))).toEqual(['fay', 'gus', 'ivy', 'hal', 'jon', 'kim'])
    await expect(cellOf(page, 'Dune', 'reviewers').locator('.avatar[data-user="fay"]')).toHaveAttribute('title', 'fay (@fay)')
    // hal's approval was cancelled by a later request for changes, ivy only commented, kim's later approval stands
    expect((await usersIn(cellOf(page, 'Dune', 'approvals'))).sort()).toEqual(['gus', 'jon', 'kim'])
    await expect(cellOf(page, 'Elder', 'reviewers')).toHaveText('–')
    await expect(cellOf(page, 'Elder', 'approvals')).toHaveText('–')
    // The full read is made of GET calls to the endpoints that were agreed, and the threads come from GraphQL
    expect(
      f.calls.filter((c) => GH_READ.test(c.endpoint) || GL_READ.test(c.endpoint) || c.endpoint.endsWith('/reviews')).every((c) => c.method === 'GET')
    ).toBe(true)
    expect(f.calls.some((c) => c.endpoint === 'graphql' && c.method === 'POST')).toBe(true)
    expect(f.calls.some((c) => c.endpoint === 'repos/acme/web/pulls/201')).toBe(true)
    expect(f.calls.some((c) => c.endpoint === 'repos/acme/web/pulls/201/reviews')).toBe(true)
    expect(f.calls.some((c) => c.endpoint === `projects/${encodeURIComponent(GL)}/merge_requests/101/approvals`)).toBe(true)
  })

  test('the list shows at once from the list call: the GitLab reviewers are there while the approvals show a placeholder, and the GitHub reviewers wait with them', async () => {
    // Arrange
    const { page } = await start(peopleFixture({ snapshotSleepMs: 2_500 }))

    // Act
    await openTab(page, 'assigned')

    // Assert: before the slow detail calls answer
    await expect(cellOf(page, 'Alder', 'author').locator('.avatar')).toHaveCount(1)
    expect(await usersIn(cellOf(page, 'Alder', 'reviewers'))).toEqual(['bob', 'cy'])
    await expect(cellOf(page, 'Alder', 'approvals')).toHaveText('…')
    await expect(cellOf(page, 'Dune', 'reviewers')).toHaveText('…')
    await expect(cellOf(page, 'Dune', 'approvals')).toHaveText('…')

    // Assert: the cells fill in when the answers arrive
    await snapshotsLoaded(page)
    expect(await usersIn(cellOf(page, 'Alder', 'approvals'))).toEqual(['cy'])
    expect((await usersIn(cellOf(page, 'Dune', 'approvals'))).sort()).toEqual(['gus', 'jon', 'kim'])
    await expect(cellOf(page, 'Beech', 'approvals')).toHaveText('–')
  })

  test('a poll does not repeat the detail calls of a change that did not change, and a change with a new updated time is read again alone', async () => {
    // Arrange
    const { page, forge: f } = await start(peopleFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const approvals = (iid: number): number => f.calls.filter((c) => c.endpoint === `projects/${encodeURIComponent(GL)}/merge_requests/${iid}/approvals`).length
    const afterLoad = readUrls(f).length
    // One full read for each of the 5 changes
    expect(afterLoad).toBe(5)
    const lists = mineCalls(f)

    // Act: a poll with nothing new
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(lists)
    await page.waitForTimeout(QUIET_MS)

    // Assert: the cells are still full and no detail call was repeated
    expect(readUrls(f).length).toBe(afterLoad)
    expect(await usersIn(cellOf(page, 'Alder', 'approvals'))).toEqual(['cy'])

    // Act: Alder is updated and the others are not
    const changed = PEOPLE_SEED.map((c) => (c.iid === 101 ? { ...c, updatedAt: ago(0.01), approvedBy: ['cy', 'dee'] } : c))
    f.setFixture(changesFixture(changed, { people: PEOPLE }))
    const alderBefore = approvals(101)
    const listsBefore = mineCalls(f)
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(listsBefore)

    // Assert: only Alder was read again, and its new approval shows
    await expect.poll(() => approvals(101)).toBe(alderBefore + 1)
    await expect.poll(async () => (await usersIn(cellOf(page, 'Alder', 'approvals'))).sort()).toEqual(['cy', 'dee'])
    await page.waitForTimeout(QUIET_MS)
    expect(approvals(101)).toBe(alderBefore + 1)
    expect(readCount(f, glUrl(101))).toBe(2)
    expect(readCount(f, glUrl(102))).toBe(1)
    expect(readCount(f, glUrl(103))).toBe(1)
    expect(readCount(f, ghUrl(201))).toBe(1)
    expect(readCount(f, ghUrl(202))).toBe(1)
    expect(approvals(102)).toBe(1)
    expect(approvals(103)).toBe(1)
    expect(f.calls.filter((c) => c.endpoint === 'repos/acme/web/pulls/201').length).toBe(1)
    expect(f.calls.filter((c) => c.endpoint === 'repos/acme/web/pulls/201/reviews').length).toBe(1)
  })

  test('a refresh does not blank the people cells while it waits for the lists', async () => {
    // Arrange
    const { page, forge: f } = await start(peopleFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const slow = peopleFixture()
    f.setFixture({ ...slow, 'GET merge_requests': { ...(slow['GET merge_requests'] as object), sleepMs: 2_000 } })
    const before = mineCalls(f)

    // Act
    await page.getByTestId('mine-refresh').click()
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(before)

    // Assert: while the slow answer is on its way
    for (let n = 0; n < 5; n++) {
      expect(await usersIn(cellOf(page, 'Alder', 'approvals'))).toEqual(['cy'])
      expect(await usersIn(cellOf(page, 'Alder', 'reviewers'))).toEqual(['bob', 'cy'])
      expect((await usersIn(cellOf(page, 'Dune', 'reviewers'))).length).toBe(6)
      await page.waitForTimeout(250)
    }
  })

  test('no more than 6 detail calls are open at the same time, and each change is read once', async () => {
    // Arrange: 14 open GitLab changes, each answer takes 300 ms
    const many: SeedChange[] = Array.from({ length: 14 }, (_, n) => ({
      provider: 'gitlab' as const,
      project: GL,
      iid: 300 + n,
      title: `Bulk${n}`,
      state: 'opened' as const,
      author: 'ann',
      updatedAt: ago(1 + n / 100),
      assigned: true,
      approvedBy: ['bob']
    }))
    const { page, forge: f } = await start(changesFixture(many, { people: PEOPLE, snapshotSleepMs: 300 }))
    const peak = f.trackPeak(/\/approvals$/)
    const readPeak = f.trackPeak(/^projects\/[^/]+\/merge_requests\/\d+$/)

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    expect(f.calls.filter((c) => c.endpoint.endsWith('/approvals')).length).toBe(14)
    expect(readUrls(f)).toHaveLength(14)
    expect(new Set(readUrls(f)).size).toBe(14)
    expect(peak.max).toBeLessThanOrEqual(6)
    expect(peak.max).toBeGreaterThan(1)
    expect(readPeak.max).toBeLessThanOrEqual(6)
    expect(readPeak.max).toBeGreaterThan(1)
    await expect(page.locator('[data-testid^="approvals-"]').locator('.avatar[data-user="bob"]')).toHaveCount(14)
  })

  test('a detail call that fails leaves a dash for that change, keeps the row and raises no error line', async () => {
    // Arrange: every GitLab approvals call fails, GitHub is fine
    const { page } = await start({ ...peopleFixture(), 'GET projects/*/merge_requests/*/approvals': { fail: 'HTTP 500 boom' } })

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    await expect(rows(page)).toHaveCount(5)
    await expect(page.getByTestId('mine-error')).toHaveCount(0)
    await expect(cellOf(page, 'Alder', 'approvals')).toHaveText('–')
    expect(await usersIn(cellOf(page, 'Alder', 'reviewers'))).toEqual(['bob', 'cy'])
    expect((await usersIn(cellOf(page, 'Dune', 'approvals'))).sort()).toEqual(['gus', 'jon', 'kim'])
  })

  // Reviewers: Alder 2, Beech 0, Cypress 1, Dune 6, Elder 0. Approvals: Alder 1, Beech 0, Cypress 2, Dune 3, Elder 0.
  // Updated: Alder 1d, Beech 2d, Cypress 3d, Dune 4d, Elder 5d. The tie of Beech and Elder is decided by the newer one, in both directions.
  // Display names: Zoe Alder (Alder, Beech), Dee Dee (Cypress), eve (Dune, Elder), which is another order than the usernames ann, dee, eve.
  const PEOPLE_ORDERS: [SortKey, string[], string[]][] = [
    ['reviewers', ['Beech', 'Elder', 'Cypress', 'Alder', 'Dune'], ['Dune', 'Alder', 'Cypress', 'Beech', 'Elder']],
    ['approved', ['Beech', 'Elder', 'Alder', 'Cypress', 'Dune'], ['Dune', 'Cypress', 'Alder', 'Beech', 'Elder']],
    ['author', ['Cypress', 'Dune', 'Elder', 'Alder', 'Beech'], ['Alder', 'Beech', 'Dune', 'Elder', 'Cypress']]
  ]
  for (const [key, asc, desc] of PEOPLE_ORDERS) {
    test(`a click on ${key} sorts by it, ascending and then descending`, async () => {
      // Arrange
      const { page } = await start(peopleFixture())
      await openTab(page, 'assigned')
      await snapshotsLoaded(page)
      await modeBtn(page, 'No group').click()

      // Act and assert
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▲')
      expect(await titles(page)).toEqual(asc)
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▼')
      expect(await titles(page)).toEqual(desc)
    })
  }
})

test.describe('collapsing the groups', () => {
  const toggle = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) the ${name} group`) })

  test('a chevron on every group header hides and shows its rows, and the header keeps its count', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await pill(page, 'Draft').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Draft\s*·\s*2$/, /^[▴▾]?\s*Open\s*·\s*5$/])

    // Assert: both groups start open, with the up chevron
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page, 'Open')).toHaveText('▴')
    await expect(toggle(page, 'Draft')).toHaveText('▴')
    await expect(rows(page)).toHaveCount(7)

    // Act: collapse Open
    await toggle(page, 'Open').click()

    // Assert: its five rows are gone, the Draft rows stay, and the header still counts 5 with the down chevron
    await expect(rows(page)).toHaveCount(2)
    for (const t of ['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri']) await expect(row(page, t)).toHaveCount(0)
    await expect(row(page, 'Cedar')).toHaveCount(1)
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Draft\s*·\s*2$/, /^[▴▾]?\s*Open\s*·\s*5$/])
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page, 'Open')).toHaveText('▾')
    await expect(toggle(page, 'Open')).toHaveAccessibleName(/^Expand the Open group/)

    // Act: collapse Draft as well, then expand Open again
    await toggle(page, 'Draft').click()
    await expect(rows(page)).toHaveCount(0)
    await toggle(page, 'Open').click()

    // Assert
    await expect(rows(page)).toHaveCount(5)
    await expect(row(page, 'Aspen')).toHaveCount(1)
    await expect(row(page, 'Cedar')).toHaveCount(0)
  })

  test('a click on the group header itself also toggles the group', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')

    // Act
    await page.getByTestId('group-row').getByText(/Open/).click()

    // Assert
    await expect(rows(page)).toHaveCount(0)
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'false')
  })

  test('a collapsed group stays collapsed after a tab switch and after a poll, and a ticked row inside it stays ticked and counted', async () => {
    // Arrange
    const { page } = await start(baseFixture(), { clock: true })
    await openTab(page, 'assigned')
    await row(page, 'Aspen').getByRole('checkbox').check()
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')

    // Act
    await toggle(page, 'Open').click()
    await expect(rows(page)).toHaveCount(0)
    await page.clock.fastForward(60_000)
    await openTab_noRows(page, 'reviewer')
    await openTab_noRows(page, 'assigned')

    // Assert: still collapsed, the selection is intact
    await expect(page.getByTestId('group-row')).toHaveCount(1)
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'false')
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
    await toggle(page, 'Open').click()
    await expect(row(page, 'Aspen').getByRole('checkbox')).toBeChecked()
  })

  test('with the grouping switched off there are no headers and every row shows', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await toggle(page, 'Open').click()
    await expect(rows(page)).toHaveCount(0)

    // Act
    await modeBtn(page, 'No group').click()

    // Assert
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(5)
  })
})

/** Switches to a mine tab without waiting for a row, because a collapsed group shows none. */
async function openTab_noRows(page: Page, which: 'assigned' | 'reviewer'): Promise<void> {
  await tab(page, which).click()
  await expect(tab(page, which)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('group-row').first()).toBeVisible({ timeout: SHORT })
}

test.describe('grouping by repo', () => {
  const toggle = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) the ${name} group`) })
  // Open changes assigned to the user: acme/web has Birch, team/backend/x has Aspen, Dogwood, Elm and Kauri. Zinnia is a third repo that sorts between them.
  const zinnia: SeedChange = {
    provider: 'gitlab',
    project: 'team/api',
    iid: 31,
    title: 'Zinnia',
    state: 'opened',
    author: 'ann',
    updatedAt: ago(0.5),
    assigned: true
  }
  const withZinnia = (): Fixture => baseFixture([...SEED, zinnia])

  test('Repo shows a header for each repo in alphabetical order with the count of the shown rows, and the rows sit under their header', async () => {
    // Arrange
    const { page } = await start(withZinnia())
    await openTab(page, 'assigned')

    // Act
    await modeBtn(page, 'Repository').click()

    // Assert
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'true')
    await expect(modeBtn(page, 'State')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/api\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*4$/])
    const order = await page
      .locator(`[data-testid="group-row"], ${ROWS}`)
      .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'group-row' ? 'G' : (e.querySelector('td.titlecell > div')?.textContent ?? ''))))
    expect(order).toEqual(['G', 'Birch', 'G', 'Zinnia', 'G', 'Aspen', 'Dogwood', 'Elm', 'Kauri'])
  })

  test('the rows inside a repo follow the column sort, and the repos stay ascending whatever the sort', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await modeBtn(page, 'Repository').click()
    await expect(page.getByTestId('group-row')).toHaveCount(2)

    // Act: Title ascending, then descending
    await page.getByTestId('sort-title').click()

    // Assert
    expect(await titles(page)).toEqual(['Birch', 'Aspen', 'Dogwood', 'Elm', 'Kauri'])

    // Act
    await page.getByTestId('sort-title').click()

    // Assert
    expect(await titles(page)).toEqual(['Birch', 'Kauri', 'Elm', 'Dogwood', 'Aspen'])
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web/, /^[▴▾]?\s*team\/backend\/x/])

    // Act: sort by Repo descending, the groups stay ascending
    await page.getByTestId('sort-repo').click()
    await page.getByTestId('sort-repo').click()

    // Assert
    await expect(page.getByTestId('sort-repo')).toContainText('▼')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web/, /^[▴▾]?\s*team\/backend\/x/])
  })

  test('the state pills filter the repos: the counts follow the shown rows and a repo without shown rows has no header', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await modeBtn(page, 'Repository').click()

    // Act: show every state
    await showAll(page)

    // Assert: acme/web has Birch open, Hazel closed, Juniper draft. team/backend/x has Aspen, Dogwood, Elm, Kauri open, Cedar draft, Fir merged
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*3$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*6$/])

    // Act: hide Open, Draft and Merged, so only Hazel in acme/web is left
    await pill(page, 'Open').click()
    await pill(page, 'Draft').click()
    await pill(page, 'Merged').click()

    // Assert
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/])
    await expect(rows(page)).toHaveCount(1)
  })

  test('a chevron collapses a repo and keeps its count, and a ticked row inside it stays counted', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await modeBtn(page, 'Repository').click()
    await row(page, 'Kauri').getByRole('checkbox').check()

    // Act
    await toggle(page, 'team/backend/x').click()

    // Assert
    await expect(rows(page)).toHaveCount(1)
    await expect(row(page, 'Birch')).toHaveCount(1)
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*4$/])
    await expect(toggle(page, 'team/backend/x')).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page, 'team/backend/x')).toHaveText('▾')
    await expect(toggle(page, 'acme/web')).toHaveText('▴')
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
  })

  test('a collapsed group is kept for each mode: collapsing Open in State mode collapses nothing in Repo mode, and it is still collapsed back in State mode', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await toggle(page, 'Open').click()
    await expect(rows(page)).toHaveCount(0)

    // Act
    await modeBtn(page, 'Repository').click()

    // Assert
    await expect(rows(page)).toHaveCount(5)
    await expect(toggle(page, 'acme/web')).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page, 'team/backend/x')).toHaveAttribute('aria-expanded', 'true')

    // Act: collapse a repo, then go back to State mode
    await toggle(page, 'acme/web').click()
    await modeBtn(page, 'State').click()

    // Assert: the Open group is still collapsed from before
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'false')
    await expect(rows(page)).toHaveCount(0)

    // Act and assert: in Repo mode the repo is still collapsed too
    await modeBtn(page, 'Repository').click()
    await expect(toggle(page, 'acme/web')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(page, 'Aspen')).toHaveCount(1)
    await expect(row(page, 'Birch')).toHaveCount(0)
  })

  test('Updated puts the rows under age headers, newest first, and Repository is the name of the repo button', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')

    // Act
    await modeBtn(page, 'Updated').click()

    // Assert: every header is one of the age groups, in the order of their age
    await expect(modeBtn(page, 'Updated')).toHaveAttribute('aria-pressed', 'true')
    const names = (await page.getByTestId('group-row').allTextContents()).map((t) =>
      t
        .replace(/[▴▾]/g, '')
        .replace(/\s*·.*$/, '')
        .trim()
    )
    const order = ['Today', 'Past few days', 'Past few weeks', 'Months ago']
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((n) => order.includes(n))).toBe(true)
    expect(names).toEqual([...names].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  })

  test('No group removes every header and shows one flat list, and Repo brings the headers back', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await modeBtn(page, 'Repository').click()
    await expect(page.getByTestId('group-row')).toHaveCount(2)

    // Act
    await modeBtn(page, 'No group').click()

    // Assert
    await expect(modeBtn(page, 'No group')).toHaveAttribute('aria-pressed', 'true')
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^(Collapse|Expand) the / })).toHaveCount(0)
    expect(await titles(page)).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])

    // Act
    await modeBtn(page, 'Repository').click()

    // Assert
    await expect(page.getByTestId('group-row')).toHaveCount(2)
  })

  test('each list tab has its own group mode, and each one is kept after a poll', async () => {
    // Arrange
    const { page, forge: f } = await start(withZinnia(), { clock: true })
    await openTab(page, 'assigned')

    // Act
    await modeBtn(page, 'Repository').click()
    await openTab(page, 'reviewer')

    // Assert: the reviewer tab still has the default group State
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'false')
    await expect(modeBtn(page, 'State')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*3$/])

    // Act: choose Repository here too. Nettle (acme/web) and Linden, Elm (team/backend/x) are the open reviewer changes
    await modeBtn(page, 'Repository').click()
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*2$/])

    // Act
    const before = mineCalls(f)
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(before)

    // Assert
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveCount(2)
    await openTab(page, 'assigned')
    await expect(modeBtn(page, 'Repository')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/api\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*4$/])
  })
})

// The approval filter and the group mode Approval.
// Open: Alpha, Bravo and Delta are approved, Charlie and Echo are not. Draft: Foxtrot is approved, Golf is not.
// Merged: Hotel is approved, India is not. Closed: Juliet is not approved. Kilo (approved) and Lima (not approved) are open and only for the reviewer tab.
const APPROVAL_SEED: SeedChange[] = [
  { provider: 'gitlab', project: GL, iid: 301, title: 'Alpha', state: 'opened', author: 'ann', updatedAt: ago(1), assigned: true, approvedBy: ['bob'] },
  { provider: 'gitlab', project: GL, iid: 302, title: 'Bravo', state: 'opened', author: 'ann', updatedAt: ago(2), assigned: true, approvedBy: ['bob', 'cy'] },
  { provider: 'gitlab', project: GL, iid: 303, title: 'Charlie', state: 'opened', author: 'ann', updatedAt: ago(3), assigned: true },
  { provider: 'github', project: GH, iid: 401, title: 'Delta', state: 'opened', author: 'eve', updatedAt: ago(4), assigned: true, approvedBy: ['gus'] },
  { provider: 'github', project: GH, iid: 402, title: 'Echo', state: 'opened', author: 'eve', updatedAt: ago(5), assigned: true },
  { provider: 'gitlab', project: GL, iid: 304, title: 'Foxtrot', state: 'draft', author: 'ann', updatedAt: ago(6), assigned: true, approvedBy: ['bob'] },
  { provider: 'gitlab', project: GL, iid: 305, title: 'Golf', state: 'draft', author: 'ann', updatedAt: ago(7), assigned: true },
  { provider: 'gitlab', project: GL, iid: 306, title: 'Hotel', state: 'merged', author: 'ann', updatedAt: ago(8), assigned: true, approvedBy: ['cy'] },
  { provider: 'gitlab', project: GL, iid: 307, title: 'India', state: 'merged', author: 'ann', updatedAt: ago(9), assigned: true },
  { provider: 'gitlab', project: GL, iid: 308, title: 'Juliet', state: 'closed', author: 'ann', updatedAt: ago(10), assigned: true },
  { provider: 'gitlab', project: GL, iid: 309, title: 'Kilo', state: 'opened', author: 'gus', updatedAt: ago(1.2), reviewer: true, approvedBy: ['dee'] },
  { provider: 'gitlab', project: GL, iid: 310, title: 'Lima', state: 'opened', author: 'hal', updatedAt: ago(2.2), reviewer: true }
]
const approvalFixture = (extra: { snapshotSleepMs?: number } = {}): Fixture => changesFixture(APPROVAL_SEED, extra)
const approvalGroup = (page: Page): Locator => page.getByRole('group', { name: 'Show change requests by approval' })
const apill = (page: Page, which: 'Approved' | 'Not approved'): Locator => approvalGroup(page).getByRole('button', { name: new RegExp(`^${which}`) })
const shownTitles = (page: Page): Promise<string[]> => rows(page).evaluateAll((els) => els.map((e) => e.querySelector('td.titlecell > div')?.textContent ?? ''))
const sortedTitles = async (page: Page): Promise<string[]> => (await shownTitles(page)).sort()

test.describe('the approval filter', () => {
  test('a second pill group Show changes by approval has the pills Approved and Not approved, both on at the start, and shows the same rows as before', async () => {
    // Arrange
    const { page } = await start(approvalFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    const group = approvalGroup(page)
    await expect(group).toHaveClass(/seg/)
    await expect(group).toHaveClass(/toggles/)
    await expect(group.getByRole('button')).toHaveCount(2)
    await expect(group.getByRole('button')).toHaveText([/^Approved/, /^Not approved/])
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'true')
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Show change requests by state' })).toHaveCount(1)
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
  })

  test('the approval pills count the loaded open changes by the approval rule, and one approval is enough', async () => {
    // Arrange
    const { page } = await start(approvalFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert: Alpha has one approval, Bravo two, Delta one on GitHub
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*3$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*2$/)
  })

  test('the approval counts follow the state pills, and the state pill counts ignore the approval pills', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act and assert: Draft on adds Foxtrot (approved) and Golf
    await pill(page, 'Draft').click()
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*4$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*3$/)

    // Act and assert: Open off leaves only the drafts
    await pill(page, 'Open').click()
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*1$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*1$/)

    // Act and assert: every state on
    await pill(page, 'Open').click()
    await pill(page, 'Merged').click()
    await pill(page, 'Closed').click()
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*5$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*5$/)

    // Act and assert: the approval pills do not change the state counts
    await apill(page, 'Approved').click()
    await apill(page, 'Not approved').click()
    await expect(pill(page, 'Draft')).toContainText('2')
    await expect(pill(page, 'Open')).toContainText('5')
    await expect(pill(page, 'Merged')).toContainText('2')
    await expect(pill(page, 'Closed')).toContainText('1')
  })

  test('the approval counts ignore the approval pills themselves', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act
    await apill(page, 'Approved').click()

    // Assert
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*3$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*2$/)
  })

  test('turning Approved off leaves the not approved changes, and turning it on shows the approved ones again', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act
    await apill(page, 'Approved').click()

    // Assert
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'false')
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'true')
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo'])

    // Act and assert
    await apill(page, 'Approved').click()
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'true')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
  })

  test('turning Not approved off leaves the approved changes', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act
    await apill(page, 'Not approved').click()

    // Assert
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'false')
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'true')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta'])
  })

  test('with both approval pills off the approval filters nothing: every row of the shown states shows, and the state pills still filter', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act
    await apill(page, 'Approved').click()
    await apill(page, 'Not approved').click()

    // Assert: the 5 open changes, the approved and the not approved ones, under one header
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'false')
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'false')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*5$/])
    await expect(page.getByTestId('new-review')).toHaveText('New review')

    // Act and assert: a state pill still filters
    await pill(page, 'Open').click()
    await pill(page, 'Draft').click()
    expect(await sortedTitles(page)).toEqual(['Foxtrot', 'Golf'])
  })

  test('with every state pill off the state filters nothing: all loaded changes show, and the approval counts then count all of them', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act: Open is the only pill that is on
    await pill(page, 'Open').click()

    // Assert: the 10 assigned changes show, under the four state headers
    for (const name of ['Draft', 'Open', 'Merged', 'Closed']) await expect(pill(page, name)).toHaveAttribute('aria-pressed', 'false')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'])
    await expect(page.getByTestId('group-row')).toHaveText([
      /^[▴▾]?\s*Draft\s*·\s*2$/,
      /^[▴▾]?\s*Open\s*·\s*5$/,
      /^[▴▾]?\s*Merged\s*·\s*2$/,
      /^[▴▾]?\s*Closed\s*·\s*1$/
    ])
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*5$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*5$/)

    // Act and assert: the approval pills still filter
    await apill(page, 'Approved').click()
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo', 'Golf', 'India', 'Juliet'])
  })

  test('a row shows only when its state pill and its approval pill are both on', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act: Draft on, Approved off
    await pill(page, 'Draft').click()
    await apill(page, 'Approved').click()

    // Assert: the not approved open and draft changes
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo', 'Golf'])

    // Act: Open off
    await pill(page, 'Open').click()

    // Assert
    expect(await sortedTitles(page)).toEqual(['Golf'])

    // Act: Not approved off, Approved on
    await apill(page, 'Not approved').click()
    await apill(page, 'Approved').click()

    // Assert
    expect(await sortedTitles(page)).toEqual(['Foxtrot'])
  })

  test('the filter works in every group mode and a group without shown rows has no header', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    await showAll(page)
    await apill(page, 'Not approved').click()

    // Assert: State mode, the approved changes only, so no Closed header
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Draft\s*·\s*1$/, /^[▴▾]?\s*Open\s*·\s*3$/, /^[▴▾]?\s*Merged\s*·\s*1$/])

    // Act and assert: Repo mode, Foxtrot, Alpha, Bravo and Hotel are in team/backend/x and Delta is in acme/web
    await modeBtn(page, 'Repository').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*4$/])
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta', 'Foxtrot', 'Hotel'])

    // Act and assert: No group
    await modeBtn(page, 'No group').click()
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta', 'Foxtrot', 'Hotel'])

    // Act and assert: Approval mode, one header
    await modeBtn(page, 'Approval').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*5$/])

    // Act and assert: swap the pills, Repo mode drops acme/web only when it has no row left
    await apill(page, 'Not approved').click()
    await apill(page, 'Approved').click()
    await modeBtn(page, 'Repository').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*acme\/web\s*·\s*1$/, /^[▴▾]?\s*team\/backend\/x\s*·\s*4$/])
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo', 'Golf', 'India', 'Juliet'])
  })

  test('the reviewer tab has its own approval filter with the counts of its own changes, and each tab keeps its choice when the tab changes', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Act
    await apill(page, 'Approved').click()
    await openTab(page, 'reviewer')
    await snapshotsLoaded(page)

    // Assert: Kilo is approved and Lima is not, and this tab still has both pills on, because the pill is off in the other tab only
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'true')
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'true')
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*1$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*1$/)
    expect(await sortedTitles(page)).toEqual(['Kilo', 'Lima'])

    // Act and assert: back on the first tab
    await openTab(page, 'assigned')
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'false')
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo'])
  })

  test('a poll keeps the approval pills and the rows they hide', async () => {
    // Arrange
    const { page, forge: f } = await start(approvalFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    await apill(page, 'Not approved').click()
    const before = mineCalls(f)

    // Act
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(before)

    // Assert
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'false')
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'true')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta'])
  })

  test('the approval pills are kept when the app starts again', async () => {
    // Arrange
    const env = makeEnv()
    const first = await start(approvalFixture(), { env })
    await openTab(first.page, 'assigned')
    await apill(first.page, 'Approved').click()
    await expect(apill(first.page, 'Approved')).toHaveAttribute('aria-pressed', 'false')
    await app?.close()
    await forge?.close()

    // Act
    const { page } = await start(approvalFixture(), { env })
    await openTab(page, 'assigned')

    // Assert
    await expect(apill(page, 'Approved')).toHaveAttribute('aria-pressed', 'false')
    await expect(apill(page, 'Not approved')).toHaveAttribute('aria-pressed', 'true')
  })

  test('a change whose details have not arrived counts as not approved and shows until Not approved is off, and then moves to its side when they arrive', async () => {
    // Arrange
    const { page } = await start(approvalFixture({ snapshotSleepMs: 2_500 }))

    // Act
    await openTab(page, 'assigned')

    // Assert: nothing is loaded, so all 5 open changes are not approved
    await expect(rows(page)).toHaveCount(5)
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*0$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*5$/)

    // Act: Approved off while the details are on their way
    await apill(page, 'Approved').click()

    // Assert: all rows stay while they wait, and the approved ones leave when the details arrive
    await expect(rows(page)).toHaveCount(5)
    await snapshotsLoaded(page)
    await expect(rows(page)).toHaveCount(2)
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo'])
    await expect(apill(page, 'Approved')).toHaveText(/^Approved\s*3$/)
    await expect(apill(page, 'Not approved')).toHaveText(/^Not approved\s*2$/)
  })

  test('with Not approved off no row shows while the details are on their way, and the approved ones show when they arrive', async () => {
    // Arrange
    const { page } = await start(approvalFixture({ snapshotSleepMs: 2_500 }))
    await openTab(page, 'assigned')

    // Act
    await apill(page, 'Not approved').click()

    // Assert
    await expect(rows(page)).toHaveCount(0)
    await expect(rows(page)).toHaveCount(3)
    await snapshotsLoaded(page)
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta'])
  })

  test('a ticked change that the filter hides stays ticked and still counts in Start review', async () => {
    // Arrange
    const { page } = await start(approvalFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    await page.getByRole('checkbox', { name: 'Select Alpha' }).check()
    await page.getByRole('checkbox', { name: 'Select Charlie' }).check()
    await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

    // Act
    await apill(page, 'Approved').click()

    // Assert: Alpha is hidden but still counted
    await expect(row(page, 'Alpha')).toHaveCount(0)
    await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

    // Act and assert: it is still ticked when it shows again
    await apill(page, 'Approved').click()
    await expect(page.getByRole('checkbox', { name: 'Select Alpha' })).toBeChecked()
    await expect(page.getByTestId('new-review')).toHaveText('New review (2)')
  })
})

test.describe('grouping by approval', () => {
  const toggle = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) the ${name} group`) })
  const setup = async (opts: { clock?: boolean } = {}): ReturnType<typeof start> => {
    const started = await start(approvalFixture(), opts)
    await openTab(started.page, 'assigned')
    await snapshotsLoaded(started.page)
    await modeBtn(started.page, 'Approval').click()
    return started
  }

  test('Approval shows the headers Approved and Not approved with their counts, in that order, and the rows sit under their header', async () => {
    // Arrange and act
    const { page } = await setup()

    // Assert
    await expect(modeBtn(page, 'Approval')).toHaveAttribute('aria-pressed', 'true')
    await expect(modeBtn(page, 'State')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*3$/, /^[▴▾]?\s*Not approved\s*·\s*2$/])
    const order = await page
      .locator(`[data-testid="group-row"], ${ROWS}`)
      .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'group-row' ? 'G' : (e.querySelector('td.titlecell > div')?.textContent ?? ''))))
    expect(order).toEqual(['G', 'Alpha', 'Bravo', 'Delta', 'G', 'Charlie', 'Echo'])
  })

  test('the rows inside a group follow the column sort, and the group order stays Approved, Not approved', async () => {
    // Arrange
    const { page } = await setup()

    // Act: Title ascending and then descending
    await page.getByTestId('sort-title').click()
    await page.getByTestId('sort-title').click()

    // Assert
    const order = await page
      .locator(`[data-testid="group-row"], ${ROWS}`)
      .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'group-row' ? 'G' : (e.querySelector('td.titlecell > div')?.textContent ?? ''))))
    expect(order).toEqual(['G', 'Delta', 'Bravo', 'Alpha', 'G', 'Echo', 'Charlie'])
  })

  test('the header counts follow the state pills and the approval pills, and an empty group has no header', async () => {
    // Arrange
    const { page } = await setup()

    // Act and assert: Draft on
    await pill(page, 'Draft').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*4$/, /^[▴▾]?\s*Not approved\s*·\s*3$/])

    // Act and assert: Approved off
    await apill(page, 'Approved').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Not approved\s*·\s*3$/])

    // Act and assert: Not approved off as well, so the approval filters nothing and the headers come back with every row of the shown states
    await apill(page, 'Not approved').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*4$/, /^[▴▾]?\s*Not approved\s*·\s*3$/])
  })

  test('a chevron collapses a group and keeps its count, and a ticked row inside it stays counted', async () => {
    // Arrange
    const { page } = await setup()
    await row(page, 'Alpha').getByRole('checkbox').check()

    // Act
    await toggle(page, 'Approved').click()

    // Assert
    await expect(toggle(page, 'Approved')).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page, 'Not approved')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*3$/, /^[▴▾]?\s*Not approved\s*·\s*2$/])
    expect(await sortedTitles(page)).toEqual(['Charlie', 'Echo'])
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')

    // Act and assert
    await toggle(page, 'Approved').click()
    await expect(row(page, 'Alpha').getByRole('checkbox')).toBeChecked()
  })

  test('a collapsed group is kept for the Approval mode only, and it is still collapsed when the mode comes back', async () => {
    // Arrange
    const { page } = await setup()
    await toggle(page, 'Not approved').click()
    await expect(toggle(page, 'Not approved')).toHaveAttribute('aria-expanded', 'false')

    // Act: State mode has its own groups
    await modeBtn(page, 'State').click()

    // Assert
    await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'true')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])

    // Act and assert: back to Approval
    await modeBtn(page, 'Approval').click()
    await expect(toggle(page, 'Not approved')).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page, 'Approved')).toHaveAttribute('aria-expanded', 'true')
    expect(await sortedTitles(page)).toEqual(['Alpha', 'Bravo', 'Delta'])
  })

  test('the mode and a collapsed group belong to their tab, and are kept after a tab switch and after a poll', async () => {
    // Arrange
    const { page, forge: f } = await setup({ clock: true })
    await toggle(page, 'Approved').click()

    // Act
    const before = mineCalls(f)
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(before)
    await openTab(page, 'reviewer')
    await snapshotsLoaded(page)

    // Assert: the reviewer tab has the default group State and nothing collapsed
    await expect(modeBtn(page, 'Approval')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Open\s*·\s*2$/])

    // Act: Approval here has its own collapsed groups. Kilo is approved and Lima is not.
    await modeBtn(page, 'Approval').click()
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*1$/, /^[▴▾]?\s*Not approved\s*·\s*1$/])
    await expect(toggle(page, 'Approved')).toHaveAttribute('aria-expanded', 'true')
    expect(await sortedTitles(page)).toEqual(['Kilo', 'Lima'])

    // Assert: the first tab kept its mode and its collapsed group
    await openTab(page, 'assigned')
    await expect(modeBtn(page, 'Approval')).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle(page, 'Approved')).toHaveAttribute('aria-expanded', 'false')
  })

  test('a change that is not loaded yet sits in Not approved and moves to Approved when its details arrive', async () => {
    // Arrange
    const { page } = await start(approvalFixture({ snapshotSleepMs: 2_500 }))
    await openTab(page, 'assigned')
    await modeBtn(page, 'Approval').click()

    // Assert: before
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Not approved\s*·\s*5$/])

    // Assert: after
    await snapshotsLoaded(page)
    await expect(page.getByTestId('group-row')).toHaveText([/^[▴▾]?\s*Approved\s*·\s*3$/, /^[▴▾]?\s*Not approved\s*·\s*2$/])
  })
})

/** Lets a test see the urls that the app would open in the browser, and opens none. The main process answers for the window. */
async function captureOpens(): Promise<void> {
  await app?.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string): Promise<void> => {
      g.__opened.push(url)
    }
  })
}
const opened = (): Promise<string[]> => app!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

// MR numbers for the sort: 9 and 10 in two repos, and 100. Updated: Alfa 1d, Bravo 2d, Charlie 3d, Delta 4d, Echo 5d.
const MR_SEED: SeedChange[] = [
  { provider: 'gitlab', project: GL, iid: 10, title: 'Alfa', state: 'opened', author: 'ann', updatedAt: ago(1), assigned: true },
  { provider: 'gitlab', project: GL, iid: 9, title: 'Bravo', state: 'opened', author: 'ann', updatedAt: ago(2), assigned: true },
  { provider: 'github', project: GH, iid: 10, title: 'Charlie', state: 'opened', author: 'bob', updatedAt: ago(3), assigned: true },
  { provider: 'gitlab', project: GL, iid: 100, title: 'Delta', state: 'opened', author: 'ann', updatedAt: ago(4), assigned: true },
  { provider: 'github', project: GH, iid: 9, title: 'Echo', state: 'opened', author: 'bob', updatedAt: ago(5), assigned: true }
]

test.describe('the shared table of the MR list', () => {
  test('both tabs show the 15 columns: the checkbox and the 14 of the MR list, in that order', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')
    const assigned = await headerTexts(page)
    await openTab(page, 'reviewer')
    const reviewer = await headerTexts(page)

    // Assert
    expect(assigned).toEqual(HEADERS)
    expect(reviewer).toEqual(HEADERS)
    expect(HEADERS).toHaveLength(15)
  })

  test('the header of the checkbox column has no button, and every other header is a sort button with the id sort-<key>', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    await expect(page.locator('table.reviews thead th').first().locator('button')).toHaveCount(0)
    await expect(page.locator('table.reviews thead th').first()).toHaveText('')
    await expect(page.locator('table.reviews thead th button')).toHaveCount(14)
    await expect(page.locator('[data-testid^="sort-"]')).toHaveCount(14)
    for (const [n, key] of SORT_KEYS.entries()) {
      await expect(
        page
          .locator('table.reviews thead th')
          .nth(n + 1)
          .getByTestId(`sort-${key}`)
      ).toHaveCount(1)
      await expect(sortBtn(page, key)).toHaveText(HEADERS[n + 1] + (key === 'updated' ? ' ▼' : ''))
    }
  })

  test('a row has the id mr-<url> and the attribute data-url, and its cells have the ids reviewers-<url>, approvals-<url> and state-<url>, on GitLab and GitHub', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    for (const [title, url] of [
      ['Aspen', glUrl(1)],
      ['Birch', ghUrl(21)]
    ]) {
      const r = row(page, title)
      await expect(r).toHaveAttribute('data-testid', `mr-${url}`)
      await expect(r).toHaveAttribute('data-url', url)
      await expect(page.getByTestId(`mr-${url}`)).toHaveCount(1)
      await expect(r.getByTestId(`reviewers-${url}`)).toHaveCount(1)
      await expect(r.getByTestId(`approvals-${url}`)).toHaveCount(1)
      await expect(r.getByTestId(`state-${url}`)).toHaveCount(1)
      await expect(r.getByTestId(`state-${url}`).locator('.statepill')).toHaveText('Open')
    }
  })

  test('the test ids of the old lists are gone', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    for (const old of ['mine-row', 'mine-group', 'mine-group-toggle', 'mine-group-mode', 'mine-author', 'mine-reviewers', 'mine-approvals', 'mine-id']) {
      await expect(page.getByTestId(old)).toHaveCount(0)
    }
    await expect(page.locator('[data-testid^="mine-sort-"]')).toHaveCount(0)
    await expect(page.getByTestId('group-mode')).toHaveCount(1)
    await expect(page.getByTestId('group-toggle')).toHaveCount(1)
    await expect(page.getByTestId('mine-refresh')).toHaveCount(1)
    await expect(page.getByTestId('new-review')).toHaveCount(1)
  })

  test('the cells that only a snapshot can fill show the placeholder until the snapshot arrives, and then the real values', async () => {
    // Arrange
    const { page } = await start(peopleFixture({ snapshotSleepMs: 2_000 }))

    // Act
    await openTab(page, 'assigned')

    // Assert: a GitLab row, the real cells of the list
    const alder = row(page, 'Alder')
    await expect(cellAt(alder, 'Repository')).toHaveText(GL)
    await expect(cellAt(alder, 'Change request')).toHaveText('!101')
    await expect(cellAt(alder, 'Title')).toHaveText('Alder')
    await expect(cellAt(alder, 'Author').locator('.avatar')).toHaveAttribute('data-user', 'ann')
    expect(await usersIn(cellAt(alder, 'Reviewers'))).toEqual(['bob', 'cy'])
    await expect(cellAt(alder, 'Updated')).toHaveText(/\d/)
    await expect(cellAt(alder, 'Updated')).not.toHaveText('…')
    await expect(cellAt(alder, 'State').locator('.statepill')).toHaveText('Open')

    // Assert: before the snapshot, the six cells show the placeholder, on a GitLab row and on a GitHub row
    for (const title of ['Alder', 'Dune']) for (const header of SNAPSHOT_ONLY) await expect(cellAt(row(page, title), header)).toHaveText('…')

    // Assert: after it, no placeholder is left and the cells hold the values of the snapshot
    await snapshotsLoaded(page)
    for (const title of ['Alder', 'Dune']) {
      await expect(cellAt(row(page, title), 'Stack')).toHaveText('–')
      await expect(cellAt(row(page, title), 'Pipeline')).toHaveText('–')
      await expect(cellAt(row(page, title), 'Your review')).toContainText('Not reviewed by you yet')
      await expect(cellAt(row(page, title), 'Comments')).toContainText('No threads')
      await expect(cellAt(row(page, title), 'Created')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d\d:\d\d$/)
      await expect(cellAt(row(page, title), 'Merged')).toHaveText('–')
      await expect(cellAt(row(page, title), 'Title')).toContainText(/feat-\d+ → main/)
    }
  })

  test('Approved by shows the placeholder until the snapshot answers, then the people or a dash, and a GitHub row waits with Reviewers too', async () => {
    // Arrange
    const { page } = await start(peopleFixture({ snapshotSleepMs: 2_000 }))

    // Act
    await openTab(page, 'assigned')

    // Assert: before
    await expect(cellAt(row(page, 'Alder'), 'Approved by')).toHaveText('…')
    await expect(cellAt(row(page, 'Beech'), 'Approved by')).toHaveText('…')
    await expect(cellAt(row(page, 'Dune'), 'Reviewers')).toHaveText('…')
    await expect(cellAt(row(page, 'Dune'), 'Approved by')).toHaveText('…')

    // Assert: after
    await snapshotsLoaded(page)
    expect(await usersIn(cellAt(row(page, 'Alder'), 'Approved by'))).toEqual(['cy'])
    await expect(cellAt(row(page, 'Beech'), 'Approved by')).toHaveText('–')
    expect(await usersIn(cellAt(row(page, 'Dune'), 'Reviewers'))).toEqual(['fay', 'gus', 'ivy', 'hal', 'jon', 'kim'])
  })

  test('a row of another author has no Mark as ready and no Mark as draft button, for a draft and for an open change', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await showAll(page)

    // Assert
    await expect(row(page, 'Cedar')).toHaveCount(1)
    await expect(row(page, 'Aspen')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /Mark as (ready|draft)/ })).toHaveCount(0)
    await expect(cellAt(row(page, 'Cedar'), 'State').getByRole('button')).toHaveCount(0)
    await expect(cellAt(row(page, 'Aspen'), 'State').getByRole('button')).toHaveCount(0)
  })

  test('the MR cell is a link with the text !<number> on GitLab and #<number> on GitHub, and the address as href and as tooltip', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')

    // Assert
    const gitlab = cellAt(row(page, 'Aspen'), 'Change request').locator('a')
    await expect(gitlab).toHaveText('!1')
    await expect(gitlab).toHaveAttribute('href', glUrl(1))
    await expect(gitlab).toHaveAttribute('title', glUrl(1))
    const github = cellAt(row(page, 'Birch'), 'Change request').locator('a')
    await expect(github).toHaveText('#21')
    await expect(github).toHaveAttribute('href', ghUrl(21))
    await expect(github).toHaveAttribute('title', ghUrl(21))
  })

  test('a click on the change request link opens the address in the browser, once for each click, and does not tick the row', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await captureOpens()

    // Act
    await cellAt(row(page, 'Aspen'), 'Change request').locator('a').click()

    // Assert
    await expect.poll(opened).toEqual([glUrl(1)])
    await expect(page.getByRole('checkbox', { name: 'Select Aspen' })).not.toBeChecked()
    await expect(page.getByTestId('new-review')).toBeEnabled()
    await expect(page.getByTestId('new-review')).toHaveText('New review')

    // Act
    await cellAt(row(page, 'Birch'), 'Change request').locator('a').click()

    // Assert: the GitHub address, and the first one is not opened again
    await expect.poll(opened).toEqual([glUrl(1), ghUrl(21)])
    await expect(page.getByRole('checkbox', { name: 'Select Birch' })).not.toBeChecked()
    await expect(page.getByTestId('new-review')).toHaveText('New review')
  })

  test('a click on the change request link of a ticked row keeps the row ticked and keeps the count', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await captureOpens()
    await page.getByRole('checkbox', { name: 'Select Aspen' }).check()

    // Act
    await cellAt(row(page, 'Aspen'), 'Change request').locator('a').click()

    // Assert
    await expect.poll(opened).toEqual([glUrl(1)])
    await expect(page.getByRole('checkbox', { name: 'Select Aspen' })).toBeChecked()
    await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
  })

  test('sorting by MR orders by the number as a number, so 9 comes before 10 and 100, and equal numbers go to the newest update and then the address, in both directions', async () => {
    // Arrange
    const { page } = await start(baseFixture(MR_SEED))
    await openTab(page, 'assigned')
    await modeBtn(page, 'No group').click()

    // Act and assert: first click, ascending. Text order would give 10, 10, 100, 9, 9.
    await sortBtn(page, 'mr').click()
    await expect(sortBtn(page, 'mr')).toContainText('▲')
    expect(await titles(page)).toEqual(['Bravo', 'Echo', 'Alfa', 'Charlie', 'Delta'])

    // Act and assert: second click, descending, and the two ties do not flip
    await sortBtn(page, 'mr').click()
    await expect(sortBtn(page, 'mr')).toContainText('▼')
    expect(await titles(page)).toEqual(['Delta', 'Alfa', 'Charlie', 'Bravo', 'Echo'])

    // Act and assert: third click, ascending again
    await sortBtn(page, 'mr').click()
    await expect(sortBtn(page, 'mr')).toContainText('▲')
    expect(await titles(page)).toEqual(['Bravo', 'Echo', 'Alfa', 'Charlie', 'Delta'])
  })

  test('sorting by MR works inside each group', async () => {
    // Arrange
    const { page } = await start(baseFixture(MR_SEED))
    await openTab(page, 'assigned')
    await modeBtn(page, 'Repository').click()

    // Act
    await sortBtn(page, 'mr').click()

    // Assert: acme/web has Echo 9 and Charlie 10, team/backend/x has Bravo 9, Alfa 10 and Delta 100
    expect(await layout(page)).toEqual(['G', 'Echo', 'Charlie', 'G', 'Bravo', 'Alfa', 'Delta'])
  })

  for (const key of SORT_KEYS) {
    test(`a click on the ${key} header sorts by it: the arrow, the sort state, and a second click reverses it`, async () => {
      // Arrange
      const { page } = await start(baseFixture())
      await openTab(page, 'assigned')
      await snapshotsLoaded(page)
      await modeBtn(page, 'No group').click()
      // Updated is sorted at the start, so its first click would be the descending one: sort by another column first
      if (key === 'updated') await sortBtn(page, 'title').click()

      // Act and assert: first click, ascending, and no row is lost
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▲')
      await expect(sortBtn(page, key).locator('xpath=..')).toHaveAttribute('aria-sort', 'ascending')
      await expect(page.locator('[data-testid^="sort-"]').filter({ hasText: /[▲▼]/ })).toHaveCount(1)
      const ascending = await titles(page)
      expect([...ascending].sort()).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])

      // Act and assert: second click, descending
      await sortBtn(page, key).click()
      await expect(sortBtn(page, key)).toContainText('▼')
      await expect(sortBtn(page, key).locator('xpath=..')).toHaveAttribute('aria-sort', 'descending')
      const descending = await titles(page)
      expect([...descending].sort()).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])
      // A column whose snapshot values are all equal keeps the tie order in both directions: newest update first. Here no row has a stack, pipeline, threads or merge time,
      // and every row is "Not reviewed by you yet".
      if (['stack', 'pipeline', 'review', 'comments', 'merged'].includes(key)) {
        expect(ascending).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])
        expect(descending).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])
      }
      // The created time of a seeded change is two days before its update, so it orders like the update
      if (key === 'created') {
        expect(ascending).toEqual(['Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen'])
        expect(descending).toEqual(['Aspen', 'Birch', 'Dogwood', 'Elm', 'Kauri'])
      }
    })
  }

  test('the Repo order and the Updated order are the ones of the MR list: by path, and by instant', async () => {
    // Arrange
    const { page } = await start(baseFixture())
    await openTab(page, 'assigned')
    await modeBtn(page, 'No group').click()

    // Act and assert: Repo ascending puts acme/web (Birch) before team/backend/x, with the tie to the newest update
    await sortBtn(page, 'repo').click()
    expect(await titles(page)).toEqual(['Birch', 'Aspen', 'Dogwood', 'Elm', 'Kauri'])

    // Act and assert: Updated ascending is oldest first
    await sortBtn(page, 'updated').click()
    expect(await titles(page)).toEqual(['Kauri', 'Elm', 'Dogwood', 'Birch', 'Aspen'])
  })
})

// The full snapshot of the shown rows: the same data that a review reads, filled into the cells of the list.
const YEAR = new Date().getFullYear()
/** A time of this year at 12:00 UTC, so the day shows the same in every time zone but the extreme ones, and the year is left out of the text. */
const at = (month: number, day: number): string => new Date(Date.UTC(YEAR, month - 1, day, 12)).toISOString()
const DATE_TEXT = (month: string, day: number): RegExp => new RegExp(`^${month} ${day}, \\d\\d:\\d\\d$`)

const FULL_SEED: SeedChange[] = [
  {
    provider: 'gitlab',
    project: GL,
    iid: 701,
    title: 'Glfull',
    state: 'opened',
    author: 'ann',
    updatedAt: ago(1),
    assigned: true,
    reviewers: ['bob'],
    approvedBy: ['cy'],
    sourceBranch: 'feat-x',
    targetBranch: 'release',
    behind: 3,
    pipeline: {
      status: 'failed',
      jobs: [
        { name: 'compile', stage: 'build', status: 'success' },
        { name: 'unit', stage: 'test', status: 'failed' }
      ]
    },
    threads: { open: 2, resolved: 1 },
    createdAt: at(3, 4),
    autoMerge: true
  },
  {
    provider: 'github',
    project: GH,
    iid: 801,
    title: 'Ghfull',
    state: 'opened',
    author: 'eve',
    updatedAt: ago(2),
    assigned: true,
    reviewers: ['fay'],
    approvedBy: ['me'],
    sourceBranch: 'feat-g',
    targetBranch: 'main',
    behind: 0,
    pipeline: { status: 'success', jobs: [{ name: 'lint', stage: 'CI', status: 'success' }] },
    threads: { open: 0, resolved: 2 },
    createdAt: at(5, 20)
  },
  {
    provider: 'gitlab',
    project: GL,
    iid: 702,
    title: 'Glmerged',
    state: 'merged',
    author: 'dee',
    updatedAt: ago(3),
    assigned: true,
    sourceBranch: 'feat-m',
    targetBranch: 'main',
    createdAt: at(3, 7),
    mergedAt: at(4, 9)
  }
]
const fullFixture = (extra: ChangesOptionsLike = {}): Fixture => changesFixture(FULL_SEED, extra)
type ChangesOptionsLike = Parameters<typeof changesFixture>[1]

test.describe('the snapshot of the shown rows', () => {
  test('a GitLab row shows the real values of its snapshot in every cell that only a snapshot can fill', async () => {
    // Arrange
    const { page } = await start(fullFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    const r = row(page, 'Glfull')
    await expect(cellAt(r, 'Stack')).toHaveText('–')
    await expect(cellAt(r, 'Title')).toContainText('feat-x → release')
    await expect(r.getByTestId(`branch-${glUrl(701)}`)).toHaveText('3 behind')
    await expect(r.getByTestId(`branch-${glUrl(701)}`)).toHaveAttribute('data-kind', 'behind')
    await expect(cellAt(r, 'Pipeline').locator('.pipechip')).toHaveText('failed')
    await expect(cellAt(r, 'Pipeline').locator('.pipechip')).toHaveClass(/failed/)
    await expect(cellAt(r, 'Pipeline').locator('button.stage')).toHaveCount(2)
    await expect(cellAt(r, 'Pipeline').getByRole('button', { name: 'Stage build: success' })).toHaveCount(1)
    await expect(cellAt(r, 'Pipeline').getByRole('button', { name: 'Stage test: failed' })).toHaveCount(1)
    expect(await usersIn(cellAt(r, 'Reviewers'))).toEqual(['bob'])
    expect(await usersIn(cellAt(r, 'Approved by'))).toEqual(['cy'])
    await expect(cellAt(r, 'Your review')).toContainText('Not reviewed by you yet')
    await expect(cellAt(r, 'Your review').getByRole('button')).toHaveText(['Submit review', 'Approve'])
    await expect(cellAt(r, 'Comments').locator('.threadchip')).toHaveText('💬 2/3')
    await expect(cellAt(r, 'Comments')).toContainText('2 open, 1 resolved')
    await expect(cellAt(r, 'Created')).toHaveText(DATE_TEXT('Mar', 4))
    await expect(cellAt(r, 'Merged')).toHaveText('–')
    await expect(cellAt(r, 'State').locator('.statepill')).toHaveText('Open')
    await expect(cellAt(r, 'State').locator('.automerge')).toHaveText('Auto-merge')
  })

  test('a GitHub row shows the real values of its snapshot in every cell that only a snapshot can fill', async () => {
    // Arrange
    const { page } = await start(fullFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    const r = row(page, 'Ghfull')
    await expect(cellAt(r, 'Stack')).toHaveText('–')
    await expect(cellAt(r, 'Title')).toContainText('feat-g → main')
    await expect(r.getByTestId(`branch-${ghUrl(801)}`)).toHaveText('Up to date')
    await expect(r.getByTestId(`branch-${ghUrl(801)}`)).toHaveAttribute('data-kind', 'level')
    await expect(cellAt(r, 'Pipeline').locator('.pipechip')).toHaveText('success')
    await expect(cellAt(r, 'Pipeline').getByRole('button', { name: 'Stage CI: success' })).toHaveCount(1)
    expect(await usersIn(cellAt(r, 'Reviewers'))).toEqual(['fay', 'me'])
    expect(await usersIn(cellAt(r, 'Approved by'))).toEqual(['me'])
    await expect(cellAt(r, 'Your review')).toContainText('Approved by you')
    await expect(cellAt(r, 'Your review').getByRole('button')).toHaveText(['Submit review', 'Revoke approval'])
    await expect(cellAt(r, 'Comments').locator('.threadchip')).toHaveText('💬 0/2')
    await expect(cellAt(r, 'Comments')).toContainText('all resolved')
    await expect(cellAt(r, 'Created')).toHaveText(DATE_TEXT('May', 20))
    await expect(cellAt(r, 'Merged')).toHaveText('–')
    await expect(cellAt(r, 'State').locator('.automerge')).toHaveCount(0)
  })

  test('a merged row shows its merge time, the created time and its review status, and no behind badge', async () => {
    // Arrange
    const { page } = await start(fullFixture())
    await openTab(page, 'assigned')
    await pill(page, 'Merged').click()

    // Act
    await snapshotsLoaded(page)

    // Assert
    const r = row(page, 'Glmerged')
    await expect(cellAt(r, 'Created')).toHaveText(DATE_TEXT('Mar', 7))
    await expect(cellAt(r, 'Merged')).toHaveText(DATE_TEXT('Apr', 9))
    await expect(cellAt(r, 'Title')).toContainText('feat-m → main')
    await expect(r.getByTestId(`branch-${glUrl(702)}`)).toHaveCount(0)
    await expect(cellAt(r, 'Your review')).toContainText('Merged, no approval')
    await expect(cellAt(r, 'State').locator('.statepill')).toHaveText('Merged')
  })

  // Stackbase and Stacktop are in one repo: Stacktop targets the source branch of Stackbase. Lonely is a change of its own.
  const STACK_SEED: SeedChange[] = [
    {
      provider: 'gitlab',
      project: GL,
      iid: 501,
      title: 'Stackbase',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(1),
      assigned: true,
      sourceBranch: 'feat-a',
      targetBranch: 'main'
    },
    {
      provider: 'gitlab',
      project: GL,
      iid: 502,
      title: 'Stacktop',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(2),
      assigned: true,
      sourceBranch: 'feat-b',
      targetBranch: 'feat-a'
    },
    {
      provider: 'github',
      project: GH,
      iid: 601,
      title: 'Lonely',
      state: 'opened',
      author: 'bob',
      updatedAt: ago(3),
      assigned: true,
      sourceBranch: 'feat-z',
      targetBranch: 'main'
    }
  ]

  test('the Stack cell shows the place in the stack for two stacked open changes of one repo, and a dash for a lone change', async () => {
    // Arrange
    const { page } = await start(changesFixture(STACK_SEED))

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    await expect(cellAt(row(page, 'Stackbase'), 'Stack').locator('.stackpill')).toHaveText('1 of 2')
    await expect(cellAt(row(page, 'Stacktop'), 'Stack').locator('.stackpill')).toHaveText('2 of 2')
    await expect(cellAt(row(page, 'Stacktop'), 'Stack').locator('.stackpill')).toHaveAttribute('title', /Stacked on !501: Stackbase/)
    await expect(cellAt(row(page, 'Lonely'), 'Stack')).toHaveText('–')
    await expect(cellAt(row(page, 'Lonely'), 'Stack').locator('.stackpill')).toHaveCount(0)
  })

  test('the Stack pill depends on the rows that are loaded: a change whose parent has no snapshot yet shows a dash until the parent arrives', async () => {
    // Arrange: the base answers late
    const slowBase = STACK_SEED.map((c) => (c.iid === 501 ? { ...c, snapshotSleepMs: 2_000 } : c))
    const { page } = await start(changesFixture(slowBase))

    // Act
    await openTab(page, 'assigned')

    // Assert: before
    await expect(cellAt(row(page, 'Stacktop'), 'Stack')).toHaveText('–')
    await expect(cellAt(row(page, 'Stackbase'), 'Stack')).toHaveText('…')

    // Assert: after
    await expect(cellAt(row(page, 'Stacktop'), 'Stack').locator('.stackpill')).toHaveText('2 of 2', { timeout: 2 * SHORT })
    await expect(cellAt(row(page, 'Stackbase'), 'Stack').locator('.stackpill')).toHaveText('1 of 2')
  })

  test('a failed read leaves the stub with a dash in the cells that need the snapshot, keeps the row and raises no error line', async () => {
    // Arrange: the read of Glfull fails, the others are fine
    const seed = FULL_SEED.map((c) => (c.iid === 701 ? { ...c, snapshotFail: true } : c))
    const { page } = await start(changesFixture(seed))

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert
    const r = row(page, 'Glfull')
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByTestId('mine-error')).toHaveCount(0)
    for (const header of [...SNAPSHOT_ONLY, 'Approved by']) await expect(cellAt(r, header)).toHaveText('–')
    expect(await usersIn(cellAt(r, 'Reviewers'))).toEqual(['bob'])
    await expect(cellAt(r, 'Title')).toHaveText('Glfull')
    await expect(cellAt(r, 'State').locator('.statepill')).toHaveText('Open')
    await expect(cellAt(row(page, 'Ghfull'), 'Pipeline').locator('.pipechip')).toHaveText('success')
  })

  test('a failed read is tried again by a poll only when the change has a new updated time', async () => {
    // Arrange
    const failing = FULL_SEED.map((c) => (c.iid === 701 ? { ...c, snapshotFail: true } : c))
    const { page, forge: f } = await start(changesFixture(failing), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    expect(readCount(f, glUrl(701))).toBe(1)
    const lists = mineCalls(f)

    // Act: a poll with nothing new
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(lists)
    await page.waitForTimeout(QUIET_MS)

    // Assert: no new try
    expect(readCount(f, glUrl(701))).toBe(1)
    await expect(cellAt(row(page, 'Glfull'), 'Pipeline')).toHaveText('–')

    // Act: the change is updated, and the forge works again
    const lists2 = mineCalls(f)
    f.setFixture(changesFixture(FULL_SEED.map((c) => (c.iid === 701 ? { ...c, updatedAt: ago(0.01) } : c))))
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(lists2)

    // Assert: it is read again and the cells fill in
    await expect.poll(() => readCount(f, glUrl(701))).toBe(2)
    await expect(cellAt(row(page, 'Glfull'), 'Pipeline').locator('.pipechip')).toHaveText('failed')
    await expect(cellAt(row(page, 'Glfull'), 'Comments').locator('.threadchip')).toHaveText('💬 2/3')
  })

  test('an old answer stays on screen while the new one is on its way, so a changed row does not go back to the placeholder', async () => {
    // Arrange
    const { page, forge: f } = await start(fullFixture(), { clock: true })
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const lists = mineCalls(f)
    const changed = FULL_SEED.map((c) =>
      c.iid === 701 ? { ...c, updatedAt: ago(0.01), snapshotSleepMs: 2_000, threads: { open: 0, resolved: 5 }, approvedBy: ['cy', 'dee'] } : c
    )
    f.setFixture(changesFixture(changed))

    // Act
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(lists)
    await expect.poll(() => readCount(f, glUrl(701))).toBe(2)

    // Assert: the old values stay while the slow read is open
    for (let n = 0; n < 4; n++) {
      await expect(cellAt(row(page, 'Glfull'), 'Comments').locator('.threadchip')).toHaveText('💬 2/3')
      expect(await usersIn(cellAt(row(page, 'Glfull'), 'Approved by'))).toEqual(['cy'])
      await expect(cellAt(row(page, 'Glfull'), 'Pipeline')).not.toHaveText('…')
      await page.waitForTimeout(250)
    }

    // Assert: the new values replace them
    await expect(cellAt(row(page, 'Glfull'), 'Comments').locator('.threadchip')).toHaveText('💬 0/5', { timeout: 2 * SHORT })
    expect((await usersIn(cellAt(row(page, 'Glfull'), 'Approved by'))).sort()).toEqual(['cy', 'dee'])
  })

  test('an older answer that arrives after a newer one does not replace it', async () => {
    // Arrange: the first read of Glfull is slow
    const slowFirst = FULL_SEED.map((c) => (c.iid === 701 ? { ...c, snapshotSleepMs: 2_500, approvedBy: ['old'] } : c))
    const { page, forge: f } = await start(changesFixture(slowFirst), { clock: true })
    await openTab(page, 'assigned')
    await expect.poll(() => readCount(f, glUrl(701))).toBe(1)
    const lists = mineCalls(f)
    f.setFixture(changesFixture(FULL_SEED.map((c) => (c.iid === 701 ? { ...c, updatedAt: ago(0.01), approvedBy: ['new'] } : c))))

    // Act: the poll reads the newer change while the first read is still open
    await page.clock.fastForward(60_000)
    await expect.poll(() => mineCalls(f)).toBeGreaterThan(lists)
    await expect.poll(() => readCount(f, glUrl(701))).toBe(2)
    await expect.poll(async () => usersIn(cellAt(row(page, 'Glfull'), 'Approved by'))).toEqual(['new'])
    await page.waitForTimeout(3_000)

    // Assert
    expect(await usersIn(cellAt(row(page, 'Glfull'), 'Approved by'))).toEqual(['new'])
  })

  test('only the rows that show are read: a row with its state pill off has no snapshot call, and turning the pill on reads it once', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture())

    // Act
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)

    // Assert: the open changes of the tab, and nothing else (no draft, merged or closed change, no change of the reviewer tab)
    expect([...readUrls(f)].sort()).toEqual([glUrl(1), glUrl(3), glUrl(6), glUrl(7), ghUrl(21)].sort())

    // Act: the Draft pill on
    await pill(page, 'Draft').click()
    await snapshotsLoaded(page)

    // Assert: the two drafts are read once each
    expect([...readUrls(f)].sort()).toEqual([glUrl(1), glUrl(2), glUrl(3), glUrl(6), glUrl(7), ghUrl(21), ghUrl(24)].sort())

    // Act: the pill off and on again
    await pill(page, 'Draft').click()
    await pill(page, 'Draft').click()
    await snapshotsLoaded(page)
    await page.waitForTimeout(QUIET_MS)

    // Assert: the main process has the answers, so no call is made
    expect(readUrls(f)).toHaveLength(7)
  })

  test('with every state pill off all the loaded changes show, so all of them are read', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture())
    await openTab(page, 'assigned')

    // Act
    await pill(page, 'Open').click()
    await expect(rows(page)).toHaveCount(9)
    await snapshotsLoaded(page)

    // Assert: the 9 assigned changes that the 30-day rule keeps (Ginkgo is too old)
    expect([...new Set(readUrls(f))].sort()).toEqual([glUrl(1), glUrl(2), glUrl(3), glUrl(4), glUrl(6), glUrl(7), ghUrl(21), ghUrl(22), ghUrl(24)].sort())
    expect(readUrls(f)).toHaveLength(9)
  })

  test('Refresh reads the shown rows again, once each, and the hidden rows stay unread', async () => {
    // Arrange
    const { page, forge: f } = await start(baseFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const shown = [glUrl(1), glUrl(3), glUrl(6), glUrl(7), ghUrl(21)]
    for (const u of shown) expect(readCount(f, u)).toBe(1)

    // Act
    await page.getByTestId('mine-refresh').click()

    // Assert
    for (const u of shown) await expect.poll(() => readCount(f, u)).toBe(2)
    await page.waitForTimeout(QUIET_MS)
    for (const u of shown) expect(readCount(f, u)).toBe(2)
    expect(readCount(f, glUrl(2))).toBe(0)
    expect(readCount(f, ghUrl(24))).toBe(0)
  })

  test('Refresh shows a changed snapshot of a row whose updated time did not change, and the old cells stay until it arrives', async () => {
    // Arrange
    const { page, forge: f } = await start(fullFixture())
    await openTab(page, 'assigned')
    await snapshotsLoaded(page)
    const changed = FULL_SEED.map((c) => (c.iid === 701 ? { ...c, snapshotSleepMs: 1_500, threads: { open: 0, resolved: 4 } } : c))
    f.setFixture(changesFixture(changed))

    // Act
    await page.getByTestId('mine-refresh').click()
    await expect.poll(() => readCount(f, glUrl(701))).toBe(2)

    // Assert
    await expect(cellAt(row(page, 'Glfull'), 'Comments')).not.toHaveText('…')
    await expect(cellAt(row(page, 'Glfull'), 'Comments').locator('.threadchip')).toHaveText('💬 2/3')
    await expect(cellAt(row(page, 'Glfull'), 'Comments').locator('.threadchip')).toHaveText('💬 0/4', { timeout: 2 * SHORT })
  })

  test('the reads of 14 changes with a delay are never more than 6 at a time, for the whole read and not only for its first call', async () => {
    // Arrange
    const many: SeedChange[] = Array.from({ length: 14 }, (_, n) => ({
      provider: 'gitlab' as const,
      project: GL,
      iid: 900 + n,
      title: `Many${n}`,
      state: 'opened' as const,
      author: 'ann',
      updatedAt: ago(1 + n / 100),
      assigned: true,
      pipeline: { status: 'success' as const }
    }))
    const { page, forge: f } = await start(changesFixture(many, { snapshotSleepMs: 200 }))
    const peaks = [/^projects\/[^/]+\/merge_requests\/\d+$/, /\/discussions$/, /\/jobs$/].map((re) => f.trackPeak(re))

    // Act
    await openTab(page, 'assigned')
    await expect(page.locator(`${ROWS} td`).filter({ hasText: '…' })).toHaveCount(0, { timeout: 15_000 })

    // Assert
    expect(readUrls(f)).toHaveLength(14)
    for (const p of peaks) expect(p.max).toBeLessThanOrEqual(6)
    expect(peaks[0].max).toBeGreaterThan(1)
  })

  // Comments: Cmone has 1 open thread (sort value 10001), Cmtwo has 3 resolved (3), Cmnone has no thread, Cmslow has 2 open (20002) but answers late.
  const COMMENTS_SEED: SeedChange[] = [
    {
      provider: 'gitlab',
      project: GL,
      iid: 951,
      title: 'Cmone',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(4),
      assigned: true,
      threads: { open: 1, resolved: 0 }
    },
    {
      provider: 'gitlab',
      project: GL,
      iid: 952,
      title: 'Cmtwo',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(3),
      assigned: true,
      threads: { open: 0, resolved: 3 }
    },
    { provider: 'gitlab', project: GL, iid: 953, title: 'Cmnone', state: 'opened', author: 'ann', updatedAt: ago(2), assigned: true },
    {
      provider: 'gitlab',
      project: GL,
      iid: 954,
      title: 'Cmslow',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(1),
      assigned: true,
      threads: { open: 2, resolved: 0 },
      snapshotSleepMs: 4_000
    }
  ]

  test('sorting by Comments uses the real thread counts, and a row without a snapshot sorts as empty: first ascending, last descending', async () => {
    // Arrange
    const { page } = await start(changesFixture(COMMENTS_SEED))
    await openTab(page, 'assigned')
    await expect(cellAt(row(page, 'Cmone'), 'Comments').locator('.threadchip')).toHaveText('💬 1/1')
    await expect(cellAt(row(page, 'Cmslow'), 'Comments')).toHaveText('…')
    await modeBtn(page, 'No group').click()

    // Act and assert: ascending while Cmslow has no snapshot. The two empty rows tie, and the newest update goes first.
    await sortBtn(page, 'comments').click()
    await expect(sortBtn(page, 'comments')).toContainText('▲')
    expect(await titles(page)).toEqual(['Cmslow', 'Cmnone', 'Cmtwo', 'Cmone'])

    // Act and assert: descending puts the empty rows last
    await sortBtn(page, 'comments').click()
    expect(await titles(page)).toEqual(['Cmone', 'Cmtwo', 'Cmslow', 'Cmnone'])

    // Act and assert: when the snapshot arrives Cmslow has the most open threads and moves to the front
    await expect(cellAt(row(page, 'Cmslow'), 'Comments').locator('.threadchip')).toHaveText('💬 2/2', { timeout: 2 * SHORT })
    expect(await titles(page)).toEqual(['Cmslow', 'Cmone', 'Cmtwo', 'Cmnone'])
    await sortBtn(page, 'comments').click()
    expect(await titles(page)).toEqual(['Cmnone', 'Cmtwo', 'Cmone', 'Cmslow'])
  })

  // Created: Cra March 1, Crb March 10, Crslow April 1 but late.
  const CREATED_SEED: SeedChange[] = [
    { provider: 'gitlab', project: GL, iid: 961, title: 'Cra', state: 'opened', author: 'ann', updatedAt: ago(3), assigned: true, createdAt: at(3, 1) },
    { provider: 'github', project: GH, iid: 962, title: 'Crb', state: 'opened', author: 'ann', updatedAt: ago(2), assigned: true, createdAt: at(3, 10) },
    {
      provider: 'gitlab',
      project: GL,
      iid: 963,
      title: 'Crslow',
      state: 'opened',
      author: 'ann',
      updatedAt: ago(1),
      assigned: true,
      createdAt: at(4, 1),
      snapshotSleepMs: 4_000
    }
  ]

  test('sorting by Created uses the real created times of a GitLab and a GitHub row, and a row without a snapshot sorts as empty', async () => {
    // Arrange
    const { page } = await start(changesFixture(CREATED_SEED))
    await openTab(page, 'assigned')
    await expect(cellAt(row(page, 'Crb'), 'Created')).toHaveText(DATE_TEXT('Mar', 10))
    await modeBtn(page, 'No group').click()

    // Act and assert: ascending, the row without a snapshot first
    await sortBtn(page, 'created').click()
    expect(await titles(page)).toEqual(['Crslow', 'Cra', 'Crb'])

    // Act and assert: descending, the row without a snapshot last
    await sortBtn(page, 'created').click()
    expect(await titles(page)).toEqual(['Crb', 'Cra', 'Crslow'])

    // Act and assert: when its snapshot arrives the newest created time sorts first in the descending order
    await expect(cellAt(row(page, 'Crslow'), 'Created')).toHaveText(DATE_TEXT('Apr', 1), { timeout: 2 * SHORT })
    expect(await titles(page)).toEqual(['Crslow', 'Crb', 'Cra'])
  })

  test('the window has the channels snapshot, submit and the one to drop the cache, and the old details channel is gone', async () => {
    // Arrange
    const { page } = await start(baseFixture())

    // Act
    const keys = await page.evaluate(() => Object.keys(window.codeDiff.changes).sort())

    // Assert
    expect(keys).toEqual(['dropSnapshots', 'mine', 'snapshot', 'submit'])
  })
})

test.describe('actions on the home rows', () => {
  const WAIT = { timeout: 10_000 }
  const glEp = (iid: number): string => `projects/${encodeURIComponent(GL)}/merge_requests/${iid}`
  const ghEp = (iid: number): string => `repos/${GH}/pulls/${iid}`
  /** A write is any call that is not a GET. A GraphQL call that is not a mutation is a read of the threads. */
  const isWrite = (c: Call): boolean =>
    c.method !== 'GET' && !(c.endpoint === 'graphql' && !String((c.body as { query?: string } | undefined)?.query ?? '').startsWith('mutation'))
  const writeCalls = (f: FakeForge): { method: string; endpoint: string; body: unknown }[] =>
    f.calls.filter(isWrite).map((c) => ({ method: c.method, endpoint: c.endpoint, body: c.body }))
  /** How often the full read of one change was asked: the GET of the change itself. */
  const reads = (f: FakeForge, endpoint: string): number => f.calls.filter((c) => c.method === 'GET' && c.endpoint === endpoint).length

  /**
   * The viewer is "me". Assigned to the viewer, newest first:
   * Acacia (GitLab, open, not approved), Banyan (GitLab, open, approved by me), Camphor (GitLab, open, mine), Deodar (GitLab, draft, mine),
   * Ebony (GitHub, open, not approved), Fig (GitHub, open, approved by me), Gum (GitHub, open, mine), Hickory (GitHub, draft, mine),
   * Iroko (merged), Juniperus (closed), Kapok (open, the viewer cannot approve), Larch (open, assigned and also a reviewer role).
   */
  const ACTION_SEED: SeedChange[] = [
    { provider: 'gitlab', project: GL, iid: 901, title: 'Acacia', state: 'opened', author: 'ann', updatedAt: ago(1), assigned: true },
    { provider: 'gitlab', project: GL, iid: 902, title: 'Banyan', state: 'opened', author: 'ann', updatedAt: ago(1.1), assigned: true, approvedBy: ['me'] },
    { provider: 'gitlab', project: GL, iid: 903, title: 'Camphor', state: 'opened', author: 'me', updatedAt: ago(1.2), assigned: true },
    { provider: 'gitlab', project: GL, iid: 904, title: 'Deodar', state: 'draft', author: 'me', updatedAt: ago(1.3), assigned: true },
    { provider: 'github', project: GH, iid: 911, title: 'Ebony', state: 'opened', author: 'bob', updatedAt: ago(1.4), assigned: true },
    { provider: 'github', project: GH, iid: 912, title: 'Fig', state: 'opened', author: 'bob', updatedAt: ago(1.5), assigned: true, approvedBy: ['me'] },
    { provider: 'github', project: GH, iid: 913, title: 'Gum', state: 'opened', author: 'me', updatedAt: ago(1.6), assigned: true },
    { provider: 'github', project: GH, iid: 914, title: 'Hickory', state: 'draft', author: 'me', updatedAt: ago(1.7), assigned: true },
    { provider: 'gitlab', project: GL, iid: 905, title: 'Iroko', state: 'merged', author: 'ann', updatedAt: ago(2), assigned: true },
    { provider: 'gitlab', project: GL, iid: 906, title: 'Juniperus', state: 'closed', author: 'ann', updatedAt: ago(2.1), assigned: true },
    { provider: 'gitlab', project: GL, iid: 907, title: 'Kapok', state: 'opened', author: 'ann', updatedAt: ago(2.2), assigned: true, userCanApprove: false },
    { provider: 'gitlab', project: GL, iid: 908, title: 'Larch', state: 'opened', author: 'ann', updatedAt: ago(2.3), assigned: true, reviewer: true }
  ]
  const patch = (iid: number, over: Partial<SeedChange>): SeedChange[] => ACTION_SEED.map((c) => (c.iid === iid ? { ...c, ...over } : c))

  /** Starts on the list "Owned by me" with every state shown and every snapshot read, unless `settle` is false. */
  async function startActions(
    seed: SeedChange[] = ACTION_SEED,
    extra: Fixture = {},
    opts: { settle?: boolean; options?: NonNullable<Parameters<typeof changesFixture>[1]> } = {}
  ): Promise<{ page: Page; forge: FakeForge }> {
    const r = await start({ ...changesFixture(seed, opts.options), ...extra })
    await openTab(r.page, 'assigned')
    await showAll(r.page)
    if (opts.settle !== false) await snapshotsLoaded(r.page)
    return r
  }
  const review = (page: Page, title: string): Locator => cellAt(row(page, title), 'Your review')
  const state = (page: Page, title: string): Locator => cellAt(row(page, title), 'State')
  const buttonsOf = (cell: Locator): Promise<string[]> => cell.getByRole('button').allTextContents()
  const approveBtn = (page: Page, title: string): Locator => review(page, title).getByRole('button', { name: 'Approve', exact: true })
  const placeholders = (page: Page, title: string): Locator => row(page, title).locator('[title="Loading"]')
  const group = (page: Page, name: string): Locator => page.getByTestId('group-row').filter({ hasText: new RegExp(`^\\s*[▴▾]?\\s*${name}\\s*·`) })

  test.describe('the buttons follow the rules of the review table', () => {
    test('a change of someone else has Submit review and Approve, or Submit review and Revoke approval when the viewer approved it, on both forges', async () => {
      // Arrange
      const { page } = await startActions()

      // Act and Assert
      for (const t of ['Acacia', 'Ebony']) {
        await expect(review(page, t)).toContainText('Not reviewed by you yet')
        expect(await buttonsOf(review(page, t)), t).toEqual(['Submit review', 'Approve'])
      }
      for (const t of ['Banyan', 'Fig']) {
        await expect(review(page, t)).toContainText('Approved by you')
        expect(await buttonsOf(review(page, t)), t).toEqual(['Submit review', 'Revoke approval'])
      }
      await expect(review(page, 'Kapok')).toContainText('Not an eligible approver')
      expect(await buttonsOf(review(page, 'Kapok'))).toEqual(['Submit review'])
      await expect(page.getByTestId(`submit-${glUrl(901)}`)).toHaveCount(1)
      await expect(page.getByTestId(`submit-${ghUrl(911)}`)).toHaveCount(1)
    })

    test('the author sees the text You are the author and no Approve, no Revoke approval and no Submit review, on both forges', async () => {
      // Arrange
      const { page } = await startActions()

      // Act and Assert
      for (const t of ['Camphor', 'Deodar', 'Gum', 'Hickory']) {
        await expect(review(page, t), t).toContainText('You are the author')
        expect(await buttonsOf(review(page, t)), t).toEqual([])
      }
      await expect(page.getByTestId(`submit-${glUrl(903)}`)).toHaveCount(0)
      await expect(page.getByTestId(`submit-${ghUrl(913)}`)).toHaveCount(0)
    })

    test('Mark as draft and Mark as ready are in the State cell of the own open changes only, with the same titles as in the review table', async () => {
      // Arrange
      const { page } = await startActions()

      // Act and Assert
      expect(await buttonsOf(state(page, 'Camphor'))).toEqual(['Mark as draft'])
      expect(await buttonsOf(state(page, 'Gum'))).toEqual(['Mark as draft'])
      expect(await buttonsOf(state(page, 'Deodar'))).toEqual(['Mark as ready'])
      expect(await buttonsOf(state(page, 'Hickory'))).toEqual(['Mark as ready'])
      await expect(state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' })).toHaveAttribute('title', 'Adds Draft: to the title')
      await expect(state(page, 'Deodar').getByRole('button', { name: 'Mark as ready' })).toHaveAttribute('title', 'Removes the Draft prefix from the title')
      await expect(state(page, 'Camphor').getByTestId('icon-mark-draft')).toHaveCount(1)
      await expect(state(page, 'Deodar').getByTestId('icon-mark-ready')).toHaveCount(1)
      for (const t of ['Acacia', 'Banyan', 'Ebony', 'Fig', 'Iroko', 'Juniperus', 'Kapok', 'Larch']) expect(await buttonsOf(state(page, t)), t).toEqual([])
      await expect(page.getByRole('button', { name: /^Mark as (ready|draft)$/ })).toHaveCount(4)
    })

    test('a merged row has no button, and a closed row has no Your review button and only Reopen in the State cell, for its author', async () => {
      // Arrange
      const seed = ACTION_SEED.map((c) => (c.iid === 905 || c.iid === 906 ? { ...c, author: 'me' } : c))
      const { page } = await startActions(seed)

      // Act and Assert
      for (const t of ['Iroko', 'Juniperus']) expect(await buttonsOf(review(page, t)), t).toEqual([])
      expect(await buttonsOf(state(page, 'Iroko'))).toEqual([])
      expect(await buttonsOf(state(page, 'Juniperus'))).toEqual(['Reopen'])
      await expect(row(page, 'Iroko').locator('.statepill')).toHaveText('Merged')
      await expect(row(page, 'Juniperus').locator('.statepill')).toHaveText('Closed')
    })

    test('a stub row, whose snapshot is still on its way, has no button in either cell, also an own open change', async () => {
      // Arrange
      const seed = ACTION_SEED.map((c) => (c.iid === 901 || c.iid === 903 ? { ...c, snapshotSleepMs: 3_000 } : c))

      // Act
      const { page } = await startActions(seed, {}, { settle: false })

      // Assert
      for (const t of ['Acacia', 'Camphor']) {
        await expect(review(page, t)).toHaveText('…')
        expect(await buttonsOf(review(page, t)), t).toEqual([])
        expect(await buttonsOf(state(page, t)), t).toEqual([])
      }
      await expect(page.getByTestId(`submit-${glUrl(901)}`)).toHaveCount(0)
      await expect(row(page, 'Banyan')).toContainText('Approved by you', WAIT)
    })

    test('a row whose read failed has no button in either cell and keeps its dashes, also an own open change', async () => {
      // Arrange
      const seed = ACTION_SEED.map((c) => (c.iid === 901 || c.iid === 903 ? { ...c, snapshotFail: true } : c))

      // Act
      const { page } = await startActions(seed)

      // Assert
      for (const t of ['Acacia', 'Camphor']) {
        await expect(review(page, t)).toHaveText('–')
        expect(await buttonsOf(review(page, t)), t).toEqual([])
        expect(await buttonsOf(state(page, t)), t).toEqual([])
      }
      await expect(page.getByTestId(`submit-${glUrl(901)}`)).toHaveCount(0)
      await expect(page.getByTestId('mine-error')).toHaveCount(0)
    })
  })

  test.describe('Approve and Revoke approval', () => {
    test('Approve on a GitLab row says Approving… in the Your review cell, posts the approval, and then the row is approved by you with your avatar in Approved by', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(901, { writeSleepMs: 1_200 }))

      // Act
      await approveBtn(page, 'Acacia').click()

      // Assert
      await expect(review(page, 'Acacia')).toContainText('Approving…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'POST', endpoint: `${glEp(901)}/approve`, body: {} }])
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      await expect(review(page, 'Acacia')).not.toContainText('Approving…')
      expect(await usersIn(cellAt(row(page, 'Acacia'), 'Approved by'))).toEqual(['me'])
      expect(await buttonsOf(review(page, 'Acacia'))).toEqual(['Submit review', 'Revoke approval'])
      expect(writeCalls(f)).toHaveLength(1)
    })

    test('Approve on a GitHub row posts a review with the event APPROVE and then shows the approval', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(911, { writeSleepMs: 1_200 }))

      // Act
      await approveBtn(page, 'Ebony').click()

      // Assert
      await expect(review(page, 'Ebony')).toContainText('Approving…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'POST', endpoint: `${ghEp(911)}/reviews`, body: { event: 'APPROVE' } }])
      await expect(review(page, 'Ebony')).toContainText('✓ Approved by you', WAIT)
      expect(await usersIn(cellAt(row(page, 'Ebony'), 'Approved by'))).toEqual(['me'])
      expect(await buttonsOf(review(page, 'Ebony'))).toEqual(['Submit review', 'Revoke approval'])
    })

    test('Revoke approval on a GitLab row says Revoking…, posts the unapprove, and then the row is not reviewed by you and the avatar is gone', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(902, { writeSleepMs: 1_200 }))
      expect(await usersIn(cellAt(row(page, 'Banyan'), 'Approved by'))).toEqual(['me'])

      // Act
      await review(page, 'Banyan').getByRole('button', { name: 'Revoke approval' }).click()

      // Assert
      await expect(review(page, 'Banyan')).toContainText('Revoking…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'POST', endpoint: `${glEp(902)}/unapprove`, body: {} }])
      await expect(review(page, 'Banyan')).toContainText('Not reviewed by you yet', WAIT)
      await expect(cellAt(row(page, 'Banyan'), 'Approved by')).toHaveText('–')
      expect(await buttonsOf(review(page, 'Banyan'))).toEqual(['Submit review', 'Approve'])
    })

    test('Revoke approval on a GitHub row dismisses the approval of the viewer and then shows the row as not approved', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(912, { writeSleepMs: 1_200 }))

      // Act
      await review(page, 'Fig').getByRole('button', { name: 'Revoke approval' }).click()

      // Assert
      await expect(review(page, 'Fig')).toContainText('Revoking…')
      await expect
        .poll(() => writeCalls(f), WAIT)
        .toEqual([{ method: 'PUT', endpoint: `${ghEp(912)}/reviews/1/dismissals`, body: { message: 'Approval withdrawn' } }])
      await expect(review(page, 'Fig')).toContainText('Not reviewed by you yet', WAIT)
      await expect(cellAt(row(page, 'Fig'), 'Approved by')).toHaveText('–')
    })

    test('after a successful action the list is read again and only that row asks for its snapshot again', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const listCalls = mineCalls(f)
      const before = { acacia: reads(f, glEp(901)), banyan: reads(f, glEp(902)), ebony: reads(f, ghEp(911)) }

      // Act
      await approveBtn(page, 'Acacia').click()

      // Assert
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      await expect.poll(() => mineCalls(f), WAIT).toBeGreaterThan(listCalls)
      expect(reads(f, glEp(901))).toBe(before.acacia + 1)
      expect(reads(f, glEp(902))).toBe(before.banyan)
      expect(reads(f, ghEp(911))).toBe(before.ebony)
    })

    test('the old cells stay while the new snapshot is on its way: no placeholder shows and the approval arrives later', async () => {
      // Arrange
      const options = {}
      const { page } = await startActions(ACTION_SEED, {}, { options })
      Object.assign(options, { snapshotSleepMs: 1_500 })

      // Act
      await approveBtn(page, 'Acacia').click()

      // Assert
      const sampled: number[] = []
      for (let i = 0; i < 10; i++) {
        sampled.push(await placeholders(page, 'Acacia').count())
        await page.waitForTimeout(100)
      }
      expect(sampled).toEqual(Array(10).fill(0))
      await expect(cellAt(row(page, 'Acacia'), 'Title')).toContainText('Acacia')
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      expect(await usersIn(cellAt(row(page, 'Acacia'), 'Approved by'))).toEqual(['me'])
    })
  })

  test.describe('Mark as ready and Mark as draft', () => {
    test('Mark as draft on an own open GitLab change says Marking as draft…, puts the Draft prefix on the title and then the row is a draft', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(903, { writeSleepMs: 1_200 }))

      // Act
      await state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' }).click()

      // Assert
      await expect(state(page, 'Camphor')).toContainText('Marking as draft…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'PUT', endpoint: glEp(903), body: { title: 'Draft: Camphor' } }])
      await expect(state(page, 'Camphor').locator('.statepill')).toHaveText('Draft', WAIT)
      await expect(state(page, 'Camphor')).not.toContainText('Marking as draft…')
      expect(await buttonsOf(state(page, 'Camphor'))).toEqual(['Mark as ready'])
      await expect(cellAt(row(page, 'Camphor'), 'Title')).toContainText('Camphor')
      expect(writeCalls(f)).toHaveLength(1)
    })

    test('Mark as ready on an own draft GitLab change puts the title without the Draft prefix and then the row is open', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(904, { writeSleepMs: 1_200 }))

      // Act
      await state(page, 'Deodar').getByRole('button', { name: 'Mark as ready' }).click()

      // Assert
      await expect(state(page, 'Deodar')).toContainText('Marking as ready…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'PUT', endpoint: glEp(904), body: { title: 'Deodar' } }])
      await expect(state(page, 'Deodar').locator('.statepill')).toHaveText('Open', WAIT)
      expect(await buttonsOf(state(page, 'Deodar'))).toEqual(['Mark as draft'])
      await expect(cellAt(row(page, 'Deodar'), 'Title')).not.toContainText('Draft:')
    })

    test('Mark as draft and Mark as ready on GitHub send the GraphQL mutation for the node of the pull request', async () => {
      // Arrange
      const { page, forge: f } = await startActions()

      // Act
      await state(page, 'Gum').getByRole('button', { name: 'Mark as draft' }).click()
      await expect(state(page, 'Gum').locator('.statepill')).toHaveText('Draft', WAIT)
      await state(page, 'Hickory').getByRole('button', { name: 'Mark as ready' }).click()
      await expect(state(page, 'Hickory').locator('.statepill')).toHaveText('Open', WAIT)

      // Assert
      const sent = writeCalls(f).map((w) => ({
        endpoint: w.endpoint,
        query: String((w.body as { query: string }).query),
        id: (w.body as { variables: { id: string } }).variables.id
      }))
      expect(sent).toHaveLength(2)
      expect(sent[0]).toMatchObject({ endpoint: 'graphql', id: `PR_${GH}#913` })
      expect(sent[0].query).toContain('convertPullRequestToDraft')
      expect(sent[1]).toMatchObject({ endpoint: 'graphql', id: `PR_${GH}#914` })
      expect(sent[1].query).toContain('markPullRequestReadyForReview')
      expect(await buttonsOf(state(page, 'Gum'))).toEqual(['Mark as ready'])
      expect(await buttonsOf(state(page, 'Hickory'))).toEqual(['Mark as draft'])
    })

    test('a closed change of someone else has no Reopen button', async () => {
      // Arrange
      const { page } = await startActions()

      // Assert
      expect(await buttonsOf(state(page, 'Juniperus'))).toEqual([])
    })

    test('Reopen on an own closed GitLab change says Reopening…, sends state_event reopen and then the row is open', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(906, { author: 'me', writeSleepMs: 1_200 }))

      // Act
      await state(page, 'Juniperus').getByRole('button', { name: 'Reopen' }).click()

      // Assert
      await expect(state(page, 'Juniperus')).toContainText('Reopening…')
      await expect.poll(() => writeCalls(f), WAIT).toEqual([{ method: 'PUT', endpoint: glEp(906), body: { state_event: 'reopen' } }])
      await expect(state(page, 'Juniperus').locator('.statepill')).toHaveText('Open', WAIT)
      expect(await buttonsOf(state(page, 'Juniperus'))).toEqual(['Mark as draft'])
    })

    test('Reopen on an own closed GitHub pull request sends the GraphQL mutation reopenPullRequest', async () => {
      // Arrange
      const seed = [
        ...ACTION_SEED,
        { provider: 'github', project: GH, iid: 915, title: 'Ironwood', state: 'closed', author: 'me', updatedAt: ago(2.4), assigned: true } as SeedChange
      ]
      const { page, forge: f } = await startActions(seed)

      // Act
      await state(page, 'Ironwood').getByRole('button', { name: 'Reopen' }).click()
      await expect(state(page, 'Ironwood').locator('.statepill')).toHaveText('Open', WAIT)

      // Assert
      const sent = writeCalls(f).map((w) => ({
        endpoint: w.endpoint,
        query: String((w.body as { query: string }).query),
        id: (w.body as { variables: { id: string } }).variables.id
      }))
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ endpoint: 'graphql', id: `PR_${GH}#915` })
      expect(sent[0].query).toContain('reopenPullRequest')
    })

    test('after the write the list is read again and the row moves to its new State group', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const listCalls = mineCalls(f)
      await expect(group(page, 'Draft')).toContainText('2')

      // Act
      await state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' }).click()

      // Assert
      await expect.poll(() => mineCalls(f), WAIT).toBeGreaterThan(listCalls)
      await expect(group(page, 'Draft')).toContainText('3', WAIT)
    })
  })

  test.describe('the errors of the forge', () => {
    test('an Approve that fails shows the error in the Your review cell, gives the button back, keeps the row and clears the error on the next success', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(901, { writeFail: 'HTTP 403 nope' }))

      // Act
      await approveBtn(page, 'Acacia').click()

      // Assert
      await expect(review(page, 'Acacia')).toContainText('HTTP 403', WAIT)
      await expect(approveBtn(page, 'Acacia')).toBeVisible()
      await expect(review(page, 'Acacia')).not.toContainText('Approving…')
      await expect(review(page, 'Acacia')).toContainText('Not reviewed by you yet')
      await expect(state(page, 'Acacia')).not.toContainText('HTTP 403')
      await expect(row(page, 'Banyan')).not.toContainText('HTTP 403')
      await expect(placeholders(page, 'Acacia')).toHaveCount(0)
      await expect(cellAt(row(page, 'Acacia'), 'Title')).toContainText('Acacia')
      f.setFixture(changesFixture(ACTION_SEED))
      await approveBtn(page, 'Acacia').click()
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      await expect(review(page, 'Acacia')).not.toContainText('HTTP 403')
    })

    test('a Revoke approval that fails shows the error in the Your review cell and gives the button back', async () => {
      // Arrange
      const { page } = await startActions(patch(902, { writeFail: 'HTTP 500 boom' }))

      // Act
      await review(page, 'Banyan').getByRole('button', { name: 'Revoke approval' }).click()

      // Assert
      await expect(review(page, 'Banyan')).toContainText('HTTP 500', WAIT)
      await expect(review(page, 'Banyan').getByRole('button', { name: 'Revoke approval' })).toBeVisible()
      await expect(review(page, 'Banyan')).toContainText('Approved by you')
      expect(await usersIn(cellAt(row(page, 'Banyan'), 'Approved by'))).toEqual(['me'])
    })

    test('a Mark as draft that fails shows the error in the State cell and not in the Your review cell, and gives the button back', async () => {
      // Arrange
      const { page } = await startActions(patch(903, { writeFail: 'HTTP 500 boom' }))

      // Act
      await state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' }).click()

      // Assert
      await expect(state(page, 'Camphor')).toContainText('HTTP 500', WAIT)
      await expect(state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' })).toBeVisible()
      await expect(state(page, 'Camphor')).not.toContainText('Marking as draft…')
      await expect(review(page, 'Camphor')).not.toContainText('HTTP 500')
      await expect(state(page, 'Camphor').locator('.statepill')).toHaveText('Open')
    })

    test('an error belongs to its row: another row shows none and a later action on it works', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(901, { writeFail: 'HTTP 403 nope' }))
      await approveBtn(page, 'Acacia').click()
      await expect(review(page, 'Acacia')).toContainText('HTTP 403', WAIT)

      // Act
      await approveBtn(page, 'Ebony').click()

      // Assert
      await expect(review(page, 'Ebony')).toContainText('✓ Approved by you', WAIT)
      await expect(review(page, 'Ebony')).not.toContainText('HTTP 403')
      await expect(review(page, 'Acacia')).toContainText('HTTP 403')
      expect(writeCalls(f).map((w) => w.endpoint)).toEqual([`${glEp(901)}/approve`, `${ghEp(911)}/reviews`])
    })
  })

  test.describe('the Submit review dialog of a home row', () => {
    const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Submit review' })
    const openFor = async (page: Page, url: string): Promise<Locator> => {
      await page.getByTestId(`submit-${url}`).click()
      await expect(dialog(page)).toBeVisible()
      return dialog(page)
    }

    test('lists the one change of the row, with its overall comment box and the three decisions', async () => {
      // Arrange
      const { page } = await startActions()

      // Act
      const dlg = await openFor(page, glUrl(901))

      // Assert
      await expect(dlg.locator('fieldset')).toHaveCount(1)
      await expect(dlg.getByLabel('Overall comment for !901')).toBeVisible()
      await expect(dlg.getByRole('radiogroup', { name: 'Decision for !901' }).getByRole('radio')).toHaveCount(3)
      await expect(dlg).toContainText('Acacia')
      await expect(dlg.getByTestId('submit-review')).toBeEnabled()
    })

    test('posts the summary and the approval for a GitLab row in that order, closes, and then the row is approved by you', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const dlg = await openFor(page, glUrl(901))

      // Act
      await dlg.getByLabel('Overall comment for !901').fill('LGTM')
      await dlg.getByLabel('Approve').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dialog(page)).toHaveCount(0, WAIT)
      expect(writeCalls(f)).toEqual([
        { method: 'POST', endpoint: `${glEp(901)}/draft_notes`, body: { note: 'LGTM' } },
        { method: 'POST', endpoint: `${glEp(901)}/draft_notes/bulk_publish`, body: undefined },
        { method: 'POST', endpoint: `${glEp(901)}/approve`, body: {} }
      ])
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      expect(await usersIn(cellAt(row(page, 'Acacia'), 'Approved by'))).toEqual(['me'])
    })

    test('requests changes on a GitHub row with its text in one review, and then the row shows Changes requested by you', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const dlg = await openFor(page, ghUrl(911))

      // Act
      await dlg.getByLabel('Overall comment for !911').fill('There is a race here')
      await dlg.getByLabel('Request changes').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dialog(page)).toHaveCount(0, WAIT)
      expect(writeCalls(f)).toEqual([{ method: 'POST', endpoint: `${ghEp(911)}/reviews`, body: { event: 'REQUEST_CHANGES', body: 'There is a race here' } }])
      await expect(review(page, 'Ebony')).toContainText('Changes requested by you', WAIT)
    })

    test('requests changes on a GitLab row by publishing the review with the state requested_changes', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const dlg = await openFor(page, glUrl(901))

      // Act
      await dlg.getByLabel('Overall comment for !901').fill('Needs work')
      await dlg.getByLabel('Request changes').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dialog(page)).toHaveCount(0, WAIT)
      expect(writeCalls(f)).toEqual([
        { method: 'POST', endpoint: `${glEp(901)}/draft_notes`, body: { note: 'Needs work' } },
        { method: 'POST', endpoint: `${glEp(901)}/draft_notes/bulk_publish`, body: { reviewer_state: 'requested_changes' } }
      ])
      await expect(review(page, 'Acacia')).toContainText('Changes requested by you', WAIT)
    })

    test('shows the red line and sends nothing when changes are requested without an overall comment, and the dialog stays open', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const dlg = await openFor(page, glUrl(901))

      // Act
      await dlg.getByLabel('Request changes').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dlg.getByText('Requesting changes needs an overall comment.')).toBeVisible()
      await expect(dialog(page)).toBeVisible()
      expect(writeCalls(f)).toEqual([])
    })

    test('closes with no call at all when nothing is chosen and no text is written, and Cancel closes too', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const dlg = await openFor(page, glUrl(901))

      // Act
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dialog(page)).toHaveCount(0)
      const dlg2 = await openFor(page, ghUrl(911))
      await dlg2.getByLabel('Overall comment for !911').fill('draft text')
      await dlg2.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog(page)).toHaveCount(0)
      expect(writeCalls(f)).toEqual([])
    })

    test('turns off the decisions the viewer cannot take, with the reason as the tooltip: already approved, not an eligible approver', async () => {
      // Arrange
      const { page } = await startActions()

      // Act
      const dlg = await openFor(page, glUrl(902))

      // Assert
      await expect(dlg.getByLabel('Approve')).toBeDisabled()
      await expect(dlg.locator('label', { hasText: 'Approve' })).toHaveAttribute('title', 'Already approved by you')
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      const dlg2 = await openFor(page, glUrl(907))
      await expect(dlg2.getByLabel('Approve')).toBeDisabled()
      await expect(dlg2.locator('label', { hasText: 'Approve' })).toHaveAttribute('title', "You can't approve this")
    })

    test('shows a partial failure for the change in the banner, keeps the dialog open and says the other parts were posted', async () => {
      // Arrange
      const { page, forge: f } = await startActions(ACTION_SEED, { [`POST ${glEp(901)}/approve`]: { fail: 'HTTP 403 Forbidden' } })
      const dlg = await openFor(page, glUrl(901))

      // Act
      await dlg.getByLabel('Overall comment for !901').fill('LGTM')
      await dlg.getByLabel('Approve').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(page.getByTestId('submit-banner')).toContainText('!901: The overall comment went out, then:', WAIT)
      await expect(page.getByTestId('submit-banner')).toContainText('The other changes were posted.')
      await expect(dialog(page)).toBeVisible()
      expect(writeCalls(f).map((w) => w.endpoint)).toEqual([`${glEp(901)}/draft_notes`, `${glEp(901)}/draft_notes/bulk_publish`, `${glEp(901)}/approve`])
    })

    test('shows the error of the forge for a GitHub change in the banner when its only write fails, and keeps the dialog open', async () => {
      // Arrange
      const { page } = await startActions(patch(911, { writeFail: 'HTTP 422 invalid' }))
      const dlg = await openFor(page, ghUrl(911))

      // Act
      await dlg.getByLabel('Approve').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(page.getByTestId('submit-banner')).toContainText('!911: ', WAIT)
      await expect(page.getByTestId('submit-banner')).toContainText('HTTP 422')
      await expect(dialog(page)).toBeVisible()
    })

    test('does not tick the row, and leaves the other ticks alone', async () => {
      // Arrange
      const { page } = await startActions()
      await page.getByLabel('Select Ebony').check()

      // Act
      const dlg = await openFor(page, glUrl(901))
      await dlg.getByLabel('Approve').check()
      await dlg.getByTestId('submit-review').click()

      // Assert
      await expect(dialog(page)).toHaveCount(0, WAIT)
      await expect(page.getByLabel('Select Acacia')).not.toBeChecked()
      await expect(page.getByLabel('Select Ebony')).toBeChecked()
      await expect(page.getByTestId('new-review')).toHaveText('New review (1)')
    })
  })

  test.describe('the same actions in every layout', () => {
    test('work in every group mode: No group, Repository, State and Approval', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const steps: { mode: 'No group' | 'Repository' | 'State' | 'Approval'; title: string; button: string; after: string }[] = [
        { mode: 'No group', title: 'Acacia', button: 'Approve', after: '✓ Approved by you' },
        { mode: 'Repository', title: 'Acacia', button: 'Revoke approval', after: 'Not reviewed by you yet' },
        { mode: 'State', title: 'Ebony', button: 'Approve', after: '✓ Approved by you' },
        { mode: 'Approval', title: 'Ebony', button: 'Revoke approval', after: 'Not reviewed by you yet' }
      ]

      // Act and Assert
      let writes = 0
      for (const step of steps) {
        await modeBtn(page, step.mode).click()
        await review(page, step.title).getByRole('button', { name: step.button, exact: true }).click()
        await expect(review(page, step.title), `${step.mode}`).toContainText(step.after, WAIT)
        expect(writeCalls(f), `${step.mode}`).toHaveLength(++writes)
      }
    })

    test('work for a row of a group that was collapsed and expanded again', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      await group(page, 'Open').getByTestId('group-toggle').click()
      await expect(row(page, 'Acacia')).toHaveCount(0)
      await group(page, 'Open').getByTestId('group-toggle').click()
      await expect(row(page, 'Acacia')).toHaveCount(1)

      // Act
      await approveBtn(page, 'Acacia').click()

      // Assert
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      expect(writeCalls(f)).toHaveLength(1)
    })

    test('a row keeps its error while its group is collapsed and expanded again', async () => {
      // Arrange
      const { page } = await startActions(patch(901, { writeFail: 'HTTP 403 nope' }))
      await approveBtn(page, 'Acacia').click()
      await expect(review(page, 'Acacia')).toContainText('HTTP 403', WAIT)

      // Act
      await group(page, 'Open').getByTestId('group-toggle').click()
      await group(page, 'Open').getByTestId('group-toggle').click()

      // Assert
      await expect(review(page, 'Acacia')).toContainText('HTTP 403')
    })

    test('leave the ticks and Start review (N) alone, and a click on a button does not tick its row', async () => {
      // Arrange
      const { page } = await startActions()
      await page.getByLabel('Select Acacia').check()
      await page.getByLabel('Select Camphor').check()
      await expect(page.getByTestId('new-review')).toHaveText('New review (2)')

      // Act
      await approveBtn(page, 'Acacia').click()
      await expect(review(page, 'Acacia')).toContainText('✓ Approved by you', WAIT)
      await approveBtn(page, 'Ebony').click()
      await expect(review(page, 'Ebony')).toContainText('✓ Approved by you', WAIT)
      await state(page, 'Camphor').getByRole('button', { name: 'Mark as draft' }).click()
      await expect(state(page, 'Camphor').locator('.statepill')).toHaveText('Draft', WAIT)

      // Assert
      await expect(page.getByLabel('Select Acacia')).toBeChecked()
      await expect(page.getByLabel('Select Camphor')).toBeChecked()
      await expect(page.getByLabel('Select Ebony')).not.toBeChecked()
      await expect(page.getByTestId('new-review')).toHaveText('New review (2)')
    })
  })

  test.describe('the same change in both tabs', () => {
    test('an action in one tab refreshes the row there, and the other tab shows the new state when it opens, from the one shared snapshot', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const before = reads(f, glEp(908))

      // Act
      await approveBtn(page, 'Larch').click()
      await expect(review(page, 'Larch')).toContainText('✓ Approved by you', WAIT)
      await openTab(page, 'reviewer')

      // Assert
      await expect(review(page, 'Larch')).toContainText('✓ Approved by you')
      expect(await usersIn(cellAt(row(page, 'Larch'), 'Approved by'))).toEqual(['me'])
      expect(reads(f, glEp(908))).toBe(before + 1)

      // Act: the other way round
      await review(page, 'Larch').getByRole('button', { name: 'Revoke approval' }).click()
      await expect(review(page, 'Larch')).toContainText('Not reviewed by you yet', WAIT)
      await openTab(page, 'assigned')

      // Assert
      await expect(review(page, 'Larch')).toContainText('Not reviewed by you yet')
      await expect(cellAt(row(page, 'Larch'), 'Approved by')).toHaveText('–')
      expect(reads(f, glEp(908))).toBe(before + 2)
    })
  })

  test.describe('the channel changes:submit by url', () => {
    type Outcome = { settled: 'ok'; v: { ok: boolean; value?: Record<string, string>; error?: string } } | { settled: 'rejected'; message: string }
    const lists = {
      approve: [] as string[],
      unapprove: [] as string[],
      requestChanges: [] as string[],
      summaries: {} as Record<string, string>,
      ready: [] as string[],
      draft: [] as string[]
    }
    const submit = (page: Page, req: Record<string, unknown>): Promise<Outcome> =>
      page.evaluate(
        (r) =>
          (window.codeDiff.changes as unknown as { submit: (x: unknown) => Promise<never> }).submit(r).then(
            (v) => ({ settled: 'ok' as const, v }),
            (e: unknown) => ({ settled: 'rejected' as const, message: String(e) })
          ),
        { ...lists, ...req }
      ) as Promise<Outcome>
    const askSnapshot = (page: Page, url: string): Promise<{ ok: boolean }> =>
      page.evaluate(async (u) => {
        const mine = await window.codeDiff.changes.mine()
        const item = mine.items.find((i) => i.url === u)!
        return window.codeDiff.changes.snapshot({ url: u, updatedAt: item.updatedAt })
      }, url) as Promise<{ ok: boolean }>
    const valueOf = (o: Outcome): { ok: boolean; value?: Record<string, string>; error?: string } => (o as Extract<Outcome, { settled: 'ok' }>).v

    test('answers like the review channel, with an empty record when every write worked, writes by the url and forgets the snapshot of that url', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const read = reads(f, glEp(902))

      // Act
      const outcome = await submit(page, { approve: [glUrl(902)] })

      // Assert
      expect(outcome).toEqual({ settled: 'ok', v: { ok: true, value: {} } })
      expect(writeCalls(f)).toEqual([{ method: 'POST', endpoint: `${glEp(902)}/approve`, body: {} }])
      expect((await askSnapshot(page, glUrl(902))).ok).toBe(true)
      expect(reads(f, glEp(902))).toBe(read + 1)
    })

    test('answers with the error of each failed url and still forgets the snapshots of every url it named', async () => {
      // Arrange
      const { page, forge: f } = await startActions(patch(901, { writeFail: 'HTTP 403 nope' }))
      const before = { gl: reads(f, glEp(901)), gh: reads(f, ghEp(911)) }

      // Act
      const outcome = await submit(page, { approve: [glUrl(901), ghUrl(911)] })

      // Assert
      expect(outcome.settled).toBe('ok')
      const value = valueOf(outcome).value!
      expect(Object.keys(value)).toEqual([glUrl(901)])
      expect(value[glUrl(901)]).toContain('HTTP 403')
      await askSnapshot(page, glUrl(901))
      await askSnapshot(page, ghUrl(911))
      expect(reads(f, glEp(901))).toBe(before.gl + 1)
      expect(reads(f, ghEp(911))).toBe(before.gh + 1)
    })

    test('refuses the whole call and names the host when one url is on a host with no saved access, writing nothing and keeping the snapshots', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const read = reads(f, glEp(901))

      // Act
      const outcome = await submit(page, { approve: [glUrl(901), 'https://git.example.org/team/z/-/merge_requests/5'] })

      // Assert
      expect(outcome.settled).toBe('ok')
      expect(valueOf(outcome).ok).toBe(false)
      expect(valueOf(outcome).error).toContain('git.example.org')
      expect(writeCalls(f)).toEqual([])
      await askSnapshot(page, glUrl(901))
      expect(reads(f, glEp(901))).toBe(read)
    })

    test('refuses the whole call when a url is not a change request url, writing nothing', async () => {
      // Arrange
      const { page, forge: f } = await startActions()

      // Act
      const outcome = await submit(page, { approve: [glUrl(901)], summaries: { 'https://gitlab.com/team/backend/x/-/issues/4': 'hello' } })

      // Assert
      expect(outcome.settled).toBe('ok')
      expect(valueOf(outcome).ok).toBe(false)
      expect(valueOf(outcome).error).toContain('/-/issues/4')
      expect(writeCalls(f)).toEqual([])
    })

    test('rejects a request with more than 100 urls in a list, a url longer than 2048 characters, a summary longer than 65536 characters or a missing list, and writes nothing', async () => {
      // Arrange
      const { page, forge: f } = await startActions()
      const many = Array.from({ length: 101 }, (_, n) => glUrl(n + 1))
      const long = `https://gitlab.com/${'a'.repeat(2_050)}/-/merge_requests/1`

      // Act
      const tooMany = await submit(page, { approve: many })
      const tooLong = await submit(page, { approve: [long] })
      const longKey = await submit(page, { summaries: { [long]: 'x' } })
      const bigText = await submit(page, { summaries: { [glUrl(901)]: 'x'.repeat(65_537) } })
      const noList = await page.evaluate(() =>
        (window.codeDiff.changes as unknown as { submit: (x: unknown) => Promise<never> }).submit({ approve: [] }).then(
          () => 'resolved',
          () => 'rejected'
        )
      )

      // Assert
      for (const o of [tooMany, tooLong, longKey, bigText]) expect(o.settled).toBe('rejected')
      expect(noList).toBe('rejected')
      expect(writeCalls(f)).toEqual([])
    })

    test('accepts exactly 100 urls in a list and a summary of exactly 65536 characters', async () => {
      // Arrange
      const { page } = await startActions()
      const hundred = Array.from({ length: 100 }, () => glUrl(907))

      // Act
      const ok100 = await submit(page, { approve: hundred })
      const okText = await submit(page, { summaries: { [glUrl(901)]: 'x'.repeat(65_536) } })

      // Assert
      expect(ok100.settled).toBe('ok')
      expect(okText.settled).toBe('ok')
    })
  })
})
