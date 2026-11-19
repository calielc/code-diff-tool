import { describe, expect, it } from 'vitest'
import { parseLaunchRequest } from '../src/shared/launch'

describe('launch requests', () => {
  it('reads flags, repeated and with =', () => {
    expect(
      parseLaunchRequest([
        'app.exe',
        '--mr',
        'https://gitlab.com/g/r/-/merge_requests/1',
        '--mr=https://github.com/o/r/pull/2',
        '--issue',
        'LX-1',
        '--title=Card'
      ])
    ).toEqual({
      mrs: ['https://gitlab.com/g/r/-/merge_requests/1', 'https://github.com/o/r/pull/2'],
      issues: ['LX-1'],
      title: 'Card',
      review: ''
    })
  })
  it('reads a codediff://new link, with encoded values', () => {
    const link = `codediff://new?mr=${encodeURIComponent('https://github.com/o/r/pull/2')}&issue=LX-1&issue=LX-2&title=A%20B`
    expect(parseLaunchRequest(['app.exe', link])).toEqual({ mrs: ['https://github.com/o/r/pull/2'], issues: ['LX-1', 'LX-2'], title: 'A B', review: '' })
  })
  it('reads the review to add to', () => {
    expect(parseLaunchRequest(['--review=LX-1', '--mr=https://github.com/o/r/pull/2'])).toMatchObject({ review: 'LX-1' })
    expect(parseLaunchRequest(['codediff://new?review=LX-9&issue=LX-2'])).toMatchObject({ review: 'LX-9', issues: ['LX-2'] })
  })
  it('ignores other links and arguments with nothing to review', () => {
    expect(parseLaunchRequest(['app.exe'])).toBeNull()
    expect(parseLaunchRequest(['app.exe', 'codediff://other?mr=x'])).toBeNull()
    expect(parseLaunchRequest(['app.exe', 'https://evil.example/new?mr=x'])).toBeNull()
    expect(parseLaunchRequest(['app.exe', '--mr'])).toBeNull()
  })
  it('limits the count and the length', () => {
    const many = Array.from({ length: 80 }, (_, i) => ['--issue', `LX-${i}`]).flat()
    expect(parseLaunchRequest(many)!.issues).toHaveLength(50)
    expect(parseLaunchRequest(['--issue', 'x'.repeat(5000)])!.issues[0]).toHaveLength(2000)
  })
})
