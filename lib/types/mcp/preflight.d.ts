/**
 * Zero-LLM concurrent HTTP preflight & standard blocking-tag filter for
 * `backlinks action="batch_preflight"`.
 */
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../host/backlinks/types.ts';
import type { FetchLike, SleepLike } from './backlinks-tool.ts';
export declare const PREFLIGHT_HEAD_BYTES = 32768;
export declare const PREFLIGHT_TAIL_BYTES = 65536;
export declare const PREFLIGHT_FULL_READ_CAP_BYTES = 131072;
export declare const PREFLIGHT_STREAM_SCAN_CAP_BYTES = 524288;
export type PreflightDeadReason = 'invalid_url' | 'http_404' | 'http_410' | 'http_5xx_persistent' | 'dns_error' | 'tls_error' | 'connection_error' | 'parked_or_suspended';
export type PreflightRetryableReason = 'timeout' | 'http_408' | 'http_429' | 'network_error';
export type WafProvider = 'cloudfront' | 'cloudflare' | 'waf';
export type PreflightSiteHint = 'wordpress_comment' | 'typecho_comment' | 'wix_blog' | 'comments_closed_hint' | 'directory_or_form' | 'other';
export interface PreflightRunnableItem {
    readonly itemId: number;
    readonly domain: string;
    readonly siteHint: PreflightSiteHint;
    readonly redirectedFromGo?: boolean;
    readonly rootSubmitHint?: string;
}
export interface PreflightTimeoutCluster {
    readonly pattern: string;
    readonly count: number;
    readonly itemIds: readonly number[];
    readonly hosts: readonly string[];
    readonly hint: string;
}
export interface PreflightHeldForManualItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly matchedTags: readonly string[];
    readonly reason: 'already_tagged_waf_403' | 'already_tagged_soft_block';
}
export interface PreflightTaggedBlockedItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly matchedTags: readonly string[];
}
export interface PreflightCautionItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly tags: readonly string[];
}
export interface PreflightDeadItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly url: string;
    readonly reason: PreflightDeadReason;
    readonly httpStatus?: number;
    readonly detail?: string;
}
export interface PreflightWafItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly url: string;
    readonly httpStatus: 403;
    readonly provider: WafProvider;
}
export interface PreflightRetryableItem {
    readonly id: number;
    readonly sourceId: number;
    readonly host: string;
    readonly url: string;
    readonly reason: PreflightRetryableReason;
    readonly httpStatus?: number;
    readonly detail?: string;
}
export interface PreflightAutoSkipError {
    readonly itemId: number;
    readonly error: string;
}
export interface BatchPreflightOptions {
    readonly timeoutMs?: number;
    readonly concurrency?: number;
    readonly autoSkip?: boolean;
    readonly autoSkipTagged?: boolean;
    readonly skipSoftTagged?: boolean;
    readonly autoFailWaf?: boolean;
    readonly skipTags?: readonly string[];
    readonly retry5xx?: number;
    readonly itemIds?: readonly number[];
    readonly fetchImpl: FetchLike;
    readonly sleepImpl: SleepLike;
}
export interface BatchPreflightResult {
    readonly summary: string;
    readonly skippedDeadItemIds: readonly number[];
    readonly skippedTaggedItemIds: readonly number[];
    readonly failedWafItemIds: readonly number[];
    readonly data: {
        readonly batchId: number;
        readonly batchName: string;
        readonly counts: {
            readonly totalItems: number;
            readonly pendingItems: number;
            readonly considered: number;
            readonly alreadyPublished: number;
            readonly taggedBlocked: number;
            readonly heldForManual: number;
            readonly probed: number;
            readonly runnable: number;
            readonly dead: number;
            readonly wafBlocked: number;
            readonly retryable: number;
            readonly autoSkipped: number;
            readonly autoFailedWaf: number;
        };
        readonly publishedSourceIds: readonly number[];
        readonly runnableItemIds: readonly number[];
        readonly runnableItems: readonly PreflightRunnableItem[];
        readonly cautionItems?: readonly PreflightCautionItem[];
        readonly taggedBlocked?: readonly PreflightTaggedBlockedItem[];
        readonly heldForManual?: readonly PreflightHeldForManualItem[];
        readonly skippedByTag?: {
            readonly hardItemIds: readonly number[];
            readonly softItemIds: readonly number[];
        };
        readonly deadItems?: readonly PreflightDeadItem[];
        readonly wafBlocked?: readonly PreflightWafItem[];
        readonly retryableItems?: readonly PreflightRetryableItem[];
        readonly timeoutClusters?: readonly PreflightTimeoutCluster[];
        readonly alreadyPublishedItemIds?: readonly number[];
        readonly autoSkipResult?: {
            readonly mode: 'preflight_skip_api' | 'legacy_fallback';
            readonly skippedItemIds: readonly number[];
            readonly unchangedCount?: number;
            readonly taggedSourceIds?: readonly number[];
            readonly downgradeNotice?: string;
            readonly errors?: readonly PreflightAutoSkipError[];
        };
        readonly autoFailWafResult?: {
            readonly failedItemIds: readonly number[];
            readonly taggedSourceIds?: readonly number[];
            readonly errors?: readonly PreflightAutoSkipError[];
        };
    };
}
/**
 * Read HTML body for preflight sniffing:
 * - Pages <= 128KB are read in full.
 * - Larger pages retain the first 32KB (head/meta/parked markers) + rolling
 *   last 64KB (footer `#commentform`, `wp-comments-post.php`, Typecho forms)
 *   up to a 512KB streaming scan cap.
 */
export declare function readBoundedBodyText(response: Response, options?: {
    readonly headBytes?: number;
    readonly tailBytes?: number;
    readonly fullReadCapBytes?: number;
    readonly streamScanCapBytes?: number;
}): Promise<string>;
/** Extract a lightweight site-type hint from a single HTTP preflight response (0 Chrome cost). */
export declare function detectSiteHint(finalUrl: string, headers: Headers, body: string): PreflightSiteHint;
/**
 * Group timed-out items sharing a common URL path prefix pattern (e.g. >= 3 items
 * matching `/nano-banana-pro-*` or `/blog/post/*`) into `timeoutClusters`.
 */
export declare function detectTimeoutClusters(retryableItems: readonly PreflightRetryableItem[], minClusterSize?: number): readonly PreflightTimeoutCluster[];
export declare function runBatchPreflight(batchSource: BacklinkBatchSourceProvider, detail: BacklinkBatchDetail, options: BatchPreflightOptions, signal?: AbortSignal): Promise<BatchPreflightResult>;
