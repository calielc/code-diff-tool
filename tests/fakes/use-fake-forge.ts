import { setCredentialProvider } from '../../src/main/clients/rest-api'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from './fake-forge'

const KEYS = [
  'CODEDIFF_TEST',
  'CODEDIFF_API_BASE_GITLAB',
  'CODEDIFF_API_BASE_GITHUB',
  'CODEDIFF_API_BASE_JIRA',
  'CODEDIFF_TEST_CREDENTIALS',
  'CODEDIFF_FAKE_CLAUDE'
]

/** Start the fake server and point the REST transport at it, with a token for every host. */
export async function useFakeForge(fixture: Fixture = {}): Promise<FakeForge> {
  const forge = await startFakeForge(fixture)
  Object.assign(process.env, forgeEnv(forge.url))
  setCredentialProvider(() => ({ token: 'test-token', email: 'me@example.com' }))
  return forge
}

export async function stopFakeForge(forge: FakeForge | undefined): Promise<void> {
  for (const k of KEYS) delete process.env[k]
  setCredentialProvider(() => null)
  await forge?.close()
}
