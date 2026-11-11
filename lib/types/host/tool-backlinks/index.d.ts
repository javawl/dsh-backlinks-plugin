/**
 * Consumer for the backlinks capability seam: model-facing `backlinks` tool over `ctx.backlinks`.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-backlinks";
export declare const inject: string[];
export declare const DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS = 300000;
export interface Config {
    readonly timeoutMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { parseItemResult, renderBacklinksValue } from './backlinks.ts';
