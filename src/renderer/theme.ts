import { themeById, tokensOf } from '@shared/themes'

const keys = new Set<string>()

/** Apply a theme to the page. An unknown id or System removes every colour of a theme, so the computer's scheme shows again. */
export function applyTheme(id: string | null | undefined): void {
  const root = document.documentElement
  for (const k of keys) root.style.removeProperty(`--${k}`)
  keys.clear()
  const theme = themeById(id)
  if (!theme) {
    root.removeAttribute('data-theme')
    root.style.colorScheme = ''
    return
  }
  for (const [k, v] of Object.entries(tokensOf(theme))) {
    root.style.setProperty(`--${k}`, v)
    keys.add(k)
  }
  root.setAttribute('data-theme', theme.id)
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
}
