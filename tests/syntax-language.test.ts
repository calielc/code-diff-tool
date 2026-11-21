import { describe, expect, it } from 'vitest'
import { LANGUAGE_IDS, languageForFence, languageForPath } from '../src/shared/syntax-language'
import { LOADERS } from '../src/renderer/highlight/loaders'

describe('languageForPath', () => {
  it.each([
    ['src/App.tsx', 'typescript'],
    ['src/app.ts', 'typescript'],
    ['index.d.mts', 'typescript'],
    ['lib/util.js', 'javascript'],
    ['lib/Button.jsx', 'javascript'],
    ['Api/Program.cs', 'csharp'],
    ['src/Main.java', 'java'],
    ['src/Main.kt', 'kotlin'],
    ['build.gradle.kts', 'kotlin'],
    ['app/main.py', 'python'],
    ['cmd/main.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['src/a.c', 'c'],
    ['include/a.h', 'c'],
    ['src/a.cpp', 'cpp'],
    ['include/a.hpp', 'cpp'],
    ['app/model.rb', 'ruby'],
    ['public/index.php', 'php'],
    ['Sources/App.swift', 'swift'],
    ['db/schema.sql', 'sql'],
    ['ci/build.sh', 'bash'],
    ['scripts/Build.ps1', 'powershell'],
    ['package.json', 'json'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['config/app.yaml', 'yaml'],
    ['Cargo.toml', 'ini'],
    ['pom.xml', 'xml'],
    ['public/index.html', 'xml'],
    ['src/styles.css', 'css'],
    ['src/styles.scss', 'scss'],
    ['README.md', 'markdown'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile.prod', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['src/Api/Api.csproj', 'xml'],
    ['Directory.Build.props', 'xml'],
    ['Api.sln', 'ini'],
    ['build.gradle', 'gradle'],
    ['infra/main.tf', 'hcl'],
    ['infra/prod.tfvars', 'hcl'],
    ['.editorconfig', 'ini'],
    ['.env.local', 'ini'],
    ['.eslintrc', 'json'],
    ['Gemfile', 'ruby'],
    ['Jenkinsfile', 'groovy'],
    ['CMakeLists.txt', 'cmake']
  ])('finds the language of %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it('looks at the name of the file only, and ignores the case', () => {
    expect(languageForPath('docs/dockerfile.md/Dockerfile')).toBe('dockerfile')
    expect(languageForPath('SRC/APP.TS')).toBe('typescript')
    expect(languageForPath('a\\b\\Program.CS')).toBe('csharp')
    expect(languageForPath('some.ts/README')).toBeNull()
  })

  it('leaves an unknown file as plain text', () => {
    expect(languageForPath('notes.txt')).toBeNull()
    expect(languageForPath('photo.png')).toBeNull()
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('')).toBeNull()
    expect(languageForPath('dir/')).toBeNull()
    expect(languageForPath('file.' + 'x'.repeat(40))).toBeNull()
  })
})

describe('languageForFence', () => {
  it('reads the language name of a code fence', () => {
    expect(languageForFence('ts')).toBe('typescript')
    expect(languageForFence('typescript')).toBe('typescript')
    expect(languageForFence(' C# ')).toBe('csharp')
    expect(languageForFence('python title="x.py"')).toBe('python')
    expect(languageForFence('shell')).toBe('bash')
    expect(languageForFence('yml')).toBe('yaml')
    expect(languageForFence('html')).toBe('xml')
    expect(languageForFence('dockerfile')).toBe('dockerfile')
  })
  it('gives null for no name, text and an unknown name', () => {
    expect(languageForFence('')).toBeNull()
    expect(languageForFence('text')).toBeNull()
    expect(languageForFence('klingon')).toBeNull()
  })
})

describe('the grammars', () => {
  it('has a loader for every language that a name can give, and none that no name gives', () => {
    expect(Object.keys(LOADERS).sort()).toEqual([...LANGUAGE_IDS])
  })
  it('covers the languages of the request', () => {
    for (const id of [
      'typescript',
      'javascript',
      'csharp',
      'java',
      'kotlin',
      'python',
      'go',
      'rust',
      'c',
      'cpp',
      'ruby',
      'php',
      'swift',
      'sql',
      'bash',
      'powershell',
      'json',
      'yaml',
      'ini',
      'xml',
      'css',
      'scss',
      'markdown',
      'dockerfile',
      'gradle',
      'hcl'
    ]) {
      expect(LANGUAGE_IDS, id).toContain(id)
    }
  })
})
