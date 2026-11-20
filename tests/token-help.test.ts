import { describe, expect, it } from 'vitest'
import { tokenHelp, type TokenHelp } from '../src/shared/token-help'
import type { AccessKind } from '../src/shared/types'

const ATLASSIAN = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const urls = (help: TokenHelp): (string | null)[] => help.options.map((o) => o.pageUrl)
const names = (help: TokenHelp, index: number): string[] => help.options[index].permissions.map((p) => p.name)

describe('tokenHelp GitLab', () => {
  it('tokenHelp_shouldGiveOneOptionWithTheExactUrl_whenGitLabHostIsGiven', () => {
    // Arrange
    const host = 'git.acme.io'

    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    expect(help.options).toHaveLength(1)
    expect(help.options[0].pageUrl).toBe('https://git.acme.io/-/user_settings/personal_access_tokens?name=Code%20Diff%20Tool&scopes=api')
  })

  it('tokenHelp_shouldAskOnlyForTheApiScope_whenGitLab', () => {
    // Arrange
    const host = 'gitlab.com'

    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    expect(names(help, 0)).toEqual(['api'])
  })

  it('tokenHelp_shouldMentionTheExpiryAndTheOlderProfilePage_whenGitLab', () => {
    // Arrange
    const host = 'gitlab.com'

    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    const notes = help.notes.join('\n').toLowerCase()
    expect(notes).toContain('expir')
    expect(notes).toContain('/-/profile/personal_access_tokens')
  })
})

describe('tokenHelp GitHub', () => {
  it('tokenHelp_shouldGiveFineGrainedThenClassicWithTheExactUrls_whenGitHubHostIsGiven', () => {
    // Arrange
    const host = 'github.acme.io'

    // Act
    const help = tokenHelp('github', host)

    // Assert
    expect(urls(help)).toEqual([
      'https://github.acme.io/settings/personal-access-tokens/new',
      'https://github.acme.io/settings/tokens/new?scopes=repo&description=Code%20Diff%20Tool'
    ])
    expect(help.options[0].label.toLowerCase()).toContain('fine-grained')
    expect(help.options[1].label.toLowerCase()).toContain('classic')
  })

  it('tokenHelp_shouldNamePullRequestsAndMetadata_whenFineGrainedOption', () => {
    // Arrange
    const host = 'github.com'

    // Act
    const help = tokenHelp('github', host)

    // Assert
    expect(names(help, 0)).toEqual(['Pull requests: Read and write', 'Metadata: Read-only'])
  })

  it('tokenHelp_shouldNameRepoAndPublicRepoWithReasons_whenClassicOption', () => {
    // Arrange
    const host = 'github.com'

    // Act
    const help = tokenHelp('github', host)

    // Assert
    expect(names(help, 1)).toEqual(['repo', 'public_repo'])
    expect(help.options[1].permissions.every((p) => p.why.length > 0)).toBe(true)
  })

  it('tokenHelp_shouldMentionSamlSso_whenGitHub', () => {
    // Arrange
    const host = 'github.com'

    // Act
    const help = tokenHelp('github', host)

    // Assert
    expect(help.notes.join('\n')).toContain('SAML SSO')
  })
})

describe('tokenHelp Jira', () => {
  it('tokenHelp_shouldGiveTheFixedAtlassianUrl_whenAnyJiraSiteIsGiven', () => {
    // Arrange
    const sites = ['acme.atlassian.net', '', 'bad host/@x', 'https://Other.example.com:8443/path?q=1']

    // Act
    const results = sites.map((s) => tokenHelp('jira', s))

    // Assert
    for (const help of results) {
      expect(help.options).toHaveLength(1)
      expect(help.options[0].pageUrl).toBe(ATLASSIAN)
    }
  })

  it('tokenHelp_shouldTellToUseThePlainTokenNotTheScopedOne_whenJira', () => {
    // Arrange
    const site = 'acme.atlassian.net'

    // Act
    const help = tokenHelp('jira', site)

    // Assert
    const steps = help.options[0].steps.join('\n')
    expect(steps).toContain('Create API token')
    expect(steps).toContain('Create API token with scopes')
    expect(steps.toLowerCase()).toMatch(/not|do not/)
  })

  it('tokenHelp_shouldListBrowseProjects_whenJira', () => {
    // Arrange
    const site = 'acme.atlassian.net'

    // Act
    const help = tokenHelp('jira', site)

    // Assert
    expect(names(help, 0)).toEqual(['Browse projects'])
  })
})

describe('tokenHelp host handling', () => {
  it.each<[AccessKind, string, string]>([
    ['gitlab', 'https://GitLab.Example.com/foo?x=1', 'gitlab.example.com'],
    ['gitlab', '  GITLAB.Corp.NET  ', 'gitlab.corp.net'],
    ['gitlab', 'http://git.local/a/b#frag', 'git.local'],
    ['gitlab', 'gitlab.local:8443', 'gitlab.local:8443'],
    ['gitlab', 'https://gitlab.local:9000/x', 'gitlab.local:9000'],
    ['gitlab', 'a.b', 'a.b'],
    ['gitlab', 'my-host', 'my-host'],
    ['github', 'HTTPS://Ghe.Example.com/org', 'ghe.example.com'],
    ['github', 'ghe.local:8443', 'ghe.local:8443']
  ])('tokenHelp_shouldNormaliseTheHost_when%s_%s', (kind, input, expected) => {
    // Arrange
    const pathOfFirstOption =
      kind === 'gitlab' ? '/-/user_settings/personal_access_tokens?name=Code%20Diff%20Tool&scopes=api' : '/settings/personal-access-tokens/new'

    // Act
    const help = tokenHelp(kind, input)

    // Assert
    expect(help.options[0].pageUrl).toBe(`https://${expected}${pathOfFirstOption}`)
  })

  it.each<[AccessKind, string]>([
    ['gitlab', 'gitlab.com'],
    ['github', 'github.com']
  ])('tokenHelp_shouldUseTheDefaultHost_whenHostIsEmptyFor%s', (kind, expected) => {
    // Arrange
    const inputs = ['', '   ']

    // Act
    const results = inputs.map((i) => tokenHelp(kind, i))

    // Assert
    for (const help of results) {
      expect(help.options[0].pageUrl).toContain(`https://${expected}/`)
    }
  })

  it('tokenHelp_shouldFillTheDefaultHostInEveryGitHubOption_whenHostIsEmpty', () => {
    // Arrange
    const host = ''

    // Act
    const help = tokenHelp('github', host)

    // Assert
    expect(urls(help)).toEqual([
      'https://github.com/settings/personal-access-tokens/new',
      'https://github.com/settings/tokens/new?scopes=repo&description=Code%20Diff%20Tool'
    ])
  })

  it.each(['evil.com/@x', 'a b', 'a\\b', 'host#frag', 'user@host.com', 'host:port', 'host:', 'ho$t.com', 'a b.com:80', 'host:80:90'])(
    'tokenHelp_shouldGiveNullUrls_whenHostIsInvalid_%s',
    (host) => {
      // Arrange
      const kinds: AccessKind[] = ['gitlab', 'github']

      // Act
      const results = kinds.map((k) => tokenHelp(k, host))

      // Assert
      for (const help of results) {
        expect(urls(help).every((u) => u === null)).toBe(true)
      }
    }
  )

  it.each(['h:0', 'h:65536', 'h:99999', 'h:000'])('tokenHelp_shouldGiveNoUrl_whenThePortIsOutOfRange_%s', (host) => {
    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    expect(help.options[0].pageUrl).toBeNull()
  })
  it.each([
    ['h:1', 'h:1'],
    ['h:65535', 'h:65535'],
    ['h:8443', 'h:8443']
  ])('tokenHelp_shouldKeepThePort_whenItIsInRange_%s', (host, expected) => {
    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    expect(help.options[0].pageUrl).toBe(`https://${expected}/-/user_settings/personal_access_tokens?name=Code%20Diff%20Tool&scopes=api`)
  })
  it('tokenHelp_shouldKeepTheStepsAndPermissions_whenHostIsInvalid', () => {
    // Arrange
    const host = 'a b'

    // Act
    const help = tokenHelp('gitlab', host)

    // Assert
    expect(help.options[0].pageUrl).toBeNull()
    expect(help.options[0].steps.length).toBeGreaterThan(0)
    expect(names(help, 0)).toEqual(['api'])
  })
})

describe('tokenHelp safety and shape', () => {
  const hosts = ['gitlab.com', 'x.y:1', 'https://u@evil.com/', 'a b', '', 'EXAMPLE.org/p?q#f']
  const kinds: AccessKind[] = ['gitlab', 'github', 'jira']

  it('tokenHelp_shouldOnlyGiveHttpsUrlsWithoutUserInfo_whenAnyKindAndHost', () => {
    // Arrange
    const combos = kinds.flatMap((k) => hosts.map((h) => tokenHelp(k, h)))

    // Act
    const all = combos.flatMap((help) => urls(help)).filter((u): u is string => u !== null)

    // Assert
    expect(all.length).toBeGreaterThan(0)
    for (const u of all) {
      expect(u.startsWith('https://')).toBe(true)
      expect(new URL(u).username).toBe('')
      expect(new URL(u).password).toBe('')
      expect(u.split('?')[0].includes('@')).toBe(false)
    }
  })

  it('tokenHelp_shouldKeepTheHostOutOfThePathAndFixTheOrigin_whenHostHasAPathAndQuery', () => {
    // Arrange
    const host = 'https://Host.Example.com/evil/path?x=1#y'

    // Act
    const help = tokenHelp('github', host)

    // Assert
    for (const u of urls(help)) {
      expect(new URL(u!).origin).toBe('https://host.example.com')
      expect(u).not.toContain('evil')
    }
  })

  it('tokenHelp_shouldFillEveryStepReasonAndIntro_whenAnyKindAndHost', () => {
    // Arrange
    const combos = kinds.flatMap((k) => hosts.map((h) => tokenHelp(k, h)))

    // Act
    const options = combos.flatMap((help) => help.options)

    // Assert
    expect(combos.every((help) => help.intro.length > 0)).toBe(true)
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect(option.steps.length).toBeGreaterThan(0)
      expect(option.pageLabel.length).toBeGreaterThan(0)
      expect(option.permissions.length).toBeGreaterThan(0)
      expect(option.permissions.every((p) => p.name.length > 0 && p.why.trim().length > 0)).toBe(true)
    }
  })
})
