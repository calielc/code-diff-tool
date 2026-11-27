import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerAppHandlers } from './ipc/app'
import { registerAccessHandlers } from './ipc/access'
import { registerChatHandlers } from './ipc/chat'
import { registerCommentHandlers } from './ipc/comments'
import { registerDevHandlers } from './ipc/dev'
import { registerReviewHandlers } from './ipc/reviews'
import { registerSectionsHandlers } from './ipc/sections'
import { registerAiHandlers } from './ipc/ai'
import { registerCommitHandlers } from './ipc/commits'
import { currentTheme, registerThemeHandlers, setTheme } from './ipc/theme'
import { prefetchMine } from './services/mine-prefetch'
import { registerPrefsHandlers } from './ipc/prefs'
import { registerChangesHandlers } from './ipc/changes'
import { registerLaunchHandlers, receiveLaunch } from './ipc/launch'
import { parseLaunchRequest, PROTOCOL } from '@shared/launch'
import { stopAllRuns, markStaleRecords } from './services/ai-runs'
import { readAppState } from './services/app-state'
import { registerIssueHandlers } from './ipc/issues'
import { applySavedLlmConfig, registerLlmHandlers } from './ipc/llm'
import { buildMenu } from './menu'
import { setAppOrigins } from './ipc/guard'
import { installCredentialStore } from './services/credentials'

app.setName('Code Diff Tool')
// Test runs keep the window hidden and out of the Dock, so they never take over the screen.
const hideWindow = process.env['CODEDIFF_HIDE_WINDOW'] === '1'
if (hideWindow) app.dock?.hide()
// Tests point the app at a throw-away data folder.
if (process.env['CODEDIFF_USER_DATA']) app.setPath('userData', process.env['CODEDIFF_USER_DATA'])

// One instance only, so two apps never fetch in the same clone (file 05 section 6.6).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let main: BrowserWindow | null = null

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const pagePath = join(__dirname, '../renderer/index.html')
  setAppOrigins(devUrl ? [devUrl] : [pathToFileURL(pagePath).href])

  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      show: false,
      title: 'Code Diff Tool',
      icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !hideWindow
      }
    })
    win.once('ready-to-show', () => {
      if (!hideWindow) win.show()
    })

    // No navigation away from the app page. Links open in the system browser, https only.
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== win.webContents.getURL()) e.preventDefault()
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (devUrl) void win.loadURL(devUrl)
    else void win.loadFile(pagePath)
    return win
  }

  // A second start of the app, or a codediff:// link, hands its request to this instance (file 05 section 6.6).
  // On macOS the app stays alive when its window is closed, so `main` can be a destroyed window.
  const liveMain = (): BrowserWindow | null => (main && !main.isDestroyed() ? main : null)
  app.on('second-instance', (_e, argv) => {
    const win = liveMain()
    if (win && !hideWindow) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else if (!win && app.isReady()) {
      main = createWindow()
    }
    receiveLaunch(parseLaunchRequest(argv.slice(1)))
  })
  app.on('open-url', (e, url) => {
    e.preventDefault()
    receiveLaunch(parseLaunchRequest([url]))
  })
  // The link scheme belongs to the installed app only, so a development run never takes it over.
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL)
  // A request in the arguments of the first start waits until the window asks for it.
  receiveLaunch(parseLaunchRequest(process.argv.slice(1)))

  app.whenReady().then(() => {
    // A development run takes its Dock icon from the Electron app in node_modules, so it is set here. A packaged app has its own.
    if (process.platform === 'darwin' && !app.isPackaged && !hideWindow) app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
    installCredentialStore()
    registerAppHandlers()
    registerAccessHandlers()
    registerLlmHandlers()
    registerChatHandlers()
    registerSectionsHandlers()
    registerAiHandlers()
    registerCommitHandlers()
    registerLaunchHandlers()
    registerChangesHandlers()
    prefetchMine()
    void readAppState().then(async (st) => {
      if (st.workspaceRoot) await markStaleRecords(st.workspaceRoot)
    })
    void applySavedLlmConfig()
    registerDevHandlers()
    registerReviewHandlers()
    registerCommentHandlers()
    registerIssueHandlers()
    main = createWindow()
    // The Theme menu marks the saved theme. A choice from the menu or from the page saves it, tells the windows and marks the menu again.
    const showMenu = async (): Promise<void> => buildMenu(liveMain, await currentTheme(), (id) => void setTheme(id).then(showMenu))
    registerThemeHandlers(() => void showMenu())
    registerPrefsHandlers()
    void showMenu()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) main = createWindow()
    })
  })

  // Every running AI run stops when the app closes, so the AI tool never outlives it and never keeps costing credit.
  let stopping = false
  app.on('before-quit', (e) => {
    if (stopping) return
    stopping = true
    e.preventDefault()
    void stopAllRuns().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
