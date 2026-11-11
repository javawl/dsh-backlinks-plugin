/**
 * Browser-safe and Host-shared data structures for the backlinks capability seam.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Exhaustiveness helper for closed discriminated unions. */
export function assertNever(_value: never, message: string): never {
  throw new Error(message)
}

/** One publish batch with per-status counts. */
export interface BacklinkBatchSummary {
  readonly id: number
  readonly name: string
  readonly websiteId: number
  readonly websiteName: string
  readonly websiteHost: string
  readonly plannedAt: string
  readonly counts: {
    readonly pending: number
    readonly executed: number
    readonly skipped: number
    readonly failed: number
    readonly total: number
  }
  /** True while an agent lease is actively executing this batch's items. */
  readonly executing: boolean
}

/** One executable plan item: the target site and its current state. */
export interface BacklinkBatchItem {
  readonly id: number
  readonly sourceId: number
  readonly sourceName: string
  readonly sourceUrl: string
  readonly sourceHost: string
  readonly submitUrl: string | null
  readonly sourceNotes: string | null
  readonly category: string | null
  readonly tags: readonly string[]
  readonly paymentType: string
  readonly linkType: string
  readonly status: string
  readonly failureMode: string | null
  readonly failureReason: string | null
  /** Public URL of an existing publish record; non-null means already published. */
  readonly publishedUrl: string | null
  /** Existing publish status (submitted/live/...); submitted or live means already published. */
  readonly publishStatus: string | null
  readonly plannedAt: string
}

/** An active anchor/target pair the promoted website offers for form filling. */
export interface BacklinkWebsiteAnchor {
  readonly id: number
  readonly anchorText: string
  readonly targetUrl: string
}

/** Batch detail: everything an executor needs before claiming. */
export interface BacklinkBatchDetail {
  readonly batch: BacklinkBatchSummary
  readonly website: {
    readonly id: number
    readonly name: string
    readonly siteUrl: string
    readonly siteHost: string
    readonly shortDescription?: string
    readonly longDescription?: string
    readonly logoUrl?: string
    readonly screenshotUrl?: string
    readonly keyFeatures?: string
    readonly pricingType?: string
  }
  readonly anchors: readonly BacklinkWebsiteAnchor[]
  readonly items: readonly BacklinkBatchItem[]
}

/** A granted lease plus the claimed items' payloads. */
export interface BacklinkLeaseClaim {
  readonly leaseId: number
  readonly leaseExpiresAt: string
  readonly items: readonly BacklinkBatchItem[]
}

/** Renewed lease window. */
export interface BacklinkHeartbeat {
  readonly leaseId: number
  readonly leaseExpiresAt: string
}

/** Agent-reported item outcome (closed union). */
export type BacklinkItemResult =
  | { readonly status: 'live'; readonly publicUrl: string; readonly anchorText: string; readonly targetUrl: string; readonly evidence?: string }
  | { readonly status: 'submitted'; readonly publicUrl?: string; readonly anchorText: string; readonly targetUrl: string; readonly evidence?: string }
  | { readonly status: 'failed'; readonly failureMode: 'retryable' | 'manual_required'; readonly failureReason: string; readonly evidence?: string }
  | { readonly status: 'skipped'; readonly skipReason: string }

/** Server-side effect of one reported result. */
export interface BacklinkItemOutcome {
  readonly itemStatus: 'executed' | 'failed' | 'skipped'
  readonly publishRecordId: number | null
}

/** Badge name and HTML for one reciprocal footer badge. */
export interface BacklinkBadgeInput {
  readonly name: string
  readonly html: string
  readonly isActive?: boolean
}

/** Reciprocal badge creation effect. */
export interface BacklinkBadgeResult {
  readonly backlinkId: number
  readonly callbackTriggered: boolean
}

/** One attached source tag resolution outcome. */
export interface BacklinkTagResult {
  readonly sourceId: number
  readonly attached: readonly { id: number; name: string; created: boolean }[]
}

/** A created mailbox address. */
export interface MailboxAddress {
  readonly email: string
}

/** One received verification mail with its extracted confirmation facts. */
export interface VerificationMail {
  readonly subject: string
  readonly from: string
  readonly text: string
  readonly code: string | null
  readonly link: string | null
  readonly receivedAt: string
}

/** Poll options: match filters plus a bounded wait. */
export interface MailPollOptions {
  readonly subjectContains?: string
  readonly fromContains?: string
  readonly timeoutMs: number
  readonly intervalMs: number
}
