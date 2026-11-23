/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */

import { chromium } from 'playwright-core'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import { assertNever } from '../../shared/backlinks-types.ts'
import type {
  BrowserAutomationProvider,
  BrowserCommand,
  BrowserResult,
  BrowserSession,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { executeCommentPublish } from './comment-publish.ts'
import {
  COMPACT_TEXT_SCRIPT,
  compactAriaSnapshot,
  compactPlainText,
  formatCompactTextEvaluation,
} from './compact-snapshot.ts'
import { parseControlReport, renderPageControls, VISIBLE_CONTROLS_SCRIPT } from './interactive.ts'

export const PLAYWRIGHT_BROWSER_PROVIDER_ID = 'playwright'
export const DEFAULT_SNAPSHOT_MAX_CHARS = 60_000
export const STRICT_MODE_INSPECT_TIMEOUT_MS = 1_500
export const STRICT_MODE_MAX_CANDIDATES = 5

const STRICT_MODE_PATTERN = /strict mode violation/iu

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
  private readonly chains = new Map<string, Promise<unknown>>()
  private legacyTail: Promise<unknown> = Promise.resolve()
  private lastRef: string | undefined
  private refSeq = 0

  constructor(
    private readonly context: BrowserContext,
    private readonly defaultTimeoutMs: number,
    private readonly defaultMaxChars: number,
  ) {
    this.context.on('close', () => {
      this.closed = true
    })
    for (const existing of this.context.pages()) {
      this.adopt(existing)
    }
  }

  async act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    throwIfAborted(signal, command.kind)
    if (this.closed) {
      throw new BrowserError('browser session is closed', 'BROWSER_ACTION_FAILED')
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
          await page.goto(command.url, {
            timeout: command.timeoutMs ?? this.defaultTimeoutMs,
            ...(command.waitUntil === undefined ? {} : { waitUntil: command.waitUntil }),
          })
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
          if (addressing.mode === 'xy') {
            await page.mouse.click(addressing.x, addressing.y)
            return { kind: 'acked' }
          }
          const locator = elementLocator(page, addressing, command.nth)
          await this.runLocatorAction('click', locator, () => locator.click({ timeout: this.defaultTimeoutMs }))
          return { kind: 'acked' }
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
          return await executeCommentPublish(page, ref, command, {
            defaultTimeoutMs: this.defaultTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          })
        }
        case 'bringToFront': {
          const { page } = await this.requirePage(command.page)
          await bringPageWindowToFront(page)
          return { kind: 'acked' }
        }
        case 'closePage': {
          const { page, ref } = await this.requirePage(command.page)
          await page.close()
          this.pages.delete(ref)
          this.chains.delete(ref)
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

  private adopt(page: Page): string {
    const ref = `p${++this.refSeq}`
    this.pages.set(ref, page)
    this.lastRef = ref
    page.on('close', () => {
      this.pages.delete(ref)
    })
    return ref
  }

  private async requirePage(ref: string | undefined): Promise<{ page: Page; ref: string }> {
    if (ref === undefined) {
      const pages = this.context.pages()
      const last = pages[pages.length - 1]
      if (last) {
        if (this.pages.get(this.lastRef ?? '') !== last) {
          this.adopt(last)
        }
        return { page: last, ref: this.lastRef as string }
      }
      const page = await this.context.newPage()
      return { page, ref: this.adopt(page) }
    }
    const page = this.pages.get(ref)
    if (page === undefined || page.isClosed()) {
      throw new BrowserError(`browser page "${ref}" is not open`, 'BROWSER_ACTION_FAILED')
    }
    this.lastRef = ref
    return { page, ref }
  }

  private async resolveForNavigate(ref: string | undefined): Promise<{ page: Page; ref: string }> {
    if (ref !== undefined) {
      const existing = this.pages.get(ref)
      if (existing !== undefined && !existing.isClosed()) {
        this.lastRef = ref
        return { page: existing, ref }
      }
      const page = await this.context.newPage()
      this.pages.set(ref, page)
      this.lastRef = ref
      page.on('close', () => {
        this.pages.delete(ref)
      })
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
