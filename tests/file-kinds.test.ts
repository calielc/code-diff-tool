import { describe, expect, it } from 'vitest'
import { fileKind } from '../src/shared/file-kinds'

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
})
