/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */
import { chromium } from 'playwright-core';
import { assertNever } from "../../shared/backlinks-types.js";
import { BrowserError } from "../browser/index.js";
export const PLAYWRIGHT_BROWSER_PROVIDER_ID = 'playwright';
export const DEFAULT_SNAPSHOT_MAX_CHARS = 60_000;
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
function elementLocator(page, addressing) {
    const locator = buildLocator(page, addressing);
    if (locator === undefined) {
        throw new BrowserError('browser xy addressing supports click only', 'BROWSER_ACTION_FAILED');
    }
    return locator;
}
function throwIfAborted(signal, commandKind) {
    if (signal?.aborted) {
        throw new BrowserError(`browser ${commandKind} aborted`, 'BROWSER_ABORTED');
    }
}
class PlaywrightSession {
    context;
    defaultTimeoutMs;
    defaultMaxChars;
    closed = false;
    pages = new Map();
    chains = new Map();
    legacyTail = Promise.resolve();
    lastRef;
    refSeq = 0;
    constructor(context, defaultTimeoutMs, defaultMaxChars) {
        this.context = context;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.defaultMaxChars = defaultMaxChars;
        this.context.on('close', () => {
            this.closed = true;
        });
        for (const existing of this.context.pages()) {
            this.adopt(existing);
        }
    }
    async act(command, signal) {
        throwIfAborted(signal, command.kind);
        if (this.closed) {
            throw new BrowserError('browser session is closed', 'BROWSER_ACTION_FAILED');
        }
        return await (command.page === undefined
            ? this.chained(this.legacyTail, (tail) => { this.legacyTail = tail; }, command, signal)
            : this.chained(this.chains.get(command.page) ?? Promise.resolve(), (tail) => { this.chains.set(command.page, tail); }, command, signal));
    }
    chained(previous, store, command, signal) {
        const next = previous.then(() => this.execute(command, signal));
        store(next.catch(() => undefined));
        return next;
    }
    async execute(command, signal) {
        throwIfAborted(signal, command.kind);
        try {
            switch (command.kind) {
                case 'navigate': {
                    const { page, ref } = await this.resolveForNavigate(command.page);
                    await page.goto(command.url, {
                        timeout: this.defaultTimeoutMs,
                        ...(command.waitUntil === undefined ? {} : { waitUntil: command.waitUntil }),
                    });
                    return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
                }
                case 'snapshot': {
                    const { page, ref } = await this.requirePage(command.page);
                    if (command.format === 'aria') {
                        const tree = await page.locator(command.selector ?? 'body').ariaSnapshot();
                        const { text, truncated } = truncate(tree, command.maxChars ?? this.defaultMaxChars);
                        return { kind: 'page', page: ref, url: page.url(), title: await page.title(), text, truncated };
                    }
                    return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars, command.selector);
                }
                case 'click': {
                    const { page } = await this.requirePage(command.page);
                    const addressing = parseSelector(command.selector);
                    if (addressing.mode === 'xy') {
                        await page.mouse.click(addressing.x, addressing.y);
                        return { kind: 'acked' };
                    }
                    await buildLocator(page, addressing)?.click({ timeout: this.defaultTimeoutMs });
                    return { kind: 'acked' };
                }
                case 'fill': {
                    const { page } = await this.requirePage(command.page);
                    const locator = elementLocator(page, parseSelector(command.selector));
                    await locator.fill(command.value, { timeout: this.defaultTimeoutMs });
                    return { kind: 'acked' };
                }
                case 'select': {
                    const { page } = await this.requirePage(command.page);
                    const locator = elementLocator(page, parseSelector(command.selector));
                    await locator.selectOption(command.value, { timeout: this.defaultTimeoutMs });
                    return { kind: 'acked' };
                }
                case 'press': {
                    const { page } = await this.requirePage(command.page);
                    await page.keyboard.press(command.key);
                    return { kind: 'acked' };
                }
                case 'upload': {
                    const { page } = await this.requirePage(command.page);
                    const locator = elementLocator(page, parseSelector(command.selector));
                    await locator.setInputFiles([...command.files], { timeout: this.defaultTimeoutMs });
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
                        const locator = elementLocator(page, parseSelector(command.selector));
                        await locator.waitFor({ state: 'visible', timeout });
                    }
                    else {
                        await page.waitForURL(command.url, { timeout });
                    }
                    return { kind: 'acked' };
                }
                case 'bringToFront': {
                    const { page } = await this.requirePage(command.page);
                    await page.bringToFront();
                    return { kind: 'acked' };
                }
                case 'closePage': {
                    const { page, ref } = await this.requirePage(command.page);
                    await page.close();
                    this.pages.delete(ref);
                    this.chains.delete(ref);
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
    adopt(page) {
        const ref = `p${++this.refSeq}`;
        this.pages.set(ref, page);
        this.lastRef = ref;
        page.on('close', () => {
            this.pages.delete(ref);
        });
        return ref;
    }
    async requirePage(ref) {
        if (ref === undefined) {
            const pages = this.context.pages();
            const last = pages[pages.length - 1];
            if (last) {
                if (this.pages.get(this.lastRef ?? '') !== last) {
                    this.adopt(last);
                }
                return { page: last, ref: this.lastRef };
            }
            const page = await this.context.newPage();
            return { page, ref: this.adopt(page) };
        }
        const page = this.pages.get(ref);
        if (page === undefined || page.isClosed()) {
            throw new BrowserError(`browser page "${ref}" is not open`, 'BROWSER_ACTION_FAILED');
        }
        this.lastRef = ref;
        return { page, ref };
    }
    async resolveForNavigate(ref) {
        if (ref !== undefined) {
            const existing = this.pages.get(ref);
            if (existing !== undefined && !existing.isClosed()) {
                this.lastRef = ref;
                return { page: existing, ref };
            }
            const page = await this.context.newPage();
            this.pages.set(ref, page);
            this.lastRef = ref;
            page.on('close', () => {
                this.pages.delete(ref);
            });
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
