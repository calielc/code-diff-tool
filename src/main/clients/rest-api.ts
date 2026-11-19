import { cancelScope } from '../processes/run'

export type Kind = 'gitlab' | 'github' | 'jira'

/** A saved access: the token, and for Jira the account email. Never logged and never sent to the window. */
export interface Credential {
  token: string
  email?: string
}

type Lookup = (kind: Kind, host: string) => Credential | null
let lookup: Lookup = () => null

/** The main process registers the encrypted store. Tests register a plain one. */
export function setCredentialProvider(fn: Lookup): void {
  lookup = fn
}
export const credentialFor = (kind: Kind, host: string): Credential | null => lookup(kind, host)

export class RestError extends Error {}

/** Tests point the API at a local server. The variable is ignored unless CODEDIFF_TEST is 1. */
function baseUrl(kind: Kind, host: string): string {
  const override = process.env['CODEDIFF_TEST'] === '1' ? process.env[`CODEDIFF_API_BASE_${kind.toUpperCase()}`] : undefined
  if (override) return override.replace(/\/?$/, '/')
  if (kind === 'gitlab') return `https://${host}/api/v4/`
  if (kind === 'github') return host === 'github.com' ? 'https://api.github.com/' : `https://${host}/api/v3/`
  return `https://${host}/`
}

const TIMEOUT_MS = 5 * 60_000

function authHeaders(kind: Kind, c: Credential): Record<string, string> {
  if (kind === 'gitlab') return { 'PRIVATE-TOKEN': c.token }
  if (kind === 'github') return { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  return { Authorization: `Basic ${Buffer.from(`${c.email ?? ''}:${c.token}`).toString('base64')}`, Accept: 'application/json' }
}

/** The text of an error answer: the forge's own message when it sends one, on one line. */
async function errorText(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).trim()
  let message = text
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown; errorMessages?: unknown }
    const m = j.message ?? j.error_description ?? j.error ?? (Array.isArray(j.errorMessages) ? j.errorMessages[0] : undefined)
    if (m !== undefined) message = typeof m === 'string' ? m : JSON.stringify(m)
  } catch {
    /* not JSON: use the text */
  }
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${message ? `: ${message.replace(/\s*[\r\n]+\s*/g, ' ').slice(0, 300)}` : ''}`
}

export interface RestOptions {
  fields?: Record<string, string | number>
  typed?: Record<string, string | number>
  body?: unknown
}

/**
 * One REST call. Returns the parsed JSON, or null for an empty answer. A GET field becomes a query parameter.
 * GitHub's GraphQL endpoint takes `query` and variables from the fields,.
 */
export async function restApi(
  kind: Kind,
  host: string,
  cred: Credential,
  endpoint: string,
  method: string,
  opts: RestOptions = {},
  as: 'json' | 'bytes' = 'json'
): Promise<unknown> {
  const url = new URL(baseUrl(kind, host) + endpoint.replace(/^\//, ''))
  let body: string | undefined
  if (method === 'GET') {
    for (const [k, v] of Object.entries({ ...opts.fields, ...opts.typed })) url.searchParams.set(k, String(v))
  } else if (kind === 'github' && endpoint === 'graphql') {
    const { query, ...rest } = { ...opts.fields } as Record<string, string | number>
    body = JSON.stringify({ query, variables: { ...rest, ...opts.typed } })
  } else if (opts.body !== undefined) body = JSON.stringify(opts.body)

  const scope = cancelScope.getStore()
  const signal = scope ? AbortSignal.any([scope, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { method, headers: { ...authHeaders(kind, cred), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body, signal })
  } catch (e) {
    if (scope?.aborted) throw new RestError('Canceled.')
    const reason =
      e instanceof Error ? (e.name === 'TimeoutError' ? 'it did not finish within 5 minutes' : (e.cause as Error | undefined)?.message || e.message) : String(e)
    throw new RestError(`Could not reach ${host}: ${reason}`)
  }
  if (!res.ok) throw new RestError(await errorText(res))
  if (as === 'bytes') return Buffer.from(await res.arrayBuffer())
  const text = (await res.text()).trim()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RestError(`Unexpected answer from ${host}: ${text.slice(0, 200)}`)
  }
}
