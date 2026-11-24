/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */

import { chromium } from 'playwright-core'
import type { BrowserContext, Dialog, Locator, Page, Response as PwResponse } from 'playwright-core'
import { assertNever } from '../../shared/backlinks-types.ts'
import type {
  BrowserAutomationProvider,
  BrowserCommand,
  BrowserPageInfo,
  BrowserResult,
  BrowserSession,
  BrowserSubmitFeedback,
  BrowserSubmitFeedbackDialog,
  BrowserSubmitFeedbackResponse,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { DEFAULT_WIX_NAV_TIMEOUT_MS, executeCommentPublish, isNavigationContextError, navigateWixWithCommit } from './comment-publish.ts'
import {
  COMPACT_TEXT_SCRIPT,
  compactAriaSnapshot,
  compactPlainText,
  formatCompactTextEvaluation,
} from './compact-snapshot.ts'
import { executeDirectoryAutofill } from './directory-autofill.ts'
import { parseControlReport, renderPageControls, VISIBLE_CONTROLS_SCRIPT } from './interactive.ts'

export const PLAYWRIGHT_BROWSER_PROVIDER_ID = 'playwright'
export const DEFAULT_SNAPSHOT_MAX_CHARS = 60_000
export const STRICT_MODE_INSPECT_TIMEOUT_MS = 1_500
export const STRICT_MODE_MAX_CANDIDATES = 5
export const DEFAULT_SUBMIT_FEEDBACK_WAIT_MS = 2_000

const STRICT_MODE_PATTERN = /strict mode violation/iu
const NAVIGATE_TIMEOUT_PATTERN = /timeout|timed\s+out/iu
const STATIC_ASSET_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|js|map)(?:[?#]|$)|google-analytics|googletagmanager|doubleclick|fonts\.googleapis/iu

const COLLECT_DOM_NOTICES_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const out = [];
  const push = (raw) => {
    const t = clean(raw).slice(0, 220);
    if (t.length >= 2 && !out.includes(t) && out.length < 10) out.push(t);
  };
  const explicitSelectors = [
    '[role="alert"]',
    '[role="alertdialog"]',
    '[role="dialog"]',
    '[role="status"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    '.toast',
    '.toastify',
    '.notyf',
    '.swal2-popup',
    '.layui-layer',
    '.el-message',
    '.el-notification',
    '.ant-message',
    '.ant-notification',
    '[class*="toast" i]',
    '[class*="snackbar" i]',
    '[class*="alert" i]',
    '[class*="modal" i]',
  ];
  for (const sel of explicitSelectors) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch {}
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      push(el.innerText || el.textContent);
    }
  }
  const keywordRegex = /\b(?:thank\s+you|thanks\s+for\s+submitting|submitted|successfully|pending\s+review|under\s+review|already\s+submitted|already\s+exists|error|invalid|required)\b|提交成功|已提交|审核中|等待审核|待审核|已存在|重复提交|失败|错误|请填写/i;
  for (const el of document.querySelectorAll('p, span, div, li, strong, small, h2, h3')) {
    if (out.length >= 10) break;
    if (!isVisible(el) || el.closest('script,style,noscript,svg,header,nav,footer')) continue;
    if (el.children && el.children.length > 3) continue;
    const t = clean(el.innerText || el.textContent);
    if (t.length >= 3 && t.length <= 220 && keywordRegex.test(t)) {
      push(t);
    }
  }
  return out;
})()`

export interface StrictModeCandidate {
  readonly index: number
  readonly tag: string
  readonly role?: string
  readonly text?: string
  readonly ariaLabel?: string
  readonly name?: string
  readonly type?: string
  readonly visible?: boolean
}

export interface StrictModeInspection {
  readonly total: number
  readonly candidates: readonly StrictModeCandidate[]
}

export interface ResolvedPlaywrightConfig {
  readonly userDataDir: string
  readonly headless: boolean
  readonly channel: string
  readonly defaultTimeoutMs: number
  readonly launchArgs: readonly string[]
  readonly ignoreDefaultArgs: readonly string[]
  readonly windowPosition: string | undefined
  readonly executablePath?: string
}

async function bringPageWindowToFront(page: Page): Promise<void> {
  // Restore minimized or offscreen (-32000,-32000) desktop Chrome windows across Windows and macOS.
  try {
    const client = await page.context().newCDPSession(page)
    try {
      const info = await client.send('Browser.getWindowForTarget')
      const windowId = info?.windowId
      const bounds = info?.bounds
      if (windowId !== undefined && bounds !== undefined) {
        if (bounds.windowState !== undefined && bounds.windowState !== 'normal') {
          await client.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal' },
          })
        }
        const offscreen = bounds.left === undefined
          || bounds.top === undefined
          || bounds.left < 0
          || bounds.top < 0
          || bounds.left > 4000
          || bounds.top > 4000
        if (offscreen) {
          await client.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
              left: 80,
              top: 80,
              width: Math.max(bounds.width ?? 1280, 1024),
              height: Math.max(bounds.height ?? 860, 720),
            },
          })
        }
      }
    } finally {
      await client.detach().catch(() => undefined)
    }
  } catch {
    // Non-CDP browsers/tests still fall back cleanly to Playwright bringToFront().
  }
  await page.bringToFront()
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`browser-playwright: ${name} must be a positive integer, got ${value}`)
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

type Addressing =
  | { mode: 'css'; frames: readonly string[]; value: string }
  | { mode: 'role'; frames: readonly string[]; value: string; name?: string }
  | { mode: 'label' | 'placeholder' | 'text'; frames: readonly string[]; value: string }
  | { mode: 'xy'; frames: readonly string[]; x: number; y: number }

function parseSelector(raw: string): Addressing {
  let rest = raw
  const frames: string[] = []
  while (true) {
    const frame = /^frame\((.+)\)>>/u.exec(rest)
    if (frame === null) break
    frames.push(frame[1] as string)
    rest = rest.slice(frame[0].length)
  }
  const prefixed = /^(role|label|placeholder|text|xy):(.*)$/su.exec(rest)
  if (prefixed === null) return { mode: 'css', frames, value: rest }
  const kind = prefixed[1] as string
  const body = prefixed[2] as string
  if (kind === 'xy') {
    const xy = /^(\d+),(\d+)$/u.exec(body)
    if (xy === null) {
      throw new BrowserError(`browser xy selector must be xy:<x>,<y> with non-negative integers, got "${raw}"`, 'BROWSER_ACTION_FAILED')
    }
    return { mode: 'xy', frames, x: Number(xy[1]), y: Number(xy[2]) }
  }
  if (kind === 'role') {
    const split = body.indexOf('|')
    if (split < 0) return { mode: 'role', frames, value: body }
    const role = body.slice(0, split)
    const name = body.slice(split + 1)
    if (role.length === 0 || name.length === 0) {
      throw new BrowserError(`browser role selector must be role:<role>|<name> with both non-empty, got "${raw}"`, 'BROWSER_ACTION_FAILED')
    }
    return { mode: 'role', frames, value: role, name }
  }
  if (body.length === 0) {
    throw new BrowserError(`browser ${kind} selector must be ${kind}:<text> with non-empty text`, 'BROWSER_ACTION_FAILED')
  }
  return { mode: kind as 'label' | 'placeholder' | 'text', frames, value: body }
}

function buildLocator(page: Page, addressing: Addressing): Locator | undefined {
  if (addressing.mode === 'xy') return undefined
  let root: Locator | { getByRole: Locator['getByRole']; getByLabel: Locator['getByLabel']; getByPlaceholder: Locator['getByPlaceholder']; getByText: Locator['getByText']; locator: Locator['locator'] } = page
  for (const frame of addressing.frames) {
    root = (root as Page).frameLocator(frame)
  }
  switch (addressing.mode) {
    case 'css':
      return (root as Page).locator(addressing.value)
    case 'role':
      return (root as Page).getByRole(addressing.value as never,
        ...(addressing.name === undefined ? [] : [{ name: addressing.name }]))
    case 'label':
      return (root as Page).getByLabel(addressing.value)
    case 'placeholder':
      return (root as Page).getByPlaceholder(addressing.value)
    case 'text':
      return (root as Page).getByText(addressing.value)
    default:
      return assertNever(addressing, 'unhandled selector addressing')
  }
}

function applyNth(locator: Locator, nth: number | undefined): Locator {
  if (nth === undefined) return locator
  if (!Number.isSafeInteger(nth) || nth < 0) {
    throw new BrowserError(`browser nth must be a non-negative integer, got ${nth}`, 'BROWSER_ACTION_FAILED')
  }
  return locator.nth(nth)
}

function elementLocator(page: Page, addressing: Addressing, nth?: number): Locator {
  const locator = buildLocator(page, addressing)
  if (locator === undefined) {
    throw new BrowserError('browser xy addressing supports click only', 'BROWSER_ACTION_FAILED')
  }
  return applyNth(locator, nth)
}

export async function inspectStrictModeCandidates(
  locator: Locator,
  timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS,
): Promise<StrictModeInspection | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const inspect = async (): Promise<StrictModeInspection | undefined> => {
    const total = await locator.count()
    if (!Number.isFinite(total) || total <= 0) return undefined
    const limit = Math.min(total, STRICT_MODE_MAX_CANDIDATES)
    const evalTimeout = Math.max(100, Math.min(timeoutMs, 1_000))
    const candidates = await Promise.all(
      Array.from({ length: limit }, async (_, index): Promise<StrictModeCandidate> => {
        const nthLocator = locator.nth(index)
        const [meta, visible] = await Promise.all([
          nthLocator.evaluate((rawNode: unknown) => {
            interface BrowserDomElementLike {
              readonly tagName?: string
              readonly textContent?: string | null
              readonly innerText?: string
              getAttribute?(name: string): string | null
            }
            const el = rawNode as BrowserDomElementLike | null
            if (!el || typeof el.tagName !== 'string') {
              return { tag: 'unknown' }
            }
            const tag = el.tagName.toLowerCase()
            const attr = (key: string): string | undefined => {
              const raw = typeof el.getAttribute === 'function' ? el.getAttribute(key) : null
              if (typeof raw !== 'string') return undefined
              const cleaned = raw.replace(/\s+/gu, ' ').trim()
              return cleaned.length > 0 ? cleaned.slice(0, 80) : undefined
            }
            const typeAttr = attr('type')
            const explicitRole = attr('role')
            const inferredRole = explicitRole ?? (
              tag === 'button' || (tag === 'input' && (typeAttr === 'button' || typeAttr === 'submit' || typeAttr === 'reset'))
                ? 'button'
                : tag === 'a' && attr('href') !== undefined
                  ? 'link'
                  : tag === 'input' || tag === 'textarea'
                    ? 'textbox'
                    : tag === 'select'
                      ? 'combobox'
                      : undefined
            )
            const rawText = typeof el.innerText === 'string' && el.innerText.trim().length > 0
              ? el.innerText
              : typeof el.textContent === 'string'
                ? el.textContent
                : ''
            const cleanedText = rawText.replace(/\s+/gu, ' ').trim()
            const text = cleanedText.length > 0
              ? (cleanedText.length > 80 ? `${cleanedText.slice(0, 80)}…` : cleanedText)
              : undefined
            const ariaLabel = attr('aria-label')
            const name = attr('name')
            return {
              tag,
              ...(inferredRole === undefined ? {} : { role: inferredRole }),
              ...(text === undefined ? {} : { text }),
              ...(ariaLabel === undefined ? {} : { ariaLabel }),
              ...(name === undefined ? {} : { name }),
              ...(typeAttr === undefined ? {} : { type: typeAttr }),
            }
          }, undefined, { timeout: evalTimeout }).catch(() => ({ tag: 'unknown' })),
          nthLocator.isVisible().catch(() => undefined),
        ])
        return {
          index,
          ...meta,
          ...(visible === undefined ? {} : { visible }),
        }
      }),
    )
    return { total, candidates }
  }

  try {
    return await Promise.race([
      inspect().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function formatStrictModeCandidates(inspection: StrictModeInspection): string {
  const lines = [
    `Matched ${inspection.total} element(s) (showing first ${inspection.candidates.length}):`,
  ]
  for (const candidate of inspection.candidates) {
    const parts = [`  [${candidate.index}] <${candidate.tag}>`]
    if (candidate.role !== undefined) parts.push(`role=${candidate.role}`)
    if (candidate.type !== undefined) parts.push(`type=${candidate.type}`)
    if (candidate.text !== undefined) parts.push(`text=${JSON.stringify(candidate.text)}`)
    if (candidate.ariaLabel !== undefined) parts.push(`aria-label=${JSON.stringify(candidate.ariaLabel)}`)
    if (candidate.name !== undefined) parts.push(`name=${JSON.stringify(candidate.name)}`)
    if (candidate.visible !== undefined) parts.push(`visible=${String(candidate.visible)}`)
    lines.push(parts.join(' '))
  }
  const suggested = inspection.candidates.find(
    c => c.visible !== false && c.role !== undefined && (c.ariaLabel !== undefined || c.text !== undefined),
  ) ?? inspection.candidates.find(
    c => c.role !== undefined && (c.ariaLabel !== undefined || c.text !== undefined),
  )
  const label = suggested?.ariaLabel ?? suggested?.text
  if (suggested !== undefined && suggested.role !== undefined && label !== undefined) {
    lines.push(
      `Hint: pass nth: <i> (0-based, e.g. nth: ${suggested.index}) or use an exact selector such as role:${suggested.role}|${label}.`,
    )
  } else {
    lines.push('Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.')
  }
  return lines.join('\n')
}

export async function enrichStrictModeError(
  commandKind: BrowserCommand['kind'],
  locator: Locator,
  error: unknown,
  timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS,
): Promise<BrowserError | undefined> {
  const rawMessage = String(error instanceof Error ? error.message : error)
  if (!STRICT_MODE_PATTERN.test(rawMessage)) return undefined
  const inspection = await inspectStrictModeCandidates(locator, timeoutMs)
  const details = inspection !== undefined && inspection.candidates.length > 0
    ? formatStrictModeCandidates(inspection)
    : 'Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.'
  return new BrowserError(
    `playwright ${commandKind} failed: ${rawMessage}\n${details}`,
    'BROWSER_ACTION_FAILED',
    { cause: error },
  )
}

function throwIfAborted(signal: AbortSignal | undefined, commandKind: string): void {
  if (signal?.aborted) {
    throw new BrowserError(`browser ${commandKind} aborted`, 'BROWSER_ABORTED')
  }
}

export class PlaywrightSession implements BrowserSession {
  private closed = false
  private readonly pages = new Map<string, Page>()
  private readonly pageToRef = new WeakMap<Page, string>()
  private readonly pageMeta = new Map<string, { readonly isPopup: boolean }>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly popupCollectors = new Set<(entry: { readonly ref: string; readonly page: Page }) => void>()
  private keeperPage: Page | undefined
  private creatingInternalPage = 0
  private legacyTail: Promise<unknown> = Promise.resolve()
  private lastRef: string | undefined
  private refSeq = 0
  private popupSeq = 0

  constructor(
    private readonly context: BrowserContext,
    private readonly defaultTimeoutMs: number,
    private readonly defaultMaxChars: number,
  ) {
    this.context.on('close', () => {
      this.closed = true
    })
    this.context.on('page', (newPage: Page) => {
      if (this.creatingInternalPage > 0) return
      if (newPage === this.keeperPage || this.pageToRef.has(newPage)) return
      const ref = `popup${++this.popupSeq}`
      this.registerPage(ref, newPage, true)
      for (const collector of this.popupCollectors) {
        collector({ ref, page: newPage })
      }
    })
    for (const existing of this.context.pages()) {
      this.adopt(existing)
    }
  }

  isClosed(): boolean {
    return this.closed
  }

  async act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    throwIfAborted(signal, command.kind)
    if (this.closed) {
      throw new BrowserError('browser session is closed', 'BROWSER_ACTION_FAILED')
    }
    if (command.kind === 'listPages') {
      return await this.execute(command, signal)
    }
    return await (command.page === undefined
      ? this.chained(this.legacyTail, (tail) => { this.legacyTail = tail }, command, signal)
      : this.chained(
        this.chains.get(command.page) ?? Promise.resolve(),
        (tail) => { this.chains.set(command.page as string, tail) },
        command,
        signal,
      ))
  }

  private chained(
    previous: Promise<unknown>,
    store: (tail: Promise<unknown>) => void,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserResult> {
    const next = previous.then(() => this.execute(command, signal))
    store(next.catch(() => undefined))
    return next
  }

  private async execute(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    throwIfAborted(signal, command.kind)
    try {
      switch (command.kind) {
        case 'navigate': {
          const { page, ref } = await this.resolveForNavigate(command.page)
          const baseTimeout = command.timeoutMs ?? this.defaultTimeoutMs
          const isWixHint = command.siteHint === 'wix_blog'
          const timeout = isWixHint
            ? Math.max(baseTimeout, DEFAULT_WIX_NAV_TIMEOUT_MS)
            : baseTimeout
          const requestedWaitUntil = command.waitUntil
          if (requestedWaitUntil === undefined && isWixHint) {
            await navigateWixWithCommit(page, command.url, {
              timeoutMs: timeout,
              ...(signal === undefined ? {} : { signal }),
            })
          } else if (requestedWaitUntil === undefined) {
            await page.goto(command.url, { timeout, waitUntil: 'domcontentloaded' })
          } else {
            try {
              await page.goto(command.url, { timeout, waitUntil: requestedWaitUntil })
            } catch (error) {
              if (requestedWaitUntil !== 'domcontentloaded' && requestedWaitUntil !== 'commit' && NAVIGATE_TIMEOUT_PATTERN.test(String(error instanceof Error ? error.message : error))) {
                const readyState = typeof page.evaluate === 'function'
                  ? await page.evaluate(() => (globalThis as { document?: { readyState?: string } }).document?.readyState ?? '').catch(() => '')
                  : ''
                const currentUrl = page.url()
                if (
                  (readyState === 'interactive' || readyState === 'complete')
                  && currentUrl.length > 0
                  && currentUrl !== 'about:blank'
                ) {
                  return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars)
                }
              }
              throw error
            }
          }
          return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars)
        }
        case 'snapshot': {
          const { page, ref } = await this.requirePage(command.page)
          const maxChars = command.maxChars ?? this.defaultMaxChars
          const isCompact = command.compact === true
          if (command.format === 'aria') {
            const tree = await page.locator(command.selector ?? 'body').ariaSnapshot()
            const title = await page.title()
            if (isCompact) {
              const compacted = compactAriaSnapshot(tree, maxChars)
              return {
                kind: 'page',
                page: ref,
                url: page.url(),
                title,
                text: compacted.text,
                truncated: compacted.truncated,
                compactSummary: compacted.compactSummary,
              }
            }
            const { text, truncated } = truncate(tree, maxChars)
            return { kind: 'page', page: ref, url: page.url(), title, text, truncated }
          }
          if (command.format === 'interactive') {
            const report = parseControlReport(await page.evaluate<unknown>(VISIBLE_CONTROLS_SCRIPT))
            const title = await page.title()
            const rawRendered = renderPageControls(title, report)
            const rendered = isCompact
              ? renderPageControls(title, report, { compact: true })
              : rawRendered
            const { text, truncated } = truncate(rendered, maxChars)
            const compactSummary = isCompact
              ? `controls=${report.controls.length} forms=${report.forms} (raw=${rawRendered.length}c -> ${rendered.length}c)`
              : undefined
            return {
              kind: 'page',
              page: ref,
              url: page.url(),
              title,
              text,
              truncated: truncated || report.truncated,
              ...(compactSummary === undefined ? {} : { compactSummary }),
            }
          }
          if (isCompact) {
            if (command.selector === undefined && typeof page.evaluate === 'function') {
              try {
                const evalPayload = await page.evaluate<unknown>(COMPACT_TEXT_SCRIPT)
                const compacted = formatCompactTextEvaluation(evalPayload, maxChars)
                return {
                  kind: 'page',
                  page: ref,
                  url: page.url(),
                  title: await page.title(),
                  text: compacted.text,
                  truncated: compacted.truncated,
                  compactSummary: compacted.compactSummary,
                }
              } catch {
                // Fall back to innerText compression when page.evaluate fails or returns unexpected output.
              }
            }
            const [url, title, rawText] = await Promise.all([
              Promise.resolve(page.url()),
              page.title(),
              page.innerText(command.selector ?? 'body'),
            ])
            const compacted = compactPlainText(rawText, maxChars)
            return {
              kind: 'page',
              page: ref,
              url,
              title,
              text: compacted.text,
              truncated: compacted.truncated,
              compactSummary: compacted.compactSummary,
            }
          }
          return await this.pageResult(page, ref, maxChars, command.selector)
        }
        case 'click': {
          const { page } = await this.requirePage(command.page)
          const addressing = parseSelector(command.selector)
          const runClick = async () => {
            if (addressing.mode === 'xy') {
              await page.mouse.click(addressing.x, addressing.y)
              return
            }
            const locator = elementLocator(page, addressing, command.nth)
            await this.runLocatorAction('click', locator, () => locator.click({ timeout: this.defaultTimeoutMs }))
          }

          if (command.captureSubmitFeedback === true) {
            const { value: submitFeedback, openedPages } = await this.withPopupCapture(() =>
              this.runClickWithSubmitFeedback(page, runClick, command.feedbackWaitMs ?? DEFAULT_SUBMIT_FEEDBACK_WAIT_MS, signal),
            )
            return {
              kind: 'acked',
              submitFeedback,
              ...(openedPages.length > 0 ? { popupPageRef: openedPages[openedPages.length - 1]!.ref, openedPages } : {}),
            }
          }

          const { openedPages } = await this.withPopupCapture(runClick)
          return {
            kind: 'acked',
            ...(openedPages.length > 0 ? { popupPageRef: openedPages[openedPages.length - 1]!.ref, openedPages } : {}),
          }
        }
        case 'fill': {
          const { page } = await this.requirePage(command.page)
          const locator = elementLocator(page, parseSelector(command.selector), command.nth)
          await this.runLocatorAction('fill', locator, () => locator.fill(command.value, { timeout: this.defaultTimeoutMs }))
          return { kind: 'acked' }
        }
        case 'select': {
          const { page } = await this.requirePage(command.page)
          const locator = elementLocator(page, parseSelector(command.selector), command.nth)
          await this.runLocatorAction('select', locator, () => locator.selectOption(command.value, { timeout: this.defaultTimeoutMs }))
          return { kind: 'acked' }
        }
        case 'check': {
          const { page } = await this.requirePage(command.page)
          const locator = elementLocator(page, parseSelector(command.selector), command.nth)
          await this.runLocatorAction('check', locator, () => locator.check({ timeout: this.defaultTimeoutMs }))
          return { kind: 'acked' }
        }
        case 'press': {
          const { page } = await this.requirePage(command.page)
          await page.keyboard.press(command.key)
          return { kind: 'acked' }
        }
        case 'upload': {
          const { page } = await this.requirePage(command.page)
          const locator = elementLocator(page, parseSelector(command.selector), command.nth)
          await this.runLocatorAction('upload', locator, () => locator.setInputFiles([...command.files], { timeout: this.defaultTimeoutMs }))
          return { kind: 'acked' }
        }
        case 'screenshot': {
          const { page } = await this.requirePage(command.page)
          const buffer = await page.screenshot({ type: 'png', timeout: this.defaultTimeoutMs })
          return { kind: 'screenshot', pngBase64: buffer.toString('base64') }
        }
        case 'waitFor': {
          if (command.selector === undefined && command.url === undefined) {
            throw new BrowserError('waitFor requires a selector or a url', 'BROWSER_ACTION_FAILED')
          }
          const { page } = await this.requirePage(command.page)
          const timeout = command.timeoutMs ?? this.defaultTimeoutMs
          if (command.selector !== undefined) {
            const locator = elementLocator(page, parseSelector(command.selector), command.nth)
            await this.runLocatorAction('waitFor', locator, () => locator.waitFor({ state: 'visible', timeout }))
          } else {
            await page.waitForURL(command.url as string, { timeout })
          }
          return { kind: 'acked' }
        }
        case 'probe': {
          const { page, ref } = await this.requirePage(command.page)
          const url = page.url()
          const title = await page.title().catch(() => '')
          const selectorVisible = command.selector === undefined
            ? undefined
            : await elementLocator(page, parseSelector(command.selector)).first().isVisible().catch(() => false)
          return {
            kind: 'probe',
            page: ref,
            url,
            title,
            ...(selectorVisible === undefined ? {} : { selectorVisible }),
          }
        }
        case 'comment_publish': {
          const { page, ref } = await this.resolveForNavigate(command.page)
          const { value: result, openedPages } = await this.withPopupCapture(() =>
            executeCommentPublish(page, ref, command, {
              defaultTimeoutMs: this.defaultTimeoutMs,
              ...(signal === undefined ? {} : { signal }),
            }),
          )
          return openedPages.length > 0
            ? { ...result, popupPageRef: openedPages[openedPages.length - 1]!.ref, openedPages }
            : result
        }
        case 'directory_autofill': {
          const { page, ref } = command.url !== undefined
            ? await this.resolveForNavigate(command.page)
            : await this.requirePage(command.page)
          return await executeDirectoryAutofill(page, ref, command, {
            defaultTimeoutMs: this.defaultTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          })
        }
        case 'listPages': {
          // Adopt any untracked live non-keeper pages that may exist in the context.
          for (const ctxPage of this.context.pages()) {
            if (ctxPage === this.keeperPage || ctxPage.isClosed()) continue
            if (!this.pageToRef.has(ctxPage)) {
              this.adopt(ctxPage)
            }
          }
          const infos: BrowserPageInfo[] = []
          for (const [ref, p] of this.pages.entries()) {
            if (p.isClosed()) continue
            const meta = this.pageMeta.get(ref)
            const url = p.url()
            const title = await p.title().catch(() => '')
            infos.push({
              ref,
              url,
              title,
              isPopup: meta?.isPopup ?? false,
              ...(ref === this.lastRef ? { active: true } : {}),
            })
          }
          return { kind: 'pages', pages: infos }
        }
        case 'bringToFront': {
          const { page } = await this.requirePage(command.page)
          await bringPageWindowToFront(page)
          return { kind: 'acked' }
        }
        case 'closePage': {
          const { page, ref } = await this.requirePage(command.page)
          const openPages = this.context.pages().filter(p => !p.isClosed())
          const otherOpen = openPages.filter(p => p !== page)
          if (otherOpen.length === 0 && typeof this.context.newPage === 'function') {
            const blank = await this.createInternalPage()
            this.keeperPage = blank
            blank.on('close', () => {
              if (this.keeperPage === blank) this.keeperPage = undefined
            })
          }
          await page.close()
          this.removePageMapping(ref, page)
          return { kind: 'acked' }
        }
        default:
          return assertNever(command, 'unhandled browser command kind')
      }
    } catch (error) {
      if (error instanceof BrowserError) throw error
      throw new BrowserError(
        `playwright ${command.kind} failed: ${String(error instanceof Error ? error.message : error)}`,
        'BROWSER_ACTION_FAILED',
        { cause: error },
      )
    }
  }

  private async runLocatorAction<T>(
    commandKind: BrowserCommand['kind'],
    locator: Locator,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const enriched = await enrichStrictModeError(commandKind, locator, error)
      if (enriched !== undefined) throw enriched
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.context.close()
    } catch {
      // swallow: closing an already-dead browser
    }
  }

  private async withPopupCapture<T>(
    run: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly openedPages: readonly BrowserPageInfo[] }> {
    const captured: Array<{ readonly ref: string; readonly page: Page }> = []
    const collector = (entry: { readonly ref: string; readonly page: Page }) => {
      captured.push(entry)
    }
    this.popupCollectors.add(collector)
    try {
      const value = await run()
      await Promise.resolve()
      const openedPages: BrowserPageInfo[] = []
      for (const entry of captured) {
        if (entry.page.isClosed()) continue
        if (entry.page.url() === 'about:blank' && typeof entry.page.waitForLoadState === 'function') {
          await entry.page.waitForLoadState('domcontentloaded', { timeout: 300 }).catch(() => undefined)
        }
        const title = await entry.page.title().catch(() => '')
        openedPages.push({
          ref: entry.ref,
          url: entry.page.url(),
          title,
          isPopup: true,
        })
      }
      return { value, openedPages }
    } finally {
      this.popupCollectors.delete(collector)
    }
  }

  private async runClickWithSubmitFeedback(
    page: Page,
    runClick: () => Promise<void>,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserSubmitFeedback> {
    const beforeNotices = new Set<string>(
      typeof page.evaluate === 'function'
        ? await page.evaluate<string[]>(COLLECT_DOM_NOTICES_SCRIPT).catch(() => [])
        : [],
    )
    const dialogs: BrowserSubmitFeedbackDialog[] = []
    const networkResponses: BrowserSubmitFeedbackResponse[] = []
    const pendingBodyReads: Promise<void>[] = []

    const onDialog = (dialog: Dialog) => {
      dialogs.push({
        type: typeof dialog.type === 'function' ? dialog.type() : 'alert',
        message: (typeof dialog.message === 'function' ? dialog.message() : '').slice(0, 300),
      })
      if (typeof dialog.accept === 'function') {
        void dialog.accept().catch(() => undefined)
      }
    }

    const onResponse = (response: PwResponse) => {
      if (networkResponses.length >= 6) return
      const req = typeof response.request === 'function' ? response.request() : undefined
      const resourceType = typeof req?.resourceType === 'function' ? req.resourceType() : ''
      const method = typeof req?.method === 'function' ? req.method().toUpperCase() : 'GET'
      const url = typeof response.url === 'function' ? response.url() : ''
      if (STATIC_ASSET_URL_PATTERN.test(url)) return
      const isInteresting =
        resourceType === 'xhr'
        || resourceType === 'fetch'
        || method === 'POST'
        || method === 'PUT'
        || method === 'PATCH'
      if (!isInteresting) return

      const status = typeof response.status === 'function' ? response.status() : 0
      const headers = typeof response.headers === 'function' ? response.headers() : {}
      const contentType = headers['content-type'] ?? headers['Content-Type'] ?? ''
      const readTask = (async () => {
        let bodySnippet: string | undefined
        if (
          typeof response.text === 'function'
          && (contentType.length === 0 || /(?:json|text|xml|html|javascript)/iu.test(contentType))
        ) {
          const rawText = await response.text().catch(() => '')
          const cleaned = rawText.replace(/\s+/gu, ' ').trim()
          if (cleaned.length > 0) bodySnippet = cleaned.slice(0, 240)
        }
        networkResponses.push({
          url: url.slice(0, 180),
          status,
          ...(contentType ? { contentType: contentType.slice(0, 60) } : {}),
          ...(bodySnippet === undefined ? {} : { bodySnippet }),
        })
      })()
      pendingBodyReads.push(readTask)
    }

    const attachable = page as unknown as {
      on?: (event: string, listener: (...args: never[]) => void) => unknown
      off?: (event: string, listener: (...args: never[]) => void) => unknown
      removeListener?: (event: string, listener: (...args: never[]) => void) => unknown
    }
    attachable.on?.('dialog', onDialog as never)
    attachable.on?.('response', onResponse as never)

    try {
      await runClick().catch((error: unknown) => {
        if (isNavigationContextError(error)) return
        throw error
      })

      const clampedWait = Math.max(0, Math.min(waitMs, 5_000))
      if (clampedWait > 0) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new BrowserError('browser click aborted', 'BROWSER_ABORTED'))
            return
          }
          const onAbort = () => {
            clearTimeout(timer)
            reject(new BrowserError('browser click aborted', 'BROWSER_ABORTED'))
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, clampedWait)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }

      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: 1_000 }).catch(() => undefined)
      }
      await Promise.allSettled(pendingBodyReads)
    } finally {
      const detach = attachable.off ?? attachable.removeListener
      detach?.call(attachable, 'dialog', onDialog as never)
      detach?.call(attachable, 'response', onResponse as never)
    }

    const afterNotices = typeof page.evaluate === 'function'
      ? await page.evaluate<string[]>(COLLECT_DOM_NOTICES_SCRIPT).catch(() => [])
      : []
    const newNotices = afterNotices.filter(n => !beforeNotices.has(n))
    const domNotices = newNotices.length > 0 ? newNotices : afterNotices.slice(0, 3)

    const finalUrl = page.url()
    const title = await page.title().catch(() => '')

    return {
      ...(dialogs.length > 0 ? { dialogs } : {}),
      ...(networkResponses.length > 0 ? { networkResponses } : {}),
      ...(domNotices.length > 0 ? { domNotices } : {}),
      finalUrl,
      ...(title ? { title } : {}),
    }
  }

  private async createInternalPage(): Promise<Page> {
    this.creatingInternalPage++
    try {
      return await this.context.newPage()
    } finally {
      this.creatingInternalPage--
    }
  }

  private registerPage(ref: string, page: Page, isPopup: boolean): void {
    this.pages.set(ref, page)
    this.pageToRef.set(page, ref)
    this.pageMeta.set(ref, { isPopup })
    if (!isPopup) {
      this.lastRef = ref
    }
    page.on('close', () => {
      this.removePageMapping(ref, page)
    })
  }

  private removePageMapping(ref: string, page: Page): void {
    if (this.pages.get(ref) !== page) return
    this.pages.delete(ref)
    this.pageMeta.delete(ref)
    this.chains.delete(ref)
    if (this.lastRef === ref) {
      this.lastRef = this.findFallbackBusinessRef()
    }
  }

  private findFallbackBusinessRef(): string | undefined {
    let fallbackPopup: string | undefined
    for (const [candidateRef, candidatePage] of this.pages.entries()) {
      if (candidatePage.isClosed()) continue
      if (this.pageMeta.get(candidateRef)?.isPopup) {
        fallbackPopup = candidateRef
      } else {
        return candidateRef
      }
    }
    return fallbackPopup
  }

  private adopt(page: Page): string {
    const existingRef = this.pageToRef.get(page)
    if (existingRef !== undefined && this.pages.get(existingRef) === page) {
      this.lastRef = existingRef
      return existingRef
    }
    const ref = `p${++this.refSeq}`
    this.registerPage(ref, page, false)
    return ref
  }

  private async requirePage(ref: string | undefined): Promise<{ page: Page; ref: string }> {
    if (ref === undefined) {
      if (this.lastRef !== undefined) {
        const active = this.pages.get(this.lastRef)
        if (active !== undefined && !active.isClosed()) {
          return { page: active, ref: this.lastRef }
        }
      }
      const fallbackRef = this.findFallbackBusinessRef()
      if (fallbackRef !== undefined) {
        const fallbackPage = this.pages.get(fallbackRef)!
        this.lastRef = fallbackRef
        return { page: fallbackPage, ref: fallbackRef }
      }
      if (this.keeperPage !== undefined && !this.keeperPage.isClosed()) {
        const promoted = this.keeperPage
        this.keeperPage = undefined
        return { page: promoted, ref: this.adopt(promoted) }
      }
      const pages = this.context.pages().filter(p => !p.isClosed() && p !== this.keeperPage)
      const last = pages[pages.length - 1]
      if (last) {
        return { page: last, ref: this.adopt(last) }
      }
      const page = await this.createInternalPage()
      return { page, ref: this.adopt(page) }
    }
    const page = this.pages.get(ref)
    if (page === undefined || page.isClosed()) {
      throw new BrowserError(`browser page "${ref}" is not open`, 'BROWSER_ACTION_FAILED')
    }
    if (!this.pageMeta.get(ref)?.isPopup) {
      this.lastRef = ref
    }
    return { page, ref }
  }

  private async resolveForNavigate(ref: string | undefined): Promise<{ page: Page; ref: string }> {
    if (ref !== undefined) {
      const existing = this.pages.get(ref)
      if (existing !== undefined && !existing.isClosed()) {
        if (!this.pageMeta.get(ref)?.isPopup) {
          this.lastRef = ref
        }
        return { page: existing, ref }
      }
      if (this.keeperPage !== undefined && !this.keeperPage.isClosed()) {
        const page = this.keeperPage
        this.keeperPage = undefined
        this.registerPage(ref, page, false)
        return { page, ref }
      }
      const page = await this.createInternalPage()
      this.registerPage(ref, page, false)
      return { page, ref }
    }
    return await this.requirePage(undefined)
  }

  private async pageResult(
    page: Page,
    ref: string,
    maxChars: number,
    selector?: string,
  ): Promise<BrowserResult> {
    const [url, title, rawText] = await Promise.all([
      Promise.resolve(page.url()),
      page.title(),
      page.innerText(selector ?? 'body'),
    ])
    const { text, truncated } = truncate(rawText, maxChars)
    return { kind: 'page', page: ref, url, title, text, truncated }
  }
}

export class PlaywrightBrowserProvider implements BrowserAutomationProvider {
  readonly id = PLAYWRIGHT_BROWSER_PROVIDER_ID

  constructor(private readonly config: ResolvedPlaywrightConfig) {}

  available(): boolean {
    return true
  }

  async open(signal?: AbortSignal): Promise<BrowserSession> {
    throwIfAborted(signal, 'launch')
    assertPositiveInteger('defaultTimeoutMs', this.config.defaultTimeoutMs)
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(this.config.userDataDir, {
        headless: this.config.headless,
        timeout: this.config.defaultTimeoutMs,
        ...(this.config.channel.length > 0 ? { channel: this.config.channel } : {}),
        ...(this.config.executablePath !== undefined && this.config.executablePath.length > 0
          ? { executablePath: this.config.executablePath }
          : {}),
        ...(this.config.ignoreDefaultArgs.length > 0
          ? { ignoreDefaultArgs: [...this.config.ignoreDefaultArgs] }
          : {}),
        args: [
          ...(this.config.windowPosition === undefined
            ? []
            : [`--window-position=${this.config.windowPosition}`]),
          ...this.config.launchArgs,
        ],
      })
    } catch (error) {
      throw new BrowserError(
        `failed to launch the persistent browser profile at ${this.config.userDataDir}: ${String(error instanceof Error ? error.message : error)}`,
        'BROWSER_LAUNCH_FAILED',
        { cause: error },
      )
    }
    return new PlaywrightSession(context, this.config.defaultTimeoutMs, DEFAULT_SNAPSHOT_MAX_CHARS)
  }
}
