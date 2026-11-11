/**
 * Service Definition for the browser automation capability seam (`ctx.browser`).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BrowserAutomationProvider,
  BrowserCommand,
  BrowserResult,
  BrowserSession,
} from './types.ts'
import { BrowserError } from './types.ts'

export { BrowserError } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

export interface BrowserRuntimeConfig {
  readonly provider?: string
}

export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, BrowserAutomationProvider>()
  private readonly providerId: string | undefined
  private session: BrowserSession | undefined
  private sessionDisposer: (() => void) | undefined
  private opening: Promise<BrowserSession> | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.providerId = config.provider ?? process.env.DSH_BROWSER_PROVIDER
  }

  registerProvider(provider: BrowserAutomationProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'browser.registerProvider()')
    return () => void dispose()
  }

  act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    const run = async (): Promise<BrowserResult> => {
      const session = await this.ensureSession(signal)
      if (signal?.aborted) throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED')
      try {
        return await session.act(command, signal)
      } catch (error) {
        if (error instanceof BrowserError) {
          if (error.message.includes('has been closed') || error.message.includes('session is closed')) {
            await this.discardSession()
          }
          throw error
        }
        await this.discardSession()
        throw new BrowserError(
          `browser command "${command.kind}" failed: ${String(error instanceof Error ? error.message : error)}`,
          'BROWSER_ACTION_FAILED',
          { cause: error },
        )
      }
    }
    return run()
  }

  async closeSession(): Promise<void> {
    await this.opening
    await this.discardSession()
  }

  private ensureSession(signal?: AbortSignal): Promise<BrowserSession> {
    if (this.session) return Promise.resolve(this.session)
    this.opening ??= this.launchSession(signal).then(
      (session) => {
        this.opening = undefined
        return session
      },
      (error: unknown) => {
        this.opening = undefined
        throw error
      },
    )
    return this.opening
  }

  private async launchSession(signal?: AbortSignal): Promise<BrowserSession> {
    const provider = resolveProvider({
      providers: this.providers,
      ...(this.providerId !== undefined ? { configuredId: this.providerId } : {}),
    })
    if (signal?.aborted) throw new BrowserError('browser launch aborted', 'BROWSER_ABORTED')
    let session: BrowserSession
    try {
      session = await provider.open(signal)
    } catch (error) {
      if (error instanceof BrowserError) throw error
      throw new BrowserError(
        `browser provider "${provider.id}" failed to open a session: ${String(error instanceof Error ? error.message : error)}`,
        'BROWSER_LAUNCH_FAILED',
        { cause: error },
      )
    }
    const dispose = this.ctx.effect(function* () {
      yield () => {
        void session.close().catch(() => undefined)
      }
    }, 'browser.session')
    this.session = session
    this.sessionDisposer = () => void dispose()
    return session
  }

  private async discardSession(): Promise<void> {
    this.sessionDisposer?.()
    this.sessionDisposer = undefined
    const session = this.session
    this.session = undefined
    try {
      await session?.close()
    } catch {
      // swallow: closing an already-dead browser
    }
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
      throw new BrowserError(`configured browser provider "${configuredId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new BrowserError(`configured browser provider "${configuredId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default BrowserRuntime
