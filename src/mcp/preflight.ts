/**
 * Zero-LLM concurrent HTTP preflight & standard blocking-tag filter for
 * `backlinks action="batch_preflight"`.
 */

import { BacklinksError } from '../host/backlinks/types.ts'
import type {
  BacklinkBatchDetail,
  BacklinkBatchItem,
  BacklinkBatchSourceProvider,
  BacklinkPreflightSkipItem,
} from '../host/backlinks/types.ts'
import {
  DEFAULT_PREFLIGHT_CONCURRENCY,
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  matchBlockingTags,
} from '../host/backlinks/standards.ts'
import { collectPublishedSourceIds, isPublishedItem } from '../host/backlinks/validation.ts'
import type { FetchLike, SleepLike } from './backlinks-tool.ts'

const MAX_PREFLIGHT_BODY_BYTES = 32_768
const RETRY_5XX_DELAY_MS = 200

const PARKING_HOST_SUFFIXES = [
  'sedoparking.com',
  'dan.com',
  'afternic.com',
  'hugedomains.com',
  'bodis.com',
  'parkingcrew.net',
  'sav.com',
  'above.com',
  'undeveloped.com',
] as const

const STRONG_DEAD_BODY_PATTERN = new RegExp(
  [
    'vercel deployment paused',
    'this deployment is temporarily paused',
    'this deployment has been disabled',
    'suspendedpage\\.cgi',
    "there isn't a github pages site here",
    'heroku \\| no such app',
    'this account has been suspended',
    'website has been suspended',
    'site has been suspended',
    'netlify site not found',
  ].join('|'),
  'iu',
)

const SHORT_OR_HEADER_DEAD_PATTERN = new RegExp(
  [
    'account suspended',
    'domain for sale',
    'this domain is for sale',
    'buy this domain',
    'domain has expired',
    'this domain name has expired',
    'domain parking',
    'parked free, courtesy of',
  ].join('|'),
  'iu',
)

const DNS_ERROR_PATTERN = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|ERR_NAME_NOT_RESOLVED|getaddrinfo|NXDOMAIN/iu
const TLS_ERROR_PATTERN = new RegExp(
  [
    'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
    'ERR_TLS_',
    'ERR_SSL_',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HOSTNAME_MISMATCH',
    'EPROTO',
    'sslv3 alert',
    'tlsv1 alert',
    'wrong version number',
    'self-signed certificate',
    'certificate has expired',
  ].join('|'),
  'iu',
)
const CONNECTION_ERROR_PATTERN = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|socket hang up|ECONNABORTED/iu
const TIMEOUT_ERROR_PATTERN = /TimeoutError|AbortError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT|ERR_TIMED_OUT|timed out/iu

export type PreflightDeadReason =
  | 'invalid_url'
  | 'http_404'
  | 'http_410'
  | 'http_5xx_persistent'
  | 'dns_error'
  | 'tls_error'
  | 'connection_error'
  | 'parked_or_suspended'

export type PreflightRetryableReason = 'timeout' | 'http_408' | 'http_429' | 'network_error'

export type WafProvider = 'cloudfront' | 'cloudflare' | 'waf'

export interface PreflightTaggedBlockedItem {
  readonly id: number
  readonly sourceId: number
  readonly host: string
  readonly matchedTags: readonly string[]
}

export interface PreflightCautionItem {
  readonly id: number
  readonly sourceId: number
  readonly host: string
  readonly tags: readonly string[]
}

export interface PreflightDeadItem {
  readonly id: number
  readonly sourceId: number
  readonly host: string
  readonly url: string
  readonly reason: PreflightDeadReason
  readonly httpStatus?: number
  readonly detail?: string
}

export interface PreflightWafItem {
  readonly id: number
  readonly sourceId: number
  readonly host: string
  readonly url: string
  readonly httpStatus: 403
  readonly provider: WafProvider
}

export interface PreflightRetryableItem {
  readonly id: number
  readonly sourceId: number
  readonly host: string
  readonly url: string
  readonly reason: PreflightRetryableReason
  readonly httpStatus?: number
  readonly detail?: string
}

export interface PreflightAutoSkipError {
  readonly itemId: number
  readonly error: string
}

export interface BatchPreflightOptions {
  readonly timeoutMs?: number
  readonly concurrency?: number
  readonly autoSkip?: boolean
  readonly autoSkipTagged?: boolean
  readonly skipTags?: readonly string[]
  readonly retry5xx?: number
  readonly itemIds?: readonly number[]
  readonly fetchImpl: FetchLike
  readonly sleepImpl: SleepLike
}

export interface BatchPreflightResult {
  readonly summary: string
  readonly skippedDeadItemIds: readonly number[]
  readonly skippedTaggedItemIds: readonly number[]
  readonly data: {
    readonly batchId: number
    readonly batchName: string
    readonly counts: {
      readonly totalItems: number
      readonly pendingItems: number
      readonly considered: number
      readonly alreadyPublished: number
      readonly taggedBlocked: number
      readonly probed: number
      readonly runnable: number
      readonly dead: number
      readonly wafBlocked: number
      readonly retryable: number
      readonly autoSkipped: number
    }
    readonly publishedSourceIds: readonly number[]
    readonly runnableItemIds: readonly number[]
    readonly cautionItems?: readonly PreflightCautionItem[]
    readonly taggedBlocked?: readonly PreflightTaggedBlockedItem[]
    readonly deadItems?: readonly PreflightDeadItem[]
    readonly wafBlocked?: readonly PreflightWafItem[]
    readonly retryableItems?: readonly PreflightRetryableItem[]
    readonly alreadyPublishedItemIds?: readonly number[]
    readonly autoSkipResult?: {
      readonly mode: 'preflight_skip_api' | 'legacy_fallback'
      readonly skippedItemIds: readonly number[]
      readonly unchangedCount?: number
      readonly taggedSourceIds?: readonly number[]
      readonly downgradeNotice?: string
      readonly errors?: readonly PreflightAutoSkipError[]
    }
  }
}

type ProbeOutcome =
  | { readonly kind: 'alive'; readonly httpStatus: number }
  | { readonly kind: 'dead'; readonly reason: PreflightDeadReason; readonly httpStatus?: number; readonly detail?: string }
  | { readonly kind: 'waf_403'; readonly provider: WafProvider }
  | { readonly kind: 'retryable'; readonly reason: PreflightRetryableReason; readonly httpStatus?: number; readonly detail?: string }

function collectErrorDiagnostics(error: unknown, depth = 0, visited = new Set<unknown>()): string {
  if (error === undefined || error === null || depth > 5 || visited.has(error)) return ''
  visited.add(error)

  if (typeof error !== 'object') {
    return String(error)
  }

  const parts: string[] = []
  const record = error as {
    readonly name?: unknown
    readonly code?: unknown
    readonly errno?: unknown
    readonly message?: unknown
    readonly cause?: unknown
    readonly errors?: unknown
  }

  for (const field of [record.name, record.code, record.errno, record.message]) {
    if (typeof field === 'string' || typeof field === 'number') {
      parts.push(String(field))
    }
  }

  if (record.cause !== undefined) {
    const nested = collectErrorDiagnostics(record.cause, depth + 1, visited)
    if (nested.length > 0) parts.push(nested)
  }
  if (Array.isArray(record.errors)) {
    for (const sub of record.errors) {
      const nested = collectErrorDiagnostics(sub, depth + 1, visited)
      if (nested.length > 0) parts.push(nested)
    }
  }

  return parts.join(' | ')
}

function classifyFetchError(error: unknown, timedOut: boolean): ProbeOutcome {
  const diag = collectErrorDiagnostics(error)
  if (timedOut || TIMEOUT_ERROR_PATTERN.test(diag)) {
    return { kind: 'retryable', reason: 'timeout', detail: diag.slice(0, 140) || 'request timed out' }
  }
  if (DNS_ERROR_PATTERN.test(diag)) {
    return { kind: 'dead', reason: 'dns_error', detail: diag.slice(0, 140) }
  }
  if (TLS_ERROR_PATTERN.test(diag)) {
    return { kind: 'dead', reason: 'tls_error', detail: diag.slice(0, 140) }
  }
  if (CONNECTION_ERROR_PATTERN.test(diag)) {
    return { kind: 'dead', reason: 'connection_error', detail: diag.slice(0, 140) }
  }
  return { kind: 'retryable', reason: 'network_error', detail: diag.slice(0, 140) || 'network error' }
}

async function readBoundedBodyText(response: Response, maxBytes = MAX_PREFLIGHT_BODY_BYTES): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (
    contentType.length > 0
    && !/(text\/|application\/(xhtml|xml|json)|javascript)/iu.test(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined)
    return ''
  }

  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done || value === undefined) break
        const remaining = maxBytes - total
        const slice = value.byteLength <= remaining ? value : value.subarray(0, remaining)
        chunks.push(slice)
        total += slice.byteLength
        if (total >= maxBytes) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
    } catch {
      // Return whatever prefix was already decoded before stream interruption.
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged)
  }

  try {
    const text = await response.text()
    return text.slice(0, maxBytes)
  } catch {
    return ''
  }
}

function isKnownParkingHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return PARKING_HOST_SUFFIXES.some(suffix => lower === suffix || lower.endsWith(`.${suffix}`))
}

function extractTitleAndH1(html: string): string {
  const parts: string[] = []
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  if (titleMatch?.[1]) parts.push(titleMatch[1])
  const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/giu
  let match: RegExpExecArray | null
  while ((match = h1Regex.exec(html)) !== null) {
    if (match[1]) parts.push(match[1])
  }
  return parts.join(' ').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function detectParkedOrSuspended(finalUrl: string, headers: Headers, body: string): string | undefined {
  const vercelError = headers.get('x-vercel-error') ?? ''
  if (/DEPLOYMENT_(PAUSED|DISABLED|NOT_FOUND)/iu.test(vercelError)) {
    return `x-vercel-error: ${vercelError}`
  }

  if (/suspendedpage\.cgi/iu.test(finalUrl)) {
    return 'redirected to suspendedpage.cgi'
  }
  try {
    const host = new URL(finalUrl).hostname
    if (isKnownParkingHostname(host)) {
      return `parked host ${host}`
    }
  } catch {
    // ignore invalid finalUrl string
  }

  const strongMatch = STRONG_DEAD_BODY_PATTERN.exec(body)
  if (strongMatch) {
    return strongMatch[0]
  }

  const headingText = extractTitleAndH1(body)
  const headingMatch = SHORT_OR_HEADER_DEAD_PATTERN.exec(headingText)
  if (headingMatch) {
    return headingMatch[0]
  }

  if (body.length < 8_000) {
    const shortMatch = SHORT_OR_HEADER_DEAD_PATTERN.exec(body.replace(/<[^>]+>/gu, ' '))
    if (shortMatch) {
      return shortMatch[0]
    }
  }

  return undefined
}

function detectWafProvider(headers: Headers, body: string): WafProvider {
  const server = (headers.get('server') ?? '').toLowerCase()
  const via = (headers.get('via') ?? '').toLowerCase()
  if (
    headers.has('x-amz-cf-id')
    || headers.has('x-amz-cf-pop')
    || server.includes('cloudfront')
    || via.includes('cloudfront')
    || /generated by cloudfront/iu.test(body)
  ) {
    return 'cloudfront'
  }
  if (
    headers.has('cf-ray')
    || headers.has('cf-mitigated')
    || server.includes('cloudflare')
    || /attention required!.*cloudflare|just a moment\.\.\./isu.test(body)
  ) {
    return 'cloudflare'
  }
  return 'waf'
}

async function singleHttpProbe(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  outerSignal?: AbortSignal,
): Promise<{ readonly response?: Response; readonly body?: string; readonly errorOutcome?: ProbeOutcome }> {
  if (outerSignal?.aborted) {
    throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onOuterAbort = () => {
    controller.abort()
  }
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; backlinks-preflight/1.0)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    })
    const body = await readBoundedBodyText(response, MAX_PREFLIGHT_BODY_BYTES)
    return { response, body }
  } catch (error) {
    if (outerSignal?.aborted) {
      throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
    }
    return { errorOutcome: classifyFetchError(error, timedOut) }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

async function probeItemUrl(
  url: string,
  timeoutMs: number,
  retry5xx: number,
  fetchImpl: FetchLike,
  sleepImpl: SleepLike,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  let parsed: URL
  try {
    parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    return { kind: 'dead', reason: 'invalid_url', detail: `invalid URL "${url}"` }
  }

  for (let attempt = 0; attempt <= retry5xx; attempt++) {
    const attemptResult = await singleHttpProbe(parsed.toString(), timeoutMs, fetchImpl, signal)
    if (attemptResult.errorOutcome !== undefined) {
      return attemptResult.errorOutcome
    }

    const response = attemptResult.response as Response
    const body = attemptResult.body ?? ''
    const finalUrl = response.url || parsed.toString()

    const parkedReason = detectParkedOrSuspended(finalUrl, response.headers, body)
    if (parkedReason !== undefined) {
      return {
        kind: 'dead',
        reason: 'parked_or_suspended',
        httpStatus: response.status,
        detail: parkedReason,
      }
    }

    if (response.status === 404) {
      return { kind: 'dead', reason: 'http_404', httpStatus: 404 }
    }
    if (response.status === 410) {
      return { kind: 'dead', reason: 'http_410', httpStatus: 410 }
    }
    if (response.status >= 500 && response.status <= 599) {
      if (attempt < retry5xx) {
        await sleepImpl(RETRY_5XX_DELAY_MS, signal)
        continue
      }
      return {
        kind: 'dead',
        reason: 'http_5xx_persistent',
        httpStatus: response.status,
      }
    }
    if (response.status === 403) {
      return {
        kind: 'waf_403',
        provider: detectWafProvider(response.headers, body),
      }
    }
    if (response.status === 408) {
      return { kind: 'retryable', reason: 'http_408', httpStatus: 408 }
    }
    if (response.status === 429) {
      return { kind: 'retryable', reason: 'http_429', httpStatus: 429 }
    }
    return { kind: 'alive', httpStatus: response.status }
  }

  return { kind: 'retryable', reason: 'network_error', detail: 'probe exhausted' }
}

interface AutoSkipEntry {
  readonly itemId: number
  readonly sourceId: number
  readonly skipReason: string
  readonly kind: 'dead' | 'tagged'
}

const PREFLIGHT_SKIP_CHUNK_SIZE = 100

function isLeaseRequiredError(error: unknown): boolean {
  if (!(error instanceof BacklinksError)) return false
  return (
    error.code === 'BACKLINKS_CONFLICT'
    || error.code === 'BACKLINKS_INVALID_REQUEST'
    || /lease/iu.test(error.message)
  )
}

function isUnsupportedEndpointError(error: unknown): boolean {
  if (!(error instanceof BacklinksError)) return false
  return (
    error.code === 'BACKLINKS_NOT_FOUND'
    || (error.code === 'BACKLINKS_API_ERROR' && error.message.includes('HTTP 405'))
  )
}

interface LegacyAutoSkipOutcome {
  readonly skippedDeadItemIds: readonly number[]
  readonly skippedTaggedItemIds: readonly number[]
  readonly taggedSourceIds: readonly number[]
  readonly errors: readonly PreflightAutoSkipError[]
}

async function applyLegacyAutoSkips(
  batchSource: BacklinkBatchSourceProvider,
  batchId: number,
  entries: readonly AutoSkipEntry[],
  signal?: AbortSignal,
): Promise<LegacyAutoSkipOutcome> {
  if (entries.length === 0) {
    return { skippedDeadItemIds: [], skippedTaggedItemIds: [], taggedSourceIds: [], errors: [] }
  }

  const skippedDeadItemIds: number[] = []
  const skippedTaggedItemIds: number[] = []
  const deadSourceIds = new Set<number>()
  const taggedSourceIds: number[] = []
  const errors: PreflightAutoSkipError[] = []

  const recordSkipSuccess = (entry: AutoSkipEntry) => {
    if (entry.kind === 'dead') {
      skippedDeadItemIds.push(entry.itemId)
      deadSourceIds.add(entry.sourceId)
    } else {
      skippedTaggedItemIds.push(entry.itemId)
    }
  }

  let startLeaseAt: number | undefined
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    try {
      await batchSource.reportItemResult(entry.itemId, { status: 'skipped', skipReason: entry.skipReason }, signal)
      recordSkipSuccess(entry)
    } catch (error) {
      if (signal?.aborted) throw error
      if (isLeaseRequiredError(error)) {
        startLeaseAt = i
        break
      }
      errors.push({
        itemId: entry.itemId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (startLeaseAt !== undefined) {
    const remaining = entries.slice(startLeaseAt)
    const remainingIds = remaining.map(entry => entry.itemId)
    let leaseId: number | undefined
    try {
      const claim = await batchSource.claim(batchId, remainingIds, signal)
      leaseId = claim.leaseId
      const claimedIds = new Set(claim.items.map(item => item.id))
      for (const entry of remaining) {
        if (claimedIds.size > 0 && !claimedIds.has(entry.itemId)) {
          errors.push({ itemId: entry.itemId, error: 'item was not included in ephemeral preflight lease' })
          continue
        }
        try {
          await batchSource.reportItemResult(entry.itemId, { status: 'skipped', skipReason: entry.skipReason }, signal)
          recordSkipSuccess(entry)
        } catch (error) {
          if (signal?.aborted) throw error
          errors.push({
            itemId: entry.itemId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      for (const entry of remaining) {
        errors.push({ itemId: entry.itemId, error: `ephemeral claim failed: ${message}` })
      }
    } finally {
      if (leaseId !== undefined) {
        await batchSource.release(leaseId, signal).catch(() => undefined)
      }
    }
  }

  for (const sourceId of deadSourceIds) {
    try {
      await batchSource.tagSource(sourceId, ['dead_site'], signal)
      taggedSourceIds.push(sourceId)
    } catch (error) {
      if (signal?.aborted) throw error
      const relatedItem = entries.find(entry => entry.kind === 'dead' && entry.sourceId === sourceId)
      errors.push({
        itemId: relatedItem?.itemId ?? sourceId,
        error: `tagSource dead_site failed for source ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return { skippedDeadItemIds, skippedTaggedItemIds, taggedSourceIds, errors }
}

async function applyAutoSkips(
  batchSource: BacklinkBatchSourceProvider,
  batchId: number,
  entries: readonly AutoSkipEntry[],
  signal?: AbortSignal,
): Promise<{
  readonly mode: 'preflight_skip_api' | 'legacy_fallback'
  readonly skippedDeadItemIds: readonly number[]
  readonly skippedTaggedItemIds: readonly number[]
  readonly unchangedCount: number
  readonly taggedSourceIds: readonly number[]
  readonly downgradeNotice?: string
  readonly errors: readonly PreflightAutoSkipError[]
}> {
  if (entries.length === 0) {
    return {
      mode: batchSource.preflightSkip ? 'preflight_skip_api' : 'legacy_fallback',
      skippedDeadItemIds: [],
      skippedTaggedItemIds: [],
      unchangedCount: 0,
      taggedSourceIds: [],
      errors: [],
    }
  }

  if (typeof batchSource.preflightSkip === 'function') {
    const skippedDeadItemIds: number[] = []
    const skippedTaggedItemIds: number[] = []
    const taggedSourceIds = new Set<number>()
    const errors: PreflightAutoSkipError[] = []
    let unchangedCount = 0

    for (let offset = 0; offset < entries.length; offset += PREFLIGHT_SKIP_CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + PREFLIGHT_SKIP_CHUNK_SIZE)
      const payload: BacklinkPreflightSkipItem[] = chunk.map(entry => ({
        itemId: entry.itemId,
        skipReason: entry.skipReason,
        ...(entry.kind === 'dead' ? { tags: ['dead_site'] } : {}),
      }))
      try {
        const res = await batchSource.preflightSkip(batchId, payload, signal)
        unchangedCount += res.unchangedCount
        const entryById = new Map(chunk.map(entry => [entry.itemId, entry]))
        if (res.results.length > 0) {
          for (const itemRes of res.results) {
            const matched = entryById.get(itemRes.itemId)
            if (itemRes.itemStatus === 'skipped' && itemRes.changed) {
              if (matched?.kind === 'dead') skippedDeadItemIds.push(itemRes.itemId)
              else skippedTaggedItemIds.push(itemRes.itemId)
            }
            if (itemRes.attachedTags.length > 0) {
              taggedSourceIds.add(itemRes.sourceId)
            }
          }
        } else {
          for (const entry of chunk) {
            if (entry.kind === 'dead') {
              skippedDeadItemIds.push(entry.itemId)
              taggedSourceIds.add(entry.sourceId)
            } else {
              skippedTaggedItemIds.push(entry.itemId)
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (isUnsupportedEndpointError(error)) {
          const fallback = await applyLegacyAutoSkips(batchSource, batchId, entries.slice(offset), signal)
          for (const id of fallback.skippedDeadItemIds) skippedDeadItemIds.push(id)
          for (const id of fallback.skippedTaggedItemIds) skippedTaggedItemIds.push(id)
          for (const sid of fallback.taggedSourceIds) taggedSourceIds.add(sid)
          for (const err of fallback.errors) errors.push(err)
          return {
            mode: 'legacy_fallback',
            skippedDeadItemIds,
            skippedTaggedItemIds,
            unchangedCount,
            taggedSourceIds: [...taggedSourceIds],
            downgradeNotice: 'Supermanager returned 404/405 for /preflight-skip; downgraded to legacy item_result/ephemeral lease flow.',
            errors,
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        for (const entry of chunk) {
          errors.push({ itemId: entry.itemId, error: message })
        }
        if (error instanceof BacklinksError && error.code === 'BACKLINKS_CONFLICT') {
          for (const entry of entries.slice(offset + PREFLIGHT_SKIP_CHUNK_SIZE)) {
            errors.push({ itemId: entry.itemId, error: message })
          }
          break
        }
      }
    }

    return {
      mode: 'preflight_skip_api',
      skippedDeadItemIds,
      skippedTaggedItemIds,
      unchangedCount,
      taggedSourceIds: [...taggedSourceIds],
      errors,
    }
  }

  const legacy = await applyLegacyAutoSkips(batchSource, batchId, entries, signal)
  return {
    mode: 'legacy_fallback',
    skippedDeadItemIds: legacy.skippedDeadItemIds,
    skippedTaggedItemIds: legacy.skippedTaggedItemIds,
    unchangedCount: 0,
    taggedSourceIds: legacy.taggedSourceIds,
    errors: legacy.errors,
  }
}

function formatDeadSkipReason(dead: PreflightDeadItem): string {
  const details = [dead.reason, ...(dead.httpStatus === undefined ? [] : [`HTTP ${dead.httpStatus}`])]
  if (dead.detail !== undefined && dead.detail.length > 0 && dead.reason === 'parked_or_suspended') {
    details.push(dead.detail.slice(0, 60))
  }
  return `预检不可用(${details.join(', ')})`
}

export async function runBatchPreflight(
  batchSource: BacklinkBatchSourceProvider,
  detail: BacklinkBatchDetail,
  options: BatchPreflightOptions,
  signal?: AbortSignal,
): Promise<BatchPreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS
  const concurrency = options.concurrency ?? DEFAULT_PREFLIGHT_CONCURRENCY
  const autoSkip = options.autoSkip === true
  const autoSkipTagged = options.autoSkipTagged === true
  const retry5xx = options.retry5xx ?? 1

  const publishedSourceIds = collectPublishedSourceIds(detail.items)
  const publishedSourceSet = new Set(publishedSourceIds)

  const pendingItems = detail.items.filter(item => item.status === 'pending')
  const requestedSet = options.itemIds === undefined ? undefined : new Set(options.itemIds)
  const candidates = requestedSet === undefined
    ? pendingItems
    : pendingItems.filter(item => requestedSet.has(item.id))

  const alreadyPublishedItemIds: number[] = []
  const taggedBlocked: PreflightTaggedBlockedItem[] = []
  const probeQueue: Array<{ readonly item: BacklinkBatchItem; readonly url: string; readonly softTags: readonly string[] }> = []

  for (const item of candidates) {
    if (isPublishedItem(item) || publishedSourceSet.has(item.sourceId)) {
      alreadyPublishedItemIds.push(item.id)
      continue
    }
    const combinedTags = [
      ...item.tags,
      ...(item.sourceTags ?? []),
      ...(item.blockingTags ?? []),
    ]
    const tagMatch = matchBlockingTags(combinedTags, options.skipTags)
    if (tagMatch.matchedSkipTags.length > 0) {
      taggedBlocked.push({
        id: item.id,
        sourceId: item.sourceId,
        host: item.sourceHost,
        matchedTags: tagMatch.matchedSkipTags,
      })
      continue
    }
    const targetUrl = item.submitUrl !== null && item.submitUrl.trim().length > 0
      ? item.submitUrl.trim()
      : item.sourceUrl.trim()
    probeQueue.push({ item, url: targetUrl, softTags: tagMatch.soft })
  }

  const probeOutcomes = new Array<ProbeOutcome>(probeQueue.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, probeQueue.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal?.aborted) {
          throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
        }
        const index = nextIndex++
        if (index >= probeQueue.length) break
        const target = probeQueue[index]!
        probeOutcomes[index] = await probeItemUrl(
          target.url,
          timeoutMs,
          retry5xx,
          options.fetchImpl,
          options.sleepImpl,
          signal,
        )
      }
    }),
  )

  const runnableItemIds: number[] = []
  const cautionItems: PreflightCautionItem[] = []
  const deadItems: PreflightDeadItem[] = []
  const wafBlocked: PreflightWafItem[] = []
  const retryableItems: PreflightRetryableItem[] = []

  for (let i = 0; i < probeQueue.length; i++) {
    const { item, url, softTags } = probeQueue[i]!
    const outcome = probeOutcomes[i]!
    switch (outcome.kind) {
      case 'alive':
        runnableItemIds.push(item.id)
        if (softTags.length > 0) {
          cautionItems.push({
            id: item.id,
            sourceId: item.sourceId,
            host: item.sourceHost,
            tags: softTags,
          })
        }
        break
      case 'dead':
        deadItems.push({
          id: item.id,
          sourceId: item.sourceId,
          host: item.sourceHost,
          url,
          reason: outcome.reason,
          ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        })
        break
      case 'waf_403':
        wafBlocked.push({
          id: item.id,
          sourceId: item.sourceId,
          host: item.sourceHost,
          url,
          httpStatus: 403,
          provider: outcome.provider,
        })
        break
      case 'retryable':
        retryableItems.push({
          id: item.id,
          sourceId: item.sourceId,
          host: item.sourceHost,
          url,
          reason: outcome.reason,
          ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        })
        break
    }
  }

  const autoSkipEntries: AutoSkipEntry[] = []
  if (autoSkip) {
    for (const dead of deadItems) {
      autoSkipEntries.push({
        itemId: dead.id,
        sourceId: dead.sourceId,
        skipReason: formatDeadSkipReason(dead),
        kind: 'dead',
      })
    }
  }
  if (autoSkipTagged) {
    for (const tagged of taggedBlocked) {
      autoSkipEntries.push({
        itemId: tagged.id,
        sourceId: tagged.sourceId,
        skipReason: `预检命中已有硬阻断标签: ${tagged.matchedTags.join(', ')}`,
        kind: 'tagged',
      })
    }
  }

  const skipEffect = await applyAutoSkips(batchSource, detail.batch.id, autoSkipEntries, signal)
  const totalAutoSkipped = skipEffect.skippedDeadItemIds.length + skipEffect.skippedTaggedItemIds.length
  const combinedSkippedIds = [...skipEffect.skippedDeadItemIds, ...skipEffect.skippedTaggedItemIds]

  const summary = `preflight batch ${detail.batch.id}: ${runnableItemIds.length} runnable, ${deadItems.length} dead, ${taggedBlocked.length} tagged-blocked, ${wafBlocked.length} waf_403, ${retryableItems.length} retryable (auto-skipped ${totalAutoSkipped})`

  return {
    summary,
    skippedDeadItemIds: skipEffect.skippedDeadItemIds,
    skippedTaggedItemIds: skipEffect.skippedTaggedItemIds,
    data: {
      batchId: detail.batch.id,
      batchName: detail.batch.name,
      counts: {
        totalItems: detail.items.length,
        pendingItems: pendingItems.length,
        considered: candidates.length,
        alreadyPublished: alreadyPublishedItemIds.length,
        taggedBlocked: taggedBlocked.length,
        probed: probeQueue.length,
        runnable: runnableItemIds.length,
        dead: deadItems.length,
        wafBlocked: wafBlocked.length,
        retryable: retryableItems.length,
        autoSkipped: totalAutoSkipped,
      },
      publishedSourceIds,
      runnableItemIds,
      ...(cautionItems.length > 0 ? { cautionItems } : {}),
      ...(taggedBlocked.length > 0 ? { taggedBlocked } : {}),
      ...(deadItems.length > 0 ? { deadItems } : {}),
      ...(wafBlocked.length > 0 ? { wafBlocked } : {}),
      ...(retryableItems.length > 0 ? { retryableItems } : {}),
      ...(alreadyPublishedItemIds.length > 0 ? { alreadyPublishedItemIds } : {}),
      ...(autoSkip || autoSkipTagged
        ? {
            autoSkipResult: {
              mode: skipEffect.mode,
              skippedItemIds: combinedSkippedIds,
              ...(skipEffect.unchangedCount > 0 ? { unchangedCount: skipEffect.unchangedCount } : {}),
              ...(skipEffect.taggedSourceIds.length > 0 ? { taggedSourceIds: skipEffect.taggedSourceIds } : {}),
              ...(skipEffect.downgradeNotice === undefined ? {} : { downgradeNotice: skipEffect.downgradeNotice }),
              ...(skipEffect.errors.length > 0 ? { errors: skipEffect.errors } : {}),
            },
          }
        : {}),
    },
  }
}
