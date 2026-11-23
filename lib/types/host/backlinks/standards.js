/**
 * Shared standard blocking source tags, timeout defaults, and circuit-breaker
 * thresholds for `backlinks` operations (zero DSH/Cordis dependencies).
 */
export const STANDARD_BLOCKING_TAGS = [
    'paid_only',
    'no_form',
    'dead_site',
    'has_captcha',
    'waf_403',
    'submitmatic_verify_fail',
    'comments_closed',
];
export const HARD_BLOCKING_TAGS = [
    'paid_only',
    'dead_site',
    'no_form',
    'comments_closed',
];
export const SOFT_BLOCKING_TAGS = [
    'has_captcha',
    'waf_403',
    'submitmatic_verify_fail',
];
export const STANDARD_TAG_ALIASES = {
    '付费': 'paid_only',
    '收费': 'paid_only',
    '死链': 'dead_site',
    '无表单': 'no_form',
    '关评': 'comments_closed',
    '验证码': 'has_captcha',
};
export const DEFAULT_MAIL_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;
export const DEFAULT_PREFLIGHT_CONCURRENCY = 6;
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2;
const HARD_BLOCKING_TAG_SET = new Set(HARD_BLOCKING_TAGS);
const SOFT_BLOCKING_TAG_SET = new Set(SOFT_BLOCKING_TAGS);
/** Normalize a raw source tag name to its canonical blocking tag when known. */
export function normalizeBlockingTag(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return '';
    const lower = trimmed.toLowerCase();
    return STANDARD_TAG_ALIASES[trimmed] ?? STANDARD_TAG_ALIASES[lower] ?? lower;
}
/** Classify a source's tags into hard-blocking, soft-blocking, and skip-matched tags. */
export function matchBlockingTags(tags, customSkipTags) {
    const skipSet = customSkipTags === undefined
        ? HARD_BLOCKING_TAG_SET
        : new Set(customSkipTags.map(normalizeBlockingTag).filter(Boolean));
    const hard = [];
    const soft = [];
    const matchedSkipTags = [];
    const seenHard = new Set();
    const seenSoft = new Set();
    const seenSkip = new Set();
    for (const raw of tags) {
        const normalized = normalizeBlockingTag(raw);
        if (normalized.length === 0)
            continue;
        if (HARD_BLOCKING_TAG_SET.has(normalized) && !seenHard.has(normalized)) {
            seenHard.add(normalized);
            hard.push(normalized);
        }
        if (SOFT_BLOCKING_TAG_SET.has(normalized) && !seenSoft.has(normalized)) {
            seenSoft.add(normalized);
            soft.push(normalized);
        }
        if (skipSet.has(normalized) && !seenSkip.has(normalized)) {
            seenSkip.add(normalized);
            matchedSkipTags.push(normalized);
        }
    }
    return { hard, soft, matchedSkipTags };
}
