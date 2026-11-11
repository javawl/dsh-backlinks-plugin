/**
 * The supermanager implementation of the batch work-source seam (`/api/agent/*`).
 */
import type { BacklinkBadgeInput, BacklinkBadgeResult, BacklinkBatchDetail, BacklinkBatchSourceProvider, BacklinkBatchSummary, BacklinkHeartbeat, BacklinkItemOutcome, BacklinkItemResult, BacklinkLeaseClaim, BacklinkTagResult } from '../backlinks/index.ts';
export declare const SUPERMANAGER_BATCH_SOURCE_ID = "supermanager";
export interface ResolvedSupermanagerConfig {
    readonly baseUrl: string;
    readonly token: string;
    readonly requestTimeoutMs: number;
}
export declare class SupermanagerBatchSource implements BacklinkBatchSourceProvider {
    private readonly resolveConfig;
    readonly id = "supermanager";
    constructor(resolveConfig: () => ResolvedSupermanagerConfig);
    available(): boolean;
    listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]>;
    getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail>;
    claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal): Promise<BacklinkLeaseClaim>;
    heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat>;
    release(leaseId: number, signal?: AbortSignal): Promise<void>;
    reportItemResult(itemId: number, result: BacklinkItemResult, signal?: AbortSignal): Promise<BacklinkItemOutcome>;
    addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal): Promise<BacklinkBadgeResult>;
    tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal): Promise<BacklinkTagResult>;
    private resultPayload;
    private requestJson;
}
