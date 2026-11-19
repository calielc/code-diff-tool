// The AI tool the user picked. Shared by the main process and the Prerequisites screen.

export type ToolId = 'claude' | 'codex' | 'custom'

/** Any other command-line AI tool. See the placeholders in the Prerequisites form. */
export interface CustomTool {
  /** The name shown in messages. */
  name: string
  command: string
  args: string[]
}

export interface LlmConfig {
  tool: ToolId
  custom?: CustomTool
  /** The Codex model name each tier means. A tier with no name uses Codex's own default. */
  codexModels?: Partial<Record<'haiku' | 'sonnet' | 'opus' | 'fable', string>>
}

export const TOOL_NAMES: Record<ToolId, string> = { claude: 'Claude Code', codex: 'Codex', custom: 'Another tool' }
