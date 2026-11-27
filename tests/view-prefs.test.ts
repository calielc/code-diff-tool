import { describe, expect, it } from 'vitest'
import { parseBool, parseChoice, parseChoices, parseFlags, parseList, parseSort, parseText, sortToPref } from '../src/shared/view-prefs'

const KEYS = ['title', 'repo', 'updated'] as const
const FALLBACK = { key: 'updated', dir: 'desc' } as const

describe('parseSort', () => {
  it.each([
    [
      { key: 'title', dir: 'asc' },
      { key: 'title', dir: 'asc' }
    ],
    [
      { key: 'repo', dir: 'desc' },
      { key: 'repo', dir: 'desc' }
    ],
    ['none', null],
    [undefined, FALLBACK],
    [null, FALLBACK],
    [{ key: 'branch', dir: 'asc' }, FALLBACK],
    [{ key: 'title', dir: 'up' }, FALLBACK],
    [{ key: 'title' }, FALLBACK],
    ['title', FALLBACK],
    [['title', 'asc'], FALLBACK]
  ])('reads %j as %j', (saved, expected) => {
    // Act
    const sort = parseSort(saved, KEYS, FALLBACK)

    // Assert
    expect(sort).toEqual(expected)
  })

  it('gives null for the order of the list when that is the fallback and nothing is saved', () => {
    // Act and Assert
    expect(parseSort(undefined, KEYS, null)).toBeNull()
  })

  it('round-trips a sort and the order of the list through sortToPref', () => {
    // Act and Assert
    expect(parseSort(sortToPref({ key: 'repo', dir: 'desc' }), KEYS, FALLBACK)).toEqual({ key: 'repo', dir: 'desc' })
    expect(parseSort(sortToPref(null), KEYS, FALLBACK)).toBeNull()
  })
})

describe('parseFlags', () => {
  const defaults = { draft: false, opened: true, merged: false }

  it('keeps the saved toggles and gives the default to one that is missing', () => {
    // Act
    const flags = parseFlags({ draft: true, merged: true }, defaults)

    // Assert
    expect(flags).toEqual({ draft: true, opened: true, merged: true })
  })

  it('drops a key that the defaults do not know and a value that is not a boolean', () => {
    // Act
    const flags = parseFlags({ opened: 'no', gone: true, merged: 1 }, defaults)

    // Assert
    expect(flags).toEqual(defaults)
  })

  it.each([undefined, null, 'x', 5, ['draft']])('gives the defaults for %j', (saved) => {
    // Act and Assert
    expect(parseFlags(saved, defaults)).toEqual(defaults)
  })
})

describe('parseChoice', () => {
  it('keeps an allowed choice and falls back for any other value', () => {
    // Act and Assert
    expect(parseChoice('repo', ['none', 'repo'], 'none')).toBe('repo')
    expect(parseChoice('state', ['none', 'repo'], 'none')).toBe('none')
    expect(parseChoice(undefined, ['none', 'repo'], 'none')).toBe('none')
    expect(parseChoice(3, ['none', 'repo'], 'none')).toBe('none')
  })
})

describe('parseBool and parseText', () => {
  it('keeps a boolean and a string, and falls back for the rest', () => {
    // Act and Assert
    expect(parseBool(true, false)).toBe(true)
    expect(parseBool('true', false)).toBe(false)
    expect(parseText('billing', '')).toBe('billing')
    expect(parseText(4, 'x')).toBe('x')
  })

  it('cuts a text that is longer than 500 characters', () => {
    // Act and Assert
    expect(parseText('a'.repeat(501), '')).toHaveLength(500)
  })
})

describe('parseList and parseChoices', () => {
  it('keeps only the strings of a list', () => {
    // Act and Assert
    expect(parseList(['a', 3, null, 'b'])).toEqual(['a', 'b'])
    expect(parseList('a')).toEqual([])
    expect(parseList(undefined)).toEqual([])
  })

  it('keeps at most 2000 entries', () => {
    // Act and Assert
    expect(parseList(Array.from({ length: 2500 }, (_, i) => String(i)))).toHaveLength(2000)
  })

  it('keeps only the allowed choices of a list', () => {
    // Act and Assert
    expect(parseChoices(['A', 'X', 'M'], ['A', 'M', 'D'] as const)).toEqual(['A', 'M'])
    expect(parseChoices(undefined, ['A'] as const)).toEqual([])
  })
})
