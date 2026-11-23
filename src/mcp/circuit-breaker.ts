/**
 * Session-scoped circuit breaker for consecutive same-template failures and
 * active reciprocal badge rollback guard.
 */

import type {
  BacklinkBatchDetail,
  BacklinkBatchItem,
  BacklinkItemResult,
} from '../host/backlinks/types.ts'
import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  type StandardBlockingTag,
} from '../host/backlinks/standards.ts'

export interface CircuitBreakerAlert {
  readonly tripped: true
  readonly fingerprint: string
  readonly consecutiveFailures: number
  readonly threshold: number
  readonly failedItemIds: readonly number[]
  readonly suggestedTag?: StandardBlockingTag
  readonly affectedPendingItemIds?: readonly number[]
  readonly action: string
}

export interface ActiveBadgeRecord {
  readonly badgeId: number
  readonly websiteId: number
  readonly name: string
  readonly html: string
}

export interface BadgeRollbackReminder {
  readonly badgeId: number
  readonly websiteId: number
  readonly name: string
  readonly action: string
}

interface DerivedTemplateFingerprint {
  readonly fingerprint: string
  readonly suggestedTag?: StandardBlockingTag
  readonly matchesItem: (candidate: BacklinkBatchItem) => boolean
}

interface BreakerEntry {
  readonly scopeKey: string
  readonly fingerprint: string
  readonly suggestedTag?: StandardBlockingTag
  matchesItem: (candidate: BacklinkBatchItem) => boolean
  consecutiveFailures: number
  failedItemIds: number[]
  tripped: boolean
}

const BREAKER_ACTION_MESSAGE =
  'TRIPPED: Stop installing badges or deep-probing matching template items in this batch; fast-verify or mark failed(manual_required)/skipped with standard tag.'

function itemSearchText(item: BacklinkBatchItem): string {
  return [
    item.sourceName,
    item.sourceHost,
    item.sourceUrl,
    item.submitUrl ?? '',
    item.sourceNotes ?? '',
    item.category ?? '',
    ...item.tags,
    ...(item.sourceTags ?? []),
    ...(item.blockingTags ?? []),
  ].join('\n')
}

function normalizeCategoryKey(category: string | null | undefined): string {
  if (!category) return 'general'
  const trimmed = category.trim().toLowerCase()
  if (trimmed.length === 0) return 'general'
  if (trimmed.includes('博客') || trimmed.includes('blog')) return 'blog'
  if (trimmed.includes('导航') || trimmed.includes('目录') || trimmed.includes('directory')) return 'directory'
  if (trimmed.includes('工具') || trimmed.includes('tool')) return 'tools'
  if (trimmed.includes('论坛') || trimmed.includes('forum')) return 'forum'
  if (trimmed.includes('内容') || trimmed.includes('article')) return 'article'
  if (trimmed.includes('游戏') || trimmed.includes('gam')) return 'gaming'
  return trimmed.replace(/\s+/gu, '_')
}

function inferTagFromText(text: string): StandardBlockingTag | undefined {
  const lower = text.toLowerCase()
  if (lower.includes('submitmatic') || lower.includes('verify_badge')) return 'submitmatic_verify_fail'
  if (lower.includes('secureimg') || lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('turnstile')) {
    return 'has_captcha'
  }
  if (lower.includes('waf_403') || lower.includes('cloudfront') || /\b403\b/u.test(lower)) return 'waf_403'
  if (lower.includes('paid_only') || lower.includes('paid')) return 'paid_only'
  if (lower.includes('comments_closed')) return 'comments_closed'
  if (lower.includes('no_form')) return 'no_form'
  if (lower.includes('dead_site')) return 'dead_site'
  return undefined
}

function classifyFailureBucket(failureText: string): string {
  if (/(verify\s*badge|verify\s*backlink|badge\s*verif|验证徽标|徽标校验|反链校验)/iu.test(failureText)) {
    return 'verify_badge'
  }
  if (/(secureimg|recaptcha|turnstile|hcaptcha|captcha|验证码|数学题)/iu.test(failureText)) {
    return 'captcha'
  }
  if (/(cloudfront|waf_403|\b403\b|waf|拦截)/iu.test(failureText)) {
    return 'waf_403'
  }
  if (/(paid|付费|收费|stripe|checkout)/iu.test(failureText)) {
    return 'paid_only'
  }
  if (/(comments?_?closed|关评|评论.*关闭)/iu.test(failureText)) {
    return 'comments_closed'
  }
  if (/(no_form|无表单|无评论区|无入口)/iu.test(failureText)) {
    return 'no_form'
  }
  if (/(timeout|timed out|超时)/iu.test(failureText)) {
    return 'timeout'
  }
  if (/(oauth|login|登录|30s)/iu.test(failureText)) {
    return 'login_blocked'
  }
  return 'failed'
}

function bucketToTag(bucket: string): StandardBlockingTag | undefined {
  switch (bucket) {
    case 'captcha':
      return 'has_captcha'
    case 'waf_403':
      return 'waf_403'
    case 'paid_only':
      return 'paid_only'
    case 'comments_closed':
      return 'comments_closed'
    case 'no_form':
      return 'no_form'
    default:
      return undefined
  }
}

export function deriveTemplateFingerprint(input: {
  readonly item?: BacklinkBatchItem
  readonly status: BacklinkItemResult['status']
  readonly failureReason?: string
  readonly skipReason?: string
  readonly evidence?: string
  readonly templateSignature?: string
}): DerivedTemplateFingerprint | undefined {
  const cleanExplicit = input.templateSignature?.trim().toLowerCase()
  if (cleanExplicit !== undefined && cleanExplicit.length > 0) {
    const prefix = cleanExplicit.split(':')[0] ?? cleanExplicit
    const suggestedTag = inferTagFromText(cleanExplicit)
    const sourceCategory = input.item?.category ?? null
    return {
      fingerprint: cleanExplicit,
      ...(suggestedTag === undefined ? {} : { suggestedTag }),
      matchesItem: (candidate) => {
        const text = itemSearchText(candidate).toLowerCase()
        if (prefix.length >= 3 && text.includes(prefix)) return true
        return sourceCategory !== null && candidate.category === sourceCategory
      },
    }
  }

  const failureContext = [input.failureReason, input.skipReason, input.evidence]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join('\n')
  const itemMeta = input.item ? itemSearchText(input.item) : ''
  const combined = [itemMeta, failureContext].filter(Boolean).join('\n')
  if (combined.length === 0) return undefined

  const hasSubmitmatic = /submitmatic/iu.test(combined)
  const isVerifyBadgeFail = /(verify\s*badge|verify\s*backlink|badge\s*verif|验证徽标|徽标校验|反链校验|徽标.*失败)/iu.test(failureContext)
  if (hasSubmitmatic && (isVerifyBadgeFail || /(badge|徽标|反链)/iu.test(failureContext))) {
    return {
      fingerprint: 'submitmatic:verify_badge_fail',
      suggestedTag: 'submitmatic_verify_fail',
      matchesItem: (candidate) => /submitmatic/iu.test(itemSearchText(candidate)),
    }
  }

  if (/secureimg/iu.test(combined)) {
    const categoryKey = normalizeCategoryKey(input.item?.category)
    const sourceCategory = input.item?.category ?? null
    return {
      fingerprint: `${categoryKey}:secureimg_captcha`,
      suggestedTag: 'has_captcha',
      matchesItem: (candidate) =>
        /secureimg/iu.test(itemSearchText(candidate))
        || (sourceCategory !== null && candidate.category === sourceCategory),
    }
  }

  if (/cloudfront/iu.test(combined) && /(403|waf|blocked|拦截)/iu.test(combined)) {
    return {
      fingerprint: 'waf:cloudfront_403',
      suggestedTag: 'waf_403',
      matchesItem: (candidate) => /cloudfront|waf_403/iu.test(itemSearchText(candidate)),
    }
  }

  const templateMarker = /@([a-z0-9_-]{3,40})/iu.exec(combined)
  if (templateMarker?.[1]) {
    const marker = `@${templateMarker[1].toLowerCase()}`
    const bucket = classifyFailureBucket(failureContext)
    const suggestedTag = marker === '@submitmatic' && bucket === 'verify_badge'
      ? 'submitmatic_verify_fail'
      : bucketToTag(bucket)
    return {
      fingerprint: `${marker}:${bucket}`,
      ...(suggestedTag === undefined ? {} : { suggestedTag }),
      matchesItem: (candidate) => itemSearchText(candidate).toLowerCase().includes(marker),
    }
  }

  if (isVerifyBadgeFail) {
    const sourceCategory = input.item?.category ?? null
    return {
      fingerprint: 'template:verify_badge_fail',
      matchesItem: (candidate) =>
        /(verify|badge|反链|徽标)/iu.test(itemSearchText(candidate))
        || (sourceCategory !== null && candidate.category === sourceCategory),
    }
  }

  const captchaMatch = /(recaptcha|turnstile|hcaptcha|math\s*captcha|数学验证码|数学题)/iu.exec(failureContext)
  if (captchaMatch?.[1]) {
    const captchaKind = captchaMatch[1].toLowerCase().replace(/\s+/gu, '_')
    const categoryKey = normalizeCategoryKey(input.item?.category)
    const sourceCategory = input.item?.category ?? null
    return {
      fingerprint: `${categoryKey}:${captchaKind}_captcha`,
      suggestedTag: 'has_captcha',
      matchesItem: (candidate) =>
        itemSearchText(candidate).toLowerCase().includes(captchaKind)
        || (sourceCategory !== null && candidate.category === sourceCategory),
    }
  }

  return undefined
}

export class PublishSessionGuard {
  private readonly itemsById = new Map<number, { batchId: number; item: BacklinkBatchItem }>()
  private readonly batchItems = new Map<number, Map<number, BacklinkBatchItem>>()
  private readonly breakers = new Map<string, BreakerEntry>()
  private readonly activeBadges = new Map<string, ActiveBadgeRecord>()

  constructor(private readonly threshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD) {}

  recordBatchDetail(detail: BacklinkBatchDetail): void {
    const map = new Map<number, BacklinkBatchItem>()
    for (const item of detail.items) {
      const copy = { ...item }
      map.set(item.id, copy)
      this.itemsById.set(item.id, { batchId: detail.batch.id, item: copy })
    }
    this.batchItems.set(detail.batch.id, map)
  }

  recordClaimedItems(batchId: number, items: readonly BacklinkBatchItem[]): void {
    let map = this.batchItems.get(batchId)
    if (!map) {
      map = new Map<number, BacklinkBatchItem>()
      this.batchItems.set(batchId, map)
    }
    for (const item of items) {
      const copy = { ...item }
      map.set(item.id, copy)
      this.itemsById.set(item.id, { batchId, item: copy })
    }
  }

  markItemTerminal(itemId: number, terminalStatus = 'executed'): void {
    const cached = this.itemsById.get(itemId)
    if (!cached) return
    const updated: BacklinkBatchItem = { ...cached.item, status: terminalStatus }
    this.itemsById.set(itemId, { batchId: cached.batchId, item: updated })
    this.batchItems.get(cached.batchId)?.set(itemId, updated)
  }

  recordItemResult(input: {
    readonly itemId: number
    readonly status: BacklinkItemResult['status']
    readonly failureReason?: string
    readonly skipReason?: string
    readonly evidence?: string
    readonly templateSignature?: string
  }): CircuitBreakerAlert | undefined {
    const cached = this.itemsById.get(input.itemId)
    const scopeKey = cached ? String(cached.batchId) : 'session'
    this.markItemTerminal(
      input.itemId,
      input.status === 'live' || input.status === 'submitted' ? 'executed' : input.status,
    )

    if (input.status === 'live' || input.status === 'submitted') {
      const explicit = input.templateSignature?.trim().toLowerCase()
      for (const breaker of this.breakers.values()) {
        if (breaker.scopeKey !== scopeKey) continue
        const matchesExplicit = explicit !== undefined && explicit.length > 0 && breaker.fingerprint === explicit
        const matchesItem = cached !== undefined && breaker.matchesItem(cached.item)
        if (matchesExplicit || matchesItem) {
          breaker.consecutiveFailures = 0
          breaker.failedItemIds = []
          breaker.tripped = false
        }
      }
      return undefined
    }

    const shouldTrack = input.status === 'failed'
      || (input.status === 'skipped' && input.templateSignature !== undefined && input.templateSignature.trim().length > 0)
    if (!shouldTrack) return undefined

    const derived = deriveTemplateFingerprint({
      ...(cached === undefined ? {} : { item: cached.item }),
      status: input.status,
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.templateSignature === undefined ? {} : { templateSignature: input.templateSignature }),
    })
    if (derived === undefined) return undefined

    const key = `${scopeKey}::${derived.fingerprint}`
    let breaker = this.breakers.get(key)
    if (!breaker) {
      breaker = {
        scopeKey,
        fingerprint: derived.fingerprint,
        ...(derived.suggestedTag === undefined ? {} : { suggestedTag: derived.suggestedTag }),
        matchesItem: derived.matchesItem,
        consecutiveFailures: 0,
        failedItemIds: [],
        tripped: false,
      }
      this.breakers.set(key, breaker)
    } else {
      breaker.matchesItem = derived.matchesItem
    }

    breaker.consecutiveFailures += 1
    if (breaker.failedItemIds[breaker.failedItemIds.length - 1] !== input.itemId) {
      breaker.failedItemIds.push(input.itemId)
    }

    if (breaker.consecutiveFailures < this.threshold) {
      return undefined
    }

    breaker.tripped = true
    const affectedPendingItemIds = cached === undefined
      ? []
      : this.findMatchingPendingItemIds(cached.batchId, input.itemId, breaker.matchesItem)

    return {
      tripped: true,
      fingerprint: breaker.fingerprint,
      consecutiveFailures: breaker.consecutiveFailures,
      threshold: this.threshold,
      failedItemIds: [...breaker.failedItemIds],
      ...(breaker.suggestedTag === undefined ? {} : { suggestedTag: breaker.suggestedTag }),
      ...(affectedPendingItemIds.length > 0 ? { affectedPendingItemIds } : {}),
      action: BREAKER_ACTION_MESSAGE,
    }
  }

  getClaimAlerts(batchId: number, claimedItems: readonly BacklinkBatchItem[]): readonly CircuitBreakerAlert[] {
    const scopeKey = String(batchId)
    const alerts: CircuitBreakerAlert[] = []
    for (const breaker of this.breakers.values()) {
      if (breaker.scopeKey !== scopeKey || !breaker.tripped) continue
      const matchingClaimed = claimedItems
        .filter(item => breaker.matchesItem(item))
        .map(item => item.id)
      if (matchingClaimed.length === 0) continue
      alerts.push({
        tripped: true,
        fingerprint: breaker.fingerprint,
        consecutiveFailures: breaker.consecutiveFailures,
        threshold: this.threshold,
        failedItemIds: [...breaker.failedItemIds],
        ...(breaker.suggestedTag === undefined ? {} : { suggestedTag: breaker.suggestedTag }),
        affectedPendingItemIds: matchingClaimed,
        action: BREAKER_ACTION_MESSAGE,
      })
    }
    return alerts
  }

  recordBadgeAdded(badge: ActiveBadgeRecord): void {
    this.activeBadges.set(`${badge.websiteId}:${badge.badgeId}`, badge)
  }

  recordBadgeDeactivated(criteria: {
    readonly websiteId?: number
    readonly badgeId?: number
    readonly name?: string
    readonly html?: string
  }): void {
    if (criteria.badgeId !== undefined) {
      if (criteria.websiteId !== undefined) {
        this.activeBadges.delete(`${criteria.websiteId}:${criteria.badgeId}`)
        return
      }
      for (const [key, badge] of this.activeBadges.entries()) {
        if (badge.badgeId === criteria.badgeId) {
          this.activeBadges.delete(key)
        }
      }
      return
    }
    const cleanName = criteria.name?.trim().toLowerCase()
    const cleanHtml = criteria.html?.trim().toLowerCase()
    for (const [key, badge] of this.activeBadges.entries()) {
      if (criteria.websiteId !== undefined && badge.websiteId !== criteria.websiteId) continue
      const matchName = cleanName !== undefined && cleanName.length > 0 && badge.name.trim().toLowerCase() === cleanName
      const matchHtml = cleanHtml !== undefined && cleanHtml.length > 0 && badge.html.trim().toLowerCase() === cleanHtml
      if (matchName || matchHtml) {
        this.activeBadges.delete(key)
      }
    }
  }

  findActiveBadgeForItem(itemId: number, contextText = ''): BadgeRollbackReminder | undefined {
    if (this.activeBadges.size === 0) return undefined
    const cached = this.itemsById.get(itemId)
    if (cached !== undefined) {
      const hostNeedle = cached.item.sourceHost.trim().toLowerCase().replace(/^www\./u, '')
      const nameNeedle = cached.item.sourceName.trim().toLowerCase()
      for (const badge of this.activeBadges.values()) {
        const badgeText = `${badge.name}\n${badge.html}`.toLowerCase()
        const hostHit = hostNeedle.length > 0 && badgeText.includes(hostNeedle)
        const nameHit = nameNeedle.length >= 3 && badgeText.includes(nameNeedle)
        if (hostHit || nameHit) {
          return {
            badgeId: badge.badgeId,
            websiteId: badge.websiteId,
            name: badge.name,
            action: `Call backlinks action="badge_deactivate" (websiteId=${badge.websiteId}, badgeId=${badge.badgeId}) immediately so no orphaned reciprocal badge remains on the promoted site.`,
          }
        }
      }
      return undefined
    }

    if (contextText.trim().length > 0 && /(badge|徽标|反链)/iu.test(contextText)) {
      const first = this.activeBadges.values().next().value
      if (first !== undefined) {
        return {
          badgeId: first.badgeId,
          websiteId: first.websiteId,
          name: first.name,
          action: `Call backlinks action="badge_deactivate" (websiteId=${first.websiteId}, badgeId=${first.badgeId}) immediately so no orphaned reciprocal badge remains on the promoted site.`,
        }
      }
    }
    return undefined
  }

  private findMatchingPendingItemIds(
    batchId: number,
    excludeItemId: number,
    matcher: (candidate: BacklinkBatchItem) => boolean,
  ): readonly number[] {
    const map = this.batchItems.get(batchId)
    if (!map) return []
    const ids: number[] = []
    for (const candidate of map.values()) {
      if (candidate.id === excludeItemId) continue
      if (candidate.status !== 'pending') continue
      if (matcher(candidate)) {
        ids.push(candidate.id)
      }
    }
    return ids
  }
}
