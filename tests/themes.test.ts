import { describe, expect, it } from 'vitest'
import { THEMES, SYSTEM_THEME, mix, themeById, tokensOf } from '../src/shared/themes'

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('themes', () => {
  it('has unique ids, none of them the system theme, and finds themes by id', () => {
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(SYSTEM_THEME)
    expect(themeById('dracula')?.name).toBe('Dracula')
    expect(themeById(SYSTEM_THEME)).toBeNull()
    expect(themeById('nope')).toBeNull()
    expect(themeById(undefined)).toBeNull()
  })
  it('mixes colours', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
  it.each(THEMES.map((t) => [t.name, t] as const))('%s gives every colour variable of the page and stays readable', (_name, theme) => {
    const tokens = tokensOf(theme)
    for (const key of [
      'bg',
      'fg',
      'muted',
      'line',
      'panel',
      'ok',
      'bad',
      'warn',
      'accent',
      'on-accent',
      'orange',
      'highlight',
      'add-bg',
      'add-ln',
      'del-bg',
      'del-ln',
      'hunk-bg',
      'hunk-fg',
      'note-bg',
      'note-fg',
      'note-line',
      'draft-bg',
      'extra-bg',
      'avatar-bg'
    ]) {
      expect(tokens[key], key).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(contrast(tokens.fg, tokens.bg)).toBeGreaterThan(7)
    expect(contrast(tokens.muted, tokens.bg)).toBeGreaterThan(3.5)
    expect(contrast(tokens['on-accent'], tokens.accent)).toBeGreaterThan(3)
    expect(contrast(tokens.fg, tokens['add-bg'])).toBeGreaterThan(4.5)
    expect(contrast(tokens.fg, tokens['del-bg'])).toBeGreaterThan(4.5)
    expect(contrast(tokens['note-fg'], tokens['note-bg'])).toBeGreaterThan(4.5)
    expect(theme.dark).toBe(lum(tokens.bg) < 0.5)
  })
})
