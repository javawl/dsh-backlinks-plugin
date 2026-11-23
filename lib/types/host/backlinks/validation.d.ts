/**
 * Pure, zero-DSH-dependency validation and payload-compaction helpers for
 * `backlinks` operations (shared between DSH `tool-backlinks` and the MCP server).
 */
import type { BacklinkBatchDetail, BacklinkBatchItem, BacklinkBatchSummary, BacklinkItemResult } from './types.ts';
export declare function readPositiveInt(value: unknown, field: string, prefix?: string): number;
export declare function readOptionalPositiveInt(value: unknown, field: string, prefix?: string): number | undefined;
export declare function readOptionalNonNegativeInt(value: unknown, field: string, prefix?: string): number | undefined;
export declare function readClampedInt(value: unknown, field: string, fallback: number, min: number, max: number, prefix?: string): number;
export declare function readNonEmpty(value: unknown, field: string, prefix?: string): string;
export declare function readOptionalString(value: unknown, field: string, prefix?: string): string | undefined;
export declare function readHttpUrl(value: unknown, field: string, prefix?: string): string;
export declare function parseItemResult(args: Record<string, unknown>): BacklinkItemResult;
export declare function parseTags(tags: unknown): readonly string[];
export interface CompactBacklinkBatchSummary {
    readonly id: number;
    readonly name: string;
    readonly websiteId: number;
    readonly websiteName: string;
    readonly websiteHost: string;
    readonly plannedAt?: string;
    readonly counts: {
        readonly pending: number;
        readonly total: number;
        readonly executed?: number;
        readonly skipped?: number;
        readonly failed?: number;
    };
    readonly executing?: true;
}
export declare function compactBatchSummary(batch: BacklinkBatchSummary): CompactBacklinkBatchSummary;
export declare function isPublishedItem(item: Pick<BacklinkBatchItem, 'publishStatus' | 'publishedUrl'>): boolean;
export declare function collectPublishedSourceIds(items: readonly BacklinkBatchItem[]): readonly number[];
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
