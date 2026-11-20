import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e-focus-'))
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, firstRunDone: true }))
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
  return { app, page }
}

// The focus check runs at most once every 2 seconds, so wait past that before the window "comes back".
// An observer on the Check again button proves that a re-check really ran: the button is disabled while it runs.
async function returnToWindow(page: Page): Promise<void> {
  await page.waitForTimeout(2_300)
  await page.evaluate(() => {
    const w = window as unknown as { __rechecked: boolean }
    w.__rechecked = false
    const button = document.querySelector('[data-testid="check-again"]') as HTMLButtonElement
    new MutationObserver(() => {
      if (button.disabled) w.__rechecked = true
    }).observe(button, { attributes: true, attributeFilter: ['disabled'] })
    window.dispatchEvent(new Event('focus'))
  })
  await page.waitForFunction(() => (window as unknown as { __rechecked: boolean }).__rechecked === true, undefined, { timeout: 10_000 })
  await expect(page.getByTestId('check-again')).toBeEnabled({ timeout: 15_000 })
}

test('an open access form keeps its fields and its collapsed help when the window gets focus again', async () => {
  // Arrange
  const { app, page } = await launch()
  await page.getByTestId('add-github').click()
  await page.getByLabel('GitHub host').fill('ghe.acme.io')
  await page.getByLabel('GitHub token').fill('typed-token-value')
  const panel = page.getByTestId('token-help-github')
  await panel.locator('summary').click()
  await expect(panel).not.toHaveAttribute('open', '')

  // Act
  await returnToWindow(page)

  // Assert
  await expect(page.getByLabel('GitHub host')).toHaveValue('ghe.acme.io')
  await expect(page.getByLabel('GitHub token')).toHaveValue('typed-token-value')
  await expect(page.getByTestId('token-help-github')).not.toHaveAttribute('open', '')
  await app.close()
})

test('the open help panel and the typed Jira fields stay when the window gets focus again', async () => {
  // Arrange
  const { app, page } = await launch()
  await page.getByTestId('add-jira').click()
  await page.getByLabel('Jira site').fill('acme.atlassian.net')
  await page.getByLabel('Jira account email').fill('me@acme.io')
  await expect(page.getByTestId('token-help-jira')).toHaveAttribute('open', '')

  // Act
  await returnToWindow(page)

  // Assert
  await expect(page.getByLabel('Jira site')).toHaveValue('acme.atlassian.net')
  await expect(page.getByLabel('Jira account email')).toHaveValue('me@acme.io')
  await expect(page.getByTestId('token-help-jira')).toHaveAttribute('open', '')
  await app.close()
})

test('the custom AI tool form keeps what was typed when the window gets focus again', async () => {
  // Arrange
  const { app, page } = await launch()
  await page.getByLabel('AI tool').selectOption('custom')
  await page.getByLabel('Tool command').fill('my-ai-tool')

  // Act
  await returnToWindow(page)

  // Assert
  await expect(page.getByLabel('AI tool')).toHaveValue('custom')
  await expect(page.getByLabel('Tool command')).toHaveValue('my-ai-tool')
  await app.close()
})
