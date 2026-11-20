import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'

const MAX_BYTES = 524_288
const MAX_URLS = 200
const PARALLEL = 6
const DAY_MS = 24 * 60 * 60 * 1000
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const memory = new Map<string, { value: string | null; at: number }>()

export function resetAvatarCache(): void {
  memory.clear()
}

const testMode = (): boolean => process.env['CODEDIFF_TEST'] === '1'

/** Only https to a public host. In test mode, http to 127.0.0.1 and localhost also passes. */
function allowed(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  if (testMode() && u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) return true
  if (u.protocol !== 'https:') return false
  return isIP(host.replace(/^\[|\]$/g, '')) === 0 && host !== 'localhost' && !/\.(local|internal|localhost)$/.test(host)
}

async function download(url: string): Promise<string | null> {
  const limitMs = testMode() ? Number(process.env['CODEDIFF_AVATAR_TIMEOUT_MS']) || 5000 : 5000
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), limitMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'error', credentials: 'omit' })
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (res.status !== 200 || !TYPES.has(type) || !res.body) return null
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) {
        ctl.abort()
        return null
      }
      chunks.push(value)
    }
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function load(url: string, cacheDir: string | undefined): Promise<string | null> {
  const known = memory.get(url)
  if (known && (known.value !== null || Date.now() - known.at < 60_000)) return known.value
  const file = cacheDir ? join(cacheDir, createHash('sha1').update(url).digest('hex')) : null
  let value: string | null = null
  if (file) {
    try {
      if (Date.now() - (await stat(file)).mtimeMs < 7 * DAY_MS) {
        const saved = await readFile(file, 'utf8')
        if (saved.startsWith('data:image/')) value = saved
      }
    } catch {
      /* no saved picture */
    }
  }
  if (value === null) {
    value = await download(url)
    if (value !== null && file) {
      await mkdir(cacheDir!, { recursive: true })
        .then(() => writeFile(file, value!))
        .catch(() => undefined)
    }
  }
  memory.set(url, { value, at: Date.now() })
  return value
}

/** A data URL for each url, or null when the url is refused or the download fails. */
export async function getAvatars(urls: string[], cacheDir?: string): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  const queue: string[] = []
  urls.forEach((url, i) => {
    result[url] = null
    if (i < MAX_URLS && allowed(url) && !queue.includes(url)) queue.push(url)
  })
  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) result[url] = await load(url, cacheDir)
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return result
}
