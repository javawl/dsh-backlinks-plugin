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
] as const

export type StandardBlockingTag = typeof STANDARD_BLOCKING_TAGS[number]

export const HARD_BLOCKING_TAGS = [
  'paid_only',
  'dead_site',
  'no_form',
  'comments_closed',
] as const

export type HardBlockingTag = typeof HARD_BLOCKING_TAGS[number]

export const SOFT_BLOCKING_TAGS = [
  'has_captcha',
  'waf_403',
  'submitmatic_verify_fail',
] as const

export type SoftBlockingTag = typeof SOFT_BLOCKING_TAGS[number]

export const STANDARD_TAG_ALIASES: Readonly<Record<string, StandardBlockingTag>> = {
  '付费': 'paid_only',
  '收费': 'paid_only',
  '仅付费': 'paid_only',
  '无表单': 'no_form',
  '无提交入口': 'no_form',
  '死链': 'dead_site',
  '停服': 'dead_site',
  '已停服': 'dead_site',
  '关评': 'comments_closed',
  '评论关闭': 'comments_closed',
  '关闭评论': 'comments_closed',
  '验证码': 'has_captcha',
  '有验证码': 'has_captcha',
  '有盾': 'waf_403',
  '徽标校验失败': 'submitmatic_verify_fail',
}

export const DEFAULT_MAIL_WAIT_TIMEOUT_MS = 30_000
export const DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS = 3_000
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000
export const DEFAULT_PREFLIGHT_CONCURRENCY = 6
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2

const HARD_BLOCKING_TAG_SET = new Set<string>(HARD_BLOCKING_TAGS)
const SOFT_BLOCKING_TAG_SET = new Set<string>(SOFT_BLOCKING_TAGS)

/**
 * Wire mapping for outbound Supermanager `/tags` / `/preflight-skip` requests.
 * Live Supermanager currently rejects English `comments_closed` with HTTP 500,
 * whereas Chinese `评论关闭` succeeds cleanly.
 */
export const SUPERMANAGER_WIRE_TAG_MAP: Readonly<Record<string, string>> = {
  comments_closed: '评论关闭',
}

/**
 * Safe Chinese fallback aliases used when live Supermanager returns HTTP 5xx
 * for English canonical blocking tag names.
 */
export const SUPERMANAGER_SAFE_ZH_TAG_FALLBACK: Readonly<Record<string, string>> = {
  paid_only: '付费',
  no_form: '无表单',
  dead_site: '死链',
  has_captcha: '验证码',
  waf_403: '有盾',
  submitmatic_verify_fail: '徽标校验失败',
  comments_closed: '评论关闭',
  low_quality: '低质量',
}

/** Map outbound source tags to Supermanager wire-compatible names (deduped). */
export function mapTagsForSupermanagerWire(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const mapped = SUPERMANAGER_WIRE_TAG_MAP[trimmed.toLowerCase()] ?? trimmed
    if (!seen.has(mapped)) {
      seen.add(mapped)
      out.push(mapped)
    }
  }
  return out
}

/** Map tags to safe Chinese aliases for Supermanager 5xx compatibility fallback. */
export function mapTagsToSafeChineseFallback(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const canonical = normalizeBlockingTag(trimmed)
    const mapped = SUPERMANAGER_SAFE_ZH_TAG_FALLBACK[canonical] ?? trimmed
    if (!seen.has(mapped)) {
      seen.add(mapped)
      out.push(mapped)
    }
  }
  return out
}

/** Detect whether an error represents an HTTP 5xx response from Supermanager. */
export function isSupermanager5xxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /\bHTTP\s+5\d\d\b/iu.test(error.message)
}

/** Normalize a raw source tag name to its canonical blocking tag when known. */
export function normalizeBlockingTag(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const lower = trimmed.toLowerCase()
  return STANDARD_TAG_ALIASES[trimmed] ?? STANDARD_TAG_ALIASES[lower] ?? lower
}

export interface BlockingTagMatch {
  readonly hard: readonly string[]
  readonly soft: readonly string[]
  readonly matchedSkipTags: readonly string[]
}

/** Classify a source's tags into hard-blocking, soft-blocking, and skip-matched tags. */
export function matchBlockingTags(
  tags: readonly string[],
  customSkipTags?: readonly string[],
): BlockingTagMatch {
  const skipSet = customSkipTags === undefined
    ? HARD_BLOCKING_TAG_SET
    : new Set(customSkipTags.map(normalizeBlockingTag).filter(Boolean))

  const hard: string[] = []
  const soft: string[] = []
  const matchedSkipTags: string[] = []
  const seenHard = new Set<string>()
  const seenSoft = new Set<string>()
  const seenSkip = new Set<string>()

  for (const raw of tags) {
    const normalized = normalizeBlockingTag(raw)
    if (normalized.length === 0) continue

    if (HARD_BLOCKING_TAG_SET.has(normalized) && !seenHard.has(normalized)) {
      seenHard.add(normalized)
      hard.push(normalized)
    }
    if (SOFT_BLOCKING_TAG_SET.has(normalized) && !seenSoft.has(normalized)) {
      seenSoft.add(normalized)
      soft.push(normalized)
    }
    if (skipSet.has(normalized) && !seenSkip.has(normalized)) {
      seenSkip.add(normalized)
      matchedSkipTags.push(normalized)
    }
  }

  return { hard, soft, matchedSkipTags }
}
