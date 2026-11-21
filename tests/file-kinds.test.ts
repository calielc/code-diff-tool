import { describe, expect, it } from 'vitest'
import { countKinds, extensionOf, fileKind, FILE_KINDS, visibleKinds, type FileKind } from '../src/shared/file-kinds'

describe('fileKind', () => {
  it.each([
    ['README.md', 'docs'],
    ['docs/api-clients.md', 'docs'],
    ['src/Api/Program.cs', 'code'],
    ['src/store/yourList.ts', 'code'],
    ['src/components/Card.vue', 'code'],
    ['test/Api.Tests/ProgramTests.cs', 'tests'],
    ['src/app.test.ts', 'tests'],
    ['tests/e2e/phase1.spec.ts', 'tests'],
    ['src/__tests__/a.ts', 'tests'],
    ['.config/dotnet-tools.json', 'config'],
    ['package.json', 'config'],
    ['.gitlab-ci.yml', 'config'],
    ['.gitignore', 'config'],
    ['Directory.Packages.props', 'config'],
    ['src/Api/Api.csproj', 'config'],
    ['.npmrc', 'config']
  ])('%s is %s', (path, kind) => {
    expect(fileKind(path)).toBe(kind)
  })

  it.each([
    ['logo.png', 'images'],
    ['assets/photo.jpg', 'images'],
    ['assets/photo.jpeg', 'images'],
    ['a/b/anim.gif', 'images'],
    ['a/pic.webp', 'images'],
    ['a/pic.bmp', 'images'],
    ['favicon.ico', 'images'],
    ['icon.svg', 'images'],
    ['a/pic.avif', 'images'],
    ['a/scan.tiff', 'images'],
    ['a/scan.tif', 'images'],
    ['a/phone.heic', 'images']
  ])('the image %s is %s', (path, kind) => {
    expect(fileKind(path)).toBe(kind)
  })

  it.each([
    ['dist/app.zip', 'binary'],
    ['lib/Api.dll', 'binary'],
    ['tools/setup.exe', 'binary'],
    ['docs/manual.pdf', 'binary'],
    ['fonts/Plex.woff2', 'binary'],
    ['fonts/Plex.ttf', 'binary'],
    ['libs/app.jar', 'binary'],
    ['wasm/engine.wasm', 'binary'],
    ['obj/Api.pdb', 'binary'],
    ['build/Main.class', 'binary'],
    ['backup.tar.gz', 'binary'],
    ['bun.lockb', 'binary']
  ])('the binary file %s is %s', (path, kind) => {
    expect(fileKind(path)).toBe(kind)
  })

  it('treats a file that git flags as binary as Binary, whatever its name', () => {
    expect(fileKind('data/blob', true)).toBe('binary')
    expect(fileKind('src/a.ts', true)).toBe('binary')
    expect(fileKind('README.md', true)).toBe('binary')
    expect(fileKind('tests/e2e/a.spec.ts', true)).toBe('binary')
  })

  it('never makes an image Binary, even when git flags it', () => {
    expect(fileKind('logo.png', true)).toBe('images')
    expect(fileKind('logo.png', false)).toBe('images')
    expect(fileKind('icon.svg', true)).toBe('images')
  })

  it('puts an image before the tests, config and docs rules', () => {
    expect(fileKind('tests/fixtures/shot.png')).toBe('images')
    expect(fileKind('.github/banner.png')).toBe('images')
    expect(fileKind('docs/images/diff.png')).toBe('images')
    expect(fileKind('src/a.test.svg')).toBe('images')
  })

  it('puts a binary file before the tests, config and docs rules', () => {
    expect(fileKind('tests/Api.Tests.dll')).toBe('binary')
    expect(fileKind('.github/tool.exe')).toBe('binary')
    expect(fileKind('docs/guide.pdf')).toBe('binary')
  })

  it('ignores the case of an extension', () => {
    expect(fileKind('LOGO.PNG')).toBe('images')
    expect(fileKind('Photo.JpEg')).toBe('images')
    expect(fileKind('Setup.EXE')).toBe('binary')
    expect(fileKind('README.MD')).toBe('docs')
  })

  it('uses the last extension of a name with several dots', () => {
    expect(fileKind('dist/app.min.js')).toBe('code')
    expect(fileKind('src/types.d.ts')).toBe('code')
    expect(fileKind('src/app.test.min.js')).toBe('code')
    expect(fileKind('pic.png.md')).toBe('docs')
    expect(fileKind('pic.svg.png')).toBe('images')
    expect(fileKind('archive.tar.gz')).toBe('binary')
    expect(fileKind('map.js.map')).toBe('code')
  })

  it('handles a name with no extension', () => {
    expect(fileKind('Dockerfile')).toBe('config')
    expect(fileKind('Makefile')).toBe('config')
    expect(fileKind('bin/run')).toBe('code')
    expect(fileKind('LICENSE')).toBe('code')
    expect(fileKind('png')).toBe('code')
  })

  it('handles a dotfile, which has no extension', () => {
    expect(fileKind('.png')).toBe('config')
    expect(fileKind('.gitignore')).toBe('config')
    expect(fileKind('src/.env')).toBe('config')
    expect(fileKind('.DS_Store', true)).toBe('binary')
  })

  it('handles a name that ends in a dot, and a dot in a folder name', () => {
    expect(fileKind('weird.')).toBe('code')
    expect(fileKind('v1.2.png/readme')).toBe('code')
    expect(fileKind('v1.zip/readme.md')).toBe('docs')
  })

  it('handles Windows separators', () => {
    expect(fileKind('assets\\logo.png')).toBe('images')
    expect(fileKind('bin\\tool.exe')).toBe('binary')
  })

  it('keeps svg as an image, because the app shows its text diff', () => {
    expect(fileKind('logo.svg', false)).toBe('images')
  })
})

describe('extensionOf', () => {
  it.each([
    ['a.png', 'png'],
    ['a/b.c/d.TXT', 'txt'],
    ['a.tar.gz', 'gz'],
    ['noext', ''],
    ['.gitignore', ''],
    ['dir.d/noext', ''],
    ['end.', '']
  ])('%s has the extension "%s"', (path, ext) => {
    expect(extensionOf(path)).toBe(ext)
  })
})

describe('countKinds', () => {
  it('counts each file once, and gives every kind a number', () => {
    const counts = countKinds([
      { path: 'a.ts' },
      { path: 'b.ts' },
      { path: 'logo.png', binary: true },
      { path: 'x.zip', binary: true },
      { path: 'blob', binary: true }
    ])
    expect(counts).toEqual({ code: 2, tests: 0, config: 0, docs: 0, images: 1, binary: 2 })
  })

  it('counts nothing for no files', () => {
    expect(Object.values(countKinds([])).every((n) => n === 0)).toBe(true)
  })
})

describe('visibleKinds', () => {
  const none = new Set<FileKind>()
  const ids = (counts: Parameters<typeof visibleKinds>[0], selected = none): string[] => visibleKinds(counts, selected).map((k) => k.id)

  it('shows only the options that have files, in the fixed order, with their counts', () => {
    const counts = { code: 3, tests: 0, config: 0, docs: 1, images: 2, binary: 0 }
    expect(visibleKinds(counts, none)).toEqual([
      { id: 'code', label: 'Code', count: 3 },
      { id: 'docs', label: 'Docs', count: 1 },
      { id: 'images', label: 'Images', count: 2 }
    ])
  })

  it('also hides Code, Tests, Config and Docs when they have no file', () => {
    expect(ids({ code: 0, tests: 0, config: 0, docs: 0, images: 1, binary: 1 })).toEqual(['images', 'binary'])
  })

  it('shows no option when no file has a kind, so the group is not shown', () => {
    expect(visibleKinds(countKinds([]), none)).toEqual([])
  })

  it('shows every option when every kind has files', () => {
    expect(ids({ code: 1, tests: 1, config: 1, docs: 1, images: 1, binary: 1 })).toEqual(FILE_KINDS.map((k) => k.id))
  })

  it('keeps an option that is on when its count falls to 0, so the reader can turn it off', () => {
    const counts = { code: 2, tests: 0, config: 0, docs: 0, images: 0, binary: 0 }
    expect(visibleKinds(counts, new Set<FileKind>(['images']))).toEqual([
      { id: 'code', label: 'Code', count: 2 },
      { id: 'images', label: 'Images', count: 0 }
    ])
  })

  it('keeps the group when the only option that is on has no file', () => {
    const counts = countKinds([])
    expect(ids(counts, new Set<FileKind>(['binary']))).toEqual(['binary'])
  })

  it('hides the option again after it is turned off', () => {
    const counts = { code: 2, tests: 0, config: 0, docs: 0, images: 0, binary: 0 }
    expect(ids(counts, new Set<FileKind>())).toEqual(['code'])
  })
})
