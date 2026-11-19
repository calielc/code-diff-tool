import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/**
 * A fake GitLab, GitHub and Jira in one HTTP server. Fixture keys are "<METHOD> <endpoint>", without a query string.
 * Values:
 *   { json: any }      answer with this JSON
 *   { list: N }        answer with page <page> of N synthetic items, honouring per_page and page
 *   { fail: 'text' }   answer with the HTTP status named in the text (500 when none) and the rest of the text as the message
 *   { echoBody: true } answer with the JSON body that was sent
 *   { empty: true }    answer with nothing
 *   { sleepMs: N }     wait before answering (can be combined with the others)
 * A value can also be an array of entries: the 1st call gets item 0, the 2nd item 1, and so on. The last item repeats.
 */
export type Entry = { json?: unknown; list?: number; fail?: string; echoBody?: boolean; empty?: boolean; sleepMs?: number }
export type Fixture = Record<string, Entry | Entry[]>

export interface Call {
  method: string
  endpoint: string
  query: Record<string, string>
  body: unknown
  /** The auth header the call carried, so a test can check a token was sent. */
  auth: string | null
}

export interface FakeForge {
  url: string
  calls: Call[]
  /** The writes (calls with a body), in order. */
  bodies: Call[]
  setFixture(f: Fixture): void
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function startFakeForge(initial: Fixture = {}): Promise<FakeForge> {
  let fixture = initial
  const counts = new Map<string, number>()
  const calls: Call[] = []
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const endpoint = url.pathname.replace(/^\//, '')
    const method = req.method ?? 'GET'
    const body = await readBody(req)
    const query = Object.fromEntries(url.searchParams)
    const auth = (req.headers['private-token'] as string | undefined) ?? (req.headers['authorization'] as string | undefined) ?? null
    calls.push({ method, endpoint, query, body, auth })

    const key = `${method} ${endpoint}`
    let entry = fixture[key]
    if (Array.isArray(entry)) {
      const n = counts.get(key) ?? 0
      counts.set(key, n + 1)
      entry = entry[Math.min(n, entry.length - 1)]
    }
    const send = (status: number, text: string, type = 'application/json'): void => {
      res.writeHead(status, { 'Content-Type': type })
      res.end(text)
    }
    if (!entry) return send(404, JSON.stringify({ message: `no fixture for ${key}` }))
    if (entry.sleepMs) await new Promise((r) => setTimeout(r, entry.sleepMs))
    if (entry.fail !== undefined) {
      const code = Number(/HTTP (\d{3})/.exec(entry.fail)?.[1] ?? 500)
      const rest = entry.fail.replace(/^HTTP \d{3}\s*/, '').trim()
      // A message that only repeats the status text adds nothing, so it is left out.
      return send(code, rest && rest !== STATUS_CODES[code] ? JSON.stringify({ message: rest }) : '')
    }
    if (entry.list !== undefined) {
      const per = Number(query['per_page'] ?? 100)
      const page = Number(query['page'] ?? 1)
      const items = []
      for (let n = (page - 1) * per; n < Math.min(entry.list, page * per); n++) items.push({ id: n + 1 })
      return send(200, JSON.stringify(items))
    }
    if (entry.echoBody) return send(200, JSON.stringify(body ?? null))
    if (entry.json !== undefined) return send(200, JSON.stringify(entry.json))
    return send(204, '')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return {
    url,
    calls,
    get bodies() {
      return calls.filter((c) => c.body !== undefined)
    },
    setFixture: (f) => {
      fixture = f
      counts.clear()
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())))
  }
}

/** The environment that points the app, or a test, at the fake server with tokens for every host used in tests. */
export function forgeEnv(url: string): Record<string, string> {
  return {
    CODEDIFF_TEST: '1',
    // A test must never reach a real claude: summaries start at every build that has issues.
    CODEDIFF_FAKE_CLAUDE: JSON.stringify(['node', join(__dirname, 'fake-claude.mjs')]),
    CODEDIFF_API_BASE_GITLAB: url,
    CODEDIFF_API_BASE_GITHUB: url,
    CODEDIFF_API_BASE_JIRA: url,
    CODEDIFF_TEST_CREDENTIALS: JSON.stringify({
      'gitlab:gitlab.com': { token: 'glpat-test' },
      'github:github.com': { token: 'ghp-test' },
      'jira:acme.atlassian.net': { token: 'jira-test', email: 'me@example.com' }
    })
  }
}
