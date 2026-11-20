// The kind of a changed file, for the Types filter of the Diff tab.

export type FileKind = 'code' | 'tests' | 'config' | 'docs'
export const FILE_KINDS: { id: FileKind; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'tests', label: 'Tests' },
  { id: 'config', label: 'Config' },
  { id: 'docs', label: 'Docs' }
]

const DOCS = /\.(md|mdx|txt|rst|adoc)$/i
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|props|targets|csproj|sln|xml|lock|env|conf|cfg|editorconfig|gitignore|gitattributes|npmrc|dockerignore)$/i
const CONFIG_NAME = /(^|\/)(\.[\w.-]+|Dockerfile|Makefile|package-lock\.json|Directory\.[\w.]+|\.?[\w-]*rc)$/i
const CONFIG_DIR = /(^|\/)(\.config|\.github|\.gitlab|\.vscode|config|configs)\//i
const TESTS = /(^|\/)(tests?|__tests__|specs?|e2e)(\/|$)|[.-](test|spec)\.[a-z]+$|Tests?\.[a-z]+$/i

/** Docs first, then tests, then config, and everything else is code. */
export function fileKind(path: string): FileKind {
  if (DOCS.test(path)) return 'docs'
  if (TESTS.test(path)) return 'tests'
  if (CONFIG_DIR.test(path) || CONFIG_EXT.test(path) || CONFIG_NAME.test(path)) return 'config'
  return 'code'
}
