import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAvatars, resetAvatarCache } from '../src/main/services/avatars'

const LIMIT = 524_288
const DAY_MS = 24 * 60 * 60 * 1000

interface Seen {
  path: string
  headers: IncomingHttpHeaders
}
type Route = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let seen: Seen[]
let inFlight: number
let maxInFlight: number
let routes: Record<string, Route>
let cacheDir: string

const body = (size: number, fill = 7): Buffer => Buffer.alloc(size, fill)
const dataUrl = (type: string, bytes: Buffer): string => `data:${type};base64,${bytes.toString('base64')}`
const send =
  (type: string | null, bytes: Buffer, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, type ? { 'Content-Type': type } : {})
    res.end(bytes)
  }
const hits = (path?: string): number => seen.filter((s) => path === undefined || s.path === path).length
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

beforeEach(async () => {
  seen = []
  inFlight = 0
  maxInFlight = 0
  routes = {}
  cacheDir = mkdtempSync(join(tmpdir(), 'codediff-avatars-'))
  process.env['CODEDIFF_TEST'] = '1'
  resetAvatarCache()
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    seen.push({ path, headers: req.headers })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.on('close', () => inFlight--)
    const route = routes[path] ?? routes['*']
    if (route) route(req, res)
    else send('text/plain', Buffer.from('no route'), 404)(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.useRealTimers()
  delete process.env['CODEDIFF_TEST']
  delete process.env['CODEDIFF_AVATAR_TIMEOUT_MS']
  await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())))
})

describe('getAvatars: which urls are fetched (AC7, AC8)', () => {
  it('returns a data URL for a picture on the local test server', async () => {
    // Arrange
    const png = body(120, 3)
    routes['/a.png'] = send('image/png', png)

    // Act
    const result = await getAvatars([`${base}/a.png`], cacheDir)

    // Assert
    expect(result).toEqual({ [`${base}/a.png`]: dataUrl('image/png', png) })
    expect(hits()).toBe(1)
  })

  it('also allows localhost over http when CODEDIFF_TEST is 1', async () => {
    // Arrange
    const port = new URL(base).port
    const url = `http://localhost:${port}/a.png`
    const png = body(64, 5)
    routes['/a.png'] = send('image/png', png)

    // Act
    const result = await getAvatars([url], cacheDir)

    // Assert
    expect(result[url]).toBe(dataUrl('image/png', png))
  })

  it('refuses http and local hosts without a request when CODEDIFF_TEST is not 1', async () => {
    // Arrange
    delete process.env['CODEDIFF_TEST']
    const port = new URL(base).port
    const urls = [`${base}/a.png`, `http://localhost:${port}/a.png`]
    routes['*'] = send('image/png', body(10))

    // Act
    const result = await getAvatars(urls, cacheDir)

    // Assert
    expect(result).toEqual({ [urls[0]]: null, [urls[1]]: null })
    expect(hits()).toBe(0)
  })

  it('gives null for a url that is not https, and for a url that is not a url', async () => {
    // Arrange
    routes['*'] = send('image/png', body(10))
    const urls = ['http://example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'not a url', '']

    // Act
    const result = await getAvatars(urls, cacheDir)

    // Assert
    expect(result).toEqual({
      'http://example.com/a.png': null,
      'file:///etc/passwd': null,
      'data:image/png;base64,AAAA': null,
      'javascript:alert(1)': null,
      'not a url': null,
      '': null
    })
    expect(hits()).toBe(0)
  })

  it.each([
    'https://10.0.0.5/a.png',
    'https://192.168.1.20/a.png',
    'https://8.8.8.8/a.png',
    'https://[::1]/a.png',
    'https://[2001:db8::1]/a.png',
    'https://localhost/a.png',
    'https://printer.local/a.png',
    'https://svc.internal/a.png',
    'https://dev.localhost/a.png'
  ])('gives null for the host in %s', async (url) => {
    // Arrange
    routes['*'] = send('image/png', body(10))

    // Act
    const result = await getAvatars([url], cacheDir)

    // Assert
    expect(result).toEqual({ [url]: null })
    expect(hits()).toBe(0)
  })
})

describe('getAvatars: the answer (AC9)', () => {
  it.each([['image/png'], ['image/jpeg'], ['image/gif'], ['image/webp']])('accepts %s', async (type) => {
    // Arrange
    const bytes = body(300, 9)
    routes['/p'] = send(type, bytes)

    // Act
    const result = await getAvatars([`${base}/p`], cacheDir)

    // Assert
    expect(result[`${base}/p`]).toBe(dataUrl(type, bytes))
  })

  it.each([['image/svg+xml'], ['text/html'], ['application/octet-stream'], ['image/bmp'], [null]])('gives null for the content type %s', async (type) => {
    // Arrange
    routes['/p'] = send(type, body(300))

    // Act
    const result = await getAvatars([`${base}/p`], cacheDir)

    // Assert
    expect(result).toEqual({ [`${base}/p`]: null })
    expect(hits()).toBe(1)
  })

  it.each([[404], [500], [201]])('gives null for the status %s', async (status) => {
    // Arrange
    routes['/p'] = send('image/png', body(300), status)

    // Act
    const result = await getAvatars([`${base}/p`], cacheDir)

    // Assert
    expect(result).toEqual({ [`${base}/p`]: null })
  })
})

describe('getAvatars: the size limit (AC10)', () => {
  it.each([
    [LIMIT - 1, true],
    [LIMIT, true],
    [LIMIT + 1, false]
  ])('a body of %s bytes is accepted: %s', async (size, accepted) => {
    // Arrange
    const bytes = body(size, 11)
    routes['/big'] = send('image/jpeg', bytes)

    // Act
    const result = await getAvatars([`${base}/big`], cacheDir)

    // Assert
    expect(result[`${base}/big`]).toBe(accepted ? dataUrl('image/jpeg', bytes) : null)
  })

  it('stops reading an endless body instead of buffering it', async () => {
    // Arrange
    let written = 0
    let closed = false
    routes['/endless'] = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.on('close', () => (closed = true))
      const chunk = body(65_536)
      const pump = (): void => {
        while (!closed && written < 200 * 1024 * 1024) {
          written += chunk.length
          if (!res.write(chunk)) return void res.once('drain', pump)
        }
      }
      pump()
    }

    // Act
    const result = await getAvatars([`${base}/endless`], cacheDir)
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 })

    // Assert
    expect(result).toEqual({ [`${base}/endless`]: null })
    expect(written).toBeLessThan(50 * 1024 * 1024)
  })
})

describe('getAvatars: the time limit (AC11)', () => {
  beforeEach(() => {
    process.env['CODEDIFF_AVATAR_TIMEOUT_MS'] = '300'
  })

  it('gives null when the answer does not start within the limit', async () => {
    // Arrange
    routes['/slow'] = (_req, res) => void setTimeout(() => send('image/png', body(10))(_req, res), 1500)
    const t0 = Date.now()

    // Act
    const result = await getAvatars([`${base}/slow`], cacheDir)

    // Assert
    expect(result).toEqual({ [`${base}/slow`]: null })
    expect(Date.now() - t0).toBeLessThan(1400)
  })

  it('gives null when the body stalls after the headers', async () => {
    // Arrange
    routes['/stall'] = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '1000' })
      res.write(body(10))
    }
    const t0 = Date.now()

    // Act
    const result = await getAvatars([`${base}/stall`], cacheDir)

    // Assert
    expect(result).toEqual({ [`${base}/stall`]: null })
    expect(Date.now() - t0).toBeLessThan(1400)
  })

  it('accepts an answer that arrives well inside the limit', async () => {
    // Arrange
    const png = body(50, 2)
    routes['/ok'] = (req, res) => void setTimeout(() => send('image/png', png)(req, res), 50)

    // Act
    const result = await getAvatars([`${base}/ok`], cacheDir)

    // Assert
    expect(result[`${base}/ok`]).toBe(dataUrl('image/png', png))
  })
})

describe('getAvatars: no credentials (AC12)', () => {
  it('sends no Authorization header and no cookie', async () => {
    // Arrange
    routes['/a.png'] = send('image/png', body(10))

    // Act
    await getAvatars([`${base}/a.png`], cacheDir)

    // Assert
    expect(hits()).toBe(1)
    expect(seen[0].headers['authorization']).toBeUndefined()
    expect(seen[0].headers['cookie']).toBeUndefined()
    expect(seen[0].headers['private-token']).toBeUndefined()
  })
})

describe('getAvatars: caches (AC13)', () => {
  it('downloads a picture once for two calls in the same run', async () => {
    // Arrange
    const png = body(80, 4)
    routes['/a.png'] = send('image/png', png)

    // Act
    const first = await getAvatars([`${base}/a.png`], cacheDir)
    const second = await getAvatars([`${base}/a.png`], cacheDir)

    // Assert
    expect(first[`${base}/a.png`]).toBe(dataUrl('image/png', png))
    expect(second).toEqual(first)
    expect(hits()).toBe(1)
  })

  it('keeps a failed download as null for 60 seconds, then tries again', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    const png = body(33, 6)
    routes['/a.png'] = send('text/plain', body(5), 404)
    const url = `${base}/a.png`

    // Act
    const first = await getAvatars([url], cacheDir)
    routes['/a.png'] = send('image/png', png)
    vi.setSystemTime(new Date('2026-11-20T10:00:59.999Z'))
    const justBefore = await getAvatars([url], cacheDir)
    const hitsBefore = hits()
    vi.setSystemTime(new Date('2026-11-20T10:01:00.001Z'))
    const justAfter = await getAvatars([url], cacheDir)

    // Assert
    expect(first[url]).toBeNull()
    expect(justBefore[url]).toBeNull()
    expect(hitsBefore).toBe(1)
    expect(justAfter[url]).toBe(dataUrl('image/png', png))
    expect(hits()).toBe(2)
  })

  it('saves a good picture under the sha1 of the url and does not save a failure', async () => {
    // Arrange
    routes['/good.png'] = send('image/png', body(40))
    routes['/bad.png'] = send('image/png', body(40), 404)
    const good = `${base}/good.png`
    const bad = `${base}/bad.png`

    // Act
    await getAvatars([good, bad], cacheDir)

    // Assert
    expect(existsSync(join(cacheDir, sha1(good)))).toBe(true)
    expect(existsSync(join(cacheDir, sha1(bad)))).toBe(false)
  })

  it('reads a saved picture after a restart without a request', async () => {
    // Arrange
    const png = body(90, 8)
    routes['/a.png'] = send('image/png', png)
    const url = `${base}/a.png`
    await getAvatars([url], cacheDir)
    routes['/a.png'] = send('text/plain', body(5), 404)
    resetAvatarCache()

    // Act
    const result = await getAvatars([url], cacheDir)

    // Assert
    expect(result[url]).toBe(dataUrl('image/png', png))
    expect(hits()).toBe(1)
  })

  it.each([
    [6, 1],
    [8, 2]
  ])('with a saved picture that is %s days old, makes %s request in all after a restart', async (days, expectedHits) => {
    // Arrange
    const png = body(70, 1)
    routes['/a.png'] = send('image/png', png)
    const url = `${base}/a.png`
    await getAvatars([url], cacheDir)
    const old = new Date(Date.now() - days * DAY_MS)
    utimesSync(join(cacheDir, sha1(url)), old, old)
    resetAvatarCache()

    // Act
    const result = await getAvatars([url], cacheDir)

    // Assert
    expect(result[url]).toBe(dataUrl('image/png', png))
    expect(hits()).toBe(expectedHits)
  })
})

describe('getAvatars: limits (AC14)', () => {
  it('runs at most 6 downloads at the same time, and reaches 6', async () => {
    // Arrange
    routes['*'] = (req, res) => void setTimeout(() => send('image/png', body(10))(req, res), 120)
    const urls = Array.from({ length: 14 }, (_, n) => `${base}/p${n}.png`)

    // Act
    const result = await getAvatars(urls, cacheDir)

    // Assert
    expect(Object.values(result).every((v) => v === dataUrl('image/png', body(10)))).toBe(true)
    expect(hits()).toBe(14)
    expect(maxInFlight).toBe(6)
  })

  it('accepts 200 urls and gives null for the 201st without a request', async () => {
    // Arrange
    routes['*'] = send('image/png', body(10))
    const urls = Array.from({ length: 201 }, (_, n) => `${base}/p${n}.png`)

    // Act
    const result = await getAvatars(urls, cacheDir)

    // Assert
    expect(result[urls[199]]).toBe(dataUrl('image/png', body(10)))
    expect(result[urls[200]]).toBeNull()
    expect(hits()).toBe(200)
    expect(hits('/p200.png')).toBe(0)
  })
})
