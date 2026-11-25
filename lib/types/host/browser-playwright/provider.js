/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */
import { chromium } from 'playwright-core';
import { assertNever } from "../../shared/backlinks-types.js";
import { BrowserError } from "../browser/types.js";
import { DEFAULT_WIX_NAV_TIMEOUT_MS, executeCommentPublish, isNavigationContextError, navigateWixWithCommit } from "./comment-publish.js";
import { COMPACT_TEXT_SCRIPT, compactAriaSnapshot, compactPlainText, formatCompactTextEvaluation, } from "./compact-snapshot.js";
import { executeDirectoryAutofill } from "./directory-autofill.js";
import { parseControlReport, renderPageControls, VISIBLE_CONTROLS_SCRIPT } from "./interactive.js";
export const PLAYWRIGHT_BROWSER_PROVIDER_ID = 'playwright';
export const DEFAULT_SNAPSHOT_MAX_CHARS = 60_000;
export const STRICT_MODE_INSPECT_TIMEOUT_MS = 1_500;
export const STRICT_MODE_MAX_CANDIDATES = 5;
export const DEFAULT_SUBMIT_FEEDBACK_WAIT_MS = 2_000;
const RECYCLE_PAGE_IO_TIMEOUT_MS = 3_000;
export class BrowserDeadlineError extends BrowserError {
    action;
    pageRef;
    deadlineMs;
    elapsedMs;
    pageRecycled;
    constructor(params) {
        super(`browser ${params.action} exceeded hard deadline (${params.deadlineMs}ms)`, 'BROWSER_TIMEOUT');
        this.name = 'BrowserDeadlineError';
        this.action = params.action;
        this.pageRef = params.pageRef;
        this.deadlineMs = params.deadlineMs;
        this.elapsedMs = params.elapsedMs;
        this.pageRecycled = params.pageRecycled;
    }
}
async function settleWithTimeout(promise, timeoutMs, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
const STRICT_MODE_PATTERN = /strict mode violation/iu;
const NAVIGATE_TIMEOUT_PATTERN = /timeout|timed\s+out/iu;
const STATIC_ASSET_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|js|map)(?:[?#]|$)|google-analytics|googletagmanager|doubleclick|fonts\.googleapis/iu;
const COLLECT_DOM_NOTICES_SCRIPT = String.raw `(() => {
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
})()`;
async function bringPageWindowToFront(page) {
    // Restore minimized or offscreen (-32000,-32000) desktop Chrome windows across Windows and macOS.
    try {
        const client = await page.context().newCDPSession(page);
        try {
            const info = await client.send('Browser.getWindowForTarget');
            const windowId = info?.windowId;
            const bounds = info?.bounds;
            if (windowId !== undefined && bounds !== undefined) {
                if (bounds.windowState !== undefined && bounds.windowState !== 'normal') {
                    await client.send('Browser.setWindowBounds', {
                        windowId,
                        bounds: { windowState: 'normal' },
                    });
                }
                const offscreen = bounds.left === undefined
                    || bounds.top === undefined
                    || bounds.left < 0
                    || bounds.top < 0
                    || bounds.left > 4000
                    || bounds.top > 4000;
                if (offscreen) {
                    await client.send('Browser.setWindowBounds', {
                        windowId,
                        bounds: {
                            left: 80,
                            top: 80,
                            width: Math.max(bounds.width ?? 1280, 1024),
                            height: Math.max(bounds.height ?? 860, 720),
                        },
                    });
                }
            }
        }
        finally {
            await client.detach().catch(() => undefined);
        }
    }
    catch {
        // Non-CDP browsers/tests still fall back cleanly to Playwright bringToFront().
    }
    await page.bringToFront();
}
function assertPositiveInteger(name, value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`browser-playwright: ${name} must be a positive integer, got ${value}`);
    }
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}
function parseSelector(raw) {
    let rest = raw;
    const frames = [];
    while (true) {
        const frame = /^frame\((.+)\)>>/u.exec(rest);
        if (frame === null)
            break;
        frames.push(frame[1]);
        rest = rest.slice(frame[0].length);
    }
    const prefixed = /^(role|label|placeholder|text|xy):(.*)$/su.exec(rest);
    if (prefixed === null)
        return { mode: 'css', frames, value: rest };
    const kind = prefixed[1];
    const body = prefixed[2];
    if (kind === 'xy') {
        const xy = /^(\d+),(\d+)$/u.exec(body);
        if (xy === null) {
            throw new BrowserError(`browser xy selector must be xy:<x>,<y> with non-negative integers, got "${raw}"`, 'BROWSER_ACTION_FAILED');
        }
        return { mode: 'xy', frames, x: Number(xy[1]), y: Number(xy[2]) };
    }
    if (kind === 'role') {
        const split = body.indexOf('|');
        if (split < 0)
            return { mode: 'role', frames, value: body };
        const role = body.slice(0, split);
        const name = body.slice(split + 1);
        if (role.length === 0 || name.length === 0) {
            throw new BrowserError(`browser role selector must be role:<role>|<name> with both non-empty, got "${raw}"`, 'BROWSER_ACTION_FAILED');
        }
        return { mode: 'role', frames, value: role, name };
    }
    if (body.length === 0) {
        throw new BrowserError(`browser ${kind} selector must be ${kind}:<text> with non-empty text`, 'BROWSER_ACTION_FAILED');
    }
    return { mode: kind, frames, value: body };
}
function buildLocator(page, addressing) {
    if (addressing.mode === 'xy')
        return undefined;
    let root = page;
    for (const frame of addressing.frames) {
        root = root.frameLocator(frame);
    }
    switch (addressing.mode) {
        case 'css':
            return root.locator(addressing.value);
        case 'role':
            return root.getByRole(addressing.value, ...(addressing.name === undefined ? [] : [{ name: addressing.name }]));
        case 'label':
            return root.getByLabel(addressing.value);
        case 'placeholder':
            return root.getByPlaceholder(addressing.value);
        case 'text':
            return root.getByText(addressing.value);
        default:
            return assertNever(addressing, 'unhandled selector addressing');
    }
}
function applyNth(locator, nth) {
    if (nth === undefined)
        return locator;
    if (!Number.isSafeInteger(nth) || nth < 0) {
        throw new BrowserError(`browser nth must be a non-negative integer, got ${nth}`, 'BROWSER_ACTION_FAILED');
    }
    return locator.nth(nth);
}
function elementLocator(page, addressing, nth) {
    const locator = buildLocator(page, addressing);
    if (locator === undefined) {
        throw new BrowserError('browser xy addressing supports click only', 'BROWSER_ACTION_FAILED');
    }
    return applyNth(locator, nth);
}
const CAPTCHA_RESPONSE_FIELD_PATTERN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/iu;
async function isCaptchaResponseLocator(locator) {
    const probe = locator;
    if (typeof probe.getAttribute !== 'function')
        return false;
    const [nameAttr, idAttr] = await Promise.all([
        probe.getAttribute('name').catch(() => null),
        probe.getAttribute('id').catch(() => null),
    ]);
    return Boolean((nameAttr && CAPTCHA_RESPONSE_FIELD_PATTERN.test(nameAttr.trim()))
        || (idAttr && CAPTCHA_RESPONSE_FIELD_PATTERN.test(idAttr.trim())));
}
/**
 * Resolve a visible, non-CAPTCHA-response locator when `nth` is omitted so hidden
 * modals and hidden `textarea[name="g-recaptcha-response"]` fields never trigger
 * strict-mode conflicts while preserving exact unique visible selectors and
 * multi-visible strict-mode diagnostics.
 */
export async function resolvePreferredVisibleLocator(locator, nth) {
    if (nth !== undefined)
        return locator;
    const probe = locator;
    if (typeof probe.count !== 'function' || typeof probe.nth !== 'function')
        return locator;
    const total = await probe.count().catch(() => 0);
    if (!Number.isFinite(total) || total <= 0)
        return locator;
    if (total === 1) {
        const only = probe.nth(0);
        if (await isCaptchaResponseLocator(only)) {
            throw new BrowserError('skipped hidden captcha response field (g-recaptcha-response / h-captcha-response)', 'BROWSER_ACTION_FAILED');
        }
        return locator;
    }
    const limit = Math.min(total, 20);
    const visibleMatches = [];
    for (let index = 0; index < limit; index++) {
        const candidate = probe.nth(index);
        if (await isCaptchaResponseLocator(candidate))
            continue;
        const visible = typeof candidate.isVisible === 'function'
            ? await candidate.isVisible().catch(() => false)
            : false;
        if (visible) {
            visibleMatches.push(candidate);
        }
    }
    if (visibleMatches.length === 1) {
        return visibleMatches[0];
    }
    return locator;
}
export async function inspectStrictModeCandidates(locator, timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS) {
    let timer;
    const inspect = async () => {
        const total = await locator.count();
        if (!Number.isFinite(total) || total <= 0)
            return undefined;
        const limit = Math.min(total, STRICT_MODE_MAX_CANDIDATES);
        const evalTimeout = Math.max(100, Math.min(timeoutMs, 1_000));
        const candidates = await Promise.all(Array.from({ length: limit }, async (_, index) => {
            const nthLocator = locator.nth(index);
            const [meta, visible] = await Promise.all([
                nthLocator.evaluate((rawNode) => {
                    const el = rawNode;
                    if (!el || typeof el.tagName !== 'string') {
                        return { tag: 'unknown' };
                    }
                    const tag = el.tagName.toLowerCase();
                    const attr = (key) => {
                        const raw = typeof el.getAttribute === 'function' ? el.getAttribute(key) : null;
                        if (typeof raw !== 'string')
                            return undefined;
                        const cleaned = raw.replace(/\s+/gu, ' ').trim();
                        return cleaned.length > 0 ? cleaned.slice(0, 80) : undefined;
                    };
                    const typeAttr = attr('type');
                    const explicitRole = attr('role');
                    const inferredRole = explicitRole ?? (tag === 'button' || (tag === 'input' && (typeAttr === 'button' || typeAttr === 'submit' || typeAttr === 'reset'))
                        ? 'button'
                        : tag === 'a' && attr('href') !== undefined
                            ? 'link'
                            : tag === 'input' || tag === 'textarea'
                                ? 'textbox'
                                : tag === 'select'
                                    ? 'combobox'
                                    : undefined);
                    const rawText = typeof el.innerText === 'string' && el.innerText.trim().length > 0
                        ? el.innerText
                        : typeof el.textContent === 'string'
                            ? el.textContent
                            : '';
                    const cleanedText = rawText.replace(/\s+/gu, ' ').trim();
                    const text = cleanedText.length > 0
                        ? (cleanedText.length > 80 ? `${cleanedText.slice(0, 80)}…` : cleanedText)
                        : undefined;
                    const ariaLabel = attr('aria-label');
                    const name = attr('name');
                    return {
                        tag,
                        ...(inferredRole === undefined ? {} : { role: inferredRole }),
                        ...(text === undefined ? {} : { text }),
                        ...(ariaLabel === undefined ? {} : { ariaLabel }),
                        ...(name === undefined ? {} : { name }),
                        ...(typeAttr === undefined ? {} : { type: typeAttr }),
                    };
                }, undefined, { timeout: evalTimeout }).catch(() => ({ tag: 'unknown' })),
                nthLocator.isVisible().catch(() => undefined),
            ]);
            return {
                index,
                ...meta,
                ...(visible === undefined ? {} : { visible }),
            };
        }));
        return { total, candidates };
    };
    try {
        return await Promise.race([
            inspect().catch(() => undefined),
            new Promise((resolve) => {
                timer = setTimeout(() => { resolve(undefined); }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function formatStrictModeCandidates(inspection) {
    const lines = [
        `Matched ${inspection.total} element(s) (showing first ${inspection.candidates.length}):`,
    ];
    for (const candidate of inspection.candidates) {
        const parts = [`  [${candidate.index}] <${candidate.tag}>`];
        if (candidate.role !== undefined)
            parts.push(`role=${candidate.role}`);
        if (candidate.type !== undefined)
            parts.push(`type=${candidate.type}`);
        if (candidate.text !== undefined)
            parts.push(`text=${JSON.stringify(candidate.text)}`);
        if (candidate.ariaLabel !== undefined)
            parts.push(`aria-label=${JSON.stringify(candidate.ariaLabel)}`);
        if (candidate.name !== undefined)
            parts.push(`name=${JSON.stringify(candidate.name)}`);
        if (candidate.visible !== undefined)
            parts.push(`visible=${String(candidate.visible)}`);
        lines.push(parts.join(' '));
    }
    const suggested = inspection.candidates.find(c => c.visible !== false && c.role !== undefined && (c.ariaLabel !== undefined || c.text !== undefined)) ?? inspection.candidates.find(c => c.role !== undefined && (c.ariaLabel !== undefined || c.text !== undefined));
    const label = suggested?.ariaLabel ?? suggested?.text;
    if (suggested !== undefined && suggested.role !== undefined && label !== undefined) {
        lines.push(`Hint: pass nth: <i> (0-based, e.g. nth: ${suggested.index}) or use an exact selector such as role:${suggested.role}|${label}.`);
    }
    else {
        lines.push('Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.');
    }
    return lines.join('\n');
}
export async function enrichStrictModeError(commandKind, locator, error, timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS) {
    const rawMessage = String(error instanceof Error ? error.message : error);
    if (!STRICT_MODE_PATTERN.test(rawMessage))
        return undefined;
    const inspection = await inspectStrictModeCandidates(locator, timeoutMs);
    const details = inspection !== undefined && inspection.candidates.length > 0
        ? formatStrictModeCandidates(inspection)
        : 'Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.';
    return new BrowserError(`playwright ${commandKind} failed: ${rawMessage}\n${details}`, 'BROWSER_ACTION_FAILED', { cause: error });
}
function throwIfAborted(signal, commandKind) {
    if (signal?.aborted) {
        throw new BrowserError(`browser ${commandKind} aborted`, 'BROWSER_ABORTED');
    }
}
export class PlaywrightSession {
    context;
    defaultTimeoutMs;
    defaultMaxChars;
    closed = false;
    pages = new Map();
    pageToRef = new WeakMap();
    pageMeta = new Map();
    chains = new Map();
    popupCollectors = new Set();
    keeperPage;
    creatingInternalPage = 0;
    legacyTail = Promise.resolve();
    lastRef;
    refSeq = 0;
    popupSeq = 0;
    constructor(context, defaultTimeoutMs, defaultMaxChars) {
        this.context = context;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.defaultMaxChars = defaultMaxChars;
        this.context.on('close', () => {
            this.closed = true;
        });
        this.context.on('page', (newPage) => {
            if (this.creatingInternalPage > 0)
                return;
            if (newPage === this.keeperPage || this.pageToRef.has(newPage))
                return;
            const ref = `popup${++this.popupSeq}`;
            this.registerPage(ref, newPage, true);
            for (const collector of this.popupCollectors) {
                collector({ ref, page: newPage });
            }
        });
        for (const existing of this.context.pages()) {
            this.adopt(existing);
        }
    }
    isClosed() {
        return this.closed;
    }
    async act(command, signal) {
        throwIfAborted(signal, command.kind);
        if (this.closed) {
            throw new BrowserError('browser session is closed', 'BROWSER_ACTION_FAILED');
        }
        if (command.kind === 'listPages') {
            return await this.execute(command, signal);
        }
        return await (command.page === undefined
            ? this.chained(this.legacyTail, (tail) => { this.legacyTail = tail; }, command, signal)
            : this.chained(this.chains.get(command.page) ?? Promise.resolve(), (tail) => { this.chains.set(command.page, tail); }, command, signal));
    }
    chained(previous, store, command, signal) {
        const next = previous.then(() => this.executeWithDeadline(command, signal));
        store(next.catch(() => undefined));
        return next;
    }
    async recyclePage(ref) {
        if (this.closed)
            return false;
        let targetRef = ref;
        let targetPage = targetRef !== undefined ? this.pages.get(targetRef) : undefined;
        if (targetPage === undefined && targetRef === undefined) {
            if (this.lastRef !== undefined) {
                targetRef = this.lastRef;
                targetPage = this.pages.get(this.lastRef);
            }
            if (targetPage === undefined) {
                const fallbackRef = this.findFallbackBusinessRef();
                if (fallbackRef !== undefined) {
                    targetRef = fallbackRef;
                    targetPage = this.pages.get(fallbackRef);
                }
            }
        }
        if (targetRef === undefined || targetPage === undefined) {
            return false;
        }
        // Evict immediately so the next command never reuses a frozen tab or stalled chain.
        this.removePageMapping(targetRef, targetPage);
        if (typeof targetPage.isClosed === 'function' && targetPage.isClosed()) {
            return true;
        }
        try {
            const openPages = this.context.pages().filter(p => !p.isClosed());
            const otherOpen = openPages.filter(p => p !== targetPage);
            if (otherOpen.length === 0 && typeof this.context.newPage === 'function') {
                const blank = await settleWithTimeout(this.createInternalPage().then(p => p), RECYCLE_PAGE_IO_TIMEOUT_MS, undefined);
                if (blank !== undefined) {
                    this.keeperPage = blank;
                    blank.on('close', () => {
                        if (this.keeperPage === blank)
                            this.keeperPage = undefined;
                    });
                }
            }
        }
        catch {
            // Best-effort keeper creation; proceed to close hung page safely.
        }
        if (typeof targetPage.close === 'function') {
            await settleWithTimeout(targetPage.close().then(() => true), RECYCLE_PAGE_IO_TIMEOUT_MS, false);
        }
        return true;
    }
    async executeWithDeadline(command, signal) {
        const deadlineMs = command.deadlineMs;
        if (deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
            return await this.execute(command, signal);
        }
        const startedAt = Date.now();
        const controller = new AbortController();
        const onExternalAbort = () => {
            controller.abort();
        };
        if (signal?.aborted) {
            controller.abort();
        }
        else if (signal) {
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
        const execPromise = this.execute(command, controller.signal);
        // Prevent unhandled rejection if deadline wins and late Playwright errors reject after page.close().
        execPromise.catch(() => undefined);
        let timer;
        const timeoutMarker = Symbol('deadline_exceeded');
        try {
            const raced = await Promise.race([
                execPromise,
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(timeoutMarker), deadlineMs);
                }),
            ]);
            if (raced !== timeoutMarker) {
                return raced;
            }
            controller.abort();
            const pageRef = command.page ?? this.lastRef ?? 'p1';
            const pageRecycled = await this.recyclePage(command.page);
            const elapsedMs = Date.now() - startedAt;
            if (command.kind === 'comment_publish') {
                const siteType = command.siteHint === 'wix_blog'
                    ? 'wix'
                    : command.siteHint === 'wordpress_comment'
                        ? 'wordpress'
                        : command.siteHint === 'typecho_comment'
                            ? 'typecho'
                            : 'other';
                return {
                    kind: 'comment_publish',
                    page: pageRef,
                    outcome: 'timeout',
                    retryable: true,
                    reason: 'tool_deadline_exceeded',
                    siteType,
                    title: '',
                    finalUrl: command.url,
                    submitTriggered: false,
                    pageRecycled,
                    deadlineMs,
                    elapsedMs,
                    evidence: `comment_publish 超过硬截止 ${deadlineMs}ms，已自动回收卡死页签 (pageRecycled=${String(pageRecycled)})`,
                };
            }
            throw new BrowserDeadlineError({
                action: command.kind,
                pageRef,
                deadlineMs,
                elapsedMs,
                pageRecycled,
            });
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            if (signal)
                signal.removeEventListener('abort', onExternalAbort);
        }
    }
    async execute(command, signal) {
        throwIfAborted(signal, command.kind);
        try {
            switch (command.kind) {
                case 'navigate': {
                    const { page, ref } = await this.resolveForNavigate(command.page);
                    const baseTimeout = command.timeoutMs ?? this.defaultTimeoutMs;
                    const isWixHint = command.siteHint === 'wix_blog';
                    const timeout = isWixHint
                        ? Math.max(baseTimeout, DEFAULT_WIX_NAV_TIMEOUT_MS)
                        : baseTimeout;
                    const requestedWaitUntil = command.waitUntil;
                    if (requestedWaitUntil === undefined && isWixHint) {
                        await navigateWixWithCommit(page, command.url, {
                            timeoutMs: timeout,
                            ...(signal === undefined ? {} : { signal }),
                        });
                    }
                    else if (requestedWaitUntil === undefined) {
                        await page.goto(command.url, { timeout, waitUntil: 'domcontentloaded' });
                    }
                    else {
                        try {
                            await page.goto(command.url, { timeout, waitUntil: requestedWaitUntil });
                        }
                        catch (error) {
                            if (requestedWaitUntil !== 'domcontentloaded' && requestedWaitUntil !== 'commit' && NAVIGATE_TIMEOUT_PATTERN.test(String(error instanceof Error ? error.message : error))) {
                                const readyState = typeof page.evaluate === 'function'
                                    ? await page.evaluate(() => globalThis.document?.readyState ?? '').catch(() => '')
                                    : '';
                                const currentUrl = page.url();
                                if ((readyState === 'interactive' || readyState === 'complete')
                                    && currentUrl.length > 0
                                    && currentUrl !== 'about:blank') {
                                    return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
                                }
                            }
                            throw error;
                        }
                    }
                    return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
                }
                case 'snapshot': {
                    const { page, ref } = await this.requirePage(command.page);
                    const maxChars = command.maxChars ?? this.defaultMaxChars;
                    const isCompact = command.compact === true;
                    if (command.format === 'aria') {
                        const tree = await page.locator(command.selector ?? 'body').ariaSnapshot();
                        const title = await page.title();
                        if (isCompact) {
                            const compacted = compactAriaSnapshot(tree, maxChars);
                            return {
                                kind: 'page',
                                page: ref,
                                url: page.url(),
                                title,
                                text: compacted.text,
                                truncated: compacted.truncated,
                                compactSummary: compacted.compactSummary,
                            };
                        }
                        const { text, truncated } = truncate(tree, maxChars);
                        return { kind: 'page', page: ref, url: page.url(), title, text, truncated };
                    }
                    if (command.format === 'interactive') {
                        const report = parseControlReport(await page.evaluate(VISIBLE_CONTROLS_SCRIPT));
                        const title = await page.title();
                        const rawRendered = renderPageControls(title, report);
                        const rendered = isCompact
                            ? renderPageControls(title, report, { compact: true })
                            : rawRendered;
                        const { text, truncated } = truncate(rendered, maxChars);
                        const compactSummary = isCompact
                            ? `controls=${report.controls.length} forms=${report.forms} (raw=${rawRendered.length}c -> ${rendered.length}c)`
                            : undefined;
                        return {
                            kind: 'page',
                            page: ref,
                            url: page.url(),
                            title,
                            text,
                            truncated: truncated || report.truncated,
                            ...(compactSummary === undefined ? {} : { compactSummary }),
                        };
                    }
                    if (isCompact) {
                        if (command.selector === undefined && typeof page.evaluate === 'function') {
                            try {
                                const evalPayload = await page.evaluate(COMPACT_TEXT_SCRIPT);
                                const compacted = formatCompactTextEvaluation(evalPayload, maxChars);
                                return {
                                    kind: 'page',
                                    page: ref,
                                    url: page.url(),
                                    title: await page.title(),
                                    text: compacted.text,
                                    truncated: compacted.truncated,
                                    compactSummary: compacted.compactSummary,
                                };
                            }
                            catch {
                                // Fall back to innerText compression when page.evaluate fails or returns unexpected output.
                            }
                        }
                        const [url, title, rawText] = await Promise.all([
                            Promise.resolve(page.url()),
                            page.title(),
                            page.innerText(command.selector ?? 'body'),
                        ]);
                        const compacted = compactPlainText(rawText, maxChars);
                        return {
                            kind: 'page',
                            page: ref,
                            url,
                            title,
                            text: compacted.text,
                            truncated: compacted.truncated,
                            compactSummary: compacted.compactSummary,
                        };
                    }
                    return await this.pageResult(page, ref, maxChars, command.selector);
                }
                case 'click': {
                    const { page } = await this.requirePage(command.page);
                    const addressing = parseSelector(command.selector);
                    const runClick = async () => {
                        if (addressing.mode === 'xy') {
                            await page.mouse.click(addressing.x, addressing.y);
                            return;
                        }
                        const rawLocator = elementLocator(page, addressing, command.nth);
                        const locator = await resolvePreferredVisibleLocator(rawLocator, command.nth);
                        await this.runLocatorAction('click', locator, () => locator.click({ timeout: this.defaultTimeoutMs }));
                    };
                    if (command.captureSubmitFeedback === true) {
                        const { value: submitFeedback, openedPages } = await this.withPopupCapture(() => this.runClickWithSubmitFeedback(page, runClick, command.feedbackWaitMs ?? DEFAULT_SUBMIT_FEEDBACK_WAIT_MS, signal));
                        return {
                            kind: 'acked',
                            submitFeedback,
                            ...(openedPages.length > 0 ? { popupPageRef: openedPages[openedPages.length - 1].ref, openedPages } : {}),
                        };
                    }
                    const { openedPages } = await this.withPopupCapture(runClick);
                    return {
                        kind: 'acked',
                        ...(openedPages.length > 0 ? { popupPageRef: openedPages[openedPages.length - 1].ref, openedPages } : {}),
                    };
                }
                case 'fill': {
                    const { page } = await this.requirePage(command.page);
                    const rawLocator = elementLocator(page, parseSelector(command.selector), command.nth);
                    const locator = await resolvePreferredVisibleLocator(rawLocator, command.nth);
                    await this.runLocatorAction('fill', locator, () => locator.fill(command.value, { timeout: this.defaultTimeoutMs }));
                    return { kind: 'acked' };
                }
                case 'select': {
                    const { page } = await this.requirePage(command.page);
                    const rawLocator = elementLocator(page, parseSelector(command.selector), command.nth);
                    const locator = await resolvePreferredVisibleLocator(rawLocator, command.nth);
                    await this.runLocatorAction('select', locator, () => locator.selectOption(command.value, { timeout: this.defaultTimeoutMs }));
                    return { kind: 'acked' };
                }
                case 'check': {
                    const { page } = await this.requirePage(command.page);
                    const rawLocator = elementLocator(page, parseSelector(command.selector), command.nth);
                    const locator = await resolvePreferredVisibleLocator(rawLocator, command.nth);
                    await this.runLocatorAction('check', locator, () => locator.check({ timeout: this.defaultTimeoutMs }));
                    return { kind: 'acked' };
                }
                case 'press': {
                    const { page } = await this.requirePage(command.page);
                    await page.keyboard.press(command.key);
                    return { kind: 'acked' };
                }
                case 'upload': {
                    const { page } = await this.requirePage(command.page);
                    const locator = elementLocator(page, parseSelector(command.selector), command.nth);
                    await this.runLocatorAction('upload', locator, () => locator.setInputFiles([...command.files], { timeout: this.defaultTimeoutMs }));
                    return { kind: 'acked' };
                }
                case 'screenshot': {
                    const { page } = await this.requirePage(command.page);
                    const buffer = await page.screenshot({ type: 'png', timeout: this.defaultTimeoutMs });
                    return { kind: 'screenshot', pngBase64: buffer.toString('base64') };
                }
                case 'waitFor': {
                    if (command.selector === undefined && command.url === undefined) {
                        throw new BrowserError('waitFor requires a selector or a url', 'BROWSER_ACTION_FAILED');
                    }
                    const { page } = await this.requirePage(command.page);
                    const timeout = command.timeoutMs ?? this.defaultTimeoutMs;
                    if (command.selector !== undefined) {
                        const locator = elementLocator(page, parseSelector(command.selector), command.nth);
                        await this.runLocatorAction('waitFor', locator, () => locator.waitFor({ state: 'visible', timeout }));
                    }
                    else {
                        await page.waitForURL(command.url, { timeout });
                    }
                    return { kind: 'acked' };
                }
                case 'probe': {
                    const { page, ref } = await this.requirePage(command.page);
                    const url = page.url();
                    const title = await page.title().catch(() => '');
                    const selectorVisible = command.selector === undefined
                        ? undefined
                        : await elementLocator(page, parseSelector(command.selector)).first().isVisible().catch(() => false);
                    return {
                        kind: 'probe',
                        page: ref,
                        url,
                        title,
                        ...(selectorVisible === undefined ? {} : { selectorVisible }),
                    };
                }
                case 'comment_publish': {
                    const { page, ref } = await this.resolveForNavigate(command.page);
                    const { value: result, openedPages } = await this.withPopupCapture(() => executeCommentPublish(page, ref, command, {
                        defaultTimeoutMs: this.defaultTimeoutMs,
                        ...(command.deadlineMs === undefined ? {} : { deadlineMs: command.deadlineMs }),
                        ...(signal === undefined ? {} : { signal }),
                    }));
                    return openedPages.length > 0
                        ? { ...result, popupPageRef: openedPages[openedPages.length - 1].ref, openedPages }
                        : result;
                }
                case 'directory_autofill': {
                    const { page, ref } = command.url !== undefined
                        ? await this.resolveForNavigate(command.page)
                        : await this.requirePage(command.page);
                    return await executeDirectoryAutofill(page, ref, command, {
                        defaultTimeoutMs: this.defaultTimeoutMs,
                        ...(command.deadlineMs === undefined ? {} : { deadlineMs: command.deadlineMs }),
                        ...(signal === undefined ? {} : { signal }),
                    });
                }
                case 'listPages': {
                    // Adopt any untracked live non-keeper pages that may exist in the context.
                    for (const ctxPage of this.context.pages()) {
                        if (ctxPage === this.keeperPage || ctxPage.isClosed())
                            continue;
                        if (!this.pageToRef.has(ctxPage)) {
                            this.adopt(ctxPage);
                        }
                    }
                    const infos = [];
                    for (const [ref, p] of this.pages.entries()) {
                        if (p.isClosed())
                            continue;
                        const meta = this.pageMeta.get(ref);
                        const url = p.url();
                        const title = await p.title().catch(() => '');
                        infos.push({
                            ref,
                            url,
                            title,
                            isPopup: meta?.isPopup ?? false,
                            ...(ref === this.lastRef ? { active: true } : {}),
                        });
                    }
                    return { kind: 'pages', pages: infos };
                }
                case 'bringToFront': {
                    const { page } = await this.requirePage(command.page);
                    await bringPageWindowToFront(page);
                    return { kind: 'acked' };
                }
                case 'closePage': {
                    const { page, ref } = await this.requirePage(command.page);
                    const openPages = this.context.pages().filter(p => !p.isClosed());
                    const otherOpen = openPages.filter(p => p !== page);
                    if (otherOpen.length === 0 && typeof this.context.newPage === 'function') {
                        const blank = await this.createInternalPage();
                        this.keeperPage = blank;
                        blank.on('close', () => {
                            if (this.keeperPage === blank)
                                this.keeperPage = undefined;
                        });
                    }
                    await page.close();
                    this.removePageMapping(ref, page);
                    return { kind: 'acked' };
                }
                default:
                    return assertNever(command, 'unhandled browser command kind');
            }
        }
        catch (error) {
            if (error instanceof BrowserError)
                throw error;
            throw new BrowserError(`playwright ${command.kind} failed: ${String(error instanceof Error ? error.message : error)}`, 'BROWSER_ACTION_FAILED', { cause: error });
        }
    }
    async runLocatorAction(commandKind, locator, run) {
        try {
            return await run();
        }
        catch (error) {
            const enriched = await enrichStrictModeError(commandKind, locator, error);
            if (enriched !== undefined)
                throw enriched;
            throw error;
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            await this.context.close();
        }
        catch {
            // swallow: closing an already-dead browser
        }
    }
    async withPopupCapture(run) {
        const captured = [];
        const collector = (entry) => {
            captured.push(entry);
        };
        this.popupCollectors.add(collector);
        try {
            const value = await run();
            await Promise.resolve();
            const openedPages = [];
            for (const entry of captured) {
                if (entry.page.isClosed())
                    continue;
                if (entry.page.url() === 'about:blank' && typeof entry.page.waitForLoadState === 'function') {
                    await entry.page.waitForLoadState('domcontentloaded', { timeout: 300 }).catch(() => undefined);
                }
                const title = await entry.page.title().catch(() => '');
                openedPages.push({
                    ref: entry.ref,
                    url: entry.page.url(),
                    title,
                    isPopup: true,
                });
            }
            return { value, openedPages };
        }
        finally {
            this.popupCollectors.delete(collector);
        }
    }
    async runClickWithSubmitFeedback(page, runClick, waitMs, signal) {
        const beforeNotices = new Set(typeof page.evaluate === 'function'
            ? await page.evaluate(COLLECT_DOM_NOTICES_SCRIPT).catch(() => [])
            : []);
        const dialogs = [];
        const networkResponses = [];
        const pendingBodyReads = [];
        const onDialog = (dialog) => {
            dialogs.push({
                type: typeof dialog.type === 'function' ? dialog.type() : 'alert',
                message: (typeof dialog.message === 'function' ? dialog.message() : '').slice(0, 300),
            });
            if (typeof dialog.accept === 'function') {
                void dialog.accept().catch(() => undefined);
            }
        };
        const onResponse = (response) => {
            if (networkResponses.length >= 6)
                return;
            const req = typeof response.request === 'function' ? response.request() : undefined;
            const resourceType = typeof req?.resourceType === 'function' ? req.resourceType() : '';
            const method = typeof req?.method === 'function' ? req.method().toUpperCase() : 'GET';
            const url = typeof response.url === 'function' ? response.url() : '';
            if (STATIC_ASSET_URL_PATTERN.test(url))
                return;
            const isInteresting = resourceType === 'xhr'
                || resourceType === 'fetch'
                || method === 'POST'
                || method === 'PUT'
                || method === 'PATCH';
            if (!isInteresting)
                return;
            const status = typeof response.status === 'function' ? response.status() : 0;
            const headers = typeof response.headers === 'function' ? response.headers() : {};
            const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
            const readTask = (async () => {
                let bodySnippet;
                if (typeof response.text === 'function'
                    && (contentType.length === 0 || /(?:json|text|xml|html|javascript)/iu.test(contentType))) {
                    const rawText = await response.text().catch(() => '');
                    const cleaned = rawText.replace(/\s+/gu, ' ').trim();
                    if (cleaned.length > 0)
                        bodySnippet = cleaned.slice(0, 240);
                }
                networkResponses.push({
                    url: url.slice(0, 180),
                    status,
                    ...(contentType ? { contentType: contentType.slice(0, 60) } : {}),
                    ...(bodySnippet === undefined ? {} : { bodySnippet }),
                });
            })();
            pendingBodyReads.push(readTask);
        };
        const attachable = page;
        attachable.on?.('dialog', onDialog);
        attachable.on?.('response', onResponse);
        try {
            await runClick().catch((error) => {
                if (isNavigationContextError(error))
                    return;
                throw error;
            });
            const clampedWait = Math.max(0, Math.min(waitMs, 5_000));
            if (clampedWait > 0) {
                await new Promise((resolve, reject) => {
                    if (signal?.aborted) {
                        reject(new BrowserError('browser click aborted', 'BROWSER_ABORTED'));
                        return;
                    }
                    const onAbort = () => {
                        clearTimeout(timer);
                        reject(new BrowserError('browser click aborted', 'BROWSER_ABORTED'));
                    };
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    }, clampedWait);
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
            }
            if (typeof page.waitForLoadState === 'function') {
                await page.waitForLoadState('domcontentloaded', { timeout: 1_000 }).catch(() => undefined);
            }
            await Promise.allSettled(pendingBodyReads);
        }
        finally {
            const detach = attachable.off ?? attachable.removeListener;
            detach?.call(attachable, 'dialog', onDialog);
            detach?.call(attachable, 'response', onResponse);
        }
        const afterNotices = typeof page.evaluate === 'function'
            ? await page.evaluate(COLLECT_DOM_NOTICES_SCRIPT).catch(() => [])
            : [];
        const newNotices = afterNotices.filter(n => !beforeNotices.has(n));
        const domNotices = newNotices.length > 0 ? newNotices : afterNotices.slice(0, 3);
        const finalUrl = page.url();
        const title = await page.title().catch(() => '');
        return {
            ...(dialogs.length > 0 ? { dialogs } : {}),
            ...(networkResponses.length > 0 ? { networkResponses } : {}),
            ...(domNotices.length > 0 ? { domNotices } : {}),
            finalUrl,
            ...(title ? { title } : {}),
        };
    }
    async createInternalPage() {
        this.creatingInternalPage++;
        try {
            return await this.context.newPage();
        }
        finally {
            this.creatingInternalPage--;
        }
    }
    registerPage(ref, page, isPopup) {
        this.pages.set(ref, page);
        this.pageToRef.set(page, ref);
        this.pageMeta.set(ref, { isPopup });
        if (!isPopup) {
            this.lastRef = ref;
        }
        page.on('close', () => {
            this.removePageMapping(ref, page);
        });
    }
    removePageMapping(ref, page) {
        if (this.pages.get(ref) !== page)
            return;
        this.pages.delete(ref);
        this.pageMeta.delete(ref);
        this.chains.delete(ref);
        if (this.lastRef === ref) {
            this.lastRef = this.findFallbackBusinessRef();
        }
    }
    findFallbackBusinessRef() {
        let fallbackPopup;
        for (const [candidateRef, candidatePage] of this.pages.entries()) {
            if (candidatePage.isClosed())
                continue;
            if (this.pageMeta.get(candidateRef)?.isPopup) {
                fallbackPopup = candidateRef;
            }
            else {
                return candidateRef;
            }
        }
        return fallbackPopup;
    }
    adopt(page) {
        const existingRef = this.pageToRef.get(page);
        if (existingRef !== undefined && this.pages.get(existingRef) === page) {
            this.lastRef = existingRef;
            return existingRef;
        }
        const ref = `p${++this.refSeq}`;
        this.registerPage(ref, page, false);
        return ref;
    }
    async requirePage(ref) {
        if (ref === undefined) {
            if (this.lastRef !== undefined) {
                const active = this.pages.get(this.lastRef);
                if (active !== undefined && !active.isClosed()) {
                    return { page: active, ref: this.lastRef };
                }
            }
            const fallbackRef = this.findFallbackBusinessRef();
            if (fallbackRef !== undefined) {
                const fallbackPage = this.pages.get(fallbackRef);
                this.lastRef = fallbackRef;
                return { page: fallbackPage, ref: fallbackRef };
            }
            if (this.keeperPage !== undefined && !this.keeperPage.isClosed()) {
                const promoted = this.keeperPage;
                this.keeperPage = undefined;
                return { page: promoted, ref: this.adopt(promoted) };
            }
            const pages = this.context.pages().filter(p => !p.isClosed() && p !== this.keeperPage);
            const last = pages[pages.length - 1];
            if (last) {
                return { page: last, ref: this.adopt(last) };
            }
            const page = await this.createInternalPage();
            return { page, ref: this.adopt(page) };
        }
        const page = this.pages.get(ref);
        if (page === undefined || page.isClosed()) {
            throw new BrowserError(`browser page "${ref}" is not open`, 'BROWSER_ACTION_FAILED');
        }
        if (!this.pageMeta.get(ref)?.isPopup) {
            this.lastRef = ref;
        }
        return { page, ref };
    }
    async resolveForNavigate(ref) {
        if (ref !== undefined) {
            const existing = this.pages.get(ref);
            if (existing !== undefined && !existing.isClosed()) {
                if (!this.pageMeta.get(ref)?.isPopup) {
                    this.lastRef = ref;
                }
                return { page: existing, ref };
            }
            if (this.keeperPage !== undefined && !this.keeperPage.isClosed()) {
                const page = this.keeperPage;
                this.keeperPage = undefined;
                this.registerPage(ref, page, false);
                return { page, ref };
            }
            const page = await this.createInternalPage();
            this.registerPage(ref, page, false);
            return { page, ref };
        }
        return await this.requirePage(undefined);
    }
    async pageResult(page, ref, maxChars, selector) {
        const [url, title, rawText] = await Promise.all([
            Promise.resolve(page.url()),
            page.title(),
            page.innerText(selector ?? 'body'),
        ]);
        const { text, truncated } = truncate(rawText, maxChars);
        return { kind: 'page', page: ref, url, title, text, truncated };
    }
}
export class PlaywrightBrowserProvider {
    config;
    id = PLAYWRIGHT_BROWSER_PROVIDER_ID;
    constructor(config) {
        this.config = config;
    }
    available() {
        return true;
    }
    async open(signal) {
        throwIfAborted(signal, 'launch');
        assertPositiveInteger('defaultTimeoutMs', this.config.defaultTimeoutMs);
        let context;
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
            });
        }
        catch (error) {
            throw new BrowserError(`failed to launch the persistent browser profile at ${this.config.userDataDir}: ${String(error instanceof Error ? error.message : error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error });
        }
        return new PlaywrightSession(context, this.config.defaultTimeoutMs, DEFAULT_SNAPSHOT_MAX_CHARS);
    }
}
