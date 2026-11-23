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
import { PlaywrightBrowserProvider } from "../host/browser-playwright/provider.js";
import { BrowserError } from "../host/browser/types.js";
import { assertNever } from "../shared/backlinks-types.js";
import { redactSecrets } from "./config.js";
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
    'closePage',
    'bringToFront',
    'closeBrowser',
    'batch_fill',
    'wait_for_login',
];
export const BROWSER_TOOL_DEFINITION = {
    name: 'browser',
    description: 'Drive one shared persistent real-Chrome session across tabs: navigate (returns compact summary), snapshot (text/aria/interactive), click/fill/select/press/upload/screenshot/waitFor, batch_fill (multi-field form fill in one call), wait_for_login (in-process polling for manual login), bringToFront, closePage, and closeBrowser.',
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
                description: 'Tab ref (e.g. p1, g1). Pass on every command for parallel tab isolation; omit for single-tab serial work.',
            },
            url: {
                type: 'string',
                description: 'Absolute http(s) URL for navigate; target URL pattern for waitFor.',
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
                description: 'Snapshot format: text, aria, or interactive (reveals icon-only sign-in buttons, iframes, and sign-in candidates).',
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
                description: 'Navigation load condition for navigate.',
            },
            maxChars: {
                type: 'integer',
                description: 'Optional output character cap (navigate defaults to 3000, snapshot defaults to 8000; explicit maxChars clamped to server maxOutputChars, default 16000).',
            },
            timeoutMs: {
                type: 'integer',
                description: 'Timeout in ms for waitFor or wait_for_login (wait_for_login defaults to 300000).',
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
                description: 'For batch_fill: optional submit button selector clicked only when all fields succeed.',
            },
            submitNth: {
                type: 'integer',
                description: 'For batch_fill: optional 0-based element index for submitTarget when it matches multiple elements.',
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
};
export class BrowserSessionManager {
    provider;
    session;
    opening;
    constructor(provider) {
        this.provider = provider;
    }
    static fromConfig(config) {
        return new BrowserSessionManager(new PlaywrightBrowserProvider({
            userDataDir: config.browserProfileDir,
            headless: config.browserHeadless,
            channel: config.browserChannel,
            defaultTimeoutMs: config.browserTimeoutMs,
            launchArgs: ['--disable-blink-features=AutomationControlled'],
            ignoreDefaultArgs: ['--enable-automation'],
            windowPosition: config.browserWindowPosition,
            ...(config.browserExecutablePath === undefined ? {} : { executablePath: config.browserExecutablePath }),
        }));
    }
    async act(command, signal) {
        const session = await this.ensureSession(signal);
        if (signal?.aborted) {
            throw new BrowserError('browser command aborted before dispatch', 'BROWSER_ABORTED');
        }
        try {
            return await session.act(command, signal);
        }
        catch (error) {
            if (error instanceof BrowserError) {
                if (error.message.includes('has been closed') || error.message.includes('session is closed')) {
                    await this.discardSession();
                }
                throw error;
            }
            await this.discardSession();
            throw new BrowserError(`browser command "${command.kind}" failed: ${error instanceof Error ? error.message : String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error });
        }
    }
    async closeSession() {
        await this.opening?.catch(() => undefined);
        await this.discardSession();
    }
    ensureSession(signal) {
        if (this.session)
            return Promise.resolve(this.session);
        this.opening ??= this.launchSession(signal).then((session) => {
            this.opening = undefined;
            return session;
        }, (error) => {
            this.opening = undefined;
            throw error;
        });
        return this.opening;
    }
    async launchSession(signal) {
        if (!this.provider.available()) {
            throw new BrowserError(`browser provider "${this.provider.id}" is unavailable`, 'BROWSER_PROVIDER_UNAVAILABLE');
        }
        if (signal?.aborted) {
            throw new BrowserError('browser launch aborted', 'BROWSER_ABORTED');
        }
        try {
            const session = await this.provider.open(signal);
            this.session = session;
            return session;
        }
        catch (error) {
            if (error instanceof BrowserError)
                throw error;
            throw new BrowserError(`browser provider "${this.provider.id}" failed to open a session: ${error instanceof Error ? error.message : String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error });
        }
    }
    async discardSession() {
        const session = this.session;
        this.session = undefined;
        try {
            await session?.close();
        }
        catch {
            // ignore close errors on dead browser
        }
    }
}
function defaultSleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject(new BrowserError('browser wait aborted', 'BROWSER_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new BrowserError('browser wait aborted', 'BROWSER_ABORTED'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function readNonEmpty(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`browser ${field} must be a non-empty string.`);
    }
    return value.trim();
}
function readSelector(value, field = 'selector') {
    const raw = readNonEmpty(value, field);
    if (raw === undefined)
        return undefined;
    if (/^xy:(?!\d+,\d+$).*/u.test(raw)) {
        throw new Error('browser xy selector must be xy:<x>,<y> with non-negative integers.');
    }
    if (/^role:[^|]*\|$/u.test(raw) || /^role:\|/u.test(raw)) {
        throw new Error('browser role selector must be role:<role>|<name> with both parts non-empty.');
    }
    if (/^(label|placeholder|text):$/u.test(raw)) {
        throw new Error(`browser ${raw.slice(0, -1)} selector must be ${raw}:<text> with non-empty text.`);
    }
    return raw;
}
function readUrl(value) {
    const raw = readNonEmpty(value, 'url');
    if (raw === undefined)
        return undefined;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('protocol');
        }
        return url.toString();
    }
    catch {
        throw new Error('browser url must be an absolute http(s) URL.');
    }
}
function readWaitUntil(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (value === 'load' || value === 'domcontentloaded' || value === 'networkidle')
        return value;
    throw new Error('browser waitUntil must be load, domcontentloaded, or networkidle.');
}
function readSnapshotFormat(value) {
    if (value === undefined || value === 'text' || value === 'aria' || value === 'interactive')
        return value;
    throw new Error('browser format must be text, aria, or interactive.');
}
function readPositiveInt(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
        throw new Error(`browser ${field} must be a positive integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`browser ${field} must be a positive integer.`);
    }
    return parsed;
}
function readNonNegativeInt(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length === 0)) {
        throw new Error(`browser ${field} must be a non-negative integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`browser ${field} must be a non-negative integer.`);
    }
    return parsed;
}
function parseBatchFillFields(rawFields) {
    if (!Array.isArray(rawFields) || rawFields.length === 0) {
        throw new Error('browser batch_fill requires a non-empty fields array.');
    }
    return rawFields.map((entry, idx) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`browser fields[${idx}] must be an object.`);
        }
        const row = entry;
        const target = readSelector(row.target, `fields[${idx}].target`);
        if (target === undefined) {
            throw new Error(`browser fields[${idx}].target is required.`);
        }
        const nth = readNonNegativeInt(row.nth, `fields[${idx}].nth`);
        const opRaw = row.op === undefined ? 'fill' : row.op;
        if (opRaw !== 'fill' && opRaw !== 'select' && opRaw !== 'click' && opRaw !== 'check') {
            throw new Error(`browser fields[${idx}].op must be fill, select, click, or check.`);
        }
        if (opRaw === 'fill') {
            if (typeof row.value !== 'string') {
                throw new Error(`browser fields[${idx}].value must be a string for op=fill.`);
            }
            return { target, op: opRaw, value: row.value, ...(nth === undefined ? {} : { nth }) };
        }
        if (opRaw === 'select') {
            const value = readNonEmpty(row.value, `fields[${idx}].value`);
            if (value === undefined) {
                throw new Error(`browser fields[${idx}].value must be a non-empty string for op=select.`);
            }
            return { target, op: opRaw, value, ...(nth === undefined ? {} : { nth }) };
        }
        return { target, op: opRaw, ...(nth === undefined ? {} : { nth }) };
    });
}
export function formatMcpBrowserOutput(result, maxChars) {
    switch (result.kind) {
        case 'page': {
            const header = `[page ${result.page}] ${result.title}\n${result.url}`;
            const truncated = result.truncated || result.text.length > maxChars;
            const body = result.text.slice(0, maxChars) + (truncated ? '\n… (truncated)' : '');
            return `${header}\n\n${body}`;
        }
        case 'acked':
            return 'ok';
        case 'screenshot':
            return `screenshot captured (${result.pngBase64.length} base64 characters)`;
        case 'probe':
            return `[page ${result.page}] ${result.title}\n${result.url}`;
        default:
            return assertNever(result, 'unhandled browser result kind');
    }
}
function matchesLoginState(probe, cond) {
    const lowerUrl = probe.url.toLowerCase();
    if (cond.urlContains !== undefined && !lowerUrl.includes(cond.urlContains.toLowerCase())) {
        return false;
    }
    if (cond.urlNotContains !== undefined && lowerUrl.includes(cond.urlNotContains.toLowerCase())) {
        return false;
    }
    if (cond.selector !== undefined && probe.selectorVisible !== true) {
        return false;
    }
    return true;
}
export function createBrowserToolHandler(deps) {
    const { sessionManager, config } = deps;
    const sleepImpl = deps.sleepImpl ?? defaultSleep;
    return async function handleBrowserTool(args, signal) {
        try {
            const action = readNonEmpty(args.action, 'action');
            if (action === undefined) {
                throw new Error(`browser action must be one of ${BROWSER_ACTIONS.join(', ')}.`);
            }
            const page = readNonEmpty(args.page, 'page');
            const addressed = (command) => (page === undefined ? command : { ...command, page });
            if (action === 'closeBrowser') {
                await sessionManager.closeSession();
                return { content: [{ type: 'text', text: 'ok' }] };
            }
            if (action === 'batch_fill') {
                const fields = parseBatchFillFields(args.fields);
                const submitTarget = readSelector(args.submitTarget, 'submitTarget');
                const submitNth = readNonNegativeInt(args.submitNth, 'submitNth');
                if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
                    throw new Error('browser stopOnError must be a boolean.');
                }
                const stopOnError = args.stopOnError === true;
                const results = [];
                let succeeded = 0;
                let failed = 0;
                for (let index = 0; index < fields.length; index++) {
                    const field = fields[index];
                    const nthField = field.nth === undefined ? {} : { nth: field.nth };
                    let cmd;
                    switch (field.op) {
                        case 'fill':
                            cmd = addressed({ kind: 'fill', selector: field.target, value: field.value ?? '', ...nthField });
                            break;
                        case 'select':
                            cmd = addressed({ kind: 'select', selector: field.target, value: field.value ?? '', ...nthField });
                            break;
                        case 'click':
                            cmd = addressed({ kind: 'click', selector: field.target, ...nthField });
                            break;
                        case 'check':
                            cmd = addressed({ kind: 'check', selector: field.target, ...nthField });
                            break;
                        default:
                            return assertNever(field.op, 'unhandled batch_fill op');
                    }
                    try {
                        await sessionManager.act(cmd, signal);
                        succeeded++;
                        results.push({ index, op: field.op, target: field.target, ok: true });
                    }
                    catch (error) {
                        if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
                            throw error;
                        }
                        failed++;
                        results.push({
                            index,
                            op: field.op,
                            target: field.target,
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        if (stopOnError)
                            break;
                    }
                }
                let submit;
                if (submitTarget !== undefined) {
                    if (failed > 0) {
                        submit = {
                            target: submitTarget,
                            attempted: false,
                            ok: false,
                            skippedReason: 'skipped because one or more fields failed',
                        };
                    }
                    else {
                        try {
                            await sessionManager.act(addressed({
                                kind: 'click',
                                selector: submitTarget,
                                ...(submitNth === undefined ? {} : { nth: submitNth }),
                            }), signal);
                            submit = { target: submitTarget, attempted: true, ok: true };
                        }
                        catch (error) {
                            if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
                                throw error;
                            }
                            submit = {
                                target: submitTarget,
                                attempted: true,
                                ok: false,
                                error: error instanceof Error ? error.message : String(error),
                            };
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
                };
                const submitSummary = submit === undefined
                    ? ''
                    : submit.ok
                        ? '; submit ok'
                        : submit.attempted
                            ? '; submit FAILED'
                            : '; submit skipped';
                const summary = `batch_fill: ${succeeded}/${fields.length} succeeded, ${failed} failed${submitSummary}`;
                return {
                    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }],
                };
            }
            if (action === 'wait_for_login') {
                const urlContains = readNonEmpty(args.urlContains, 'urlContains');
                const urlNotContains = readNonEmpty(args.urlNotContains, 'urlNotContains');
                const selector = readSelector(args.selector, 'selector');
                if (urlContains === undefined && urlNotContains === undefined && selector === undefined) {
                    throw new Error('browser wait_for_login requires at least one of urlContains, urlNotContains, or selector.');
                }
                const timeoutMs = readPositiveInt(args.timeoutMs, 'timeoutMs') ?? 300_000;
                const pollIntervalMs = readPositiveInt(args.pollIntervalMs, 'pollIntervalMs') ?? 3_000;
                if (args.bringToFront !== undefined && typeof args.bringToFront !== 'boolean') {
                    throw new Error('browser bringToFront must be a boolean.');
                }
                const shouldBringToFront = args.bringToFront !== false;
                const startedAt = Date.now();
                const deadline = startedAt + timeoutMs;
                let polls = 0;
                let broughtToFront = false;
                let lastProbe;
                while (true) {
                    polls++;
                    try {
                        const raw = await sessionManager.act(addressed({
                            kind: 'probe',
                            ...(selector === undefined ? {} : { selector }),
                        }), signal);
                        if (raw.kind === 'probe') {
                            lastProbe = raw;
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
                                };
                                return {
                                    content: [{ type: 'text', text: `logged in (${raw.url})\n${JSON.stringify(payload)}` }],
                                };
                            }
                        }
                    }
                    catch (error) {
                        if (signal?.aborted || (error instanceof BrowserError && error.code === 'BROWSER_ABORTED')) {
                            throw error;
                        }
                        if (error instanceof BrowserError && /is not open|session is closed|has been closed/iu.test(error.message)) {
                            const payload = {
                                loggedIn: false,
                                closed: true,
                                reason: error.message,
                                polls,
                                elapsedMs: Date.now() - startedAt,
                            };
                            return {
                                content: [{ type: 'text', text: `login wait stopped: ${error.message}\n${JSON.stringify(payload)}` }],
                            };
                        }
                        // Transient navigation/execution context errors during login redirect are expected while polling.
                    }
                    if (shouldBringToFront && !broughtToFront) {
                        broughtToFront = true;
                        await sessionManager.act({
                            kind: 'bringToFront',
                            ...(lastProbe?.page !== undefined ? { page: lastProbe.page } : page !== undefined ? { page } : {}),
                        }, signal).catch(() => undefined);
                    }
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) {
                        const payload = {
                            loggedIn: false,
                            timedOut: true,
                            ...(lastProbe === undefined ? {} : { page: lastProbe.page, url: lastProbe.url, title: lastProbe.title }),
                            polls,
                            elapsedMs: Date.now() - startedAt,
                        };
                        return {
                            content: [{ type: 'text', text: `login wait timed out after ${timeoutMs}ms\n${JSON.stringify(payload)}` }],
                        };
                    }
                    await sleepImpl(Math.min(pollIntervalMs, remaining), signal);
                }
            }
            const selector = readSelector(args.selector);
            const nth = readNonNegativeInt(args.nth, 'nth');
            const nthProp = nth === undefined ? {} : { nth };
            const url = readNonEmpty(args.url, 'url');
            const value = readNonEmpty(args.value, 'value');
            const waitUntil = readWaitUntil(args.waitUntil);
            const timeoutMs = readPositiveInt(args.timeoutMs, 'timeoutMs');
            const requestedMaxChars = readPositiveInt(args.maxChars, 'maxChars');
            let command;
            let effectiveMaxChars = config.maxOutputChars;
            switch (action) {
                case 'bringToFront':
                    command = addressed({ kind: 'bringToFront' });
                    break;
                case 'navigate': {
                    const target = readUrl(args.url);
                    if (target === undefined)
                        throw new Error('browser navigate requires an http(s) url.');
                    effectiveMaxChars = requestedMaxChars !== undefined
                        ? Math.min(requestedMaxChars, config.maxOutputChars)
                        : Math.min(config.navigateMaxChars, config.maxOutputChars);
                    command = addressed({
                        kind: 'navigate',
                        url: target,
                        ...(waitUntil === undefined ? {} : { waitUntil }),
                        maxChars: effectiveMaxChars,
                    });
                    break;
                }
                case 'snapshot': {
                    const format = readSnapshotFormat(args.format);
                    effectiveMaxChars = requestedMaxChars !== undefined
                        ? Math.min(requestedMaxChars, config.maxOutputChars)
                        : Math.min(config.snapshotMaxChars, config.maxOutputChars);
                    command = addressed({
                        kind: 'snapshot',
                        ...(selector === undefined ? {} : { selector }),
                        ...(format === undefined ? {} : { format }),
                        maxChars: effectiveMaxChars,
                    });
                    break;
                }
                case 'click':
                    if (selector === undefined)
                        throw new Error('browser click requires a selector.');
                    command = addressed({ kind: 'click', selector, ...nthProp });
                    break;
                case 'fill':
                    if (selector === undefined)
                        throw new Error('browser fill requires a selector.');
                    if (typeof args.value !== 'string' || args.value.trim().length === 0) {
                        throw new Error('browser fill requires a value.');
                    }
                    command = addressed({ kind: 'fill', selector, value: value, ...nthProp });
                    break;
                case 'select':
                    if (selector === undefined)
                        throw new Error('browser select requires a selector.');
                    if (value === undefined)
                        throw new Error('browser select requires a value.');
                    command = addressed({ kind: 'select', selector, value, ...nthProp });
                    break;
                case 'press':
                    if (typeof args.key !== 'string' || args.key.trim().length === 0) {
                        throw new Error('browser press requires a key (for example Enter, Tab).');
                    }
                    command = addressed({ kind: 'press', key: args.key.trim() });
                    break;
                case 'upload':
                    if (selector === undefined)
                        throw new Error('browser upload requires a selector.');
                    if (!Array.isArray(args.files)
                        || args.files.length === 0
                        || args.files.some(file => typeof file !== 'string' || file.trim().length === 0)) {
                        throw new Error('browser upload requires a non-empty files array of paths.');
                    }
                    command = addressed({ kind: 'upload', selector, files: args.files.map(file => String(file)), ...nthProp });
                    break;
                case 'screenshot':
                    command = addressed({ kind: 'screenshot' });
                    break;
                case 'waitFor':
                    if (selector === undefined && url === undefined) {
                        throw new Error('browser waitFor requires a selector or a url.');
                    }
                    command = addressed({
                        kind: 'waitFor',
                        ...(selector === undefined ? {} : { selector, ...nthProp }),
                        ...(url === undefined ? {} : { url }),
                        ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    });
                    break;
                case 'closePage':
                    command = addressed({ kind: 'closePage' });
                    break;
                default:
                    return assertNever(action, `browser action must be one of ${BROWSER_ACTIONS.join(', ')}.`);
            }
            const result = await sessionManager.act(command, signal);
            if (result.kind === 'screenshot') {
                return {
                    content: [
                        { type: 'text', text: formatMcpBrowserOutput(result, effectiveMaxChars) },
                        { type: 'image', data: result.pngBase64, mimeType: 'image/png' },
                    ],
                };
            }
            return {
                content: [{ type: 'text', text: formatMcpBrowserOutput(result, effectiveMaxChars) }],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: 'text', text: redactSecrets(message, config) }],
            };
        }
    };
}
