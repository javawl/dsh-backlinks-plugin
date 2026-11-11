/**
 * Service Definition for the backlinks capability seam (`ctx.backlinks`).
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BacklinkBadgeInput, BacklinkBadgeResult, BacklinkBatchDetail, BacklinkBatchSourceProvider, BacklinkBatchSummary, BacklinkHeartbeat, BacklinkItemOutcome, BacklinkItemResult, BacklinkLeaseClaim, BacklinkTagResult, MailboxAddress, MailboxProvider, MailPollOptions, VerificationMail } from './types.ts';
export { BacklinksError } from './types.ts';
export type * from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        backlinks: BacklinksRuntime;
    }
}
export interface BacklinksRuntimeConfig {
    readonly batchSourceProvider?: string;
    readonly mailboxProvider?: string;
}
export declare class BacklinksRuntime extends Service {
    static Config: z<BacklinksRuntimeConfig>;
    private batchSources;
    private mailboxes;
    private readonly batchSourceId;
    private readonly mailboxId;
    constructor(ctx: Context, config?: BacklinksRuntimeConfig);
    registerBatchSourceProvider(provider: BacklinkBatchSourceProvider): () => void;
    registerMailboxProvider(provider: MailboxProvider): () => void;
    private registerProvider;
    listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]>;
    getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail>;
    claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal): Promise<BacklinkLeaseClaim>;
    heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat>;
    release(leaseId: number, signal?: AbortSignal): Promise<void>;
    reportItemResult(itemId: number, result: BacklinkItemResult, signal?: AbortSignal): Promise<BacklinkItemOutcome>;
    addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal): Promise<BacklinkBadgeResult>;
    tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal): Promise<BacklinkTagResult>;
    createMailbox(options: {
        readonly localPart: string;
        readonly domain: string;
    }, signal?: AbortSignal): Promise<MailboxAddress>;
    pollMail(address: MailboxAddress, options: MailPollOptions, signal?: AbortSignal): Promise<VerificationMail | null>;
    private resolveBatchSource;
    private resolveMailbox;
}
export default BacklinksRuntime;
