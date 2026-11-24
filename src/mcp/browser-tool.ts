/**
 * MCP `browser` tool definition, session manager, and action handler (zero
 * DSH/Cordis dependencies).
 *
 * Exposes all 12 existing actions (`navigate`, `snapshot`, `click`, `fill`,
 * `select`, `press`, `upload`, `screenshot`, `waitFor`, `closePage`,
 * `bringToFront`, `closeBrowser`) plus:
 * - Lower default token limits (`navigate` summary 3,000; `snapshot` default 8,000; hard clamp `maxOutputChars` 16,000)
 * - Optional `nth` / `submitNth` disambiguation and Playwright strict-mode diagnostics
 * - `batch_fill`: serial multi-field form filling + optional submit in 1 round-trip
 * - `wait_for_login`: in-process polling waiting for manual login completion.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_WIX_NAV_TIMEOUT_MS } from '../host/browser-playwright/comment-publish.ts'
import { PlaywrightBrowserProvider } from '../host/browser-playwright/provider.ts'
import type {
  BrowserAutomationProvider,
  BrowserCommand,
  BrowserProbeResult,
  BrowserResult,
  BrowserSession,
  BrowserSnapshotCommand,
} from '../host/browser/types.ts'
import { BrowserError } from '../host/browser/types.ts'
import { assertNever } from '../shared/backlinks-types.ts'
import { redactSecrets, type McpConfig } from './config.ts'
import type { SleepLike } from './backlinks-tool.ts'

export const BROWSER_ACTIONS = [
  'navigate',
  'snapshot',
  'click',
  'fill',
  'select',
  'press',
  'upload',
  'screenshot',
  'waitFor',
  'listPages',
  'closePage',
  'bringToFront',
  'closeBrowser',
  'batch_fill',
  'wait_for_login',
  'comment_publish',
  'directory_autofill',
] as const

export type BrowserAction = typeof BROWSER_ACTIONS[number]
export type BatchFillOp = 'fill' | 'select' | 'click' | 'check'

export type McpBrowserToolResult = CallToolResult

export interface BatchFillField {
  readonly target: string
  readonly value?: string
  readonly op: BatchFillOp
  readonly nth?: number
}

export const BROWSER_TOOL_DEFINITION: Tool = {
  name: 'browser',
  description:
    'Drive one shared persistent real-Chrome session across tabs: comment_publish (deterministic WordPress/Wix/Typecho/Blogger comment probe, fill, submit & reload verification), directory_autofill (MkDirs / AI-Autofill URL fetch + backfill fast-path), navigate (domcontentloaded priority, compact summary), snapshot (compact by default at 4500 chars with >15-option select collapsing; full=true to expand), click/fill/select/press/upload/screenshot/waitFor, batch_fill (with post-submit dialog/XHR/toast submitFeedback), wait_for_login, listPages (active tabs & OAuth popups), bringToFront, closePage, and closeBrowser.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [...BROWSER_ACTIONS],
        description: `Action to perform: ${BROWSER_ACTIONS.join(', ')}.`,
      },
      page: {
        type: 'string',
        description: 'Tab ref (e.g. p1, g1, popup1). Pass on every command for parallel tab isolation; omit for single-tab serial work.',
      },
      url: {
        type: 'string',
        description: 'Absolute http(s) URL for navigate / comment_publish / optional directory_autofill submit page; target URL pattern for waitFor.',
      },
      selector: {
        type: 'string',
        description: 'Element selector: prefer exact role:<role>|<name> (e.g. role:button|Submit) over broad text:<text>; also supports label:<text>, placeholder:<text>, bare CSS, optionally prefixed frame(<iframe css>)>>; click also accepts xy:<x>,<y>. Pass nth if multiple elements match. Also used by wait_for_login.',
      },
      nth: {
        type: 'integer',
        description: 'Optional 0-based element index when selector matches multiple elements (supported by click, fill, select, upload, waitFor).',
      },
      format: {
        type: 'string',
        enum: ['text', 'aria', 'interactive'],
        description: 'Snapshot format: text, aria, or interactive (reveals icon-only sign-in buttons, input[type=url], iframes, and sign-in candidates).',
      },
      full: {
        type: 'boolean',
        description: 'For snapshot: when true, disable boilerplate pruning and expand default limit to server maxOutputChars (16000). Default false uses compact mode (4500 chars).',
      },
      value: { type: 'string', description: 'Text value for fill or option value for select.' },
      key: { type: 'string', description: 'Keyboard key for press (e.g. Enter, Tab, End).' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths for upload.',
      },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'Navigation load condition for navigate (defaults to domcontentloaded; load timeout gracefully returns when DOM is ready).',
      },
      maxChars: {
        type: 'integer',
        description: 'Optional output character cap (navigate defaults to 3000, snapshot defaults to 4500 in compact mode; pass full=true or explicit maxChars up to server maxOutputChars, default 16000).',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Timeout in ms for navigate (default 10000, or 15000 when siteHint=wix_blog; overridable per call, recommend 8000-10000), comment_publish (default 10000; Wix navigation auto-relaxes to 15000 when siteHint=wix_blog), directory_autofill (default 10000), waitFor (default 10000), or wait_for_login (default 300000).',
      },
      siteHint: {
        type: 'string',
        description: 'Optional preflight siteHint (e.g. wix_blog, wordpress_comment, typecho_comment, comments_closed_hint) for navigate / comment_publish; relaxes initial domcontentloaded timeout to 15000ms for slow Wix sites.',
      },
      commentText: {
        type: 'string',
        description: 'For comment_publish: comment content (plain text or with anchor/link; required unless probeOnly=true).',
      },
      authorName: {
        type: 'string',
        description: 'For comment_publish: commenter display name.',
      },
      authorEmail: {
        type: 'string',
        description: 'For comment_publish: commenter email address.',
      },
      websiteUrl: {
        type: 'string',
        description: 'For comment_publish / directory_autofill: target promoted URL (filled into Website/URL field or embedded as anchor link).',
      },
      anchorText: {
        type: 'string',
        description: 'For comment_publish: optional anchor text used when embedding link into comment body.',
      },
      name: {
        type: 'string',
        description: 'For directory_autofill: product/site name used to backfill if autofill leaves Name empty.',
      },
      tagline: {
        type: 'string',
        description: 'For directory_autofill: short tagline/summary used to backfill if autofill leaves Tagline empty.',
      },
      description: {
        type: 'string',
        description: 'For directory_autofill: long description used to backfill if autofill leaves Description empty.',
      },
      email: {
        type: 'string',
        description: 'For directory_autofill: submitter email used to backfill if Email input is empty.',
      },
      waitAfterFetchMs: {
        type: 'integer',
        description: 'For directory_autofill: max wait time in ms after clicking Fetch/Autofill (default 4000).',
      },
      verifyReload: {
        type: 'boolean',
        description: 'For comment_publish: reload the clean public URL after submit to verify live link vs moderation (default true).',
      },
      probeOnly: {
        type: 'boolean',
        description: 'For comment_publish: detect site type / closed comments / captcha / guest editor without submitting (default false).',
      },
      fields: {
        type: 'array',
        description: 'For batch_fill: ordered list of form operations executed serially.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target'],
          properties: {
            target: { type: 'string', description: 'Element selector (role/label/placeholder/text/css/frame()>>).' },
            value: { type: 'string', description: 'Value for fill or select.' },
            op: {
              type: 'string',
              enum: ['fill', 'select', 'click', 'check'],
              description: 'Operation kind (default fill).',
            },
            nth: {
              type: 'integer',
              description: 'Optional 0-based element index when target matches multiple elements.',
            },
          },
        },
      },
      submitTarget: {
        type: 'string',
        description: 'For batch_fill: optional submit button selector clicked only when all fields succeed (automatically captures post-submit dialog/XHR/toast submitFeedback).',
      },
      submitNth: {
        type: 'integer',
        description: 'For batch_fill: optional 0-based element index for submitTarget when it matches multiple elements.',
      },
      feedbackWaitMs: {
        type: 'integer',
        description: 'For batch_fill with submitTarget: post-submit feedback capture wait in ms (default 2000, max 5000).',
      },
      stopOnError: {
        type: 'boolean',
        description: 'For batch_fill: stop immediately on the first field failure (default false).',
      },
      urlContains: {
        type: 'string',
        description: 'For wait_for_login: case-insensitive URL substring that must be present once logged in.',
      },
      urlNotContains: {
        type: 'string',
        description: 'For wait_for_login: case-insensitive URL substring that must no longer be present once logged in.',
      },
      pollIntervalMs: {
        type: 'integer',
        description: 'For wait_for_login: polling interval in ms (default 3000).',
      },
      bringToFront: {
        type: 'boolean',
        description: 'For wait_for_login: bring browser window to front if not already logged in (default true).',
      },
    },
  },
}

export class BrowserSessionManager {
  private session: BrowserSession | undefined
  private opening: Promise<BrowserSession> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly provider: BrowserAutomationProvider) {}

  static fromConfig(config: McpConfig): BrowserSessionManager {
    return new BrowserSessionManager(
      new PlaywrightBrowserProvider({
        userDataDir: config.browserProfileDir,
        headless: config.browserHeadless,
        channel: config.browserChannel,
        defaultTimeoutMs: config.browserTimeoutMs,
        launchArgs: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        windowPosition: config.browserWindowPosition,
        ...(config.browserExecutablePath === undefined ? {} : { executablePath: config.browserExecutablePath }),
      }),
    )
  }

  async act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    if (signal?.aborted) {
      throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED')
    }
    let session = await this.ensureSession(signal)
    if (signal?.aborted) {
      throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED')
    }
    try {
      return await session.act(command, signal)
    } catch (error) {
      if (error instanceof BrowserError) {
        const isPreDispatchClosed = error.message === 'browser session is closed'
        if (isPreDispatchClosed) {
          await this.discardSession(session)
          session = await this.ensureSession(signal)
          if (signal?.aborted) {
            throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED')
          }
          return await session.act(command, signal)
        }
        if (error.message.includes('has been closed') || error.message.includes('session is closed')) {
          await this.discardSession(session)
        }
        throw error
      }
      await this.discardSession(session)
      throw new BrowserError(
        `browser command "${command.kind}" failed: ${error instanceof Error ? error.message : String(error)}`,
        'BROWSER_ACTION_FAILED',
        { cause: error },
      )
    }
  }

  async closeSession(): Promise<void> {
    await this.opening?.catch(() => undefined)
    await this.discardSession()
  }

  private async ensureSession(signal?: AbortSignal): Promise<BrowserSession> {
    while (true) {
      if (signal?.aborted) {
        throw new BrowserError('browser launch aborted', 'BROWSER_ABORTED')
      }
      if (this.closing) {
        await this.closing.catch(() => undefined)
        continue
      }
      if (this.session) {
        if (this.session.isClosed?.() === true) {
          await this.discardSession(this.session)
          continue
        }
        return this.session
      }
      if (!this.opening) {
        this.opening = this.launchSession().then(
          (session) => {
            this.opening = undefined
            return session
          },
          (error: unknown) => {
            this.opening = undefined
            throw error
          },
        )
      }
      const pending = this.opening
      if (!signal) {
        return await pending
      }
      return await new Promise<BrowserSession>((resolve, reject) => {
        if (signal.aborted) {
          reject(new BrowserError('browser launch aborted', 'BROWSER_ABORTED'))
          return
        }
        const onAbort = () => {
          reject(new BrowserError('browser launch aborted', 'BROWSER_ABORTED'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.then(
          (session) => {
            signal.removeEventListener('abort', onAbort)
            resolve(session)
          },
          (err: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
    }
  }

  private async launchSession(): Promise<BrowserSession> {
    if (!this.provider.available()) {
      throw new BrowserError(`browser provider "${this.provider.id}" is unavailable`, 'BROWSER_PROVIDER_UNAVAILABLE')
    }
    try {
      const session = await this.provider.open()
      this.session = session
      return session
    } catch (error) {
      if (error instanceof BrowserError) throw error
      throw new BrowserError(
        `browser provider "${this.provider.id}" failed to open a session: ${error instanceof Error ? error.message : String(error)}`,
        'BROWSER_LAUNCH_FAILED',
        { cause: error },
      )
    }
  }

  private async discardSession(expectedSession?: BrowserSession): Promise<void> {
    if (this.closing) {
      await this.closing.catch(() => undefined)
      if (expectedSession === undefined || this.session !== expectedSession) {
        return
      }
    }
    if (expectedSession !== undefined && this.session !== expectedSession) {
      return
    }
    const session = this.session
    this.session = undefined
    if (!session) return
    const closePromise = Promise.resolve()
      .then(() => session.close())
      .catch(() => undefined)
      .finally(() => {
        if (this.closing === closePromise) {
          this.closing = undefined
        }
      })
    this.closing = closePromise
    await closePromise
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) {
    return Promise.reject(new BrowserError('browser wait aborted', 'BROWSER_ABORTED'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BrowserError('browser wait aborted', 'BROWSER_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function readNonEmpty(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`browser ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function readSelector(value: unknown, field = 'selector'): string | undefined {
  const raw = readNonEmpty(value, field)
  if (raw === undefined) return undefined
  if (/^xy:(?!\d+,\d+$).*/u.test(raw)) {
    throw new Error('browser xy selector must be xy:<x>,<y> with non-negative integers.')
  }
  if (/^role:[^|]*\|$/u.test(raw) || /^role:\|/u.test(raw)) {
    throw new Error('browser role selector must be role:<role>|<name> with both parts non-empty.')
  }
  if (/^(label|placeholder|text):$/u.test(raw)) {
    throw new Error(`browser ${raw.slice(0, -1)} selector must be ${raw}:<text> with non-empty text.`)
  }
  return raw
}

function readUrl(value: unknown, field = 'url'): string | undefined {
  const raw = readNonEmpty(value, field)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('protocol')
    }
    return url.toString()
  } catch {
    throw new Error(`browser ${field} must be an absolute http(s) URL.`)
  }
}

function readWaitUntil(value: unknown): 'load' | 'domcontentloaded' | 'networkidle' | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'load' || value === 'domcontentloaded' || value === 'networkidle') return value
  throw new Error('browser waitUntil must be load, domcontentloaded, or networkidle.')
}

function readSnapshotFormat(value: unknown): BrowserSnapshotCommand['format'] {
  if (value === undefined || value === 'text' || value === 'aria' || value === 'interactive') return value
  throw new Error('browser format must be text, aria, or interactive.')
}

function readPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`browser ${field} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`browser ${field} must be a positive integer.`)
  }
  return parsed
}

function readNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`browser ${field} must be a non-negative integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`browser ${field} must be a non-negative integer.`)
  }
  return parsed
}

function parseBatchFillFields(rawFields: unknown): readonly BatchFillField[] {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new Error('browser batch_fill requires a non-empty fields array.')
  }
  return rawFields.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`browser fields[${idx}] must be an object.`)
    }
    const row = entry as Record<string, unknown>
    const target = readSelector(row.target, `fields[${idx}].target`)
    if (target === undefined) {
      throw new Error(`browser fields[${idx}].target is required.`)
    }
    const nth = readNonNegativeInt(row.nth, `fields[${idx}].nth`)
    const opRaw = row.op === undefined ? 'fill' : row.op
    if (opRaw !== 'fill' && opRaw !== 'select' && opRaw !== 'click' && opRaw !== 'check') {
      throw new Error(`browser fields[${idx}].op must be fill, select, click, or check.`)
    }
    if (opRaw === 'fill') {
      if (typeof row.value !== 'string') {
        throw new Error(`browser fields[${idx}].value must be a string for op=fill.`)
      }
      return { target, op: opRaw, value: row.value, ...(nth === undefined ? {} : { nth }) }
    }
    if (opRaw === 'select') {
      const value = readNonEmpty(row.value, `fields[${idx}].value`)
      if (value === undefined) {
        throw new Error(`browser fields[${idx}].value must be a non-empty string for op=select.`)
      }
      return { target, op: opRaw, value, ...(nth === undefined ? {} : { nth }) }
    }
    return { target, op: opRaw, ...(nth === undefined ? {} : { nth }) }
  })
}

export function formatMcpBrowserOutput(result: BrowserResult, maxChars: number): string {
  switch (result.kind) {
    case 'page': {
      const compactLine = result.compactSummary ? `\n[compact] ${result.compactSummary}` : ''
      const header = `[page ${result.page}] ${result.title}\n${result.url}${compactLine}`
      const truncated = result.truncated || result.text.length > maxChars
      const body = result.text.slice(0, maxChars) + (truncated ? '\n… (truncated)' : '')
      return `${header}\n\n${body}`
    }
    case 'acked': {
      const hasPopups = result.openedPages !== undefined && result.openedPages.length > 0
      const hasFeedback = result.submitFeedback !== undefined
      if (!hasPopups && !hasFeedback) return 'ok'
      const payload = {
        ok: true,
        ...(result.popupPageRef === undefined ? {} : { popupPageRef: result.popupPageRef }),
        ...(hasPopups ? { openedPages: result.openedPages } : {}),
        ...(hasFeedback ? { submitFeedback: result.submitFeedback } : {}),
      }
      const header = hasPopups
        ? `ok (opened popup ${result.popupPageRef})`
        : 'ok (submitFeedback captured)'
      return `${header}\n${JSON.stringify(payload)}`
    }
    case 'screenshot':
      return `screenshot captured (${result.pngBase64.length} base64 characters)`
    case 'probe':
      return `[page ${result.page}] ${result.title}\n${result.url}`
    case 'pages': {
      const summary = `pages: ${result.pages.length} open (${result.pages.map(p => `${p.ref}${p.isPopup ? '[popup]' : ''}`).join(', ') || 'none'})`
      return `${summary}\n${JSON.stringify({ pages: result.pages })}`
    }
    case 'directory_autofill': {
      const payload = {
        page: result.page,
        outcome: result.outcome,
        url: result.url,
        title: result.title,
        autofillTriggered: result.autofillTriggered,
        autofilledFields: result.autofilledFields,
        filledFields: result.filledFields,
        remainingRequired: result.remainingRequired,
        fields: result.fields,
        ...(result.selects === undefined ? {} : { selects: result.selects }),
        ...(result.fileInputs === undefined ? {} : { fileInputs: result.fileInputs }),
        ...(result.submitSelector === undefined ? {} : { submitSelector: result.submitSelector }),
        ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      }
      return `[page ${result.page}] directory_autofill: ${result.outcome} -> ${result.url}\n${JSON.stringify(payload)}`
    }
    case 'comment_publish': {
      const targetDisplay = result.publicUrl ?? result.finalUrl
      const payload = {
        page: result.page,
        outcome: result.outcome,
        siteType: result.siteType,
        title: result.title,
        finalUrl: result.finalUrl,
        ...(result.publicUrl === undefined ? {} : { publicUrl: result.publicUrl }),
        ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.skipReason === undefined ? {} : { skipReason: result.skipReason }),
        ...(result.templateSignature === undefined ? {} : { templateSignature: result.templateSignature }),
        ...(result.suggestedTags === undefined ? {} : { suggestedTags: result.suggestedTags }),
        submitTriggered: result.submitTriggered,
        ...(result.probeOnly === undefined ? {} : { probeOnly: result.probeOnly }),
        ...(result.loginInfo === undefined ? {} : { loginInfo: result.loginInfo }),
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.postSubmitUrl === undefined ? {} : { postSubmitUrl: result.postSubmitUrl }),
        ...(result.postSubmitSnippet === undefined ? {} : { postSubmitSnippet: result.postSubmitSnippet }),
        ...(result.popupPageRef === undefined ? {} : { popupPageRef: result.popupPageRef }),
        ...(result.openedPages === undefined ? {} : { openedPages: result.openedPages }),
        ...(result.formSummary === undefined ? {} : { formSummary: result.formSummary }),
        ...(result.bottomSnapshot === undefined ? {} : { bottomSnapshot: result.bottomSnapshot }),
      }
      return `[page ${result.page}] comment_publish: ${result.outcome} (${result.siteType}) -> ${targetDisplay}\n${JSON.stringify(payload)}`
    }
    default:
      return assertNever(result, 'unhandled browser result kind')
  }
}

function matchesLoginState(
  probe: BrowserProbeResult,
  cond: {
    readonly urlContains?: string
    readonly urlNotContains?: string
    readonly selector?: string
  },
): boolean {
  const lowerUrl = probe.url.toLowerCase()
  if (cond.urlContains !== undefined && !lowerUrl.includes(cond.urlContains.toLowerCase())) {
    return false
  }
  if (cond.urlNotContains !== undefined && lowerUrl.includes(cond.urlNotContains.toLowerCase())) {
    return false
  }
  if (cond.selector !== undefined && probe.selectorVisible !== true) {
    return false
  }
  return true
}

export interface BrowserToolDependencies {
  readonly sessionManager: BrowserSessionManager
  readonly config: McpConfig
  readonly sleepImpl?: SleepLike
}

export function createBrowserToolHandler(deps: BrowserToolDependencies) {
  const { sessionManager, config } = deps
  const sleepImpl = deps.sleepImpl ?? defaultSleep

  return async function handleBrowserTool(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpBrowserToolResult> {
    try {
      const action = readNonEmpty(args.action, 'action') as BrowserAction | undefined
      if (action === undefined) {
        throw new Error(`browser action must be one of ${BROWSER_ACTIONS.join(', ')}.`)
      }
      const page = readNonEmpty(args.page, 'page')
      const addressed = <T extends BrowserCommand>(command: T): T => (
        page === undefined ? command : { ...command, page }
      )

      if (action === 'closeBrowser') {
        await sessionManager.closeSession()
        return { content: [{ type: 'text', text: 'ok' }] }
      }

      if (action === 'batch_fill') {
        const fields = parseBatchFillFields(args.fields)
        const submitTarget = readSelector(args.submitTarget, 'submitTarget')
        const submitNth = readNonNegativeInt(args.submitNth, 'submitNth')
        const feedbackWaitMs = readNonNegativeInt(args.feedbackWaitMs, 'feedbackWaitMs')
        if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
          throw new Error('browser stopOnError must be a boolean.')
        }
        const stopOnError = args.stopOnError === true

        const results: Array<{
          readonly index: number
          readonly op: BatchFillOp
          readonly target: string
          readonly ok: boolean
          readonly error?: string
        }> = []

        let succeeded = 0
        let failed = 0

        for (let index = 0; index < fields.length; index++) {
          const field = fields[index]!
          const nthField = field.nth === undefined ? {} : { nth: field.nth }
          let cmd: BrowserCommand
          switch (field.op) {
            case 'fill':
              cmd = addressed({ kind: 'fill', selector: field.target, value: field.value ?? '', ...nthField })
              break
            case 'select':
              cmd = addressed({ kind: 'select', selector: field.target, value: field.value ?? '', ...nthField })
              break
            case 'click':
              cmd = addressed({ kind: 'click', selector: field.target, ...nthField })
              break
            case 'check':
              cmd = addressed({ kind: 'check', selector: field.target, ...nthField })
              break
            default:
              return assertNever(field.op, 'unhandled batch_fill op')
          }

          try {
            await sessionManager.act(cmd, signal)
            succeeded++
            results.push({ index, op: field.op, target: field.target, ok: true })
          } catch (error) {
            if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
              throw error
            }
            failed++
            results.push({
              index,
              op: field.op,
              target: field.target,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
            if (stopOnError) break
          }
        }

        let submit:
          | {
              readonly target: string
              readonly attempted: boolean
              readonly ok: boolean
              readonly error?: string
              readonly skippedReason?: string
            }
          | undefined
        let submitFeedback: unknown
        let popupPageRef: string | undefined
        let openedPages: unknown

        if (submitTarget !== undefined) {
          if (failed > 0) {
            submit = {
              target: submitTarget,
              attempted: false,
              ok: false,
              skippedReason: 'skipped because one or more fields failed',
            }
          } else {
            try {
              const submitRes = await sessionManager.act(
                addressed({
                  kind: 'click',
                  selector: submitTarget,
                  ...(submitNth === undefined ? {} : { nth: submitNth }),
                  captureSubmitFeedback: true,
                  ...(feedbackWaitMs === undefined ? {} : { feedbackWaitMs }),
                }),
                signal,
              )
              if (submitRes.kind === 'acked') {
                if (submitRes.submitFeedback !== undefined) {
                  submitFeedback = submitRes.submitFeedback
                }
                if (submitRes.popupPageRef !== undefined) {
                  popupPageRef = submitRes.popupPageRef
                  openedPages = submitRes.openedPages
                }
              }
              submit = { target: submitTarget, attempted: true, ok: true }
            } catch (error) {
              if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
                throw error
              }
              submit = {
                target: submitTarget,
                attempted: true,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          }
        }

        const payload = {
          total: fields.length,
          attempted: results.length,
          succeeded,
          failed,
          results,
          ...(submit === undefined ? {} : { submit }),
          ...(submitFeedback === undefined ? {} : { submitFeedback }),
          ...(popupPageRef === undefined ? {} : { popupPageRef, openedPages }),
        }
        const submitSummary = submit === undefined
          ? ''
          : submit.ok
            ? '; submit ok'
            : submit.attempted
              ? '; submit FAILED'
              : '; submit skipped'
        const summary = `batch_fill: ${succeeded}/${fields.length} succeeded, ${failed} failed${submitSummary}`

        return {
          content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }],
        }
      }

      if (action === 'wait_for_login') {
        const urlContains = readNonEmpty(args.urlContains, 'urlContains')
        const urlNotContains = readNonEmpty(args.urlNotContains, 'urlNotContains')
        const selector = readSelector(args.selector, 'selector')
        if (urlContains === undefined && urlNotContains === undefined && selector === undefined) {
          throw new Error('browser wait_for_login requires at least one of urlContains, urlNotContains, or selector.')
        }
        const timeoutMs = readPositiveInt(args.timeoutMs, 'timeoutMs') ?? 300_000
        const pollIntervalMs = readPositiveInt(args.pollIntervalMs, 'pollIntervalMs') ?? 3_000
        if (args.bringToFront !== undefined && typeof args.bringToFront !== 'boolean') {
          throw new Error('browser bringToFront must be a boolean.')
        }
        const shouldBringToFront = args.bringToFront !== false

        const startedAt = Date.now()
        const deadline = startedAt + timeoutMs
        let polls = 0
        let broughtToFront = false
        let lastProbe: BrowserProbeResult | undefined

        while (true) {
          polls++
          try {
            const raw = await sessionManager.act(
              addressed({
                kind: 'probe',
                ...(selector === undefined ? {} : { selector }),
              }),
              signal,
            )
            if (raw.kind === 'probe') {
              lastProbe = raw
              if (matchesLoginState(raw, {
                ...(urlContains === undefined ? {} : { urlContains }),
                ...(urlNotContains === undefined ? {} : { urlNotContains }),
                ...(selector === undefined ? {} : { selector }),
              })) {
                const payload = {
                  loggedIn: true,
                  page: raw.page,
                  url: raw.url,
                  title: raw.title,
                  polls,
                  elapsedMs: Date.now() - startedAt,
                }
                return {
                  content: [{ type: 'text', text: `logged in (${raw.url})\n${JSON.stringify(payload)}` }],
                }
              }
            }
          } catch (error) {
            if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
              throw error
            }
            if (error instanceof BrowserError && /is not open|session is closed|has been closed/iu.test(error.message)) {
              const payload = {
                loggedIn: false,
                closed: true,
                reason: error.message,
                polls,
                elapsedMs: Date.now() - startedAt,
              }
              return {
                content: [{ type: 'text', text: `login wait stopped: ${error.message}\n${JSON.stringify(payload)}` }],
              }
            }
            // Transient navigation/execution context errors during login redirect are expected while polling.
          }

          if (shouldBringToFront && !broughtToFront) {
            broughtToFront = true
            await sessionManager.act(
              {
                kind: 'bringToFront',
                ...(lastProbe?.page !== undefined ? { page: lastProbe.page } : page !== undefined ? { page } : {}),
              },
              signal,
            ).catch(() => undefined)
          }

          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            const payload = {
              loggedIn: false,
              timedOut: true,
              ...(lastProbe === undefined ? {} : { page: lastProbe.page, url: lastProbe.url, title: lastProbe.title }),
              polls,
              elapsedMs: Date.now() - startedAt,
            }
            return {
              content: [{ type: 'text', text: `login wait timed out after ${timeoutMs}ms\n${JSON.stringify(payload)}` }],
            }
          }

          await sleepImpl(Math.min(pollIntervalMs, remaining), signal)
        }
      }

      const selector = readSelector(args.selector)
      const nth = readNonNegativeInt(args.nth, 'nth')
      const nthProp = nth === undefined ? {} : { nth }
      const url = readNonEmpty(args.url, 'url')
      const value = readNonEmpty(args.value, 'value')
      const waitUntil = readWaitUntil(args.waitUntil)
      const siteHint = readNonEmpty(args.siteHint, 'siteHint')
      const timeoutMs = readPositiveInt(args.timeoutMs, 'timeoutMs')
      const requestedMaxChars = readPositiveInt(args.maxChars, 'maxChars')

      let command: BrowserCommand
      let effectiveMaxChars = config.maxOutputChars

      switch (action) {
        case 'bringToFront':
          command = addressed({ kind: 'bringToFront' })
          break
        case 'navigate': {
          const target = readUrl(args.url)
          if (target === undefined) throw new Error('browser navigate requires an http(s) url.')
          effectiveMaxChars = requestedMaxChars !== undefined
            ? Math.min(requestedMaxChars, config.maxOutputChars)
            : Math.min(config.navigateMaxChars, config.maxOutputChars)
          const effectiveNavTimeoutMs = timeoutMs
            ?? (siteHint === 'wix_blog' ? Math.max(config.browserTimeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS) : undefined)
          command = addressed({
            kind: 'navigate',
            url: target,
            ...(waitUntil === undefined ? {} : { waitUntil }),
            ...(siteHint === undefined ? {} : { siteHint }),
            ...(effectiveNavTimeoutMs === undefined ? {} : { timeoutMs: effectiveNavTimeoutMs }),
            maxChars: effectiveMaxChars,
          })
          break
        }
        case 'snapshot': {
          if (args.full !== undefined && typeof args.full !== 'boolean') {
            throw new Error('browser full must be a boolean.')
          }
          const full = args.full === true
          const format = readSnapshotFormat(args.format)
          effectiveMaxChars = requestedMaxChars !== undefined
            ? Math.min(requestedMaxChars, config.maxOutputChars)
            : full
              ? config.maxOutputChars
              : Math.min(config.snapshotMaxChars, config.maxOutputChars)
          command = addressed({
            kind: 'snapshot',
            ...(selector === undefined ? {} : { selector }),
            ...(format === undefined ? {} : { format }),
            maxChars: effectiveMaxChars,
            compact: !full,
          })
          break
        }
        case 'comment_publish': {
          const targetUrl = readUrl(args.url, 'url')
          if (targetUrl === undefined) {
            throw new Error('browser comment_publish requires an http(s) url.')
          }
          if (args.verifyReload !== undefined && typeof args.verifyReload !== 'boolean') {
            throw new Error('browser verifyReload must be a boolean.')
          }
          if (args.probeOnly !== undefined && typeof args.probeOnly !== 'boolean') {
            throw new Error('browser probeOnly must be a boolean.')
          }
          const probeOnly = args.probeOnly === true
          const commentText = readNonEmpty(args.commentText, 'commentText')
          if (!probeOnly && commentText === undefined) {
            throw new Error('browser comment_publish requires commentText unless probeOnly=true.')
          }
          const authorName = readNonEmpty(args.authorName, 'authorName')
          const authorEmail = readNonEmpty(args.authorEmail, 'authorEmail')
          const websiteUrl = readUrl(args.websiteUrl, 'websiteUrl')
          const anchorText = readNonEmpty(args.anchorText, 'anchorText')
          const effectiveCommentTimeoutMs = timeoutMs
            ?? (siteHint === 'wix_blog' ? Math.max(config.browserTimeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS) : config.browserTimeoutMs)
          command = addressed({
            kind: 'comment_publish',
            url: targetUrl,
            commentText: commentText ?? '',
            ...(authorName === undefined ? {} : { authorName }),
            ...(authorEmail === undefined ? {} : { authorEmail }),
            ...(websiteUrl === undefined ? {} : { websiteUrl }),
            ...(anchorText === undefined ? {} : { anchorText }),
            ...(siteHint === undefined ? {} : { siteHint }),
            timeoutMs: effectiveCommentTimeoutMs,
            ...(args.verifyReload === undefined ? {} : { verifyReload: args.verifyReload }),
            ...(args.probeOnly === undefined ? {} : { probeOnly: args.probeOnly }),
          })
          break
        }
        case 'click':
          if (selector === undefined) throw new Error('browser click requires a selector.')
          command = addressed({ kind: 'click', selector, ...nthProp })
          break
        case 'fill':
          if (selector === undefined) throw new Error('browser fill requires a selector.')
          if (typeof args.value !== 'string' || args.value.trim().length === 0) {
            throw new Error('browser fill requires a value.')
          }
          command = addressed({ kind: 'fill', selector, value: value!, ...nthProp })
          break
        case 'select':
          if (selector === undefined) throw new Error('browser select requires a selector.')
          if (value === undefined) throw new Error('browser select requires a value.')
          command = addressed({ kind: 'select', selector, value, ...nthProp })
          break
        case 'press':
          if (typeof args.key !== 'string' || args.key.trim().length === 0) {
            throw new Error('browser press requires a key (for example Enter, Tab).')
          }
          command = addressed({ kind: 'press', key: args.key.trim() })
          break
        case 'upload':
          if (selector === undefined) throw new Error('browser upload requires a selector.')
          if (
            !Array.isArray(args.files)
            || args.files.length === 0
            || args.files.some(file => typeof file !== 'string' || file.trim().length === 0)
          ) {
            throw new Error('browser upload requires a non-empty files array of paths.')
          }
          command = addressed({ kind: 'upload', selector, files: args.files.map(file => String(file)), ...nthProp })
          break
        case 'screenshot':
          command = addressed({ kind: 'screenshot' })
          break
        case 'waitFor':
          if (selector === undefined && url === undefined) {
            throw new Error('browser waitFor requires a selector or a url.')
          }
          command = addressed({
            kind: 'waitFor',
            ...(selector === undefined ? {} : { selector, ...nthProp }),
            ...(url === undefined ? {} : { url }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })
          break
        case 'directory_autofill': {
          const targetPageUrl = args.url === undefined ? undefined : readUrl(args.url, 'url')
          const websiteUrl = readUrl(args.websiteUrl, 'websiteUrl')
          if (websiteUrl === undefined) {
            throw new Error('browser directory_autofill requires an http(s) websiteUrl.')
          }
          const siteName = readNonEmpty(args.name, 'name') ?? readNonEmpty(args.authorName, 'authorName')
          const tagline = readNonEmpty(args.tagline, 'tagline')
          const description = readNonEmpty(args.description, 'description')
          const email = readNonEmpty(args.email, 'email') ?? readNonEmpty(args.authorEmail, 'authorEmail')
          const waitAfterFetchMs = readPositiveInt(args.waitAfterFetchMs, 'waitAfterFetchMs')
          command = addressed({
            kind: 'directory_autofill',
            ...(targetPageUrl === undefined ? {} : { url: targetPageUrl }),
            websiteUrl,
            ...(siteName === undefined ? {} : { name: siteName }),
            ...(tagline === undefined ? {} : { tagline }),
            ...(description === undefined ? {} : { description }),
            ...(email === undefined ? {} : { email }),
            ...(waitAfterFetchMs === undefined ? {} : { waitAfterFetchMs }),
            timeoutMs: timeoutMs ?? config.browserTimeoutMs,
          })
          break
        }
        case 'listPages':
          command = addressed({ kind: 'listPages' })
          break
        case 'closePage':
          command = addressed({ kind: 'closePage' })
          break
        default:
          return assertNever(action, `browser action must be one of ${BROWSER_ACTIONS.join(', ')}.`)
      }

      const result = await sessionManager.act(command, signal)
      if (result.kind === 'screenshot') {
        return {
          content: [
            { type: 'text', text: formatMcpBrowserOutput(result, effectiveMaxChars) },
            { type: 'image', data: result.pngBase64, mimeType: 'image/png' },
          ],
        }
      }

      return {
        content: [{ type: 'text', text: formatMcpBrowserOutput(result, effectiveMaxChars) }],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        isError: true,
        content: [{ type: 'text', text: redactSecrets(message, config) }],
      }
    }
  }
}
