/**
 * The supermanager implementation of the batch work-source seam (`/api/agent/*`).
 */

import type {
  BacklinkBadgeDeactivateInput,
  BacklinkBadgeDeactivateResult,
  BacklinkBadgeInput,
  BacklinkBadgeResult,
  BacklinkBatchDetail,
  BacklinkBatchItem,
  BacklinkBatchSourceProvider,
  BacklinkBatchSummary,
  BacklinkHeartbeat,
  BacklinkItemOutcome,
  BacklinkItemResult,
  BacklinkLeaseClaim,
  BacklinkPreflightSkipItem,
  BacklinkPreflightSkipItemResult,
  BacklinkPreflightSkipResult,
  BacklinkTagResult,
  BacklinkWebsiteAnchor,
} from '../backlinks/types.ts'
import {
  isSupermanager5xxError,
  mapTagsForSupermanagerWire,
  mapTagsToSafeChineseFallback,
} from '../backlinks/standards.ts'
import { BacklinksError } from '../backlinks/types.ts'

export const SUPERMANAGER_BATCH_SOURCE_ID = 'supermanager'

export interface ResolvedSupermanagerConfig {
  readonly baseUrl: string
  readonly token: string
  readonly requestTimeoutMs: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNumber(value: unknown): number {
  return Number(value)
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toCounts(value: Record<string, unknown>): BacklinkBatchSummary['counts'] {
  const counts = asRecord(value)
  return {
    pending: toNumber(counts.pending),
    executed: toNumber(counts.executed),
    skipped: toNumber(counts.skipped),
    failed: toNumber(counts.failed),
    total: toNumber(counts.total),
  }
}

function profileField(
  source: Record<string, unknown>,
  field: 'shortDescription' | 'longDescription' | 'logoUrl' | 'screenshotUrl' | 'keyFeatures' | 'pricingType',
): { [key: string]: string } {
  const value = source[field]
  return typeof value === 'string' && value.length > 0 ? { [field]: value } : {}
}

function toBatchSummary(value: unknown): BacklinkBatchSummary {
  const row = asRecord(value)
  return {
    id: toNumber(row.id),
    name: str(row.name),
    websiteId: toNumber(row.websiteId),
    websiteName: str(row.websiteName),
    websiteHost: str(row.websiteHost),
    plannedAt: str(row.plannedAt),
    counts: toCounts(asRecord(row.counts)),
    executing: row.executing === true,
  }
}

function extractTagNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    let text = ''
    if (typeof entry === 'string') {
      text = entry.trim()
    } else if (typeof entry === 'object' && entry !== null) {
      const name = (entry as { name?: unknown }).name
      if (typeof name === 'string') text = name.trim()
    }
    if (text.length > 0 && !seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
  }
  return out
}

function mergeTagLists(...lists: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const tag of list) {
      if (!seen.has(tag)) {
        seen.add(tag)
        out.push(tag)
      }
    }
  }
  return out
}

function toItem(value: unknown): BacklinkBatchItem {
  const row = asRecord(value)
  const rawTags = extractTagNames(row.tags)
  const rawSourceTags = extractTagNames(row.sourceTags)
  const rawBlockingTags = extractTagNames(row.blockingTags)
  return {
    id: toNumber(row.id),
    sourceId: toNumber(row.sourceId),
    sourceName: str(row.sourceName),
    sourceUrl: str(row.sourceUrl),
    sourceHost: str(row.sourceHost),
    submitUrl: toNullableString(row.submitUrl),
    sourceNotes: toNullableString(row.sourceNotes),
    category: toNullableString(row.category),
    tags: mergeTagLists(rawTags, rawSourceTags),
    ...(Array.isArray(row.sourceTags) ? { sourceTags: rawSourceTags } : {}),
    ...(Array.isArray(row.blockingTags) ? { blockingTags: rawBlockingTags } : {}),
    paymentType: str(row.paymentType),
    linkType: str(row.linkType),
    status: str(row.status),
    failureMode: toNullableString(row.failureMode),
    failureReason: toNullableString(row.failureReason),
    publishedUrl: toNullableString(row.publishedUrl),
    publishStatus: toNullableString(row.publishStatus),
    plannedAt: str(row.plannedAt),
  }
}

function toAnchor(value: unknown): BacklinkWebsiteAnchor {
  const row = asRecord(value)
  return {
    id: toNumber(row.id),
    anchorText: String(row.anchorText),
    targetUrl: String(row.targetUrl),
  }
}

function toDetail(value: Record<string, unknown>): BacklinkBatchDetail {
  const website = asRecord(value.website)
  return {
    batch: toBatchSummary(value.batch),
    website: {
      id: toNumber(website.id),
      name: String(website.name),
      siteUrl: String(website.siteUrl),
      siteHost: String(website.siteHost),
      ...profileField(website, 'shortDescription'),
      ...profileField(website, 'longDescription'),
      ...profileField(website, 'logoUrl'),
      ...profileField(website, 'screenshotUrl'),
      ...profileField(website, 'keyFeatures'),
      ...profileField(website, 'pricingType'),
    },
    anchors: Array.isArray(value.anchors) ? value.anchors.map(toAnchor) : [],
    items: Array.isArray(value.items) ? value.items.map(toItem) : [],
  }
}

function httpError(path: string, response: Response, bodyText: string): BacklinksError {
  const retryAfter = Number(response.headers.get('retry-after') ?? '')
  const retryAfterSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
  const detail = bodyText.slice(0, 300)
  switch (response.status) {
    case 400:
      return new BacklinksError(`supermanager rejected ${path}: ${detail}`, 'BACKLINKS_INVALID_REQUEST', null)
    case 401:
    case 403:
      return new BacklinksError(`supermanager denied ${path} (${response.status}): ${detail}`, 'BACKLINKS_UNAUTHORIZED')
    case 404:
      return new BacklinksError(`supermanager has no resource for ${path}: ${detail}`, 'BACKLINKS_NOT_FOUND')
    case 409:
      return new BacklinksError(`supermanager conflict on ${path}: ${detail}`, 'BACKLINKS_CONFLICT', retryAfterSeconds)
    default:
      return new BacklinksError(`supermanager ${path} failed (HTTP ${response.status}): ${detail}`, 'BACKLINKS_API_ERROR')
  }
}

export class SupermanagerBatchSource implements BacklinkBatchSourceProvider {
  readonly id = SUPERMANAGER_BATCH_SOURCE_ID

  constructor(private readonly resolveConfig: () => ResolvedSupermanagerConfig) {}

  available(): boolean {
    const { baseUrl, token } = this.resolveConfig()
    return baseUrl.length > 0 && token.length > 0
  }

  async listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]> {
    const body = await this.requestJson('/api/agent/batches', { method: 'GET' }, signal)
    const batches = asRecord(body).batches
    return Array.isArray(batches) ? batches.map(toBatchSummary) : []
  }

  async getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail> {
    const body = await this.requestJson(`/api/agent/batches/${batchId}`, { method: 'GET' }, signal)
    return toDetail(asRecord(body))
  }

  async claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal): Promise<BacklinkLeaseClaim> {
    const payload = itemIds === undefined ? {} : { itemIds: [...itemIds] }
    const body = await this.requestJson(`/api/agent/batches/${batchId}/claim`, { method: 'POST', payload }, signal)
    const record = asRecord(body)
    return {
      leaseId: toNumber(record.leaseId),
      leaseExpiresAt: str(record.leaseExpiresAt),
      items: Array.isArray(record.items) ? record.items.map(toItem) : [],
    }
  }

  async heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat> {
    const body = await this.requestJson(`/api/agent/leases/${leaseId}/heartbeat`, { method: 'POST' }, signal)
    const record = asRecord(body)
    return {
      leaseId: toNumber(record.leaseId),
      leaseExpiresAt: str(record.leaseExpiresAt),
    }
  }

  async release(leaseId: number, signal?: AbortSignal): Promise<void> {
    await this.requestJson(`/api/agent/leases/${leaseId}/release`, { method: 'POST' }, signal)
  }

  async reportItemResult(itemId: number, result: BacklinkItemResult, signal?: AbortSignal): Promise<BacklinkItemOutcome> {
    const body = await this.requestJson(`/api/agent/items/${itemId}/result`, {
      method: 'POST',
      payload: this.resultPayload(result),
    }, signal)
    const record = asRecord(body)
    return {
      itemStatus: str(record.itemStatus) as BacklinkItemOutcome['itemStatus'],
      publishRecordId: record.publishRecordId === undefined || record.publishRecordId === null
        ? null
        : toNumber(record.publishRecordId),
    }
  }

  async addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal): Promise<BacklinkBadgeResult> {
    const body = await this.requestJson(`/api/agent/websites/${websiteId}/footer-backlinks`, {
      method: 'POST',
      payload: {
        name: badge.name,
        html: badge.html,
        ...(badge.isActive === undefined ? {} : { isActive: badge.isActive }),
      },
    }, signal)
    const record = asRecord(body)
    return {
      backlinkId: toNumber(record.backlinkId),
      callbackTriggered: record.callbackTriggered === true,
    }
  }

  async deactivateBadge(
    websiteId: number | undefined,
    input: BacklinkBadgeDeactivateInput,
    signal?: AbortSignal,
  ): Promise<BacklinkBadgeDeactivateResult> {
    const hasBadgeId = input.badgeId !== undefined
    const cleanName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : undefined
    const cleanHtml = typeof input.html === 'string' && input.html.trim().length > 0 ? input.html.trim() : undefined
    if (!hasBadgeId && cleanName === undefined && cleanHtml === undefined) {
      throw new BacklinksError(
        'badge deactivation requires badgeId, name, or html',
        'BACKLINKS_INVALID_REQUEST',
      )
    }
    if (!hasBadgeId && websiteId === undefined) {
      throw new BacklinksError(
        'badge deactivation by name or html requires websiteId',
        'BACKLINKS_INVALID_REQUEST',
      )
    }

    const query = websiteId !== undefined ? `?websiteId=${websiteId}` : ''
    const endpoint = hasBadgeId
      ? `/api/agent/badges/${input.badgeId}${query}`
      : `/api/agent/websites/${websiteId}/footer-backlinks`

    try {
      if (hasBadgeId) {
        if (input.remove === true) {
          const body = await this.requestJson(endpoint, { method: 'DELETE' }, signal)
          const record = asRecord(body)
          const resolvedWebsiteId = record.websiteId !== undefined && record.websiteId !== null
            ? toNumber(record.websiteId)
            : websiteId
          return {
            backlinkId: record.backlinkId !== undefined && record.backlinkId !== null
              ? toNumber(record.backlinkId)
              : (input.badgeId as number),
            ...(resolvedWebsiteId === undefined ? {} : { websiteId: resolvedWebsiteId }),
            isActive: false,
            deleted: record.deleted === undefined ? true : record.deleted === true,
            ...(record.alreadyDeleted === undefined ? {} : { alreadyDeleted: record.alreadyDeleted === true }),
            ...(record.changed === undefined ? {} : { changed: record.changed === true }),
            callbackTriggered: record.callbackTriggered === true,
            strategy: 'delete_by_id',
          }
        }
        const body = await this.requestJson(endpoint, {
          method: 'PATCH',
          payload: {
            isActive: false,
            ...(websiteId === undefined ? {} : { websiteId }),
            ...(cleanName === undefined ? {} : { name: cleanName }),
            ...(cleanHtml === undefined ? {} : { html: cleanHtml }),
            ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          },
        }, signal)
        const record = asRecord(body)
        const resolvedWebsiteId = record.websiteId !== undefined && record.websiteId !== null
          ? toNumber(record.websiteId)
          : websiteId
        return {
          backlinkId: record.backlinkId !== undefined && record.backlinkId !== null
            ? toNumber(record.backlinkId)
            : (input.badgeId as number),
          ...(resolvedWebsiteId === undefined ? {} : { websiteId: resolvedWebsiteId }),
          isActive: false,
          deleted: record.deleted === true,
          ...(record.changed === undefined ? {} : { changed: record.changed === true }),
          callbackTriggered: record.callbackTriggered === true,
          strategy: 'patch_by_id',
        }
      }

      const body = await this.requestJson(endpoint, {
        method: 'PATCH',
        payload: {
          ...(cleanName === undefined ? {} : { name: cleanName }),
          ...(cleanHtml === undefined ? {} : { html: cleanHtml }),
          isActive: false,
          ...(input.remove === true ? { remove: true } : {}),
        },
      }, signal)
      const record = asRecord(body)
      const resolvedWebsiteId = record.websiteId !== undefined && record.websiteId !== null
        ? toNumber(record.websiteId)
        : websiteId
      return {
        backlinkId: record.backlinkId !== undefined && record.backlinkId !== null
          ? toNumber(record.backlinkId)
          : null,
        ...(resolvedWebsiteId === undefined ? {} : { websiteId: resolvedWebsiteId }),
        isActive: false,
        deleted: record.deleted === true || input.remove === true,
        ...(record.alreadyDeleted === undefined ? {} : { alreadyDeleted: record.alreadyDeleted === true }),
        ...(record.changed === undefined ? {} : { changed: record.changed === true }),
        callbackTriggered: record.callbackTriggered === true,
        strategy: 'patch_by_match',
      }
    } catch (error) {
      if (
        error instanceof BacklinksError
        && (error.code === 'BACKLINKS_NOT_FOUND'
          || (error.code === 'BACKLINKS_API_ERROR' && error.message.includes('HTTP 405')))
      ) {
        throw new BacklinksError(
          `${error.message} (Supermanager backend may not yet expose ${input.remove === true && hasBadgeId ? 'DELETE' : 'PATCH'} ${endpoint})`,
          error.code,
          error.retryAfterSeconds,
          { cause: error },
        )
      }
      throw error
    }
  }

  async preflightSkip(
    batchId: number,
    items: readonly BacklinkPreflightSkipItem[],
    signal?: AbortSignal,
  ): Promise<BacklinkPreflightSkipResult> {
    if (items.length === 0 || items.length > 100) {
      throw new BacklinksError(
        'preflight-skip requires between 1 and 100 items',
        'BACKLINKS_INVALID_REQUEST',
      )
    }
    const body = await this.requestJson(`/api/agent/batches/${batchId}/preflight-skip`, {
      method: 'POST',
      payload: {
        items: items.map(entry => {
          const wireTags = entry.tags !== undefined ? mapTagsForSupermanagerWire(entry.tags).slice(0, 10) : []
          return {
            itemId: entry.itemId,
            skipReason: entry.skipReason.slice(0, 2000),
            ...(wireTags.length > 0 ? { tags: wireTags } : {}),
          }
        }),
      },
    }, signal)
    const record = asRecord(body)
    const results: BacklinkPreflightSkipItemResult[] = Array.isArray(record.results)
      ? record.results.map((entry: unknown) => {
        const row = asRecord(entry)
        return {
          itemId: toNumber(row.itemId),
          sourceId: toNumber(row.sourceId),
          itemStatus: str(row.itemStatus),
          publishRecordId: row.publishRecordId === undefined || row.publishRecordId === null
            ? null
            : toNumber(row.publishRecordId),
          changed: row.changed === true,
          attachedTags: Array.isArray(row.attachedTags) ? row.attachedTags.map(String) : [],
        }
      })
      : []

    return {
      ok: record.ok !== false,
      batchId: record.batchId !== undefined ? toNumber(record.batchId) : batchId,
      skippedCount: record.skippedCount !== undefined ? toNumber(record.skippedCount) : 0,
      unchangedCount: record.unchangedCount !== undefined ? toNumber(record.unchangedCount) : 0,
      results,
    }
  }

  async tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal): Promise<BacklinkTagResult> {
    const wireTags = mapTagsForSupermanagerWire(names)
    const sendTagRequest = async (tagsToSend: readonly string[]): Promise<BacklinkTagResult> => {
      const body = await this.requestJson(`/api/agent/sources/${sourceId}/tags`, {
        method: 'POST',
        payload: { tags: [...tagsToSend] },
      }, signal)
      const record = asRecord(body)
      const attached = Array.isArray(record.attached)
        ? record.attached.map((entry: unknown) => {
          const row = asRecord(entry)
          return {
            id: toNumber(row.id),
            name: str(row.name),
            created: row.created === true,
          }
        })
        : []
      return {
        sourceId: record.sourceId !== undefined && record.sourceId !== null ? toNumber(record.sourceId) : sourceId,
        attached,
      }
    }

    try {
      return await sendTagRequest(wireTags)
    } catch (error) {
      if (signal?.aborted || !isSupermanager5xxError(error)) {
        throw error
      }

      let lastError: unknown = error
      let lastAttemptedTags: readonly string[] = wireTags
      const fallbackTags = mapTagsToSafeChineseFallback(wireTags)
      const hasDifferentFallback = fallbackTags.length !== wireTags.length
        || fallbackTags.some((tag, idx) => tag !== wireTags[idx])

      if (hasDifferentFallback) {
        try {
          const retryOutcome = await sendTagRequest(fallbackTags)
          return {
            ...retryOutcome,
            fallbackUsed: true,
            sentTags: [...fallbackTags],
            warning: 'Supermanager source_tags returned 5xx; succeeded with safe Chinese tag fallback.',
          }
        } catch (retryError) {
          if (signal?.aborted || !isSupermanager5xxError(retryError)) {
            throw retryError
          }
          lastError = retryError
          lastAttemptedTags = fallbackTags
        }
      }

      const errorMessage = lastError instanceof Error ? lastError.message : String(lastError)
      const warning = `supermanager source_tags returned 5xx after compatibility fallback; skipped non-fatally (${errorMessage.slice(0, 180)})`
      process.stderr.write(`[backlinks-publisher] ${warning}\n`)
      return {
        sourceId,
        attached: [],
        degraded: true,
        warning,
        sentTags: [...lastAttemptedTags],
      }
    }
  }

  private resultPayload(result: BacklinkItemResult): Record<string, unknown> {
    switch (result.status) {
      case 'live':
        return {
          status: 'live',
          publicUrl: result.publicUrl,
          anchorText: result.anchorText,
          targetUrl: result.targetUrl,
          ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
        }
      case 'submitted':
        return {
          status: 'submitted',
          ...(result.publicUrl === undefined ? {} : { publicUrl: result.publicUrl }),
          anchorText: result.anchorText,
          targetUrl: result.targetUrl,
          ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
        }
      case 'failed':
        return {
          status: 'failed',
          failureMode: result.failureMode,
          failureReason: result.failureReason,
          ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
        }
      case 'skipped':
        return { status: 'skipped', skipReason: result.skipReason }
    }
  }

  private async requestJson(
    path: string,
    init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; payload?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
    const { baseUrl, token, requestTimeoutMs } = this.resolveConfig()
    const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, requestTimeoutMs)
    const onOuterAbort = () => { timeout.abort() }
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      let response: Response
      try {
        response = await fetch(`${cleanBase}${path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.payload === undefined ? {} : { body: JSON.stringify(init.payload) }),
          signal: timeout.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
        if (timeout.signal.aborted) {
          throw new BacklinksError(`supermanager ${path} timed out after ${requestTimeoutMs}ms`, 'BACKLINKS_TIMEOUT')
        }
        throw new BacklinksError(
          `supermanager ${path} transport failure: ${String(error instanceof Error ? error.message : error)}`,
          'BACKLINKS_TRANSPORT',
          null,
          { cause: error },
        )
      }
      const bodyText = await response.text()
      if (!response.ok) throw httpError(path, response, bodyText)
      if (response.status === 204 || bodyText.trim().length === 0) return {}
      return JSON.parse(bodyText) as unknown
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}
