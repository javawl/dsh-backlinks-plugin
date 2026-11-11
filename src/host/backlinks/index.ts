/**
 * Service Definition for the backlinks capability seam (`ctx.backlinks`).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BacklinkBadgeInput,
  BacklinkBadgeResult,
  BacklinkBatchDetail,
  BacklinkBatchSourceProvider,
  BacklinkBatchSummary,
  BacklinkHeartbeat,
  BacklinkItemOutcome,
  BacklinkItemResult,
  BacklinkLeaseClaim,
  BacklinkTagResult,
  MailboxAddress,
  MailboxProvider,
  MailPollOptions,
  VerificationMail,
} from './types.ts'
import { BacklinksError } from './types.ts'

export { BacklinksError } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    backlinks: BacklinksRuntime
  }
}

export interface BacklinksRuntimeConfig {
  readonly batchSourceProvider?: string
  readonly mailboxProvider?: string
}

export class BacklinksRuntime extends Service {
  static Config: z<BacklinksRuntimeConfig> = z.object({
    batchSourceProvider: z.string(),
    mailboxProvider: z.string(),
  })

  private batchSources = new Map<string, BacklinkBatchSourceProvider>()
  private mailboxes = new Map<string, MailboxProvider>()
  private readonly batchSourceId: string | undefined
  private readonly mailboxId: string | undefined

  constructor(ctx: Context, config: BacklinksRuntimeConfig = {}) {
    super(ctx, 'backlinks')
    this.batchSourceId = config.batchSourceProvider ?? process.env.DSH_BACKLINKS_BATCH_SOURCE
    this.mailboxId = config.mailboxProvider ?? process.env.DSH_BACKLINKS_MAILBOX
  }

  registerBatchSourceProvider(provider: BacklinkBatchSourceProvider): () => void {
    return this.registerProvider(this.batchSources, provider, 'batch source')
  }

  registerMailboxProvider(provider: MailboxProvider): () => void {
    return this.registerProvider(this.mailboxes, provider, 'mailbox')
  }

  private registerProvider<P extends { readonly id: string }>(
    store: Map<string, P>,
    provider: P,
    kind: string,
  ): () => void {
    if (store.has(provider.id)) {
      throw new BacklinksError(`a ${kind} provider with id "${provider.id}" is already registered`, 'BACKLINKS_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'backlinks.registerProvider()')
    return () => void dispose()
  }

  async listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]> {
    return this.resolveBatchSource().listBatches(signal)
  }

  async getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail> {
    return this.resolveBatchSource().getBatch(batchId, signal)
  }

  async claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal): Promise<BacklinkLeaseClaim> {
    return this.resolveBatchSource().claim(batchId, itemIds, signal)
  }

  async heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat> {
    return this.resolveBatchSource().heartbeat(leaseId, signal)
  }

  async release(leaseId: number, signal?: AbortSignal): Promise<void> {
    await this.resolveBatchSource().release(leaseId, signal)
  }

  async reportItemResult(itemId: number, result: BacklinkItemResult, signal?: AbortSignal): Promise<BacklinkItemOutcome> {
    return this.resolveBatchSource().reportItemResult(itemId, result, signal)
  }

  async addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal): Promise<BacklinkBadgeResult> {
    return this.resolveBatchSource().addBadge(websiteId, badge, signal)
  }

  async tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal): Promise<BacklinkTagResult> {
    return this.resolveBatchSource().tagSource(sourceId, names, signal)
  }

  async createMailbox(options: { readonly localPart: string; readonly domain: string }, signal?: AbortSignal): Promise<MailboxAddress> {
    return this.resolveMailbox().createMailbox(options, signal)
  }

  async pollMail(address: MailboxAddress, options: MailPollOptions, signal?: AbortSignal): Promise<VerificationMail | null> {
    return this.resolveMailbox().pollMail(address, options, signal)
  }

  private resolveBatchSource(): BacklinkBatchSourceProvider {
    return resolveProvider({
      providers: this.batchSources,
      ...(this.batchSourceId !== undefined ? { configuredId: this.batchSourceId } : {}),
    })
  }

  private resolveMailbox(): MailboxProvider {
    return resolveProvider({
      providers: this.mailboxes,
      ...(this.mailboxId !== undefined ? { configuredId: this.mailboxId } : {}),
    })
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

interface Selection<P> {
  readonly configuredId?: string
  readonly providers: ReadonlyMap<string, P>
}

function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new BacklinksError(`configured backlinks provider "${configuredId}" is not registered`, 'BACKLINKS_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new BacklinksError(`configured backlinks provider "${configuredId}" is registered but unavailable`, 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new BacklinksError('no usable backlinks provider is registered', 'BACKLINKS_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new BacklinksError(`multiple usable backlinks providers are registered (${ids}); configure one explicitly`, 'BACKLINKS_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default BacklinksRuntime
