/**
 * Consumer for the browser automation seam: model-facing `browser` tool over `ctx.browser`.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-browser";
export declare const inject: string[];
export declare const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 180000;
export declare const DEFAULT_BROWSER_MAX_OUTPUT_CHARS = 60000;
export interface Config {
    readonly maxOutputChars?: number;
    readonly timeoutMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { formatBrowserOutput, parseBrowserArgs } from './browser.ts';
