/**
 * Consumer for the backlinks capability seam: model-facing `backlinks` tool over `ctx.backlinks`.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyBacklinksTool } from './backlinks.ts'

export const name = 'tool-backlinks'
export const inject = ['tools', 'backlinks', 'systemPrompt']
export const DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS = 300_000

export interface Config {
  readonly timeoutMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error(`tool-backlinks: timeoutMs must be a positive integer, got ${resolved.timeoutMs}`)
  }
  applyBacklinksTool(ctx, resolved.timeoutMs)
}

export { parseItemResult, renderBacklinksValue } from './backlinks.ts'
