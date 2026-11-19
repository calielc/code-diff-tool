import { z } from 'zod'
import { CH } from '@shared/channels'
import type { LlmConfig } from '@shared/llm'
import type { Result } from '@shared/types'
import { getLlmConfig, setLlmConfig } from '../processes/llm'
import { readAppState, writeAppState } from '../services/app-state'
import { handle } from './guard'

const config = z.object({
  tool: z.enum(['claude', 'codex', 'custom']),
  custom: z.object({ name: z.string().max(60), command: z.string().max(500), args: z.array(z.string().max(2000)).max(50) }).optional(),
  codexModels: z.record(z.string(), z.string().max(100)).optional()
})

/** Apply the saved choice at start. */
export async function applySavedLlmConfig(): Promise<void> {
  const saved = (await readAppState()).llm
  if (saved) setLlmConfig(saved)
}

export function registerLlmHandlers(): void {
  handle(CH.llmGet, null, (): LlmConfig => getLlmConfig())
  handle(CH.llmSet, config, async (c): Promise<Result<true>> => {
    if (c.tool === 'custom' && !c.custom?.command.trim()) return { ok: false, error: 'Enter the command of the tool.' }
    setLlmConfig(c as LlmConfig)
    await writeAppState({ llm: c as LlmConfig })
    return { ok: true, value: true }
  })
}
