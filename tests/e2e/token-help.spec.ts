import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(__dirname, '../../out/main/index.js')

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const base = mkdtempSync(join(tmpdir(), 'codediff-e2e-th-'))
  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, firstRunDone: true }))
  // no token is saved, so the Prerequisites screen opens first
  const app = await electron.launch({ args: [main], env: { ...process.env, CODEDIFF_USER_DATA: ud } as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Prerequisites' })).toBeVisible()
  return { app, page }
}

test('the GitLab help panel names the api scope and follows the host field', async () => {
  const { app, page } = await launch()
  await page.getByTestId('add-gitlab').click()
  const panel = page.getByTestId('token-help-gitlab')
  await expect(panel, 'the help panel is missing').toBeVisible({ timeout: 3_000 })
  await expect(panel).toContainText('How to create a token')
  await expect(panel).toContainText('api')
  const button = page.getByTestId('token-page-gitlab-0')
  await expect(button).toHaveAttribute('data-url', 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Code%20Diff%20Tool&scopes=api')
  await page.getByLabel('GitLab host').fill('git.acme.io:8443')
  await expect(button).toHaveAttribute('data-url', 'https://git.acme.io:8443/-/user_settings/personal_access_tokens?name=Code%20Diff%20Tool&scopes=api')
  await app.close()
})

test('a bad host disables the page button and shows the hint', async () => {
  const { app, page } = await launch()
  await page.getByTestId('add-gitlab').click()
  const panel = page.getByTestId('token-help-gitlab')
  await expect(panel, 'the help panel is missing').toBeVisible({ timeout: 3_000 })
  await page.getByLabel('GitLab host').fill('evil.com/@x')
  await expect(page.getByTestId('token-page-gitlab-0')).toBeDisabled()
  await expect(panel).toContainText('Check the host name above.')
  await page.getByLabel('GitLab host').fill('gitlab.example.com')
  await expect(page.getByTestId('token-page-gitlab-0')).toBeEnabled()
  await expect(panel).not.toContainText('Check the host name above.')
  await app.close()
})

test('the GitHub panel shows two options', async () => {
  const { app, page } = await launch()
  await page.getByTestId('add-github').click()
  await expect(page.getByTestId('token-help-github'), 'the help panel is missing').toBeVisible({ timeout: 3_000 })
  await expect(page.getByTestId('token-page-github-0')).toHaveAttribute('data-url', 'https://github.com/settings/personal-access-tokens/new')
  await expect(page.getByTestId('token-page-github-1')).toHaveAttribute(
    'data-url',
    'https://github.com/settings/tokens/new?scopes=repo&description=Code%20Diff%20Tool'
  )
  await app.close()
})

test('the Jira panel shows the fixed Atlassian page and warns about the scoped token', async () => {
  const { app, page } = await launch()
  await page.getByTestId('add-jira').click()
  const panel = page.getByTestId('token-help-jira')
  await expect(panel, 'the help panel is missing').toBeVisible({ timeout: 3_000 })
  await expect(panel).toContainText('Create API token with scopes')
  await expect(panel).toContainText('Browse projects')
  const button = page.getByTestId('token-page-jira-0')
  await expect(button).toHaveAttribute('data-url', 'https://id.atlassian.com/manage-profile/security/api-tokens')
  await page.getByLabel('Jira site').fill('acme.atlassian.net')
  await expect(button).toHaveAttribute('data-url', 'https://id.atlassian.com/manage-profile/security/api-tokens')
  await page.getByLabel('Jira site').fill('')
  await expect(button).toBeEnabled()
  await app.close()
})
