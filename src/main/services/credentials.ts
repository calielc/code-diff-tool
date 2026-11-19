import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { credentialFor, restApi, setCredentialProvider, type Credential, type Kind } from '../clients/rest-api'
import { setJiraAccessProvider } from './issues'

/**
 * Saved tokens. Each one is encrypted with the operating system's own protection (Electron safeStorage: DPAPI on Windows,
 * the Keychain on macOS, the keyring on Linux). Nothing is saved in plain text. A token never goes to the window, a log
 * or a file in the workspace (file 05 section 8, adapted: the app now holds tokens, so it protects them).
 */
interface Entry {
  /** base64 of the encrypted JSON `{ token, email? }` */
  enc: string
  /** The Jira account email is not secret, and the access list shows it. */
  email?: string
}
type Store = Record<string, Entry>

const file = (): string => join(app.getPath('userData'), 'credentials.json')
const keyOf = (kind: Kind, host: string): string => `${kind}:${host.toLowerCase()}`

let cache: Store | null = null

function readStoreSync(): Store {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as Store
  } catch {
    cache = {} // a file that cannot be read counts as empty
  }
  return cache
}

/** Tests give the app tokens without touching the operating system store. The variable is ignored unless CODEDIFF_TEST is 1. */
function testCredentials(): Store | null {
  if (process.env['CODEDIFF_TEST'] !== '1' || !process.env['CODEDIFF_TEST_CREDENTIALS']) return null
  try {
    return JSON.parse(process.env['CODEDIFF_TEST_CREDENTIALS']) as Store
  } catch {
    return null
  }
}

export function getCredential(kind: Kind, host: string): Credential | null {
  const k = keyOf(kind, host)
  const t = testCredentials()
  if (t) {
    const e = t[k] as unknown as Credential | undefined
    return e && e.token ? e : null
  }
  const entry = readStoreSync()[k]
  if (!entry || !safeStorage.isEncryptionAvailable()) return null
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))) as Credential
  } catch {
    return null // a token that cannot be decrypted counts as not set up
  }
}

export interface AccessInfo {
  kind: Kind
  host: string
  email?: string
}

/** The saved accesses, without their tokens. */
export function listAccess(): AccessInfo[] {
  const t = testCredentials()
  const store = t ?? readStoreSync()
  return Object.entries(store).map(([k, e]) => {
    const i = k.indexOf(':')
    return { kind: k.slice(0, i) as Kind, host: k.slice(i + 1), email: (e as { email?: string }).email }
  })
}

async function persist(store: Store): Promise<void> {
  await mkdir(join(file(), '..'), { recursive: true })
  const tmp = `${file()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
  await rename(tmp, file())
  cache = store
}

/** What a token must be able to do before it is saved: read the account it belongs to. */
async function whoAmI(kind: Kind, host: string, cred: Credential): Promise<string> {
  if (kind === 'jira')
    return String(((await restApi('jira', host, cred, 'rest/api/3/myself', 'GET')) as { displayName?: string }).displayName ?? cred.email ?? 'ok')
  const u = (await restApi(kind, host, cred, 'user', 'GET')) as { username?: string; login?: string }
  return String(u.username ?? u.login ?? 'ok')
}

/** Check the token against the service, then save it encrypted. A token that does not work is not saved. */
export async function saveAccess(kind: Kind, host: string, cred: Credential): Promise<{ ok: true; user: string } | { ok: false; error: string }> {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!h) return { ok: false, error: 'Enter a host name.' }
  if (!cred.token.trim()) return { ok: false, error: 'Enter a token.' }
  if (kind === 'jira' && !(cred.email ?? '').trim()) return { ok: false, error: 'Enter the email of your Jira account.' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'This computer has no secure place to keep a token, so the app will not save one.' }
  let user: string
  try {
    user = await whoAmI(kind, h, { token: cred.token.trim(), email: cred.email?.trim() })
  } catch (e) {
    return { ok: false, error: `That token did not work: ${e instanceof Error ? e.message : String(e)}` }
  }
  const store = { ...readStoreSync() }
  const secret: Credential = { token: cred.token.trim(), ...(kind === 'jira' ? { email: cred.email?.trim() } : {}) }
  store[keyOf(kind, h)] = { enc: safeStorage.encryptString(JSON.stringify(secret)).toString('base64'), ...(secret.email ? { email: secret.email } : {}) }
  await persist(store)
  return { ok: true, user }
}

export async function removeAccess(kind: Kind, host: string): Promise<void> {
  const store = {
    ...(await readFile(file(), 'utf8').then(
      (s) => JSON.parse(s) as Store,
      () => ({}) as Store
    ))
  }
  delete store[keyOf(kind, host)]
  await persist(store)
}

/** Register the store with the REST transport. */
export function installCredentialStore(): void {
  setCredentialProvider((kind, host) => getCredential(kind, host))
  // Issues are read with the first saved Jira site.
  setJiraAccessProvider(() => {
    const a = listAccess().find((x) => x.kind === 'jira')
    const cred = a ? getCredential('jira', a.host) : null
    return a && cred ? { site: a.host, cred } : null
  })
}

export { credentialFor }
