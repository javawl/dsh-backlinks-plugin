/**
 * Pure, zero-DSH-dependency validation and payload-compaction helpers for
 * `backlinks` operations (shared between DSH `tool-backlinks` and the MCP server).
 */

import type {
  BacklinkBatchDetail,
  BacklinkBatchItem,
  BacklinkBatchSummary,
  BacklinkItemResult,
} from './types.ts'

export function readPositiveInt(value: unknown, field: string, prefix = 'backlinks'): number {
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`${prefix} ${field} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${prefix} ${field} must be a positive integer.`)
  }
  return parsed
}

export function readOptionalPositiveInt(value: unknown, field: string, prefix = 'backlinks'): number | undefined {
  if (value === undefined || value === null) return undefined
  return readPositiveInt(value, field, prefix)
}

export function readOptionalNonNegativeInt(value: unknown, field: string, prefix = 'backlinks'): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`${prefix} ${field} must be a non-negative integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${prefix} ${field} must be a non-negative integer.`)
  }
  return parsed
}

export function readClampedInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
  prefix = 'backlinks',
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`${prefix} ${field} must be an integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${prefix} ${field} must be an integer.`)
  }
  return Math.min(Math.max(parsed, min), max)
}

export function readNonEmpty(value: unknown, field: string, prefix = 'backlinks'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${prefix} ${field} must be a non-empty string.`)
  }
  return value.trim()
}

export function readOptionalString(value: unknown, field: string, prefix = 'backlinks'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new Error(`${prefix} ${field} must be a string.`)
  }
  return value
}

export function readHttpUrl(value: unknown, field: string, prefix = 'backlinks'): string {
  const raw = readNonEmpty(value, field, prefix)
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol')
    }
    return parsed.toString()
  } catch {
    throw new Error(`${prefix} ${field} must be an absolute http(s) URL.`)
  }
}

export function parseItemResult(args: Record<string, unknown>): BacklinkItemResult {
  const evidence = readOptionalString(args.evidence, 'evidence')
  switch (args.status) {
    case 'live':
      return {
        status: 'live',
        publicUrl: readNonEmpty(args.publicUrl, 'publicUrl'),
        anchorText: readNonEmpty(args.anchorText, 'anchorText'),
        targetUrl: readNonEmpty(args.targetUrl, 'targetUrl'),
        ...(evidence === undefined ? {} : { evidence }),
      }
    case 'submitted': {
      const publicUrl = readOptionalString(args.publicUrl, 'publicUrl')
      return {
        status: 'submitted',
        ...(publicUrl === undefined ? {} : { publicUrl }),
        anchorText: readNonEmpty(args.anchorText, 'anchorText'),
        targetUrl: readNonEmpty(args.targetUrl, 'targetUrl'),
        ...(evidence === undefined ? {} : { evidence }),
      }
    }
    case 'failed': {
      const failureMode = args.failureMode
      if (failureMode !== 'retryable' && failureMode !== 'manual_required') {
        throw new Error('backlinks failureMode must be retryable or manual_required.')
      }
      return {
        status: 'failed',
        failureMode,
        failureReason: readNonEmpty(args.failureReason, 'failureReason'),
        ...(evidence === undefined ? {} : { evidence }),
      }
    }
    case 'skipped':
      return { status: 'skipped', skipReason: readNonEmpty(args.skipReason, 'skipReason') }
    default:
      throw new Error('backlinks item_result requires status live, submitted, failed, or skipped.')
  }
}

export function parseTags(tags: unknown): readonly string[] {
  if (
    !Array.isArray(tags)
    || tags.length === 0
    || tags.length > 10
    || tags.some(tag => typeof tag !== 'string' || tag.trim().length === 0 || tag.trim().length > 100)
  ) {
    throw new Error('backlinks source_tags requires a tags array of 1-10 non-empty names.')
  }
  return [...new Set((tags as string[]).map(tag => tag.trim()))]
}

function truncateNote(value: string | null | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`
}

export interface CompactBacklinkBatchSummary {
  readonly id: number
  readonly name: string
  readonly websiteId: number
  readonly websiteName: string
  readonly websiteHost: string
  readonly plannedAt?: string
  readonly counts: {
    readonly pending: number
    readonly total: number
    readonly executed?: number
    readonly skipped?: number
    readonly failed?: number
  }
  readonly executing?: true
}

export function compactBatchSummary(batch: BacklinkBatchSummary): CompactBacklinkBatchSummary {
  return {
    id: batch.id,
    name: batch.name,
    websiteId: batch.websiteId,
    websiteName: batch.websiteName,
    websiteHost: batch.websiteHost,
    ...(batch.plannedAt.trim().length > 0 ? { plannedAt: batch.plannedAt } : {}),
    counts: {
      pending: batch.counts.pending,
      total: batch.counts.total,
      ...(batch.counts.executed > 0 ? { executed: batch.counts.executed } : {}),
      ...(batch.counts.skipped > 0 ? { skipped: batch.counts.skipped } : {}),
      ...(batch.counts.failed > 0 ? { failed: batch.counts.failed } : {}),
    },
    ...(batch.executing ? { executing: true as const } : {}),
  }
}

export function isPublishedItem(item: Pick<BacklinkBatchItem, 'publishStatus' | 'publishedUrl'>): boolean {
  const normalizedStatus = typeof item.publishStatus === 'string'
    ? item.publishStatus.trim().toLowerCase()
    : ''
  if (normalizedStatus === 'submitted' || normalizedStatus === 'live') {
    return true
  }
  return typeof item.publishedUrl === 'string' && item.publishedUrl.trim().length > 0
}

export function collectPublishedSourceIds(items: readonly BacklinkBatchItem[]): readonly number[] {
  const ids = new Set<number>()
  for (const item of items) {
    if (isPublishedItem(item)) {
      ids.add(item.sourceId)
    }
  }
  return [...ids].sort((left, right) => left - right)
}

export interface CompactBacklinkBatchItem {
  readonly id: number
  readonly sourceId: number
  readonly sourceName: string
  readonly sourceUrl: string
  readonly sourceHost: string
  readonly submitUrl?: string
  readonly sourceNotes?: string
  readonly category?: string
  readonly tags?: readonly string[]
  readonly paymentType?: string
  readonly linkType?: string
  readonly status: string
  readonly failureMode?: string
  readonly failureReason?: string
  readonly publishedUrl?: string
  readonly publishStatus?: string
}

export interface CompactBacklinkBatchDetail {
  readonly compact: true
  readonly batch: BacklinkBatchDetail['batch']
  readonly website: BacklinkBatchDetail['website']
  readonly anchors: BacklinkBatchDetail['anchors']
  readonly items: readonly CompactBacklinkBatchItem[]
}

function compactItem(item: BacklinkBatchItem): CompactBacklinkBatchItem {
  const sourceNotes = truncateNote(item.sourceNotes, 200)
  const failureReason = truncateNote(item.failureReason, 160)
  return {
    id: item.id,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    sourceHost: item.sourceHost,
    ...(item.submitUrl !== null && item.submitUrl.length > 0 ? { submitUrl: item.submitUrl } : {}),
    ...(sourceNotes !== undefined ? { sourceNotes } : {}),
    ...(item.category !== null && item.category.length > 0 ? { category: item.category } : {}),
    ...(item.tags.length > 0 ? { tags: item.tags } : {}),
    ...(item.paymentType.length > 0 ? { paymentType: item.paymentType } : {}),
    ...(item.linkType.length > 0 ? { linkType: item.linkType } : {}),
    status: item.status,
    ...(item.failureMode !== null && item.failureMode.length > 0 ? { failureMode: item.failureMode } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(item.publishedUrl !== null && item.publishedUrl.length > 0 ? { publishedUrl: item.publishedUrl } : {}),
    ...(item.publishStatus !== null && item.publishStatus.length > 0 ? { publishStatus: item.publishStatus } : {}),
  }
}

export function compactBatchDetail(detail: BacklinkBatchDetail): CompactBacklinkBatchDetail {
  return {
    compact: true,
    batch: detail.batch,
    website: detail.website,
    anchors: detail.anchors,
    items: detail.items.map(compactItem),
  }
}
