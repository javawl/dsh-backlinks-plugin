/**
 * Host-side provider interfaces and error class for `ctx.backlinks`.
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { BacklinkBadgeInput, BacklinkBadgeResult, BacklinkBatchDetail, BacklinkBatchSummary, BacklinkHeartbeat, BacklinkItemOutcome, BacklinkItemResult, BacklinkLeaseClaim, BacklinkTagResult, MailboxAddress, MailPollOptions, VerificationMail } from '../../shared/backlinks-types.ts';
export type * from '../../shared/backlinks-types.ts';
export interface BacklinkBatchSourceProvider {
    readonly id: string;
    available(): boolean;
    listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]>;
    getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail>;
    claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal): Promise<BacklinkLeaseClaim>;
    heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat>;
    release(leaseId: number, signal?: AbortSignal): Promise<void>;
    reportItemResult(itemId: number, result: BacklinkItemResult, signal?: AbortSignal): Promise<BacklinkItemOutcome>;
    addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal): Promise<BacklinkBadgeResult>;
    tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal): Promise<BacklinkTagResult>;
}
export interface MailboxProvider {
    readonly id: string;
    available(): boolean;
    createMailbox(options: {
        readonly localPart: string;
        readonly domain: string;
    }, signal?: AbortSignal): Promise<MailboxAddress>;
    pollMail(address: MailboxAddress, options: MailPollOptions, signal?: AbortSignal): Promise<VerificationMail | null>;
}
export type BacklinksErrorCode = 'BACKLINKS_DUPLICATE_PROVIDER' | 'BACKLINKS_PROVIDER_CONFIGURED_MISSING' | 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE' | 'BACKLINKS_PROVIDER_UNAVAILABLE' | 'BACKLINKS_PROVIDER_AMBIGUOUS' | 'BACKLINKS_UNAUTHORIZED' | 'BACKLINKS_NOT_FOUND' | 'BACKLINKS_CONFLICT' | 'BACKLINKS_INVALID_REQUEST' | 'BACKLINKS_API_ERROR' | 'BACKLINKS_TRANSPORT' | 'BACKLINKS_TIMEOUT' | 'BACKLINKS_ABORTED';
export declare class BacklinksError extends HarnessError {
    readonly retryAfterSeconds: number | null;
    constructor(message: string, code: BacklinksErrorCode, retryAfterSeconds?: number | null, options?: ErrorOptions);
}
