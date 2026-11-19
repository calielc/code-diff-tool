import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkills, parseSkill } from '../src/main/services/skills'

const skill = (fm: string): string => `---\n${fm}\n---\n\nBody text.\n`

describe('review skill discovery (file 04 section 7.2)', () => {
  it('accepts the usage as a string or in a list, and reads name, plugin, description and model', () => {
    const root = join(tmpdir(), 'plugins')
    const folder = join(root, 'teams', 'lx', 'skills', 'review-code')
    const s = parseSkill(skill('name: review-code\ndescription: Reviews.\nmodel: sonnet\nmetadata:\n  usage: [other, code-diff-review]'), folder, root)
    expect(s).toMatchObject({
      id: 'teams/lx/review-code',
      name: 'review-code',
      plugin: 'teams/lx',
      description: 'Reviews.',
      model: 'sonnet',
      text: 'Body text.'
    })
    expect(parseSkill(skill('metadata:\n  usage: code-diff-review'), folder, root)?.name).toBe('review-code') // name falls back to the folder
  })
  it('ignores no front matter, broken YAML, a non-mapping root, other usage and a model that is not one of the four', () => {
    const root = join(tmpdir(), 'p')
    const folder = join(root, 'a', 'skills', 'x')
    expect(parseSkill('# no front matter', folder, root)).toBeNull()
    expect(parseSkill(skill('a: [unclosed'), folder, root)).toBeNull()
    expect(parseSkill(skill('- a\n- b'), folder, root)).toBeNull()
    expect(parseSkill(skill('metadata:\n  usage: other'), folder, root)).toBeNull()
    expect(parseSkill(skill('model: gpt\nmetadata:\n  usage: code-diff-review'), folder, root)?.model).toBeNull()
  })
  it('lists the built-in skill first as the default, then the folder skills sorted by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    for (const n of ['zeta', 'alpha']) {
      const d = join(root, 'plug', 'skills', n)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'SKILL.md'), skill(`name: ${n}\nmetadata:\n  usage: code-diff-review`))
    }
    const list = await listSkills(root)
    expect(list.map((s) => s.name)).toEqual(['general-review', 'alpha', 'zeta'])
    expect(list.filter((s) => s.default)).toHaveLength(1)
    expect((await listSkills(null)).map((s) => s.name)).toEqual(['general-review'])
  })
})
