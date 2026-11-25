import { describe, expect, it } from 'vitest'
import { createLimiter, SNAPSHOT_CONCURRENCY } from '../src/main/clients/limit'
import { createSnapshotCache, type SnapshotCacheDeps } from '../src/main/clients/snapshot-cache'
import type { ChangeRef, ChangeSnapshot } from '../src/shared/provider'

const GL_URL = (n: number): string => `https://gitlab.com/team/backend/x/-/merge_requests/${n}`
const GH_URL = (n: number): string => `https://github.com/acme/web/pull/${n}`

/** A snapshot that a test can tell from another one by its title. */
const snapshotOf = (title: string): ChangeSnapshot => ({ info: { title } }) as unknown as ChangeSnapshot
const titleOf = (r: { ok: boolean; value?: ChangeSnapshot }): string | undefined => (r.value?.info as { title?: string } | undefined)?.title

const direct: SnapshotCacheDeps['limit'] = (call) => call()

/** A read that a test finishes by hand, and that counts the reads that are open at once. */
function manualReads(): {
  read: SnapshotCacheDeps['read']
  started: ChangeRef[]
  open: () => number
  peak: () => number
  finish: (n: number, title: string) => void
  fail: (n: number, message: string) => void
} {
  const started: ChangeRef[] = []
  const pending: { resolve: (s: ChangeSnapshot) => void; reject: (e: Error) => void }[] = []
  let open = 0
  let peak = 0
  return {
    read: (ref) => {
      started.push(ref)
      open++
      peak = Math.max(peak, open)
      return new Promise<ChangeSnapshot>((resolve, reject) => {
        pending.push({ resolve, reject })
      }).finally(() => open--)
    },
    started,
    open: () => open,
    peak: () => peak,
    finish: (n, title) => pending[n].resolve(snapshotOf(title)),
    fail: (n, message) => pending[n].reject(new Error(message))
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createLimiter', () => {
  it('keeps the contract of 6 reads in flight for the shared limiter', () => {
    expect(SNAPSHOT_CONCURRENCY).toBe(6)
  })

  it.each([1, 3, 6])('never runs more than %i calls at the same time and finishes all 14', async (max) => {
    // Arrange
    const limit = createLimiter(max)
    let open = 0
    let peak = 0
    const call = async (n: number): Promise<number> => {
      open++
      peak = Math.max(peak, open)
      await new Promise((r) => setTimeout(r, 5))
      open--
      return n * 3
    }

    // Act
    const results = await Promise.all(Array.from({ length: 14 }, (_, n) => limit(() => call(n))))

    // Assert
    expect(results).toEqual(Array.from({ length: 14 }, (_, n) => n * 3))
    expect(peak).toBe(Math.min(max, 14))
  })

  it('starts a waiting call as soon as a running one finishes', async () => {
    // Arrange
    const limit = createLimiter(2)
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const first = limit(
      () =>
        new Promise<void>((r) => {
          releaseFirst = r
        })
    )
    const second = limit(() => new Promise<void>((r) => setTimeout(r, 30)))
    const third = limit(async () => {
      order.push('third')
    })

    // Act
    await tick()
    expect(order).toEqual([])
    releaseFirst()
    await Promise.all([first, second, third])

    // Assert
    expect(order).toEqual(['third'])
  })

  it('gives its slot back when a call fails, and passes the error on', async () => {
    // Arrange
    const limit = createLimiter(1)

    // Act
    const failed = limit(() => Promise.reject(new Error('boom')))
    const after = limit(() => Promise.resolve('fine'))

    // Assert
    await expect(failed).rejects.toThrow('boom')
    await expect(after).resolves.toBe('fine')
  })
})

describe('createSnapshotCache', () => {
  const deps = (read: SnapshotCacheDeps['read'], over: Partial<SnapshotCacheDeps> = {}): SnapshotCacheDeps => ({
    read,
    limit: direct,
    hasAccess: () => true,
    ...over
  })

  it('reads a change once for the same url and updated time, also when two asks are open at the same time', async () => {
    // Arrange
    const reads = manualReads()
    const cache = createSnapshotCache(deps(reads.read))

    // Act
    const a = cache.get(GL_URL(7), '2026-11-10T10:00:00Z')
    const b = cache.get(GL_URL(7), '2026-11-10T10:00:00Z')
    await tick()
    reads.finish(0, 'seven')
    const [first, second] = await Promise.all([a, b])
    const third = await cache.get(GL_URL(7), '2026-11-10T10:00:00Z')

    // Assert
    expect(reads.started).toHaveLength(1)
    expect(reads.started[0]).toEqual({ provider: 'gitlab', host: 'gitlab.com', project: 'team/backend/x', iid: 7 })
    expect([titleOf(first), titleOf(second), titleOf(third)]).toEqual(['seven', 'seven', 'seven'])
    expect(first.ok && second.ok && third.ok).toBe(true)
  })

  it('reads a GitHub change by its parsed reference', async () => {
    // Arrange
    const reads = manualReads()
    const cache = createSnapshotCache(deps(reads.read))

    // Act
    const pending = cache.get(GH_URL(21), 'x')
    await tick()
    reads.finish(0, 'twenty-one')
    await pending

    // Assert
    expect(reads.started).toEqual([{ provider: 'github', host: 'github.com', project: 'acme/web', iid: 21 }])
  })

  it('reads again when the updated time is another one, in both directions, and keeps only the latest answer', async () => {
    // Arrange
    let n = 0
    const cache = createSnapshotCache(deps(async () => snapshotOf(`read ${++n}`)))

    // Act
    const a1 = await cache.get(GL_URL(1), '2026-11-10T10:00:00Z')
    const b = await cache.get(GL_URL(1), '2026-11-12T10:00:00Z')
    const a2 = await cache.get(GL_URL(1), '2026-11-10T10:00:00Z')

    // Assert
    expect([titleOf(a1), titleOf(b), titleOf(a2)]).toEqual(['read 1', 'read 2', 'read 3'])
  })

  it('keeps a separate answer for each url', async () => {
    // Arrange
    let n = 0
    const cache = createSnapshotCache(deps(async (ref) => snapshotOf(`${ref.iid}:${++n}`)))

    // Act
    const one = await cache.get(GL_URL(1), 't')
    const two = await cache.get(GL_URL(2), 't')
    const oneAgain = await cache.get(GL_URL(1), 't')

    // Assert
    expect([titleOf(one), titleOf(two), titleOf(oneAgain)]).toEqual(['1:1', '2:2', '1:1'])
  })

  it('answers a failed read with the error text, and does not keep it, so the next ask reads again', async () => {
    // Arrange
    let n = 0
    const cache = createSnapshotCache(
      deps(async () => {
        if (++n === 1) throw new Error('HTTP 500: boom')
        return snapshotOf('second try')
      })
    )

    // Act
    const failed = await cache.get(GL_URL(3), 't')
    const retried = await cache.get(GL_URL(3), 't')
    const kept = await cache.get(GL_URL(3), 't')

    // Assert
    expect(failed).toEqual({ ok: false, error: 'HTTP 500: boom' })
    expect(titleOf(retried)).toBe('second try')
    expect(titleOf(kept)).toBe('second try')
    expect(n).toBe(2)
  })

  it('shares one failure between two asks that are open at the same time, and reads again afterwards', async () => {
    // Arrange
    const reads = manualReads()
    const cache = createSnapshotCache(deps(reads.read))
    const a = cache.get(GL_URL(4), 't')
    const b = cache.get(GL_URL(4), 't')
    await tick()

    // Act
    reads.fail(0, 'down')
    const both = await Promise.all([a, b])
    const next = cache.get(GL_URL(4), 't')
    await tick()
    reads.finish(1, 'back')

    // Assert
    expect(both).toEqual([
      { ok: false, error: 'down' },
      { ok: false, error: 'down' }
    ])
    expect(titleOf(await next)).toBe('back')
    expect(reads.started).toHaveLength(2)
  })

  it('refuses a url that is not a change, with a clean error and no read', async () => {
    // Arrange
    const reads = manualReads()
    const cache = createSnapshotCache(deps(reads.read))

    // Act
    const results = await Promise.all(['', 'https://example.com/page', 'not a url', 'https://gitlab.com/team/x/-/issues/4'].map((u) => cache.get(u, 't')))

    // Assert
    for (const r of results) expect(r).toEqual({ ok: false, error: 'This is not a merge request or pull request URL.' })
    expect(reads.started).toHaveLength(0)
  })

  it('refuses a host without a saved access, names the host and makes no read', async () => {
    // Arrange
    const reads = manualReads()
    const seen: ChangeRef[] = []
    const cache = createSnapshotCache(
      deps(reads.read, {
        hasAccess: (ref) => {
          seen.push(ref)
          return ref.host !== 'gitlab.example.com'
        }
      })
    )

    // Act
    const refused = await cache.get('https://gitlab.example.com/team/backend/x/-/merge_requests/9', 't')

    // Assert
    expect(refused.ok).toBe(false)
    expect(refused).toMatchObject({ error: expect.stringContaining('gitlab.example.com') })
    expect(seen).toEqual([{ provider: 'gitlab', host: 'gitlab.example.com', project: 'team/backend/x', iid: 9 }])
    expect(reads.started).toHaveLength(0)
  })

  it('does not keep the refusal of a host: an access saved later lets the same url through', async () => {
    // Arrange
    let allowed = false
    const cache = createSnapshotCache(deps(async () => snapshotOf('now'), { hasAccess: () => allowed }))
    const before = await cache.get(GL_URL(5), 't')

    // Act
    allowed = true
    const after = await cache.get(GL_URL(5), 't')

    // Assert
    expect(before.ok).toBe(false)
    expect(titleOf(after)).toBe('now')
  })

  it('makes every read through the limit, and never has more than 6 reads open for 14 different changes', async () => {
    // Arrange
    const reads = manualReads()
    let limited = 0
    const limit = createLimiter(SNAPSHOT_CONCURRENCY)
    const cache = createSnapshotCache(
      deps(reads.read, {
        limit: (call) => {
          limited++
          return limit(call)
        }
      })
    )

    // Act
    const all = Array.from({ length: 14 }, (_, n) => cache.get(GL_URL(100 + n), 't'))
    await tick()

    // Assert: the first 6 are open and the rest wait
    expect(reads.open()).toBe(6)
    expect(limited).toBe(14)
    for (let n = 0; n < 14; n++) {
      while (reads.started.length <= n) await tick()
      reads.finish(n, `change ${n}`)
      await tick()
    }
    const results = await Promise.all(all)
    expect(results.map(titleOf)).toEqual(Array.from({ length: 14 }, (_, n) => `change ${n}`))
    expect(reads.peak()).toBe(6)
  })

  it('drops the answers of the urls that are named and keeps the others', async () => {
    // Arrange
    let n = 0
    const cache = createSnapshotCache(deps(async (ref) => snapshotOf(`${ref.iid}:${++n}`)))
    await cache.get(GL_URL(1), 't')
    await cache.get(GL_URL(2), 't')
    await cache.get(GL_URL(3), 't')

    // Act
    cache.drop([GL_URL(1), GL_URL(3)])

    // Assert
    expect(titleOf(await cache.get(GL_URL(1), 't'))).toBe('1:4')
    expect(titleOf(await cache.get(GL_URL(2), 't'))).toBe('2:2')
    expect(titleOf(await cache.get(GL_URL(3), 't'))).toBe('3:5')
  })

  it('drops every answer when no urls are named, and an empty list drops nothing', async () => {
    // Arrange
    let n = 0
    const cache = createSnapshotCache(deps(async (ref) => snapshotOf(`${ref.iid}:${++n}`)))
    await cache.get(GL_URL(1), 't')
    await cache.get(GH_URL(2), 't')

    // Act
    cache.drop([])
    const kept = [titleOf(await cache.get(GL_URL(1), 't')), titleOf(await cache.get(GH_URL(2), 't'))]
    cache.drop()
    const fresh = [titleOf(await cache.get(GL_URL(1), 't')), titleOf(await cache.get(GH_URL(2), 't'))]

    // Assert
    expect(kept).toEqual(['1:1', '2:2'])
    expect(fresh).toEqual(['1:3', '2:4'])
  })

  it('does not keep the answer of a read that was open when its url was dropped', async () => {
    // Arrange
    const reads = manualReads()
    const cache = createSnapshotCache(deps(reads.read))
    const open = cache.get(GL_URL(6), 't')
    await tick()

    // Act
    cache.drop([GL_URL(6)])
    reads.finish(0, 'late')
    await open
    const next = cache.get(GL_URL(6), 't')
    await tick()
    reads.finish(1, 'fresh')

    // Assert
    expect(titleOf(await next)).toBe('fresh')
    expect(reads.started).toHaveLength(2)
  })
})
