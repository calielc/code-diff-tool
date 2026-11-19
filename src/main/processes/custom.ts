import { run } from './run'
import { spawnLines, validateAsk, type AskInput } from './claude'

import type { CustomTool } from '@shared/llm'
export type { CustomTool }

/**
 * Any other command-line AI tool. The user gives a command and its arguments. These placeholders are replaced in each
 * argument: {prompt} {instructions} {model} {effort} {dir} {session}. When no argument holds {prompt}, the prompt (with the
 * instructions in front, unless {instructions} is used) goes to the tool on standard input. The tool prints its answer on
 * standard output as plain text. It has no session, so the app sends the earlier turns itself.
 */
export function buildCustomArgs(tool: CustomTool, i: AskInput): { args: string[]; stdin: string | undefined } {
  const usesPrompt = tool.args.some((a) => a.includes('{prompt}'))
  const usesInstructions = tool.args.some((a) => a.includes('{instructions}'))
  const values: Record<string, string> = {
    '{prompt}': usesInstructions ? i.prompt : `${i.instructions}\n\n${i.prompt}`,
    '{instructions}': i.instructions,
    '{model}': i.model,
    '{effort}': i.effort ?? '',
    '{dir}': i.workingDirectory,
    '{session}': i.session
  }
  const args = tool.args.map((a) => Object.entries(values).reduce((s, [k, v]) => s.split(k).join(v), a))
  return { args, stdin: usesPrompt ? undefined : usesInstructions ? i.prompt : `${i.instructions}\n\n${i.prompt}` }
}

const out = (o: unknown): string => JSON.stringify(o)

export async function* askCustom(tool: CustomTool, input: AskInput, signal?: AbortSignal): AsyncGenerator<string> {
  const bad = validateAsk({ ...input, tools: undefined })
  if (bad) throw new Error(bad)
  const started = Date.now()
  const { args, stdin } = buildCustomArgs(tool, input)
  let text = ''
  let begun = false
  for await (const line of spawnLines(tool.command, args, input.workingDirectory, signal, stdin)) {
    if (!begun) {
      begun = true
      yield out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    }
    const piece = (text ? '\n' : '') + line
    text += piece
    yield out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } })
  }
  yield out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - started, result: text.trim(), session_id: input.session })
}

export async function customState(tool: CustomTool): Promise<'ok' | 'missing'> {
  const r = await run(tool.command, ['--version'], { timeoutMs: 15_000 })
  // Many tools have no --version. Only a program that cannot start counts as missing.
  return r.launchError ? 'missing' : 'ok'
}
