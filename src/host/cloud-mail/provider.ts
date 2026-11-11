/**
 * The cloud-mail implementation of the mailbox seam (`POST /public/addUser`, `POST /public/emailList`).
 */

import type {
  MailboxAddress,
  MailboxProvider,
  MailPollOptions,
  VerificationMail,
} from '../backlinks/index.ts'
import { BacklinksError } from '../backlinks/index.ts'

export const CLOUD_MAIL_MAILBOX_ID = 'cloud-mail'

const FIRST_URL = /https?:\/\/[^\s<>"')]+/u

export interface ResolvedCloudMailConfig {
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

function toVerificationMail(row: Record<string, unknown>): VerificationMail {
  const text = typeof row.text === 'string' && row.text.length > 0 ? row.text : str(row.content)
  const link = text.match(FIRST_URL)?.[0] ?? null
  return {
    subject: str(row.subject),
    from: str(row.sendEmail),
    text,
    code: typeof row.code === 'string' && row.code.length > 0 ? row.code : null,
    link,
    receivedAt: str(row.createTime),
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new BacklinksError('mailbox wait aborted', 'BACKLINKS_ABORTED'))
    }, { once: true })
  })
}

export class CloudMailMailbox implements MailboxProvider {
  readonly id = CLOUD_MAIL_MAILBOX_ID

  constructor(private readonly resolveConfig: () => ResolvedCloudMailConfig) {}

  available(): boolean {
    const { baseUrl, token } = this.resolveConfig()
    return baseUrl.length > 0 && token.length > 0
  }

  async createMailbox(options: { readonly localPart: string; readonly domain: string }, signal?: AbortSignal): Promise<MailboxAddress> {
    const email = `${options.localPart}@${options.domain}`
    await this.requestJson('/public/addUser', {
      method: 'POST',
      payload: { list: [{ email }] },
    }, signal)
    return { email }
  }

  async pollMail(address: MailboxAddress, options: MailPollOptions, signal?: AbortSignal): Promise<VerificationMail | null> {
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      const rows = await this.fetchMailRows(address, signal)
      const match = rows.find(row => this.matches(row, options))
      if (match !== undefined) return toVerificationMail(match)
      if (Date.now() + options.intervalMs >= deadline) return null
      await sleep(options.intervalMs, signal)
    }
  }

  private async fetchMailRows(address: MailboxAddress, signal?: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const body = await this.requestJson('/public/emailList', {
      method: 'POST',
      payload: { toEmail: address.email, size: 20, num: 1, type: 0, isDel: 0 },
    }, signal)
    const data = asRecord(body).data ?? body
    const rows = Array.isArray(data) ? data : asRecord(data).list
    return Array.isArray(rows) ? rows.map(asRecord) : []
  }

  private matches(row: Record<string, unknown>, options: MailPollOptions): boolean {
    if (options.subjectContains !== undefined
      && !str(row.subject).toLowerCase().includes(options.subjectContains.toLowerCase())) {
      return false
    }
    if (options.fromContains !== undefined
      && !str(row.sendEmail).toLowerCase().includes(options.fromContains.toLowerCase())) {
      return false
    }
    return true
  }

  private async requestJson(path: string, init: { method: 'POST'; payload: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
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
          headers: { authorization: token, 'content-type': 'application/json' },
          body: JSON.stringify(init.payload),
          signal: timeout.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED')
        if (timeout.signal.aborted) {
          throw new BacklinksError(`cloud-mail ${path} timed out after ${requestTimeoutMs}ms`, 'BACKLINKS_TIMEOUT')
        }
        throw new BacklinksError(
          `cloud-mail ${path} transport failure: ${String(error instanceof Error ? error.message : error)}`,
          'BACKLINKS_TRANSPORT',
          null,
          { cause: error },
        )
      }
      const bodyText = await response.text()
      if (!response.ok) {
        throw new BacklinksError(
          `cloud-mail ${path} failed (HTTP ${response.status}): ${bodyText.slice(0, 300)}`,
          response.status === 401 || response.status === 403 ? 'BACKLINKS_UNAUTHORIZED' : 'BACKLINKS_API_ERROR',
        )
      }
      return JSON.parse(bodyText) as unknown
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}
