import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
const X = 'team/backend/x'
const Y = 'team/frontend/y'
const EP = (project: string, iid: number): string => `projects/${encodeURIComponent(project)}/merge_requests/${iid}`
const key = (project: string, iid: number): string => `${project.slice(project.indexOf('/') + 1)}!${iid}`
const WAIT = { timeout: 15_000 }

const SORT_KEYS = ['repo', 'mr', 'stack', 'title', 'pipeline', 'author', 'reviewers', 'approved', 'review', 'comments', 'created', 'updated', 'merged', 'state']
const HEADERS = [
  'Repo',
  'MR',
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

let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

function makeRepo(root: string, rel: string, remote: string): { base: string; head: string } {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('checkout', '-q', '-B', 'main')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('remote', 'add', 'origin', remote)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.txt'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-B', 'mr1', base)
  writeFileSync(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n')
  git('commit', '-qam', 'mr1')
  return { base, head: git('rev-parse', 'HEAD') }
}

interface Spec {
  project: string
  iid: number
  author: string
  state: 'opened' | 'merged' | 'closed'
  created: string
  reviewers: string[]
  draft?: boolean
  canApprove?: boolean
  approvedBy?: string[]
  extra?: object
}

// The order of this list is the order of the review file. Every MR has the same updated_at, so a tie in a sort falls back to this order.
// Dates are in 2025 so the year always shows. The viewer is "me".
const SPECS: Spec[] = [
  { project: X, iid: 21, author: 'ann', state: 'opened', created: '2025-01-06T12:00:00Z', reviewers: ['bob', 'carol'], approvedBy: ['bob'], canApprove: true },
  { project: X, iid: 22, author: 'ann', state: 'opened', created: '2025-01-02T12:00:00Z', reviewers: [], draft: true, canApprove: false },
  {
    project: X,
    iid: 23,
    author: 'bob',
    state: 'merged',
    created: '2025-01-03T12:00:00Z',
    reviewers: ['ann'],
    approvedBy: ['bob'],
    extra: { merged_at: '2025-01-09T08:00:00Z' }
  },
  { project: X, iid: 25, author: 'me', state: 'opened', created: '2025-01-05T12:00:00Z', reviewers: ['ann'], canApprove: true },
  { project: X, iid: 26, author: 'me', state: 'opened', created: '2025-01-07T12:00:00Z', reviewers: [], draft: true, canApprove: false },
  { project: Y, iid: 31, author: 'carol', state: 'opened', created: '2025-01-08T12:00:00Z', reviewers: ['me', 'ann', 'bob'], approvedBy: ['me'] },
  { project: Y, iid: 32, author: 'bob', state: 'closed', created: '2025-01-04T12:00:00Z', reviewers: ['ann'] },
  { project: Y, iid: 33, author: 'ann', state: 'opened', created: '2025-01-01T12:00:00Z', reviewers: ['bob'], canApprove: true }
]
// The closed MR 32 is hidden by the default filters.
const REVIEW_ORDER = [21, 22, 23, 25, 26, 31, 33]
const CREATED_ASC = [33, 22, 23, 25, 21, 26, 31]
const keyOf = (iid: number): string => {
  const s = SPECS.find((m) => m.iid === iid)!
  return key(s.project, iid)
}

const person = (username: string): object => ({ username, name: username.toUpperCase() })

function buildFixture(shas: Record<string, { base: string; head: string }>, over: Record<string, unknown>): Record<string, unknown> {
  const fixture: Record<string, unknown> = { 'GET user': { json: { username: 'me' } } }
  for (const m of SPECS) {
    const ep = EP(m.project, m.iid)
    const open = m.state === 'opened'
    fixture[`GET ${ep}`] = {
      json: {
        web_url: `https://gitlab.com/${m.project}/-/merge_requests/${m.iid}`,
        state: m.state,
        title: m.draft ? `Draft: Change ${m.iid}` : `Change ${m.iid}`,
        draft: m.draft === true,
        author: person(m.author),
        reviewers: m.reviewers.map(person),
        source_branch: `branch-${m.iid}`,
        target_branch: 'main',
        created_at: m.created,
        updated_at: '2025-02-01T09:05:00Z',
        user_notes_count: 0,
        diff_refs: { base_sha: shas[m.project].base, start_sha: shas[m.project].base, head_sha: shas[m.project].head },
        ...m.extra
      }
    }
    fixture[`GET ${ep}/approvals`] = {
      json: {
        approved_by: (m.approvedBy ?? []).map((u) => ({ user: person(u) })),
        user_can_approve: open && m.canApprove === true,
        user_has_approved: (m.approvedBy ?? []).includes('me')
      }
    }
    fixture[`GET ${ep}/discussions`] = { json: [] }
    fixture[`GET ${ep}/reviewers`] = { json: [] }
  }
  return { ...fixture, ...over }
}

async function openReview(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
  await page.getByTestId('review-R-1').dblclick()
  await expect(page.getByTestId('mrs-summary')).toBeVisible(WAIT)
}

async function launch(over: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const tmp = mkdtempSync(join(tmpdir(), 'codediff-e2e-changes-table-'))
  const root = join(tmp, 'ws')
  const shas = {
    [X]: makeRepo(root, 'backend/x', `git@gitlab.com:${X}.git`),
    [Y]: makeRepo(root, 'frontend/y', `git@gitlab.com:${Y}.git`)
  }
  const ud = join(tmp, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  forge = await startFakeForge(buildFixture(shas, over) as Record<string, any>)
  const dir = join(root, '.code-diff', 'reviews', 'R-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ title: 'Review', mrs: SPECS.map((m) => ({ projectPath: m.project, iid: m.iid })), issues: [] }))
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, TZ: 'UTC', CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await openReview(page)
  return { app, page }
}

const strip = (t: string): string => t.replace(/[▲▼]/g, '').trim()
const headers = async (page: Page): Promise<string[]> => (await page.locator('[data-testid="mrs-tab"] table thead th').allTextContents()).map(strip)
const th = (page: Page, sortKey: string): Locator => page.getByTestId(`sort-${sortKey}`).locator('xpath=ancestor::th')

async function cell(page: Page, iid: number, header: string): Promise<Locator> {
  const col = HEADERS.indexOf(header)
  expect(col, `column ${header}`).toBeGreaterThan(-1)
  return page
    .getByTestId(`mr-${keyOf(iid)}`)
    .locator('td')
    .nth(col)
}

const iidOf = (testId: string): number => Number(testId.slice(testId.lastIndexOf('!') + 1))
const rowOrder = async (page: Page): Promise<number[]> =>
  (await page.locator('tr[data-testid^="mr-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid') ?? ''))).map(iidOf)

/** The body rows in order: the text "Name · count" of a group header row, or the number of an MR. */
const sequence = async (page: Page): Promise<(string | number)[]> =>
  (
    await page.locator('[data-testid="mrs-tab"] tbody tr').evaluateAll((rows) =>
      rows.map((r) =>
        r.getAttribute('data-testid') === 'group-row'
          ? `G:${(r.textContent ?? '')
              .replace(/^\s*[▴▾]\s*/, '')
              .replace(/\s+/g, ' ')
              .trim()}`
          : (r.getAttribute('data-testid') ?? '')
      )
    )
  ).map((id) => (id.startsWith('G:') ? id : iidOf(id)))

const groupRow = (page: Page, name: string): Locator => page.getByTestId('group-row').filter({ hasText: new RegExp(`^\\s*[▴▾]?\\s*${name}\\s*·`) })
const modes = (page: Page): Locator => page.getByTestId('group-mode')
const setMode = (page: Page, name: string): Promise<void> => modes(page).getByRole('button', { name, exact: true }).click()

test.describe('the columns', () => {
  test('are Repo, MR, Stack, Title, Pipeline, Author, Reviewers, Approved by, Your review, Comments, Created, Updated, Merged, State, each with a sort button', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const found = await headers(page)
    const sortIds = await page
      .locator('[data-testid="mrs-tab"] thead [data-testid^="sort-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

    // Assert
    expect(found).toEqual(HEADERS)
    expect(sortIds).toEqual(SORT_KEYS.map((k) => `sort-${k}`))
    await app.close()
  })

  test('start with the Created sort and the order of that sort, and no group header', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const order = await rowOrder(page)

    // Assert
    await expect(th(page, 'created')).toHaveAttribute('aria-sort', 'ascending')
    expect(order).toEqual(CREATED_ASC)
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    await app.close()
  })
})

test.describe('the Reviewers column', () => {
  test('shows an avatar for each requested reviewer, in order, with the name as the tooltip', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const cell21 = page.getByTestId(`reviewers-${keyOf(21)}`)
    const cell31 = page.getByTestId(`reviewers-${keyOf(31)}`)

    // Assert
    expect(await cell21.locator('[data-user]').evaluateAll((els) => els.map((e) => e.getAttribute('data-user')))).toEqual(['bob', 'carol'])
    expect(await cell21.locator('[data-user]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(['BOB (@bob)', 'CAROL (@carol)'])
    expect(await cell31.locator('[data-user]').evaluateAll((els) => els.map((e) => e.getAttribute('data-user')))).toEqual(['me', 'ann', 'bob'])
    await expect(cell31.locator('[data-user="me"]')).toHaveAttribute('title', 'ME (@me), you')
    await app.close()
  })

  test('shows a dash when nobody is asked to review', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act and Assert
    for (const iid of [22, 26]) {
      await expect(page.getByTestId(`reviewers-${keyOf(iid)}`)).toHaveText('–')
      await expect(page.getByTestId(`reviewers-${keyOf(iid)}`).locator('[data-user]')).toHaveCount(0)
    }
    await app.close()
  })

  test('is the 7th cell of the row, between Author and Approved by', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const testId = await (await cell(page, 21, 'Reviewers')).getAttribute('data-testid')
    const approvals = await (await cell(page, 21, 'Approved by')).getAttribute('data-testid')

    // Assert
    expect(testId).toBe(`reviewers-${keyOf(21)}`)
    expect(approvals).toBe(`approvals-${keyOf(21)}`)
    await app.close()
  })
})

test.describe('sorting', () => {
  test('cycles ascending, descending, none on every header, and shows the arrow of the sorted one only', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act and Assert
    for (const k of SORT_KEYS.filter((k) => k !== 'created')) {
      const button = page.getByTestId(`sort-${k}`)
      await button.click()
      await expect(th(page, k), `${k} asc`).toHaveAttribute('aria-sort', 'ascending')
      await expect(button).toContainText('▲')
      await expect(page.locator('[data-testid^="sort-"]').filter({ hasText: /[▲▼]/ })).toHaveCount(1)
      await button.click()
      await expect(th(page, k), `${k} desc`).toHaveAttribute('aria-sort', 'descending')
      await expect(button).toContainText('▼')
      await button.click()
      await expect(th(page, k), `${k} none`).toHaveAttribute('aria-sort', 'none')
      await expect(page.locator('[data-testid^="sort-"]').filter({ hasText: /[▲▼]/ })).toHaveCount(0)
    }
    await app.close()
  })

  test('on Created, which starts ascending, goes descending, none, then ascending again', async () => {
    // Arrange
    const { app, page } = await launch()
    const button = page.getByTestId('sort-created')

    // Act and Assert
    await button.click()
    await expect(th(page, 'created')).toHaveAttribute('aria-sort', 'descending')
    expect(await rowOrder(page)).toEqual([...CREATED_ASC].reverse())
    await button.click()
    await expect(th(page, 'created')).toHaveAttribute('aria-sort', 'none')
    expect(await rowOrder(page)).toEqual(REVIEW_ORDER)
    await button.click()
    await expect(th(page, 'created')).toHaveAttribute('aria-sort', 'ascending')
    expect(await rowOrder(page)).toEqual(CREATED_ASC)
    await app.close()
  })

  // Every MR has the same update time, so a tie keeps the order of the review: 21, 22, 23, 25, 26, 31, 33.
  const ORDERS: [string, number[], number[]][] = [
    ['repo', [21, 22, 23, 25, 26, 31, 33], [31, 33, 21, 22, 23, 25, 26]],
    ['mr', [21, 22, 23, 25, 26, 31, 33], [33, 31, 26, 25, 23, 22, 21]],
    ['title', [21, 23, 25, 31, 33, 22, 26], [26, 22, 33, 31, 25, 23, 21]],
    ['author', [21, 22, 33, 23, 31, 25, 26], [25, 26, 31, 23, 21, 22, 33]],
    ['reviewers', [22, 26, 23, 25, 33, 21, 31], [31, 21, 23, 25, 33, 22, 26]],
    ['approved', [22, 25, 26, 33, 21, 23, 31], [21, 23, 31, 22, 25, 26, 33]],
    ['state', [22, 26, 21, 25, 31, 33, 23], [23, 21, 25, 31, 33, 22, 26]]
  ]
  for (const [k, asc, desc] of ORDERS) {
    test(`by ${k} orders the rows ascending, then descending`, async () => {
      // Arrange
      const { app, page } = await launch()

      // Act
      await page.getByTestId(`sort-${k}`).click()
      const first = await rowOrder(page)
      await page.getByTestId(`sort-${k}`).click()
      const second = await rowOrder(page)

      // Assert
      expect(first).toEqual(asc)
      expect(second).toEqual(desc)
      await app.close()
    })
  }

  test('by Reviewers sorts by the number of reviewers: 0, 0, 1, 1, 1, 2, 3', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await page.getByTestId('sort-reviewers').click()
    const counts = await page
      .locator('tr[data-testid^="mr-"]')
      .evaluateAll((rows) => rows.map((r) => r.querySelectorAll('[data-testid^="reviewers-"] [data-user]').length))

    // Assert
    expect(counts).toEqual([0, 0, 1, 1, 1, 2, 3])
    await app.close()
  })

  test('is saved in codediff:mrSort, so the sort by Reviewers is there after a reload', async () => {
    // Arrange
    const { app, page } = await launch()
    await page.getByTestId('sort-reviewers').click()
    await page.getByTestId('sort-reviewers').click()

    // Act
    await page.reload()
    await openReview(page)

    // Assert
    expect(await page.evaluate(() => localStorage.getItem('codediff:mrSort'))).toBe('{"key":"reviewers","dir":"desc"}')
    await expect(th(page, 'reviewers')).toHaveAttribute('aria-sort', 'descending')
    expect(await rowOrder(page)).toEqual([31, 21, 23, 25, 33, 22, 26])
    await app.close()
  })
})

test.describe('the filters', () => {
  test('keep the summary text, count the hidden MRs and are saved in codediff:mrFilters', async () => {
    // Arrange
    const { app, page } = await launch()
    const states = page.getByRole('group', { name: 'Show MRs by state' })
    const approvals = page.getByRole('group', { name: 'Show MRs by approval' })
    await expect(page.getByTestId('mrs-summary')).toContainText('2 draft · 4 open · 1 merged · 1 closed, 1 hidden')

    // Act
    await states.getByRole('button', { name: /^Merged/ }).click()
    await approvals.getByRole('button', { name: /^Approved/ }).click()

    // Assert
    expect(await rowOrder(page)).toEqual([33, 22, 25, 26])
    await expect(page.getByTestId('mrs-summary')).toContainText('2 draft · 4 open · 1 merged · 1 closed, 4 hidden')
    await page.reload()
    await openReview(page)
    await expect(page.getByRole('group', { name: 'Show MRs by state' }).getByRole('button', { name: /^Merged/ })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('group', { name: 'Show MRs by approval' }).getByRole('button', { name: /^Approved/ })).toHaveAttribute('aria-pressed', 'false')
    expect(await rowOrder(page)).toEqual([33, 22, 25, 26])
    await app.close()
  })

  test('with every state button off show every MR, the same as with every button on', async () => {
    // Arrange
    const { app, page } = await launch()
    const states = page.getByRole('group', { name: 'Show MRs by state' })

    // Act
    for (const name of [/^Draft/, /^Open/, /^Merged/]) await states.getByRole('button', { name }).click()

    // Assert
    expect(await rowOrder(page)).toEqual([33, 22, 23, 32, 25, 21, 26, 31])
    await expect(page.getByTestId('mrs-summary')).not.toContainText('hidden')
    await app.close()
  })

  test('with both approval buttons off show every MR of the states that are on', async () => {
    // Arrange
    const { app, page } = await launch()
    const approvals = page.getByRole('group', { name: 'Show MRs by approval' })

    // Act
    await approvals.getByRole('button', { name: /^Approved/ }).click()
    await approvals.getByRole('button', { name: /^Not approved/ }).click()

    // Assert
    expect(await rowOrder(page)).toEqual(CREATED_ASC)
    await app.close()
  })
})

test.describe('the group buttons', () => {
  test('are a group named Group the list with No group, Repo, State and Approval, and No group is on at the start', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const group = page.getByRole('group', { name: 'Group the list' })

    // Assert
    await expect(group).toHaveCount(1)
    await expect(group).toHaveAttribute('data-testid', 'group-mode')
    await expect(group).toHaveClass(/\bseg\b/)
    await expect(group.getByRole('button')).toHaveText(['No group', 'Repo', 'State', 'Approval'])
    await expect(group.getByRole('button', { name: 'No group', exact: true })).toHaveAttribute('aria-pressed', 'true')
    for (const name of ['Repo', 'State', 'Approval']) await expect(group.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false')
    await app.close()
  })

  test('make the pressed one the only pressed one', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await setMode(page, 'State')

    // Assert
    await expect(modes(page).getByRole('button', { name: 'State', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { name: 'No group', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(modes(page).locator('[aria-pressed="true"]')).toHaveCount(1)
    await app.close()
  })

  test('by State put the MRs under Draft, Open and Merged, each with its count, in the order of the active sort', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await setMode(page, 'State')

    // Assert
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23])
    await app.close()
  })

  test('by State with the Closed button on add a Closed group last', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')

    // Act
    await page
      .getByRole('group', { name: 'Show MRs by state' })
      .getByRole('button', { name: /^Closed/ })
      .click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23, 'G:Closed · 1', 32])
    await app.close()
  })

  test('by Repo put the MRs under the repos, sorted by the path', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await setMode(page, 'Repo')

    // Assert
    expect(await sequence(page)).toEqual(['G:backend/x · 5', 22, 23, 25, 21, 26, 'G:frontend/y · 2', 33, 31])
    await app.close()
  })

  test('by Approval put the MRs under Approved and Not approved', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await setMode(page, 'Approval')

    // Assert
    expect(await sequence(page)).toEqual(['G:Approved · 3', 23, 21, 31, 'G:Not approved · 4', 33, 22, 25, 26])
    await app.close()
  })

  test('by Approval with the Approved button off leave only the Not approved group', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'Approval')

    // Act
    await page
      .getByRole('group', { name: 'Show MRs by approval' })
      .getByRole('button', { name: /^Approved/ })
      .click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Not approved · 4', 33, 22, 25, 26])
    await app.close()
  })

  test('by State with the Draft button off leave no Draft group', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')

    // Act
    await page
      .getByRole('group', { name: 'Show MRs by state' })
      .getByRole('button', { name: /^Draft/ })
      .click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23])
    await app.close()
  })

  test('make the rows follow the active column sort inside every group', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')

    // Act
    await page.getByTestId('sort-mr').click()
    const asc = await sequence(page)
    await page.getByTestId('sort-mr').click()
    const desc = await sequence(page)

    // Assert
    expect(asc).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 21, 25, 31, 33, 'G:Merged · 1', 23])
    expect(desc).toEqual(['G:Draft · 2', 26, 22, 'G:Open · 4', 33, 31, 25, 21, 'G:Merged · 1', 23])
    await app.close()
  })

  test('make the rows of a repo group follow the sort by Reviewers', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'Repo')

    // Act
    await page.getByTestId('sort-reviewers').click()

    // Assert
    expect(await sequence(page)).toEqual(['G:backend/x · 5', 22, 26, 23, 25, 21, 'G:frontend/y · 2', 33, 31])
    await app.close()
  })

  test('with the sort cleared keep the order of the review inside the groups', async () => {
    // Arrange
    const { app, page } = await launch()
    await page.getByTestId('sort-created').click()
    await page.getByTestId('sort-created').click()

    // Act
    await setMode(page, 'State')

    // Assert
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 21, 25, 31, 33, 'G:Merged · 1', 23])
    await app.close()
  })

  test('back to No group show no header row and the order of the sort as before', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'Repo')

    // Act
    await setMode(page, 'No group')

    // Assert
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    expect(await rowOrder(page)).toEqual(CREATED_ASC)
    await app.close()
  })

  test('are not saved: after a reload No group is on again, and nothing about the group is in the local storage', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'Repo')
    await expect(page.getByTestId('group-row')).toHaveCount(2)
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /group/i.test(k)))).toEqual([])

    // Act
    await page.reload()
    await openReview(page)

    // Assert
    await expect(modes(page).getByRole('button', { name: 'No group', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    expect(await page.evaluate(() => Object.values(localStorage).filter((v) => /"repo"|"approval"|"state":"/.test(v)))).toEqual([])
    await app.close()
  })
})

test.describe('the group header rows', () => {
  test('show the chevron, the name and the count, and a toggle button named for its group', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await setMode(page, 'State')

    // Assert
    await expect(page.getByTestId('group-row')).toHaveText([/^\s*▴\s*Draft\s*·\s*2\s*$/, /^\s*▴\s*Open\s*·\s*4\s*$/, /^\s*▴\s*Merged\s*·\s*1\s*$/])
    const toggle = groupRow(page, 'Open').getByTestId('group-toggle')
    await expect(toggle).toHaveText('▴')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAccessibleName('Collapse the Open group')
    await expect(page.getByRole('button', { name: 'Collapse the Draft group' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Collapse the Merged group' })).toHaveCount(1)
    await app.close()
  })

  test('hide the rows of a collapsed group, keep the count and turn the chevron, then show the rows again', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')

    // Act
    await groupRow(page, 'Open').getByTestId('group-toggle').click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 'G:Merged · 1', 23])
    const toggle = groupRow(page, 'Open').getByTestId('group-toggle')
    await expect(toggle).toHaveText('▾')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAccessibleName('Expand the Open group')
    await toggle.click()
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23])
    await expect(groupRow(page, 'Open').getByTestId('group-toggle')).toHaveText('▴')
    await app.close()
  })

  test('toggle with a click on the text of the header too', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')

    // Act
    await groupRow(page, 'Draft').getByText('Draft · 2', { exact: true }).click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Draft · 2', 'G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23])
    await expect(groupRow(page, 'Draft').getByTestId('group-toggle')).toHaveAttribute('aria-expanded', 'false')
    await groupRow(page, 'Draft').getByText('Draft · 2', { exact: true }).click()
    expect(await sequence(page)).toEqual(['G:Draft · 2', 22, 26, 'G:Open · 4', 33, 25, 21, 31, 'G:Merged · 1', 23])
    await app.close()
  })

  test('keep a collapsed group for each group key while the screen is open: State, Repo and Approval do not share', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'State')
    await groupRow(page, 'Open').getByTestId('group-toggle').click()
    await groupRow(page, 'Draft').getByTestId('group-toggle').click()

    // Act
    await setMode(page, 'Repo')
    const inRepo = await sequence(page)
    await groupRow(page, 'frontend/y').getByTestId('group-toggle').click()
    await setMode(page, 'Approval')
    const inApproval = await sequence(page)
    await setMode(page, 'State')
    const backInState = await sequence(page)
    await setMode(page, 'Repo')
    const backInRepo = await sequence(page)

    // Assert
    expect(inRepo).toEqual(['G:backend/x · 5', 22, 23, 25, 21, 26, 'G:frontend/y · 2', 33, 31])
    expect(inApproval).toEqual(['G:Approved · 3', 23, 21, 31, 'G:Not approved · 4', 33, 22, 25, 26])
    expect(backInState).toEqual(['G:Draft · 2', 'G:Open · 4', 'G:Merged · 1', 23])
    expect(backInRepo).toEqual(['G:backend/x · 5', 22, 23, 25, 21, 26, 'G:frontend/y · 2'])
    await app.close()
  })

  test('keep the count of a collapsed group when a filter changes it', async () => {
    // Arrange
    const { app, page } = await launch()
    await setMode(page, 'Approval')
    await groupRow(page, 'Approved').getByTestId('group-toggle').click()

    // Act
    await page
      .getByRole('group', { name: 'Show MRs by state' })
      .getByRole('button', { name: /^Merged/ })
      .click()

    // Assert
    expect(await sequence(page)).toEqual(['G:Approved · 2', 'G:Not approved · 4', 33, 22, 25, 26])
    await app.close()
  })
})

test.describe('Mark as ready and Mark as draft', () => {
  const PUT25 = `PUT ${EP(X, 25)}`
  const PUT26 = `PUT ${EP(X, 26)}`
  const puts = (): { endpoint: string; body: unknown }[] => forge!.bodies.filter((b) => b.method === 'PUT')

  test('are in the State cell of the viewer’s own open MRs, with their icons, and nowhere else', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const state = async (iid: number): Promise<string[]> =>
      await page
        .getByTestId(`state-${keyOf(iid)}`)
        .getByRole('button')
        .allTextContents()

    // Assert
    expect(await state(25)).toEqual(['Mark as draft'])
    expect(await state(26)).toEqual(['Mark as ready'])
    await expect(page.getByTestId(`state-${keyOf(25)}`).getByTestId('icon-mark-draft')).toHaveCount(1)
    await expect(page.getByTestId(`state-${keyOf(26)}`).getByTestId('icon-mark-ready')).toHaveCount(1)
    await expect(page.getByTestId(`state-${keyOf(25)}`).getByRole('button', { name: 'Mark as draft' })).toHaveAttribute('title', 'Adds Draft: to the title')
    await expect(page.getByTestId(`state-${keyOf(26)}`).getByRole('button', { name: 'Mark as ready' })).toHaveAttribute(
      'title',
      'Removes the Draft prefix from the title'
    )
    for (const iid of [21, 22, 23, 31, 33]) expect(await state(iid), `!${iid}`).toEqual([])
    await expect(page.getByTestId(`state-${keyOf(25)}`).locator('.statepill')).toHaveText('Open')
    await expect(page.getByTestId(`state-${keyOf(26)}`).locator('.statepill')).toHaveText('Draft')
    await expect(page.getByText(/^Mark as (ready|draft)$/)).toHaveCount(2)
    await app.close()
  })

  test('are not in the Your review cell, which keeps its status text', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    const mine = await cell(page, 25, 'Your review')
    const draft = await cell(page, 26, 'Your review')

    // Assert
    await expect(mine).toContainText('You are the author')
    await expect(draft).toContainText('You are the author')
    await expect(mine.getByRole('button')).toHaveCount(0)
    await expect(draft.getByRole('button')).toHaveCount(0)
    await expect(mine.getByTestId('icon-mark-draft')).toHaveCount(0)
    await expect(draft.getByTestId('icon-mark-ready')).toHaveCount(0)
    await app.close()
  })

  test('Mark as draft sends the title with the Draft prefix, and the State cell says Marking as draft… meanwhile', async () => {
    // Arrange
    const { app, page } = await launch({ [PUT25]: { empty: true, sleepMs: 1500 } })

    // Act
    await page
      .getByTestId(`state-${keyOf(25)}`)
      .getByRole('button', { name: 'Mark as draft' })
      .click()

    // Assert
    await expect(page.getByTestId(`state-${keyOf(25)}`)).toContainText('Marking as draft…')
    await expect
      .poll(
        () =>
          puts()
            .filter((p) => p.endpoint === EP(X, 25))
            .map((p) => p.body),
        WAIT
      )
      .toEqual([{ title: 'Draft: Change 25' }])
    expect(puts()).toHaveLength(1)
    await app.close()
  })

  test('Mark as ready sends the title without the Draft prefix, and the State cell says Marking as ready… meanwhile', async () => {
    // Arrange
    const { app, page } = await launch({ [PUT26]: { empty: true, sleepMs: 1500 } })

    // Act
    await page
      .getByTestId(`state-${keyOf(26)}`)
      .getByRole('button', { name: 'Mark as ready' })
      .click()

    // Assert
    await expect(page.getByTestId(`state-${keyOf(26)}`)).toContainText('Marking as ready…')
    await expect
      .poll(
        () =>
          puts()
            .filter((p) => p.endpoint === EP(X, 26))
            .map((p) => p.body),
        WAIT
      )
      .toEqual([{ title: 'Change 26' }])
    expect(puts()).toHaveLength(1)
    await app.close()
  })

  test('show the error in the State cell and give the button back when the forge refuses', async () => {
    // Arrange
    const { app, page } = await launch({ [PUT25]: { fail: 'HTTP 500 boom' } })

    // Act
    await page
      .getByTestId(`state-${keyOf(25)}`)
      .getByRole('button', { name: 'Mark as draft' })
      .click()

    // Assert
    await expect(page.getByTestId(`state-${keyOf(25)}`)).toContainText('HTTP 500', WAIT)
    await expect(page.getByTestId(`state-${keyOf(25)}`).getByRole('button', { name: 'Mark as draft' })).toBeVisible()
    await expect(page.getByTestId(`state-${keyOf(25)}`)).not.toContainText('Marking as draft…')
    await expect(await cell(page, 25, 'Your review')).not.toContainText('HTTP 500')
    await app.close()
  })

  test('work from a State group too', async () => {
    // Arrange
    const { app, page } = await launch({ [PUT26]: { empty: true } })
    await setMode(page, 'State')

    // Act
    await groupRow(page, 'Draft').locator('xpath=following-sibling::tr').getByRole('button', { name: 'Mark as ready' }).click()

    // Assert
    await expect.poll(() => puts().map((p) => p.endpoint), WAIT).toEqual([EP(X, 26)])
    await app.close()
  })
})

test.describe('Approve, Submit review and Revoke approval', () => {
  const buttons = async (page: Page, iid: number): Promise<string[]> => await (await cell(page, iid, 'Your review')).getByRole('button').allTextContents()

  test('stay in the Your review cell with the status text', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act and Assert
    await expect(await cell(page, 33, 'Your review')).toContainText('Not reviewed by you yet')
    expect(await buttons(page, 33)).toEqual(['Submit review', 'Approve'])
    await expect(await cell(page, 31, 'Your review')).toContainText('✓ Approved by you')
    expect(await buttons(page, 31)).toEqual(['Submit review', 'Revoke approval'])
    await expect(await cell(page, 22, 'Your review')).toContainText('Not an eligible approver')
    expect(await buttons(page, 22)).toEqual(['Submit review'])
    expect(await buttons(page, 23)).toEqual([])
    await expect(page.getByTestId(`state-${keyOf(33)}`).getByRole('button')).toHaveCount(0)
    await app.close()
  })

  test('Approve posts the approval and says Approving… in the Your review cell meanwhile', async () => {
    // Arrange
    const { app, page } = await launch({ [`POST ${EP(Y, 33)}/approve`]: { empty: true, sleepMs: 1500 } })

    // Act
    await (await cell(page, 33, 'Your review')).getByRole('button', { name: 'Approve', exact: true }).click()

    // Assert
    await expect(await cell(page, 33, 'Your review')).toContainText('Approving…')
    await expect.poll(() => forge!.bodies.filter((b) => b.endpoint === `${EP(Y, 33)}/approve`).length, WAIT).toBe(1)
    await app.close()
  })

  test('Revoke approval posts the unapprove and says Revoking… in the Your review cell meanwhile', async () => {
    // Arrange
    const { app, page } = await launch({ [`POST ${EP(Y, 31)}/unapprove`]: { empty: true, sleepMs: 1500 } })

    // Act
    await (await cell(page, 31, 'Your review')).getByRole('button', { name: 'Revoke approval' }).click()

    // Assert
    await expect(await cell(page, 31, 'Your review')).toContainText('Revoking…')
    await expect.poll(() => forge!.bodies.filter((b) => b.endpoint === `${EP(Y, 31)}/unapprove`).length, WAIT).toBe(1)
    await app.close()
  })

  test('Submit review opens the dialog for that MR', async () => {
    // Arrange
    const { app, page } = await launch()

    // Act
    await page.getByTestId(`submit-${keyOf(21)}`).click()

    // Assert
    await expect(page.getByRole('dialog', { name: 'Submit review' })).toBeVisible()
    await expect(page.getByLabel('Overall comment for !21')).toBeVisible()
    await app.close()
  })

  test('Approve shows its error in the Your review cell', async () => {
    // Arrange
    const { app, page } = await launch({ [`POST ${EP(Y, 33)}/approve`]: { fail: 'HTTP 403 nope' } })

    // Act
    await (await cell(page, 33, 'Your review')).getByRole('button', { name: 'Approve', exact: true }).click()

    // Assert
    await expect(await cell(page, 33, 'Your review')).toContainText('HTTP 403', WAIT)
    await app.close()
  })
})
