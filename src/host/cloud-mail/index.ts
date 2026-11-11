/**
 * Service Provider for the cloud-mail mailbox seam.
 * Settings namespace: `backlinks-cloud-mail`.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '../backlinks/index.ts'
import { CloudMailMailbox, type ResolvedCloudMailConfig } from './provider.ts'

export const name = 'backlinks-cloud-mail'
export const inject = ['backlinks']
export const BACKLINKS_CLOUD_MAIL_SETTINGS_NAMESPACE = 'backlinks-cloud-mail'

export interface Config {
  readonly baseUrl: Volatile<string>
  readonly token: Volatile<string | undefined>
  readonly requestTimeoutMs: Volatile<number>
}

export const Config = z.object({
  baseUrl: z.string().default('').volatile(),
  token: z.string().role('secret').volatile(),
  requestTimeoutMs: z.number().default(15_000).volatile(),
})

function assertHttpBaseUrl(baseUrl: string): void {
  if (baseUrl.length > 0 && !/^https?:\/\//u.test(baseUrl)) {
    throw new Error(`backlinks-cloud-mail: baseUrl must be an http(s) URL, got ${baseUrl}`)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolve = (): ResolvedCloudMailConfig => {
    const requestTimeoutMs = config.requestTimeoutMs.get()
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error(`backlinks-cloud-mail: requestTimeoutMs must be a positive integer, got ${requestTimeoutMs}`)
    }
    const baseUrl = config.baseUrl.get()
    assertHttpBaseUrl(baseUrl)
    const declared = config.token.get()
    const token = declared !== undefined && declared.length > 0
      ? declared
      : launchEnvironmentOf(ctx).get('CLOUDMAIL_TOKEN')?.value ?? ''
    return { baseUrl, token, requestTimeoutMs }
  }
  ctx.effect(() => ctx.backlinks.registerMailboxProvider(new CloudMailMailbox(resolve)), 'backlinks-cloud-mail: provider')
}

export { CLOUD_MAIL_MAILBOX_ID, CloudMailMailbox } from './provider.ts'
