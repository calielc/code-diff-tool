import { describe, expect, it, vi } from 'vitest'
import { submitByUrls } from '../src/main/clients/submit-by-url'
import type { ChangeRef } from '../src/shared/provider'

type Deps = Parameters<typeof submitByUrls>[0]
type Input = Parameters<typeof submitByUrls>[1]

const GL = (n: number): string => `https://gitlab.com/team/backend/x/-/merge_requests/${n}`
const GH = (n: number): string => `https://github.com/acme/web/pull/${n}`
const OTHER = (n: number): string => `https://git.example.org/team/z/-/merge_requests/${n}`

const empty = (over: Partial<Input> = {}): Input => ({ approve: [], unapprove: [], requestChanges: [], summaries: {}, ready: [], draft: [], ...over })

interface Harness {
  deps: Deps
  submit: ReturnType<typeof vi.fn>
  hasAccess: ReturnType<typeof vi.fn>
  dropSnapshots: ReturnType<typeof vi.fn>
  order: string[]
}

/** Deps that record their calls in one list, so a test can check what came before what. */
function harness(over: { errors?: Record<string, string>; hosts?: string[]; submitThrows?: Error } = {}): Harness {
  const order: string[] = []
  const hosts = over.hosts ?? ['gitlab.com', 'github.com']
  const submit = vi.fn(async () => {
    order.push('submit')
    if (over.submitThrows) throw over.submitThrows
    return over.errors ?? {}
  })
  const hasAccess = vi.fn((ref: ChangeRef) => hosts.includes(ref.host))
  const dropSnapshots = vi.fn(() => {
    order.push('drop')
  })
  return { deps: { submit, hasAccess, dropSnapshots } as unknown as Deps, submit, hasAccess, dropSnapshots, order }
}

const refsOf = (h: Harness): Map<string, ChangeRef> => h.submit.mock.calls[0][1] as Map<string, ChangeRef>
const inputOf = (h: Harness): Input => h.submit.mock.calls[0][0] as Input

describe('submitByUrls', () => {
  it('should give the write path a ref for every url, once, and pass the lists and the summaries on unchanged', async () => {
    // Arrange
    const h = harness()
    const input = empty({
      approve: [GL(3), GH(21)],
      unapprove: [GL(8)],
      requestChanges: [GH(21)],
      summaries: { [GL(3)]: 'Looks fine', [GH(21)]: 'Please fix the race' },
      ready: [GL(11)],
      draft: [GH(40)]
    })

    // Act
    await submitByUrls(h.deps, input)

    // Assert
    expect(h.submit).toHaveBeenCalledTimes(1)
    expect(inputOf(h)).toMatchObject(input)
    const refs = refsOf(h)
    expect([...refs.keys()].sort()).toEqual([GL(3), GL(8), GL(11), GH(21), GH(40)].sort())
    expect(refs.get(GL(3))).toMatchObject({ provider: 'gitlab', host: 'gitlab.com', project: 'team/backend/x', iid: 3 })
    expect(refs.get(GH(21))).toMatchObject({ provider: 'github', host: 'github.com', project: 'acme/web', iid: 21 })
    expect(refs.get(GL(11))).toMatchObject({ iid: 11 })
    expect(refs.get(GH(40))).toMatchObject({ iid: 40 })
  })

  it('should check the access of the host of every ref it builds', async () => {
    // Arrange
    const h = harness()

    // Act
    await submitByUrls(h.deps, empty({ approve: [GL(3)], ready: [GH(40)] }))

    // Assert
    const checked = h.hasAccess.mock.calls.map((c) => (c[0] as ChangeRef).host)
    expect(new Set(checked)).toEqual(new Set(['gitlab.com', 'github.com']))
  })

  it('should return what the write path returned, an empty answer when every write worked', async () => {
    // Arrange
    const h = harness()

    // Act
    const result = await submitByUrls(h.deps, empty({ approve: [GL(3)] }))

    // Assert
    expect(result).toEqual({ ok: true, value: {} })
  })

  it('should pass the failures of the write path on, keyed by url, and still be an ok answer', async () => {
    // Arrange
    const errors = { [GL(3)]: 'HTTP 403 nope', [GH(21)]: 'requesting changes needs an overall comment.' }
    const h = harness({ errors })

    // Act
    const result = await submitByUrls(h.deps, empty({ approve: [GL(3)], requestChanges: [GH(21)] }))

    // Assert
    expect(result).toEqual({ ok: true, value: errors })
  })

  it('should drop the snapshots of exactly the urls the request names, each once, after the write', async () => {
    // Arrange
    const h = harness()
    const input = empty({ approve: [GL(3), GH(21)], requestChanges: [GH(21)], summaries: { [GH(21)]: 'x', [GL(9)]: 'y' }, draft: [GL(3)] })

    // Act
    await submitByUrls(h.deps, input)

    // Assert
    expect(h.dropSnapshots).toHaveBeenCalledTimes(1)
    const dropped = h.dropSnapshots.mock.calls[0][0] as string[]
    expect([...dropped].sort()).toEqual([GL(3), GL(9), GH(21)].sort())
    expect(h.order).toEqual(['submit', 'drop'])
  })

  it('should drop the snapshots of every named url when only some writes failed, because the forge may have changed', async () => {
    // Arrange
    const h = harness({ errors: { [GL(3)]: 'HTTP 500 boom' } })

    // Act
    await submitByUrls(h.deps, empty({ approve: [GL(3), GH(21)] }))

    // Assert
    expect([...(h.dropSnapshots.mock.calls[0][0] as string[])].sort()).toEqual([GL(3), GH(21)].sort())
  })

  it('should drop the snapshots and answer with the error when the write path itself throws', async () => {
    // Arrange
    const h = harness({ submitThrows: new Error('socket closed') })

    // Act
    const result = await submitByUrls(h.deps, empty({ approve: [GL(3)] }))

    // Assert
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('socket closed')
    expect(h.dropSnapshots).toHaveBeenCalledWith([GL(3)])
  })

  it('should refuse the whole call, write nothing and drop nothing, when one url is not a merge request or pull request url', async () => {
    // Arrange
    const h = harness()
    const bad = 'https://gitlab.com/team/backend/x/-/issues/4'

    // Act
    const result = await submitByUrls(h.deps, empty({ approve: [GL(3)], ready: [bad] }))

    // Assert
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain(bad)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.dropSnapshots).not.toHaveBeenCalled()
  })

  it('should refuse a url of a text that is not a url at all', async () => {
    // Arrange
    const h = harness()

    // Act
    const result = await submitByUrls(h.deps, empty({ summaries: { 'not a url': 'hello' } }))

    // Assert
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('not a url')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.dropSnapshots).not.toHaveBeenCalled()
  })

  it('should refuse the whole call and name the host, writing nothing and dropping nothing, when a host has no saved access', async () => {
    // Arrange
    const h = harness({ hosts: ['gitlab.com'] })

    // Act
    const result = await submitByUrls(h.deps, empty({ approve: [GL(3), GH(21)] }))

    // Assert
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('github.com')
    expect((result as { error: string }).error).not.toContain('gitlab.com')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.dropSnapshots).not.toHaveBeenCalled()
  })

  it('should name a self-hosted host that has no access, and write nothing for the urls that do have access', async () => {
    // Arrange
    const h = harness()

    // Act
    const result = await submitByUrls(h.deps, empty({ unapprove: [OTHER(5)], approve: [GL(3)] }))

    // Assert
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('git.example.org')
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('should do nothing for a request that names no url, and not drop anything', async () => {
    // Arrange
    const h = harness()

    // Act
    const result = await submitByUrls(h.deps, empty())

    // Assert
    expect(result).toEqual({ ok: true, value: {} })
    expect(h.dropSnapshots).not.toHaveBeenCalled()
  })
})
