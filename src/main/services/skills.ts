import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_SKILL_TEXT } from '@shared/review-prompts'
import { isModel, type Model } from '../processes/claude'
import { atomicWrite, stateDir } from './reviews'

export interface ReviewSkill {
  /** `<plugin>/<name>`. */
  id: string
  name: string
  plugin: string
  description: string
  /** The model named by the skill, when it is one of the four. */
  model: Model | null
  default: boolean
  /** The folder of the skill, or null for the built-in one. */
  folder: string | null
}

export interface LoadedSkill extends ReviewSkill {
  text: string
}

export const BUILTIN_ID = 'builtin/general-review'

const builtin = (): LoadedSkill => ({
  id: BUILTIN_ID,
  name: 'general-review',
  plugin: 'builtin',
  description: 'A general review of correctness, the issue spec, tests, security, design and readability.',
  model: null,
  default: true,
  folder: null,
  text: BUILTIN_SKILL_TEXT
})

const SKIP = new Set(['node_modules', '.git', 'dist', 'out'])

async function findSkillFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const e of entries) {
    if (e.isFile() && e.name === 'SKILL.md') found.push(join(dir, e.name))
    else if (e.isDirectory() && !SKIP.has(e.name)) found.push(...(await findSkillFiles(join(dir, e.name), depth + 1)))
  }
  return found
}

/** A file counts as a review skill when its front matter declares `metadata.usage` as `code-diff-review`, alone or in a list. */
export function parseSkill(text: string, folder: string, root: string): LoadedSkill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  let fm: unknown
  try {
    fm = parseYaml(m[1])
  } catch {
    return null // YAML that does not parse
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null
  const usage = (fm as { metadata?: { usage?: unknown } }).metadata?.usage
  if (!(usage === 'code-diff-review' || (Array.isArray(usage) && usage.includes('code-diff-review')))) return null
  const f = fm as { name?: unknown; description?: unknown; model?: unknown }
  const rel = relative(root, folder).split(sep).join('/')
  const cut = rel.lastIndexOf('/skills/')
  const plugin = cut >= 0 ? rel.slice(0, cut) : rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const name = typeof f.name === 'string' && f.name ? f.name : (folder.split(/[\\/]/).pop() ?? 'skill')
  return {
    id: `${plugin}/${name}`,
    name,
    plugin,
    description: typeof f.description === 'string' ? f.description : '',
    model: isModel(f.model) ? f.model : null,
    default: false,
    folder,
    text: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  }
}

/** The review skills: the built-in one, then every `SKILL.md` of the skills folder that declares the usage, sorted by name then plugin. */
export async function listSkills(skillsFolder: string | null): Promise<LoadedSkill[]> {
  const out: LoadedSkill[] = []
  if (skillsFolder) {
    for (const file of await findSkillFiles(skillsFolder)) {
      try {
        const skill = parseSkill(await readFile(file, 'utf8'), join(file, '..'), skillsFolder)
        if (skill) out.push(skill)
      } catch {
        /* an unreadable file is ignored */
      }
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))
  return [builtin(), ...out]
}

// ---- The picks, shared by every review on this machine (file 04 section 10) ----

export interface AiPicks {
  skill: string | null
  model: Model | null
  acModel: Model | null
  acEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
}

const EMPTY: AiPicks = { skill: null, model: null, acModel: null, acEffort: null }
const picksFile = (root: string): string => join(stateDir(root), 'settings.json')

export async function readPicks(root: string): Promise<AiPicks> {
  try {
    const o = JSON.parse(await readFile(picksFile(root), 'utf8')) as Partial<AiPicks>
    return {
      skill: typeof o.skill === 'string' ? o.skill : null,
      model: isModel(o.model) ? o.model : null,
      acModel: isModel(o.acModel) ? o.acModel : null,
      acEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(o.acEffort as string) ? (o.acEffort as AiPicks['acEffort']) : null
    }
  } catch {
    return { ...EMPTY } // a missing or unreadable file gives all null
  }
}

export async function writePicks(root: string, picks: AiPicks): Promise<void> {
  await atomicWrite(picksFile(root), JSON.stringify(picks))
}
