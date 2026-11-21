// Colour themes. A theme gives nine base colours; the colours of the diff, the notes and the highlights are mixed from them.
// "System" is the default: it follows the colour scheme of the computer and sets no colour of its own.

import { TOKEN_KINDS, type TokenKind } from './syntax-tokens'

export interface Palette {
  bg: string
  fg: string
  muted: string
  line: string
  panel: string
  ok: string
  bad: string
  warn: string
  accent: string
}

/** The wanted colour of each kind of token of code. `tokensOf` moves a colour that is too faint on a background of the diff. */
export type Syntax = Record<TokenKind, string>

export interface Theme {
  id: string
  name: string
  /** The scheme the form controls and scroll bars use. */
  dark: boolean
  palette: Palette
  syntax: Syntax
}

export const SYSTEM_THEME = 'system'

export const THEMES: Theme[] = [
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    dark: true,
    palette: {
      bg: '#1a1b26',
      fg: '#c0caf5',
      muted: '#7982a9',
      line: '#2f3549',
      panel: '#16161e',
      ok: '#9ece6a',
      bad: '#f7768e',
      warn: '#e0af68',
      accent: '#7aa2f7'
    },
    syntax: {
      kw: '#bb9af7',
      str: '#9ece6a',
      num: '#ff9e64',
      cm: '#7982a9',
      fn: '#7aa2f7',
      ty: '#2ac3de',
      va: '#e0af68',
      at: '#73daca',
      tg: '#f7768e',
      mt: '#7dcfff',
      sy: '#c0a0ff',
      lt: '#ff9e64'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    palette: {
      bg: '#282a36',
      fg: '#f8f8f2',
      muted: '#8a94c4',
      line: '#44475a',
      panel: '#21222c',
      ok: '#50fa7b',
      bad: '#ff5555',
      warn: '#f1fa8c',
      accent: '#bd93f9'
    },
    syntax: {
      kw: '#ff79c6',
      str: '#f1fa8c',
      num: '#bd93f9',
      cm: '#8a94c4',
      fn: '#50fa7b',
      ty: '#8be9fd',
      va: '#ffb86c',
      at: '#80e0a0',
      tg: '#ff79c6',
      mt: '#ffb86c',
      sy: '#bd93f9',
      lt: '#bd93f9'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    palette: {
      bg: '#2e3440',
      fg: '#d8dee9',
      muted: '#8d9ab3',
      line: '#434c5e',
      panel: '#3b4252',
      ok: '#a3be8c',
      bad: '#bf616a',
      warn: '#ebcb8b',
      accent: '#88c0d0'
    },
    syntax: {
      kw: '#81a1c1',
      str: '#a3be8c',
      num: '#b48ead',
      cm: '#8d9ab3',
      fn: '#88c0d0',
      ty: '#8fbcbb',
      va: '#d08770',
      at: '#ebcb8b',
      tg: '#81a1c1',
      mt: '#5e81ac',
      sy: '#ebcb8b',
      lt: '#b48ead'
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    dark: true,
    palette: {
      bg: '#282828',
      fg: '#ebdbb2',
      muted: '#a89984',
      line: '#3c3836',
      panel: '#1d2021',
      ok: '#b8bb26',
      bad: '#fb4934',
      warn: '#fabd2f',
      accent: '#83a598'
    },
    syntax: {
      kw: '#fb4934',
      str: '#b8bb26',
      num: '#d3869b',
      cm: '#a89984',
      fn: '#8ec07c',
      ty: '#fabd2f',
      va: '#83a598',
      at: '#fe8019',
      tg: '#fb4934',
      mt: '#8ec07c',
      sy: '#d3869b',
      lt: '#d3869b'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    palette: {
      bg: '#002b36',
      fg: '#b3c0c0',
      muted: '#7a9099',
      line: '#0b4350',
      panel: '#00212b',
      ok: '#859900',
      bad: '#dc322f',
      warn: '#b58900',
      accent: '#268bd2'
    },
    syntax: {
      kw: '#859900',
      str: '#2aa198',
      num: '#d33682',
      cm: '#7a9099',
      fn: '#268bd2',
      ty: '#b58900',
      va: '#cb4b16',
      at: '#93a1a1',
      tg: '#268bd2',
      mt: '#cb4b16',
      sy: '#6c71c4',
      lt: '#d33682'
    }
  },
  {
    id: 'paper',
    name: 'Paper (light)',
    dark: false,
    palette: {
      bg: '#fbf7ef',
      fg: '#3b3b3b',
      muted: '#7a7466',
      line: '#d9d3c7',
      panel: '#f3eee2',
      ok: '#2e7d4f',
      bad: '#c0392b',
      warn: '#7a5200',
      accent: '#2b6cb0'
    },
    syntax: {
      kw: '#8b3fa6',
      str: '#1f7a3f',
      num: '#b15a00',
      cm: '#7a7466',
      fn: '#1f5fa8',
      ty: '#8f5a00',
      va: '#8a4b2a',
      at: '#0a7280',
      tg: '#b02a37',
      mt: '#6a4aa0',
      sy: '#a1401f',
      lt: '#b15a00'
    }
  }
]

/**
 * The two looks of System, the light one and the dark one. They are not in the list of themes, because System sets no
 * colour of its own. Their base colours are those of `styles.css`, and `highlight.css` holds their token colours.
 * A test keeps the three in step.
 */
export const SYSTEM_LIGHT: Theme = {
  id: 'system-light',
  name: 'System (light)',
  dark: false,
  palette: {
    bg: '#ffffff',
    fg: '#1d2330',
    muted: '#5f6b7d',
    line: '#dfe3ea',
    panel: '#f6f8fb',
    ok: '#1a7f37',
    bad: '#cf222e',
    warn: '#9a6700',
    accent: '#2f54d4'
  },
  syntax: {
    kw: '#7246c4',
    str: '#0b7a4a',
    num: '#b54708',
    cm: '#6e7781',
    fn: '#0a5fc7',
    ty: '#0e7490',
    va: '#953800',
    at: '#8a6d00',
    tg: '#a0111f',
    mt: '#9a3d7a',
    sy: '#6e5494',
    lt: '#0550ae'
  }
}
export const SYSTEM_DARK: Theme = {
  id: 'system-dark',
  name: 'System (dark)',
  dark: true,
  palette: {
    bg: '#161b22',
    fg: '#e6edf3',
    muted: '#8d96a0',
    line: '#2d343e',
    panel: '#1c232d',
    ok: '#3fb950',
    bad: '#f85149',
    warn: '#d29922',
    accent: '#6f8cff'
  },
  syntax: {
    kw: '#ff7b72',
    str: '#a5d6ff',
    num: '#79c0ff',
    cm: '#8b949e',
    fn: '#d2a8ff',
    ty: '#ffa657',
    va: '#f0b37e',
    at: '#7ee787',
    tg: '#ff9bce',
    mt: '#e3b341',
    sy: '#a5a5ff',
    lt: '#56d4dd'
  }
}

/** The theme with this id, or null for System and for an id that no theme has. */
export const themeById = (id: string | null | undefined): Theme | null => THEMES.find((t) => t.id === id) ?? null

const channels = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
const toHex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** `t` of `b` over `a`: 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = channels(a)
  const y = channels(b)
  return toHex(x.map((v, i) => v + (y[i] - v) * t))
}

const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((v) => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The contrast ratio of two colours, from 1 to 21. WCAG asks for 4.5 for normal text. */
export function contrast(a: string, b: string): number {
  const lin = (hex: string): number => {
    const [r, g, bl] = channels(hex)
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lin(a), lin(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The weakest contrast that code text may have on its background. This is the AA level of WCAG for normal text. */
export const MIN_CODE_CONTRAST = 4.5

/**
 * The backgrounds that code shows on. `plain` has the page, the panel of a code block, an added line and a removed
 * line. `marked` has the strong marks inside an added and a removed line, which use the same mix as the rule `.chg`
 * in the style sheet. A mark is much stronger than a line, so a token inside a mark has its own, further moved colour.
 * This keeps the colours of the tokens lively on the lines and still readable inside the marks.
 */
export function codeBackgrounds(p: Palette): { plain: string[]; marked: string[] } {
  return {
    plain: [p.bg, p.panel, mix(p.bg, p.fg, 0.05), mix(p.bg, p.ok, 0.16), mix(p.bg, p.bad, 0.16)],
    marked: [mix(p.bg, p.ok, 0.38), mix(p.bg, p.bad, 0.38)]
  }
}

/** The colour, moved toward white (dark theme) or black (light theme) in small steps until it reads on every background. */
export function readableOn(color: string, backgrounds: string[], dark: boolean): string {
  const target = dark ? '#ffffff' : '#000000'
  for (let t = 0; t < 1; t += 0.04) {
    const c = mix(color, target, t)
    if (backgrounds.every((bg) => contrast(c, bg) >= MIN_CODE_CONTRAST)) return c
  }
  return target
}

/** Every colour variable of a theme: the nine base colours and those mixed from them. */
export function tokensOf(theme: Theme): Record<string, string> {
  const p = theme.palette
  return {
    ...p,
    page: p.panel,
    panel: mix(p.bg, p.fg, 0.05),
    'on-accent': luminance(p.accent) > 0.5 ? '#14161a' : '#ffffff',
    orange: p.warn,
    highlight: mix(p.bg, p.warn, 0.4),
    'add-bg': mix(p.bg, p.ok, 0.16),
    'add-ln': mix(p.bg, p.ok, 0.28),
    'del-bg': mix(p.bg, p.bad, 0.16),
    'del-ln': mix(p.bg, p.bad, 0.28),
    'hunk-bg': mix(p.bg, p.accent, 0.16),
    'hunk-fg': p.accent,
    'note-bg': mix(p.bg, p.warn, theme.dark ? 0.18 : 0.1),
    'note-fg': theme.dark ? mix(p.warn, p.fg, 0.5) : p.warn,
    'note-line': mix(p.bg, p.warn, 0.5),
    'draft-bg': mix(p.bg, p.warn, 0.1),
    'extra-bg': p.panel,
    'avatar-bg': p.line,
    ...Object.fromEntries(
      TOKEN_KINDS.flatMap((k) => {
        const bgs = codeBackgrounds(p)
        const plain = readableOn(theme.syntax[k], bgs.plain, theme.dark)
        return [
          [`tok-${k}`, plain],
          [`tok-${k}-chg`, readableOn(plain, bgs.marked, theme.dark)]
        ]
      })
    )
  }
}
