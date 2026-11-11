/**
 * Model-facing `browser` tool and `tool:browser` system-prompt section.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools';
import { type JsonValue } from '../../shared/backlinks-types.ts';
import type { BrowserCommand, BrowserResult } from '../browser/index.ts';
export interface BrowserCloseBrowserMarker {
    readonly kind: 'closeBrowser';
}
export declare function parseBrowserArgs(args: Record<string, unknown>): BrowserCommand | BrowserCloseBrowserMarker;
export declare function formatBrowserOutput(result: BrowserResult, maxChars: number): string;
export declare function browserIsConcurrencySafe(): boolean;
export declare function presentBrowserCall(args: Record<string, unknown>): GenericCallView;
export declare function presentBrowserResult(_args: Record<string, unknown>, result: ToolResult): GenericResultView | undefined;
export declare function browserMetaFromValue(value: unknown): JsonValue;
export declare function browserMetaFromMeta(meta: unknown): {
    title: string;
} | undefined;
export declare function applyBrowserTool(ctx: Context, timeoutMs: number, maxOutputChars: number): void;
