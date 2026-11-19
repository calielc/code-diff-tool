import { credentialFor, restApi, type Kind } from './rest-api'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type Provider = 'gitlab' | 'github'

/** Where a call goes: a forge and its host. The token of that host is looked up for every call. */
export interface Target {
  provider: Provider
  host: string
}
export const gitlabAt = (ref: { host: string }): Target => ({ provider: 'gitlab', host: ref.host })
export const githubAt = (ref: { host: string }): Target => ({ provider: 'github', host: ref.host })

/** Thrown for every failed call. The message is the text the window shows. */
export class ApiError extends Error {}

function fail(method: Method, endpoint: string, message: string, write: boolean): never {
  // Writes carry the call in the text (file 05 section 2.1 rule 5). Reads show the bare message (rule 4).
  throw new ApiError(write ? `${method} ${endpoint} failed: ${message}` : message || `${endpoint} failed`)
}

export interface ApiOptions {
  /** Query parameters for a GET. For GitHub's GraphQL endpoint they are the query and its variables. */
  fields?: Record<string, string | number>
  /** JSON body of a write. */
  body?: unknown
  /** Typed GraphQL variables, so numbers stay numbers. */
  typed?: Record<string, string | number>
}

/** One call to GitLab or GitHub over REST. No leading slash and no query string in the endpoint. */
export async function forgeApi(target: Target, endpoint: string, method: Method, opts: ApiOptions = {}): Promise<unknown> {
  const write = method !== 'GET'
  const kind: Kind = target.provider
  const cred = credentialFor(kind, target.host)
  if (!cred) return fail(method, endpoint, `No access to ${target.host} is set up. Open Prerequisites and add a token.`, write)
  try {
    return await restApi(kind, target.host, cred, endpoint, method, opts)
  } catch (e) {
    return fail(method, endpoint, e instanceof Error ? e.message : String(e), write)
  }
}

/** Read a list endpoint page by page until a page holds fewer than 100 items (file 05 section 2.2). */
export async function forgePaged<T = unknown>(
  target: Target,
  endpoint: string,
  fields: Record<string, string | number> = {},
  pick: (page: unknown) => unknown[] = (p) => (Array.isArray(p) ? p : [])
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const items = pick(await forgeApi(target, endpoint, 'GET', { fields: { ...fields, per_page: 100, page } }))
    all.push(...(items as T[]))
    if (items.length < 100) return all
  }
}
