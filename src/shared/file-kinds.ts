// The kind of a changed file, for the Types filter of the Diff tab.

export type FileKind = 'code' | 'tests' | 'config' | 'docs' | 'images' | 'binary'
export const FILE_KINDS: { id: FileKind; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'tests', label: 'Tests' },
  { id: 'config', label: 'Config' },
  { id: 'docs', label: 'Docs' },
  { id: 'images', label: 'Images' },
  { id: 'binary', label: 'Binary' }
]

const DOCS = /\.(md|mdx|txt|rst|adoc)$/i
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|props|targets|csproj|sln|xml|lock|env|conf|cfg|editorconfig|gitignore|gitattributes|npmrc|dockerignore)$/i
const CONFIG_NAME = /(^|\/)(\.[\w.-]+|Dockerfile|Makefile|package-lock\.json|Directory\.[\w.]+|\.?[\w-]*rc)$/i
const CONFIG_DIR = /(^|\/)(\.config|\.github|\.gitlab|\.vscode|config|configs)\//i
const TESTS = /(^|\/)(tests?|__tests__|specs?|e2e)(\/|$)|[.-](test|spec)\.[a-z]+$|Tests?\.[a-z]+$/i

/** The extensions of image files. SVG is here too. It is text, so the diff shows its lines, but it is an image to the reader. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'ico',
  'cur',
  'svg',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'jxl',
  'psd'
])

/** The extensions of files that are binary and not images. A file with one of them counts as Binary even when git did not flag it. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // archives and packages
  ...['zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'tar', 'jar', 'war', 'ear', 'aar', 'apk', 'ipa', 'whl', 'egg'],
  ...['nupkg', 'snupkg', 'vsix', 'deb', 'rpm', 'msi', 'dmg', 'iso', 'img', 'asar'],
  // compiled code and libraries
  ...['exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'pdb', 'class', 'pyc', 'pyo', 'wasm', 'node', 'dex', 'bin'],
  // documents
  ...['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'],
  // fonts
  ...['ttf', 'otf', 'woff', 'woff2', 'eot'],
  // audio and video
  ...['mp3', 'mp4', 'm4a', 'wav', 'ogg', 'flac', 'avi', 'mov', 'mkv', 'webm'],
  // data and keys
  ...['sqlite', 'sqlite3', 'db', 'lockb', 'pkl', 'npy', 'onnx', 'pt', 'pth', 'p12', 'pfx', 'jks', 'keystore']
])

/** The lower-case extension of the file name, without the dot. A name with no dot, a dotfile such as `.gitignore` and a name that ends in a dot have none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * The one kind of a file. The checks run in this order, and the first that matches wins:
 * 1. Images, by extension. An image is never Binary, even when git flagged it as binary.
 * 2. Binary, when git flagged the file as binary or the extension is a known binary one.
 * 3. Docs.
 * 4. Tests.
 * 5. Config.
 * 6. Code, for everything else.
 * So a PNG in a `tests` folder is an image, and a `Tests.dll` is binary.
 */
export function fileKind(path: string, binary = false): FileKind {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'images'
  if (binary || BINARY_EXTENSIONS.has(ext)) return 'binary'
  if (DOCS.test(path)) return 'docs'
  if (TESTS.test(path)) return 'tests'
  if (CONFIG_DIR.test(path) || CONFIG_EXT.test(path) || CONFIG_NAME.test(path)) return 'config'
  return 'code'
}

/** How many files each kind has. Every kind is a key, so a kind with no file has 0. */
export function countKinds(files: { path: string; binary?: boolean }[]): Record<FileKind, number> {
  const counts: Record<FileKind, number> = { code: 0, tests: 0, config: 0, docs: 0, images: 0, binary: 0 }
  for (const f of files) counts[fileKind(f.path, f.binary)]++
  return counts
}

/**
 * The options that the Types filter shows, in the fixed order of FILE_KINDS.
 * An option shows when it has files. An option that is on shows even when it has none, so the reader can see why the list is empty and turn it off.
 * When the result is empty, the Types filter does not show at all.
 */
export function visibleKinds(counts: Record<FileKind, number>, selected: ReadonlySet<FileKind>): { id: FileKind; label: string; count: number }[] {
  return FILE_KINDS.filter((k) => counts[k.id] > 0 || selected.has(k.id)).map((k) => ({ ...k, count: counts[k.id] }))
}
