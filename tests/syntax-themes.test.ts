import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIN_CODE_CONTRAST, SYSTEM_DARK, SYSTEM_LIGHT, THEMES, codeBackgrounds, contrast, mix, readableOn, tokensOf, type Theme } from '../src/shared/themes'
import { TOKEN_KINDS } from '../src/shared/syntax-tokens'

const css = readFileSync('src/renderer/highlight.css', 'utf8')
const base = readFileSync('src/renderer/styles.css', 'utf8')

/** The `--name: value` pairs of the CSS block that starts at the first `{` after `marker`. */
function block(source: string, marker: string): Record<string, string> {
  const open = source.indexOf('{', source.indexOf(marker))
  const body = source.slice(open + 1, source.indexOf('}', open))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

describe('the colours of the code tokens', () => {
  it.each([...THEMES, SYSTEM_LIGHT, SYSTEM_DARK].map((t) => [t.name, t] as const))('%s reads on every background of the diff', (_name, theme: Theme) => {
    const tokens = tokensOf(theme)
    const backgrounds = codeBackgrounds({ ...theme.palette, panel: tokens.panel })
    // The same backgrounds as the page really uses
    expect(backgrounds.plain).toEqual(expect.arrayContaining([tokens.bg, tokens.panel, tokens['add-bg'], tokens['del-bg']]))
    expect(backgrounds.marked).toEqual([mix(tokens.bg, tokens.ok, 0.38), mix(tokens.bg, tokens.bad, 0.38)])
    for (const kind of TOKEN_KINDS) {
      const plain = tokens[`tok-${kind}`]
      const marked = tokens[`tok-${kind}-chg`]
      expect(plain, kind).toMatch(/^#[0-9a-f]{6}$/)
      expect(marked, kind).toMatch(/^#[0-9a-f]{6}$/)
      for (const bg of backgrounds.plain) expect(contrast(plain, bg), `${theme.name}: ${kind} ${plain} on ${bg}`).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
      for (const bg of backgrounds.marked)
        expect(contrast(marked, bg), `${theme.name}: ${kind} inside a mark ${marked} on ${bg}`).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    }
  })

  it.each([...THEMES, SYSTEM_LIGHT, SYSTEM_DARK].map((t) => [t.name, t] as const))(
    '%s keeps most kinds apart from each other and from the plain text',
    (_name, theme: Theme) => {
      const tokens = tokensOf(theme)
      const colors = TOKEN_KINDS.map((k) => tokens[`tok-${k}`])
      expect(new Set(colors).size).toBeGreaterThanOrEqual(8)
      expect(colors).not.toContain(tokens.fg)
    }
  )

  it('moves a faint colour only as far as it needs', () => {
    const bgs = ['#ffffff']
    expect(readableOn('#000000', bgs, false)).toBe('#000000')
    const moved = readableOn('#aaaaaa', bgs, false)
    expect(contrast(moved, '#ffffff')).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST)
    expect(contrast(moved, '#ffffff')).toBeLessThan(MIN_CODE_CONTRAST + 1)
    expect(readableOn('#444444', ['#161b22'], true)).not.toBe('#444444')
  })

  it('has the System sets of the style sheet in step with the base colours and the theme tables', () => {
    const lightBase = block(base, ':root')
    const darkBase = block(base, '@media (prefers-color-scheme: dark)')
    for (const [theme, source] of [
      [SYSTEM_LIGHT, lightBase],
      [SYSTEM_DARK, darkBase]
    ] as const) {
      for (const key of ['bg', 'fg', 'muted', 'line', 'panel', 'ok', 'bad', 'warn', 'accent'] as const)
        expect(theme.palette[key], `${theme.id} ${key}`).toBe(source[key])
    }
    const light = block(css, ':root')
    const dark = block(css, '@media (prefers-color-scheme: dark)')
    for (const [theme, set] of [
      [SYSTEM_LIGHT, light],
      [SYSTEM_DARK, dark]
    ] as const) {
      const tokens = tokensOf(theme)
      for (const kind of TOKEN_KINDS) {
        expect(set[`tok-${kind}`], `${theme.id} ${kind}`).toBe(tokens[`tok-${kind}`])
        expect(set[`tok-${kind}-chg`], `${theme.id} ${kind} inside a mark`).toBe(tokens[`tok-${kind}-chg`])
      }
    }
  })

  it('has a rule for every kind of token', () => {
    for (const kind of TOKEN_KINDS) {
      expect(css).toContain(`.tk-${kind} {\n  color: var(--tok-${kind});`)
      expect(css).toContain(`.tk-${kind}.chg {\n  color: var(--tok-${kind}-chg);`)
    }
  })
})
