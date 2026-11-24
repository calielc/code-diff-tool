import { describe, expect, it } from 'vitest'
import { parseUrlBox, slugFromName, slugProblem, suggestReviewName } from '../src/shared/review'

const refs = (...urls: string[]) => parseUrlBox(urls.join('\n')).refs

const MR_CATALOG = 'https://gitlab.com/goodhabitz/frontend/content-catalog-mfe/-/merge_requests/502'
const MR_X = 'https://gitlab.com/team/backend/x/-/merge_requests/12'
const PR_GITHUB = 'https://github.com/acme/widgets/pull/9'

describe('suggestReviewName', () => {
  it('uses the first Jira key when there is one', () => {
    // Arrange
    const input = { issueKeys: ['LX-2813', 'LX-9'], refs: refs(MR_X) }

    // Act
    const name = suggestReviewName(input)

    // Assert
    expect(name).toBe('LX-2813')
  })

  it('uses the last segment of the project path and the number when there is no key', () => {
    expect(suggestReviewName({ issueKeys: [], refs: refs(MR_CATALOG) })).toBe('content-catalog-mfe-502')
  })

  it.each([
    [MR_X, 'x-12'],
    [PR_GITHUB, 'widgets-9']
  ])('names the change %s as %s', (url, expected) => {
    expect(suggestReviewName({ issueKeys: [], refs: refs(url) })).toBe(expected)
  })

  it('uses only the first change when there are several', () => {
    expect(suggestReviewName({ issueKeys: [], refs: refs(MR_X, MR_CATALOG) })).toBe('x-12')
  })

  it('returns the empty string when there is no key and no change', () => {
    expect(suggestReviewName({ issueKeys: [], refs: [] })).toBe('')
  })
})

describe('slugFromName', () => {
  it.each([
    ['LX-2813', 'LX-2813'],
    ['My review: login fix!', 'My-review-login-fix'],
    ['   ', 'review'],
    ['', 'review'],
    ['!!!', 'review'],
    ['content-catalog-mfe-502', 'content-catalog-mfe-502'],
    ['a/b+c', 'a-b-c'],
    ['  --Fix login--  ', 'Fix-login'],
    ['v1.2_final', 'v1.2_final'],
    ['Café login', 'Caf-login'],
    ['.hidden name', 'hidden-name']
  ])('turns %j into %j', (name, expected) => {
    expect(slugFromName(name, [])).toBe(expected)
  })

  it('keeps a name of 59, 60 and 61 characters at the right length', () => {
    expect(slugFromName('a'.repeat(59), [])).toBe('a'.repeat(59))
    expect(slugFromName('a'.repeat(60), [])).toBe('a'.repeat(60))
    expect(slugFromName('a'.repeat(61), [])).toBe('a'.repeat(60))
  })

  it('trims a dash that the cut leaves at the end', () => {
    // 59 letters, a space, then more text: the cut at 60 ends on the dash made from the space
    expect(slugFromName(`${'b'.repeat(59)} tail`, [])).toBe('b'.repeat(59))
  })

  it('appends -2, then -3, until the slug is free', () => {
    expect(slugFromName('LX-2813', ['LX-2813'])).toBe('LX-2813-2')
    expect(slugFromName('LX-2813', ['LX-2813', 'LX-2813-2'])).toBe('LX-2813-3')
    expect(slugFromName('LX-2813', ['LX-2813', 'LX-2813-2', 'LX-2813-3', 'LX-2813-4'])).toBe('LX-2813-5')
  })

  it('compares with the existing slugs without regard to case', () => {
    expect(slugFromName('LX-2813', ['lx-2813'])).toBe('LX-2813-2')
    expect(slugFromName('LX-2813', ['lx-2813', 'LX-2813-2'])).toBe('LX-2813-3')
    expect(slugFromName('lx-2813', ['LX-2813'])).toBe('lx-2813-2')
  })

  it('does not count a slug that only starts the same as taken', () => {
    expect(slugFromName('LX-2813', ['LX-28130', 'LX-2813-22'])).toBe('LX-2813')
  })

  it('keeps the suffix inside the limit that slugProblem allows', () => {
    const slug = slugFromName('a'.repeat(80), ['a'.repeat(60)])
    expect(slug).toBe(`${'a'.repeat(60)}-2`)
    expect(slugProblem(slug)).toBeNull()
  })

  it.each(['LX-2813', 'My review: login fix!', '   ', '!!!', '/', 'Café', 'a'.repeat(200), `${'b'.repeat(59)} tail`, '-.-x', '__init__'])(
    'always returns a slug that passes slugProblem for %j',
    (name) => {
      expect(slugProblem(slugFromName(name, []))).toBeNull()
      expect(slugProblem(slugFromName(name, [slugFromName(name, [])]))).toBeNull()
    }
  )
})
