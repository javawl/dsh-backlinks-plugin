/**
 * Session-scoped circuit breaker for consecutive same-template failures and
 * active reciprocal badge rollback guard.
 */
import type { BacklinkBatchDetail, BacklinkBatchItem, BacklinkItemResult } from '../host/backlinks/types.ts';
import { type StandardBlockingTag } from '../host/backlinks/standards.ts';
export interface CircuitBreakerAlert {
    readonly tripped: true;
    readonly fingerprint: string;
    readonly consecutiveFailures: number;
    readonly threshold: number;
    readonly failedItemIds: readonly number[];
    readonly suggestedTag?: StandardBlockingTag;
    readonly affectedPendingItemIds?: readonly number[];
    readonly action: string;
}
export interface ActiveBadgeRecord {
    readonly badgeId: number;
    readonly websiteId: number;
    readonly name: string;
    readonly html: string;
}
export interface BadgeRollbackReminder {
    readonly badgeId: number;
    readonly websiteId: number;
    readonly name: string;
    readonly action: string;
}
interface DerivedTemplateFingerprint {
    readonly fingerprint: string;
    readonly suggestedTag?: StandardBlockingTag;
    readonly matchesItem: (candidate: BacklinkBatchItem) => boolean;
}
export declare function deriveTemplateFingerprint(input: {
    readonly item?: BacklinkBatchItem;
    readonly status: BacklinkItemResult['status'];
    readonly failureReason?: string;
    readonly skipReason?: string;
    readonly evidence?: string;
    readonly templateSignature?: string;
}): DerivedTemplateFingerprint | undefined;
export declare class PublishSessionGuard {
    private readonly threshold;
    private readonly itemsById;
    private readonly batchItems;
    private readonly breakers;
    private readonly activeBadges;
    constructor(threshold?: number);
    recordBatchDetail(detail: BacklinkBatchDetail): void;
    recordClaimedItems(batchId: number, items: readonly BacklinkBatchItem[]): void;
    markItemTerminal(itemId: number, terminalStatus?: string): void;
    recordItemResult(input: {
        readonly itemId: number;
        readonly status: BacklinkItemResult['status'];
        readonly failureReason?: string;
        readonly skipReason?: string;
        readonly evidence?: string;
        readonly templateSignature?: string;
    }): CircuitBreakerAlert | undefined;
    getClaimAlerts(batchId: number, claimedItems: readonly BacklinkBatchItem[]): readonly CircuitBreakerAlert[];
    recordBadgeAdded(badge: ActiveBadgeRecord): void;
    recordBadgeDeactivated(criteria: {
        readonly websiteId: number;
        readonly badgeId?: number;
        readonly name?: string;
        readonly html?: string;
    }): void;
    findActiveBadgeForItem(itemId: number, contextText?: string): BadgeRollbackReminder | undefined;
    private findMatchingPendingItemIds;
}
export {};
