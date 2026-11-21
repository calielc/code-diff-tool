// The highlighter. It colours a whole text with one grammar and returns the tokens of each line. It runs in a worker
// (highlight.worker.ts), and the unit tests call it directly. It never produces HTML: the result is plain data.

import { createLowlight } from 'lowlight'
import { linesFromTree, textOfTokens, type TokenLine } from '@shared/syntax-tokens'
import { LOADERS, NEEDS } from './loaders'

const lowlight = createLowlight()
const loaded = new Map<string, Promise<boolean>>()

/** Register a grammar once. Resolves false when the app has no grammar with this id. */
function ensure(id: string): Promise<boolean> {
  let p = loaded.get(id)
  if (!p) {
    const load = LOADERS[id]
    p = load
      ? Promise.all([load(), ...(NEEDS[id] ?? []).map(ensure)]).then(
          ([module]) => (lowlight.register(id, module.default), true),
          () => false
        )
      : Promise.resolve(false)
    loaded.set(id, p)
  }
  return p
}

/**
 * The tokens of each line of `lines`, coloured as one text in the language `lang`. Resolves null when the grammar is
 * unknown, when it fails, or when its answer does not match the text. The answer then is plain text, never a crash.
 */
export async function highlightLines(lang: string, lines: readonly string[]): Promise<TokenLine[] | null> {
  if (!(await ensure(lang))) return null
  try {
    const tree = lowlight.highlight(lang, lines.join('\n'))
    const out = linesFromTree(tree)
    if (out.length !== lines.length) return null
    for (let i = 0; i < lines.length; i++) if (textOfTokens(out[i]) !== lines[i]) return null
    return out
  } catch {
    return null
  }
}
