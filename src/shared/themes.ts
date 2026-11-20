// Colour themes. A theme gives nine base colours; the colours of the diff, the notes and the highlights are mixed from them.
// "System" is the default: it follows the colour scheme of the computer and sets no colour of its own.

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

export interface Theme {
  id: string
  name: string
  /** The scheme the form controls and scroll bars use. */
  dark: boolean
  palette: Palette
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
    }
  }
]

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
    'avatar-bg': p.line
  }
}
