/**
 * Shared Typert Remote client/host wire descriptors for `backlinksConsole`.
 */

import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type {
  RemoteResult,
  TypertRemoteInfo,
  TypertRemoteMethod,
} from '@deepseek-ai/dsh-typert-protocol'
import type { BacklinkBatchDetail, BacklinkBatchSummary } from './backlinks-types.ts'

export const PACKAGE_NAME = '@javawl/dsh-backlinks-bundle'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface BacklinksConsoleRemoteNamespace {
    batch: (batchId: number) => Promise<RemoteResult<BacklinkBatchDetail>>
    batches: () => Promise<RemoteResult<readonly BacklinkBatchSummary[]>>
  }
  interface TypertRemoteMap {
    'backlinksConsole/batch': (batchId: number) => Promise<RemoteResult<BacklinkBatchDetail>>
    'backlinksConsole/batches': () => Promise<RemoteResult<readonly BacklinkBatchSummary[]>>
  }
  interface TypertRemoteNamespaceMap {
    backlinksConsole: BacklinksConsoleRemoteNamespace
  }
}

let batchParamSchema: z.ZodNumber | undefined
const getBatchParamSchema = () => (batchParamSchema ??= z.number())

let batchSummarySchema: z.ZodType<BacklinkBatchSummary> | undefined
const getBatchSummarySchema = () =>
  (batchSummarySchema ??= z.object({
    id: z.number().readonly(),
    name: z.string().readonly(),
    websiteId: z.number().readonly(),
    websiteName: z.string().readonly(),
    websiteHost: z.string().readonly(),
    plannedAt: z.string().readonly(),
    counts: z
      .object({
        pending: z.number().readonly(),
        executed: z.number().readonly(),
        skipped: z.number().readonly(),
        failed: z.number().readonly(),
        total: z.number().readonly(),
      })
      .readonly(),
    executing: z.boolean().readonly(),
  }).readonly())

let batchesResultSchema: z.ZodType<readonly BacklinkBatchSummary[]> | undefined
const getBatchesResultSchema = () =>
  (batchesResultSchema ??= z.array(getBatchSummarySchema()).readonly())

let batchDetailSchema: z.ZodType<BacklinkBatchDetail> | undefined
const getBatchDetailSchema = () =>
  (batchDetailSchema ??= z.object({
    batch: getBatchSummarySchema(),
    website: z
      .object({
        id: z.number().readonly(),
        name: z.string().readonly(),
        siteUrl: z.string().readonly(),
        siteHost: z.string().readonly(),
        shortDescription: z.string().readonly().optional(),
        longDescription: z.string().readonly().optional(),
        logoUrl: z.string().readonly().optional(),
        screenshotUrl: z.string().readonly().optional(),
        keyFeatures: z.string().readonly().optional(),
        pricingType: z.string().readonly().optional(),
      })
      .readonly(),
    anchors: z
      .array(
        z
          .object({
            id: z.number().readonly(),
            anchorText: z.string().readonly(),
            targetUrl: z.string().readonly(),
          })
          .readonly(),
      )
      .readonly(),
    items: z
      .array(
        z
          .object({
            id: z.number().readonly(),
            sourceId: z.number().readonly(),
            sourceName: z.string().readonly(),
            sourceUrl: z.string().readonly(),
            sourceHost: z.string().readonly(),
            submitUrl: z.union([z.literal(null), z.string()]).readonly(),
            sourceNotes: z.union([z.literal(null), z.string()]).readonly(),
            category: z.union([z.literal(null), z.string()]).readonly(),
            tags: z.array(z.string()).readonly(),
            paymentType: z.string().readonly(),
            linkType: z.string().readonly(),
            status: z.string().readonly(),
            failureMode: z.union([z.literal(null), z.string()]).readonly(),
            failureReason: z.union([z.literal(null), z.string()]).readonly(),
            publishedUrl: z.union([z.literal(null), z.string()]).readonly(),
            publishStatus: z.union([z.literal(null), z.string()]).readonly(),
            plannedAt: z.string().readonly(),
          })
          .readonly(),
      )
      .readonly(),
  }).readonly())

export const TYPERT_REMOTE: TypertRemoteInfo<{
  readonly 'backlinksConsole/batch': TypertRemoteMethod<{ readonly batchId: number }, BacklinkBatchDetail>
  readonly 'backlinksConsole/batches': TypertRemoteMethod<Record<string, never>, readonly BacklinkBatchSummary[]>
}> = createTypertRemoteInfo(
  {
    package: PACKAGE_NAME,
    methods: {
      'backlinksConsole/batch': {
        service: 'backlinksConsole',
        description: "One batch's full detail: website, anchors, and items.",
        invocation: { kind: 'direct' },
        parameters: [
          {
            name: 'batchId',
            description: 'the batch to read.',
            source: 'json',
            codec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batch:batchId`,
              create: getBatchParamSchema,
              jsonSchema: { type: 'number' },
            },
            strictCodec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batch:batchId`,
              create: getBatchParamSchema,
              jsonSchema: { type: 'number' },
            },
          },
        ],
        result: {
          mode: 'strict',
          typeSymbol: `${PACKAGE_NAME}#BacklinkBatchDetail`,
          create: getBatchDetailSchema,
          description: 'batch, website, anchors, and items.',
        },
      },
      'backlinksConsole/batches': {
        service: 'backlinksConsole',
        description: 'Every batch in the workspace with per-status counts and the executing flag.',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batches:result`,
          create: getBatchesResultSchema,
          description: "the provider's batch summaries, newest-planned first.",
        },
      },
    },
  },
  z,
) as unknown as TypertRemoteInfo<{
  readonly 'backlinksConsole/batch': TypertRemoteMethod<{ readonly batchId: number }, BacklinkBatchDetail>
  readonly 'backlinksConsole/batches': TypertRemoteMethod<Record<string, never>, readonly BacklinkBatchSummary[]>
}>

export default TYPERT_REMOTE
