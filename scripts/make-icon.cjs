// Renders build/icon.svg to build/icon.png (512) and build/icon.ico (16..256, PNG entries).
// Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const dir = join(__dirname, '..', 'build')

async function render512() {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, useContentSize: true, transparent: true, frame: false })
  const page = join(tmpdir(), 'code-diff-icon.html')
  writeFileSync(page, '<html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:transparent"><img style="width:100vw;height:100vh;display:block" src="' + pathToFileURL(join(dir, 'icon.svg')).href + '"></body></html>')
  await win.loadFile(page)
  await new Promise((r) => setTimeout(r, 500))
  const image = await win.webContents.capturePage()
  win.destroy()
  return image.resize({ width: 512, height: 512, quality: 'best' })
}

app.whenReady().then(async () => {
  const big = await render512()
  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = sizes.map((s) => big.resize({ width: s, height: s, quality: 'best' }).toPNG())
  writeFileSync(join(dir, 'icon.png'), big.toPNG())
  // ICO: header, one directory entry per image, then the PNG data
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((s, i) => {
    const o = 6 + 16 * i
    head.writeUInt8(s >= 256 ? 0 : s, o)
    head.writeUInt8(s >= 256 ? 0 : s, o + 1)
    head.writeUInt16LE(1, o + 4)
    head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(pngs[i].length, o + 8)
    head.writeUInt32LE(offset, o + 12)
    offset += pngs[i].length
  })
  writeFileSync(join(dir, 'icon.ico'), Buffer.concat([head, ...pngs]))
  app.quit()
})
