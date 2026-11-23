/**
 * Pure, zero-DSH-dependency validation and payload-compaction helpers for
 * `backlinks` operations (shared between DSH `tool-backlinks` and the MCP server).
 */
import type { BacklinkBatchDetail, BacklinkItemResult } from './types.ts';
export declare function readPositiveInt(value: unknown, field: string, prefix?: string): number;
export declare function readOptionalPositiveInt(value: unknown, field: string, prefix?: string): number | undefined;
export declare function readNonEmpty(value: unknown, field: string, prefix?: string): string;
export declare function readOptionalString(value: unknown, field: string, prefix?: string): string | undefined;
export declare function readHttpUrl(value: unknown, field: string, prefix?: string): string;
export declare function parseItemResult(args: Record<string, unknown>): BacklinkItemResult;
export declare function parseTags(tags: unknown): readonly string[];
export interface CompactBacklinkBatchItem {
    readonly id: number;
    readonly sourceId: number;
    readonly sourceName: string;
    readonly sourceUrl: string;
    readonly sourceHost: string;
    readonly submitUrl?: string;
    readonly sourceNotes?: string;
    readonly category?: string;
    readonly tags?: readonly string[];
    readonly paymentType?: string;
    readonly linkType?: string;
    readonly status: string;
    readonly failureMode?: string;
    readonly failureReason?: string;
    readonly publishedUrl?: string;
    readonly publishStatus?: string;
}
export interface CompactBacklinkBatchDetail {
    readonly compact: true;
    readonly batch: BacklinkBatchDetail['batch'];
    readonly website: BacklinkBatchDetail['website'];
    readonly anchors: BacklinkBatchDetail['anchors'];
    readonly items: readonly CompactBacklinkBatchItem[];
}
export declare function compactBatchDetail(detail: BacklinkBatchDetail): CompactBacklinkBatchDetail;
