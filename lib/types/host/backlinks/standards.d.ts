/**
 * Shared standard blocking source tags, timeout defaults, and circuit-breaker
 * thresholds for `backlinks` operations (zero DSH/Cordis dependencies).
 */
export declare const STANDARD_BLOCKING_TAGS: readonly ["paid_only", "no_form", "dead_site", "has_captcha", "waf_403", "submitmatic_verify_fail", "comments_closed"];
export type StandardBlockingTag = typeof STANDARD_BLOCKING_TAGS[number];
export declare const HARD_BLOCKING_TAGS: readonly ["paid_only", "dead_site", "no_form", "comments_closed"];
export type HardBlockingTag = typeof HARD_BLOCKING_TAGS[number];
export declare const SOFT_BLOCKING_TAGS: readonly ["has_captcha", "waf_403", "submitmatic_verify_fail"];
export type SoftBlockingTag = typeof SOFT_BLOCKING_TAGS[number];
export declare const STANDARD_TAG_ALIASES: Readonly<Record<string, StandardBlockingTag>>;
export declare const DEFAULT_MAIL_WAIT_TIMEOUT_MS = 30000;
export declare const DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS = 3000;
export declare const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5000;
export declare const DEFAULT_PREFLIGHT_CONCURRENCY = 6;
export declare const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2;
/**
 * Wire mapping for outbound Supermanager `/tags` / `/preflight-skip` requests.
 * Live Supermanager currently rejects English `comments_closed` with HTTP 500,
 * whereas Chinese `评论关闭` succeeds cleanly.
 */
export declare const SUPERMANAGER_WIRE_TAG_MAP: Readonly<Record<string, string>>;
/**
 * Safe Chinese fallback aliases used when live Supermanager returns HTTP 5xx
 * for English canonical blocking tag names.
 */
export declare const SUPERMANAGER_SAFE_ZH_TAG_FALLBACK: Readonly<Record<string, string>>;
/** Map outbound source tags to Supermanager wire-compatible names (deduped). */
export declare function mapTagsForSupermanagerWire(tags: readonly string[]): readonly string[];
/** Map tags to safe Chinese aliases for Supermanager 5xx compatibility fallback. */
export declare function mapTagsToSafeChineseFallback(tags: readonly string[]): readonly string[];
/** Detect whether an error represents an HTTP 5xx response from Supermanager. */
export declare function isSupermanager5xxError(error: unknown): boolean;
/** Normalize a raw source tag name to its canonical blocking tag when known. */
export declare function normalizeBlockingTag(raw: string): string;
export interface BlockingTagMatch {
    readonly hard: readonly string[];
    readonly soft: readonly string[];
    readonly matchedSkipTags: readonly string[];
}
/** Classify a source's tags into hard-blocking, soft-blocking, and skip-matched tags. */
export declare function matchBlockingTags(tags: readonly string[], customSkipTags?: readonly string[]): BlockingTagMatch;
