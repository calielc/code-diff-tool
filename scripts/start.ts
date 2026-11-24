/**
 * Gets the newest code of Code Diff from GitHub and starts the app. No installer is needed.
 *
 *   npm run app
 *
 * The steps:
 * 1. On the branch `main` with no local changes, it pulls the new commits. On any other branch, or with local changes, it skips the pull and uses
 *    the code as it is. A pull that fails, for example without a network, only gives a warning.
 * 2. It installs the packages when `package-lock.json` changed since the last install, and makes sure that the Electron binary is there.
 * 3. It builds the code and starts the app, then exits. The app keeps running without this window.
 *
 * If a step fails, the window stays open so that you can read the error. Node 22.18 or later runs this file directly.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const installMark = join(root, 'node_modules', '.codediff-install')

// A shell inside another Electron app or a Claude Code session passes variables on that break this app: ELECTRON_* points at the wrong binary
// or dev server, NODE_ENV=production makes npm skip the dev packages, and CLAUDE_* marks every claude that the app starts as a child session.
const INHERITED = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*|ELECTRON_.*|NODE_ENV|NODE_ENV_ELECTRON_VITE)$/

function cleanEnv(): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED.test(name)) clean[name] = value
  }
  return clean
}

const env = cleanEnv()

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Runs a command in the repository. Returns its output, or undefined when it fails. */
function capture(command: string): string | undefined {
  const result = spawnSync(command, { cwd: root, env, shell: true, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function run(command: string): boolean {
  console.log(`> ${command}`)
  // One string, because Windows starts `npm` through a shell.
  return spawnSync(command, { cwd: root, env, stdio: 'inherit', shell: true }).status === 0
}

function fail(message: string): never {
  console.error(`\n${message}\nPress Enter to close this window.`)
  try {
    readFileSync(0)
  } catch {
    // No input to wait for. The window closes.
  }
  process.exit(1)
}

const branch = capture('git rev-parse --abbrev-ref HEAD')
const dirty = (capture('git status --porcelain') ?? 'x') !== ''

if (branch === 'main' && !dirty) {
  console.log('Getting the newest code from GitHub...')
  if (!run('git pull --ff-only --quiet')) console.warn('The pull failed. Code Diff starts with the code you have.')
} else {
  console.log(`Skipping the pull (${dirty ? 'local changes' : `branch ${branch}`}).`)
}

const lock = createHash('sha256')
  .update(read(join(root, 'package-lock.json')))
  .digest('hex')
// A first run with packages in place only records the state. It must not wipe a working install.
if (!existsSync(join(root, 'node_modules'))) {
  if (!run('npm ci --include=dev')) fail('npm ci failed.')
  writeFileSync(installMark, lock)
} else if (!existsSync(installMark)) {
  writeFileSync(installMark, lock)
} else if (read(installMark) !== lock) {
  if (!run('npm ci --include=dev')) fail('npm ci failed.')
  writeFileSync(installMark, lock)
}
// The Electron package downloads its binary in an install step. This does nothing when the binary is there.
if (!run('node node_modules/electron/install.js')) fail('The Electron binary is missing and the download failed.')

console.log('Starting Code Diff.')
const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
if (!run(`"${process.execPath}" "${bin}" build`)) fail('The build failed.')
const child = spawn(process.execPath, [bin, 'preview'], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true })
child.unref()
