/**
 * Consumer for the browser automation seam: model-facing `browser` tool over `ctx.browser`.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyBrowserTool } from './browser.ts'

export const name = 'tool-browser'
export const inject = ['tools', 'browser', 'systemPrompt']
export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 180_000
export const DEFAULT_BROWSER_MAX_OUTPUT_CHARS = 60_000

export interface Config {
  readonly maxOutputChars?: number
  readonly timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxOutputChars: z.number().default(DEFAULT_BROWSER_MAX_OUTPUT_CHARS),
  timeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error(`tool-browser: maxOutputChars must be a positive integer, got ${resolved.maxOutputChars}`)
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error(`tool-browser: timeoutMs must be a positive integer, got ${resolved.timeoutMs}`)
  }
  applyBrowserTool(ctx, resolved.timeoutMs, resolved.maxOutputChars)
}

export { formatBrowserOutput, parseBrowserArgs } from './browser.ts'
