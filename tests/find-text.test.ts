import { describe, expect, it } from 'vitest'
import { findAll } from '../src/shared/find-text'

describe('findAll', () => {
  it('finds every match and ignores case', () => {
    // Act and assert
    expect(findAll('Add a + add', 'ADD')).toEqual([0, 8])
  })

  it('does not overlap matches', () => {
    // Act and assert
    expect(findAll('aaaa', 'aa')).toEqual([0, 2])
  })

  it('has no match for an empty query or a missing text', () => {
    // Act and assert
    expect(findAll('abc', '')).toEqual([])
    expect(findAll('abc', 'd')).toEqual([])
  })

  it('treats the characters of the query as plain text, not as a pattern', () => {
    // Act and assert
    expect(findAll('a.b a+b', '.')).toEqual([1])
    expect(findAll('a.b a+b', 'a+b')).toEqual([4])
  })
})
