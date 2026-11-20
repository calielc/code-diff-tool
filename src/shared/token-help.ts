import type { AccessKind } from './types'

export interface TokenPermission {
  name: string
  why: string
}

export interface TokenOption {
  label: string
  pageUrl: string | null
  pageLabel: string
  steps: string[]
  permissions: TokenPermission[]
}

export interface TokenHelp {
  intro: string
  options: TokenOption[]
  notes: string[]
}

const DEFAULT_HOSTS: Record<'gitlab' | 'github', string> = { gitlab: 'gitlab.com', github: 'github.com' }
const VALID_HOST = /^[a-z0-9.-]+(:\d+)?$/
const TOKEN_NAME = 'Code%20Diff%20Tool'

/** Returns a clean host name with an optional port, or null when the text is not a plain host name. */
function cleanHost(input: string, fallback: string): string | null {
  let host = input.trim().toLowerCase()
  if (host === '') return fallback
  if (/^https?:\/\//.test(host)) host = host.replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  if (!VALID_HOST.test(host)) return null
  const port = host.split(':')[1]
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535) ? host : null
}

function gitlabHelp(host: string | null): TokenHelp {
  return {
    intro: 'The app needs a personal access token to talk to GitLab for you.',
    options: [
      {
        label: 'Personal access token',
        pageUrl: host && `https://${host}/-/user_settings/personal_access_tokens?name=${TOKEN_NAME}&scopes=api`,
        pageLabel: 'Open the token page',
        steps: [
          'Open the token page. GitLab fills in the name and the scope for you.',
          'Check that the api scope is selected.',
          'Choose an expiry date, then select Create personal access token.',
          'Copy the token and paste it into the field below.'
        ],
        permissions: [
          {
            name: 'api',
            why: 'The app posts comments, publishes review notes, approves, resolves threads, deletes notes and changes the Draft prefix. The read_api scope only reads, so these actions would fail.'
          }
        ]
      }
    ],
    notes: [
      'GitLab asks for an expiry date. Write down when the token ends.',
      'The token never does more than your account can do. To approve, your role must be allowed to approve on that project.',
      'On an older GitLab, use the page /-/profile/personal_access_tokens on your host instead.'
    ]
  }
}

function githubHelp(host: string | null): TokenHelp {
  return {
    intro: 'The app needs a personal access token to talk to GitHub for you. A fine-grained token is the safer choice.',
    options: [
      {
        label: 'Fine-grained token (recommended)',
        pageUrl: host && `https://${host}/settings/personal-access-tokens/new`,
        pageLabel: 'Open the token page',
        steps: [
          'Open the token page.',
          'Set the resource owner to the user or the organization that owns the repositories.',
          'Under Repository access, choose the repositories you want to review.',
          'Under Permissions, set the access shown below.',
          'Select Generate token, then copy it and paste it into the field below.'
        ],
        permissions: [
          { name: 'Pull requests: Read and write', why: 'The app posts comments and reviews, dismisses reviews, resolves threads and toggles Draft.' },
          { name: 'Metadata: Read-only', why: 'GitHub adds this permission by itself. Every token needs it.' }
        ]
      },
      {
        label: 'Classic token',
        pageUrl: host && `https://${host}/settings/tokens/new?scopes=repo&description=${TOKEN_NAME}`,
        pageLabel: 'Open the classic token page',
        steps: [
          'Open the token page. GitHub fills in the name and the repo scope for you.',
          'Use public_repo instead of repo if you only review public repositories.',
          'Select Generate token, then copy it and paste it into the field below.'
        ],
        permissions: [
          { name: 'repo', why: 'Gives access to private repositories. Needed to read and review them.' },
          { name: 'public_repo', why: 'Gives access to public repositories only. Use it in place of repo when that is enough.' }
        ]
      }
    ],
    notes: [
      'If your organization uses SAML SSO, authorize the token for it. Use Configure SSO next to the token.',
      'An organization can require an owner to approve a fine-grained token before it works.'
    ]
  }
}

function jiraHelp(): TokenHelp {
  return {
    intro: 'The app needs an Atlassian API token and the email of the same account to read Jira issues.',
    options: [
      {
        label: 'API token',
        pageUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
        pageLabel: 'Open the token page',
        steps: [
          'Open the token page. It is the same page for every Jira site.',
          'Select Create API token.',
          'Do not select Create API token with scopes. The app signs in with your email and the token, and only a plain token works that way.',
          'Choose an expiry date, then copy the token and paste it into the field below.'
        ],
        permissions: [
          {
            name: 'Browse projects',
            why: 'A plain token has the permissions of your account. The account must see the projects of the issues. The app only reads.'
          }
        ]
      }
    ],
    notes: ['Use the email of the Atlassian account that created the token.', 'Atlassian asks for an expiry of 1 to 365 days. Write down when the token ends.']
  }
}

export function tokenHelp(kind: AccessKind, host: string): TokenHelp {
  if (kind === 'jira') return jiraHelp()
  const clean = cleanHost(host, DEFAULT_HOSTS[kind])
  return kind === 'gitlab' ? gitlabHelp(clean) : githubHelp(clean)
}
