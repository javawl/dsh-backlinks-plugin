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
/** Normalize a raw source tag name to its canonical blocking tag when known. */
export declare function normalizeBlockingTag(raw: string): string;
export interface BlockingTagMatch {
    readonly hard: readonly string[];
    readonly soft: readonly string[];
    readonly matchedSkipTags: readonly string[];
}
/** Classify a source's tags into hard-blocking, soft-blocking, and skip-matched tags. */
export declare function matchBlockingTags(tags: readonly string[], customSkipTags?: readonly string[]): BlockingTagMatch;
