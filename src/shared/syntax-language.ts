// Which language a file or a code fence is written in, so the app can colour it. The answer is the id of a grammar, or
// null for plain text. The ids are the names of the highlight.js grammars, plus `hcl`, which the app defines itself.

/** The language of a file by its extension. The extension is lower case and has no dot. */
const BY_EXTENSION: Record<string, string> = {
  // The web
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  // The main languages
  cs: 'csharp',
  csx: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  phtml: 'php',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  pm: 'perl',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vbnet',
  mm: 'objectivec',
  // Data and configuration
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  webmanifest: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  editorconfig: 'ini',
  gitconfig: 'ini',
  npmrc: 'ini',
  env: 'ini',
  service: 'ini',
  desktop: 'ini',
  properties: 'properties',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
  plist: 'xml',
  wsdl: 'xml',
  rss: 'xml',
  atom: 'xml',
  xaml: 'xml',
  resx: 'xml',
  csproj: 'xml',
  vbproj: 'xml',
  fsproj: 'xml',
  proj: 'xml',
  props: 'xml',
  targets: 'xml',
  nuspec: 'xml',
  config: 'xml',
  slnx: 'xml',
  sln: 'ini',
  gradle: 'gradle',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // Shells and build files
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  mk: 'makefile',
  cmake: 'cmake',
  dockerfile: 'dockerfile'
}

/** The language of a file by its whole name, in lower case. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  jenkinsfile: 'groovy',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  guardfile: 'ruby',
  gradlew: 'bash',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.bash_aliases': 'bash',
  '.zshrc': 'bash',
  '.zprofile': 'bash',
  '.profile': 'bash',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.stylelintrc': 'json',
  '.swcrc': 'json',
  '.jshintrc': 'json',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.dockerignore': 'ini',
  '.npmignore': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitconfig': 'ini',
  '.env': 'ini',
  'cargo.lock': 'ini',
  'go.mod': 'go',
  'nginx.conf': 'nginx'
}

/** The names that code fences use for a language, mapped to the id of its grammar. A name that is also an extension needs no entry. */
const BY_FENCE: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  'c#': 'csharp',
  csharp: 'csharp',
  golang: 'go',
  'c++': 'cpp',
  python: 'python',
  python3: 'python',
  ruby: 'ruby',
  rust: 'rust',
  kotlin: 'kotlin',
  shell: 'bash',
  console: 'bash',
  shellscript: 'bash',
  powershell: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  terraform: 'hcl',
  html: 'xml',
  node: 'javascript',
  nodejs: 'javascript'
}

/** The longest extension that the app looks at. Anything longer is not an extension. */
const MAX_EXTENSION = 16

/** The ids of every language that the tables above can return. The loaders of the renderer must cover all of them. */
export const LANGUAGE_IDS: readonly string[] = [...new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_NAME), ...Object.values(BY_FENCE)])].sort()

/** The grammar for the name of a file, or null when the app does not know the language. Only the name of the file counts, never its folder. */
export function languageForPath(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  if (name === '') return null
  const whole = BY_NAME[name]
  if (whole) return whole
  // Dockerfile.dev and Dockerfile.prod, and the .env files of each stage
  if (name.startsWith('dockerfile.')) return 'dockerfile'
  if (name.startsWith('.env.')) return 'ini'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || name.length - dot - 1 > MAX_EXTENSION) return null
  return BY_EXTENSION[name.slice(dot + 1)] ?? null
}

/** The grammar for the language name of a code fence (the text after the three backticks), or null. */
export function languageForFence(info: string): string | null {
  const word = info
    .trim()
    .split(/[\s{,]/, 1)[0]
    .toLowerCase()
  if (word === '') return null
  return BY_FENCE[word] ?? BY_EXTENSION[word] ?? null
}
