/**
 * Consumer for the backlinks capability seam: model-facing `backlinks` tool over `ctx.backlinks`.
 */
import z from '@deepseek-ai/schemastery';
import { applyBacklinksTool } from "./backlinks.js";
export const name = 'tool-backlinks';
export const inject = ['tools', 'backlinks', 'systemPrompt'];
export const DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS = 300_000;
export const Config = z.object({
    timeoutMs: z.number().default(DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS),
});
export function apply(ctx, config) {
    const resolved = config;
    if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
        throw new Error(`tool-backlinks: timeoutMs must be a positive integer, got ${resolved.timeoutMs}`);
    }
    applyBacklinksTool(ctx, resolved.timeoutMs);
}
export { parseItemResult, renderBacklinksValue } from "./backlinks.js";
