import { answer as claudeAnswer, ask as claudeAsk, claudeState, missingMessage as claudeMissing, type AskInput, type Model } from './claude'
import { askCodex, codexState } from './codex'
import type { LlmConfig, ToolId } from '@shared/llm'
import { askCustom, customState } from './custom'

let config: LlmConfig = { tool: 'claude' }
export const setLlmConfig = (c: LlmConfig): void => {
  config = c
}
export const getLlmConfig = (): LlmConfig => config

/** The name used in messages, such as `claude took longer than 3 minutes`. */
export function toolName(): string {
  if (config.tool === 'claude') return 'claude'
  if (config.tool === 'codex') return 'codex'
  return config.custom?.name || 'the AI tool'
}

/** What the tool can do. A tool with no session needs the app to send the earlier turns again. */
export function capabilities(): { resume: boolean } {
  return { resume: config.tool !== 'custom' }
}

const win = (): boolean => process.platform === 'win32'

/** The text shown when the tool is not installed. */
export function missingMessage(): string {
  if (config.tool === 'claude') return claudeMissing()
  if (config.tool === 'codex') {
    return `'codex' not found — install it first (${win() ? 'npm install -g @openai/codex' : 'npm install -g @openai/codex, or `brew install codex`'}), then reopen the review.`
  }
  return `'${config.custom?.command ?? 'The AI tool'}' could not be started. Check the command in the AI tool settings, then reopen the review.`
}

/** The command to run so the tool has a login, shown with the not-logged-in text. */
export function loginCommand(): string {
  return config.tool === 'codex' ? 'codex login' : 'claude'
}

export async function llmState(): Promise<'ok' | 'missing' | 'nologin'> {
  if (config.tool === 'claude') return claudeState()
  if (config.tool === 'codex') return codexState()
  return config.custom ? customState(config.custom) : 'missing'
}

/** Run one turn with the chosen tool and yield its lines in the stream-json shape. */
export function ask(input: AskInput, signal?: AbortSignal): AsyncGenerator<string> {
  if (config.tool === 'claude') return claudeAsk(input, signal)
  if (config.tool === 'codex') return askCodex(input, config.codexModels ?? {}, signal)
  if (!config.custom) throw new Error('No command is set for the AI tool. Open Prerequisites and set it.')
  return askCustom(config.custom, input, signal)
}

/** Run one turn and return the final text: the `result` of the first result line (file 04 section 1.4). */
export async function answer(input: AskInput, signal?: AbortSignal): Promise<string> {
  if (config.tool === 'claude') return claudeAnswer(input, signal) // keeps the exact messages of the spec
  const name = toolName()
  for await (const line of ask(input, signal)) {
    if (!line.startsWith('{')) continue
    let o: { type?: string; is_error?: boolean; result?: unknown }
    try {
      o = JSON.parse(line) as typeof o
    } catch {
      continue
    }
    if (o.type !== 'result') continue
    if (o.is_error) throw new Error(`${name} answered with an error: ${typeof o.result === 'string' ? o.result : ''}`)
    return typeof o.result === 'string' ? o.result : ''
  }
  throw new Error(`${name} ended before it answered.`)
}

export type { AskInput, LlmConfig, Model, ToolId }
