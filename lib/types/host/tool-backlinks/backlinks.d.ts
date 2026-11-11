/**
 * Model-facing `backlinks` tool and `tool:backlinks` system-prompt section.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools';
import { type JsonValue } from '../../shared/backlinks-types.ts';
import type { BacklinkItemResult } from '../backlinks/index.ts';
export declare function parseItemResult(args: Record<string, unknown>): BacklinkItemResult;
export declare function renderBacklinksValue(value: unknown): string;
export declare function presentBacklinksCall(args: Record<string, unknown>): GenericCallView;
export declare function backlinksMetaFromValue(value: unknown): JsonValue;
export declare function backlinksMetaFromMeta(meta: unknown): {
    summary: string;
} | undefined;
export declare function presentBacklinksResult(_args: Record<string, unknown>, result: ToolResult): GenericResultView | undefined;
export declare function backlinksIsConcurrencySafe(): boolean;
export declare function applyBacklinksTool(ctx: Context, timeoutMs: number): void;
