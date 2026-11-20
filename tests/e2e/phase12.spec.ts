import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeEnv, startFakeForge, type FakeForge } from '../fakes/fake-forge'

const main = join(__dirname, '../../out/main/index.js')
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

async function launch(ud: string): Promise<{ app: ElectronApplication; page: Page }> {
  forge = await startFakeForge({ 'GET user': { json: { username: 'me' } } })
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud, ...forgeEnv(forge.url) } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading').first()).toBeVisible()
  return { app, page }
}
const cssVar = (page: Page, name: string): Promise<string> => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const bodyBg = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
/** The label of the checked item of the Theme menu. */
const checkedTheme = (app: ElectronApplication): Promise<string | undefined> =>
  app.evaluate(
    ({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((i) => i.label === 'Theme')
        ?.submenu?.items.find((i) => i.checked)?.label
  )

test('a theme applies to the page at once, is marked in the Theme menu and survives a restart (acceptance check 1)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e12-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))

  let { app, page } = await launch(ud)
  expect(await checkedTheme(app)).toBe('System')
  expect(await cssVar(page, '--bg')).toBe('#ffffff') // the system look, light here

  // a choice in the Theme menu
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Theme')
      ?.submenu?.items.find((i) => i.label === 'Dracula')
      ?.click()
  )
  await expect.poll(() => cssVar(page, '--bg')).toBe('#282a36')
  expect(await bodyBg(page)).toBe('rgb(33, 34, 44)') // the page colour is the panel colour of the theme
  expect(await cssVar(page, '--accent')).toBe('#bd93f9')
  expect(await cssVar(page, '--add-bg')).toMatch(/^#[0-9a-f]{6}$/)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dracula')
  await expect.poll(() => checkedTheme(app)).toBe('Dracula')
  await app.close()

  // the choice is saved
  ;({ app, page } = await launch(ud))
  await expect.poll(() => cssVar(page, '--bg')).toBe('#282a36')
  expect(await checkedTheme(app)).toBe('Dracula')

  // a light theme, chosen from the page side
  await page.evaluate(() => window.codeDiff.theme.choose('paper'))
  await expect.poll(() => cssVar(page, '--bg')).toBe('#fbf7ef')
  await expect.poll(() => checkedTheme(app)).toBe('Paper (light)')

  // System removes every colour of a theme
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Theme')
      ?.submenu?.items.find((i) => i.label === 'System')
      ?.click()
  )
  await expect.poll(() => cssVar(page, '--bg')).toBe('#ffffff')
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  await app.close()
})

test('an id that no theme has reads as System (acceptance check 2)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e12-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true, theme: 'does-not-exist' }))
  const { app, page } = await launch(ud)
  expect(await checkedTheme(app)).toBe('System')
  expect(await cssVar(page, '--bg')).toBe('#ffffff')
  expect(await page.evaluate((id) => window.codeDiff.theme.choose(id), 'also-missing')).toBe('system')
  await app.close()
})
