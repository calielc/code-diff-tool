import type { LevelName } from '@shared/diff'

export interface KeyedLine {
  index: number
  key: string
}

export interface Rename {
  from: string
  to: string
}

// The expressions of file 03 section 4.4. The `s` flag makes `.` match a carriage return, as it does in .NET.
const CSharpUsing = /^(?:global\s+)?using\s+(?!var\b)[^\s(][^;(]*;\s*$/s
const ScriptImport = /^import\s.*\sfrom\s*['"][^'"]+['"]\s*;?\s*$/s
const ScriptSideEffectImport = /^import\s*['"][^'"]+['"]\s*;?\s*$/s
const ScriptMultiLineImportStart = /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*$/s
const ScriptImportEnd = /from\s*['"][^'"]+['"]\s*;?\s*$/s
const HarmlessModifier = /\b(?:static|sealed|readonly)\b/g

const SCRIPT_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])
const HASH_COMMENT_EXT = new Set(['yaml', 'yml', 'sh'])

/** The extension after the last dot of the file name, lower case. A name with no dot has none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

// The whitespace set of .NET char.IsWhiteSpace. U+FEFF is removed separately.
// eslint-disable-next-line no-control-regex
const WS = /[\u0009-\u000D \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g

function isStrictNoise(trimmed: string, hashComments: boolean): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#nullable') ||
    trimmed.startsWith('#pragma warning') ||
    (hashComments && trimmed.startsWith('#'))
  )
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Apply the renames, longest old name first. Each replacement runs on the output of the previous one (section 5). */
export function applyRenames(line: string, renames: Rename[]): string {
  let out = line
  for (const r of renames) out = out.replace(new RegExp(`(?<![\\w.])${escapeRe(r.from)}(?!\\w)`, 'g'), () => r.to)
  return out
}

/** `Keys(path, lines, level, renames)`: the comparison keys of a file's lines (file 03 section 4). */
export function keysFor(path: string, lines: string[], level: LevelName, renames: Rename[] = []): KeyedLine[] {
  if (level === 'raw') return lines.map((key, index) => ({ index, key }))
  const ext = extensionOf(path)
  const isCSharp = ext === 'cs'
  const isScript = SCRIPT_EXT.has(ext)
  const hashComments = HASH_COMMENT_EXT.has(ext)
  const strict = level === 'strict'
  const out: KeyedLine[] = []
  let inImport = false
  lines.forEach((raw, i) => {
    let line = raw
    if (i === 0) line = line.replace(/^\ufeff+/, '')
    if (inImport) {
      if (ScriptImportEnd.test(line)) inImport = false
      return
    }
    if (isCSharp && CSharpUsing.test(line)) return
    if (isScript && (ScriptImport.test(line) || ScriptSideEffectImport.test(line))) return
    if (isScript && ScriptMultiLineImportStart.test(line)) {
      inImport = true
      return
    }
    if (strict && isStrictNoise(line.replace(/^\s+/, ''), hashComments)) return
    let text = applyRenames(line, renames)
    if (strict && isCSharp) text = text.replace(HarmlessModifier, '')
    const key = text.replace(WS, '')
    if (key !== '') out.push({ index: i, key })
  })
  return out
}

/** Detect C# namespace moves over the changed files (file 03 section 5). */
export function detectRenames(files: { path: string; oldText: string | null; newText: string | null }[]): Rename[] {
  const renames: Rename[] = []
  const re = /^\s*namespace\s+([\w.]+)/m
  for (const f of files) {
    if (!f.path.toLowerCase().endsWith('.cs') || f.oldText === null || f.newText === null) continue
    const o = re.exec(f.oldText)?.[1]
    const n = re.exec(f.newText)?.[1]
    if (o && n && o !== n && !renames.some((r) => r.from === o)) renames.push({ from: o, to: n })
  }
  return renames.sort((a, b) => b.from.length - a.from.length) // stable sort, longest old name first
}

const GENERATED_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'packages.lock.json'])
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.designer.cs', '.g.cs', 'modelsnapshot.cs']

/** Generated file rules (file 03 section 6). `content` is the new text, or the old text for a deleted file. */
export function isGenerated(path: string, content: string | null): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (GENERATED_NAMES.has(name)) return true
  if (GENERATED_SUFFIXES.some((s) => name.endsWith(s))) return true
  if (content === null) return false
  if (name.endsWith('.json')) return /^\ufeff?\s*\{\s*"(?:openapi|swagger)"\s*:/.test(content)
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return /^\ufeff?(?:#[^\n]*\n|\s)*(?:openapi|swagger)\s*:/.test(content)
  return false
}

/** Cleaning of a displayed line: strip leading U+FEFF and trailing whitespace (file 03 section 3.4). */
export const cleanLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/^\ufeff+/, '').replace(/[\u0009-\u000D \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/, '')
