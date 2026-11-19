import { BrowserWindow, Menu } from 'electron'
import { CH } from '@shared/channels'
import { SYSTEM_THEME, THEMES } from '@shared/themes'

/** Application menu. The developer screen sits behind Developer > Read change by URL (file 05 phase 2). */
export function buildMenu(getWindow: () => BrowserWindow | null, currentTheme: string, chooseTheme: (id: string) => void): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      {
        label: 'Theme',
        submenu: [{ id: SYSTEM_THEME, name: 'System' }, ...THEMES].map((t) => ({
          label: t.name,
          type: 'radio' as const,
          checked: t.id === currentTheme,
          click: () => chooseTheme(t.id)
        }))
      },
      {
        label: 'Developer',
        submenu: [{ label: 'Read change by URL…', click: () => getWindow()?.webContents.send(CH.menuOpenDev) }]
      },
      { role: 'windowMenu' }
    ])
  )
}
