/**
 * MCP `backlinks` tool definition and handler (zero DSH/Cordis dependencies).
 *
 * Exposes all 10 existing actions (`batch_list`, `batch_get`, `batch_claim`,
 * `lease_heartbeat`, `lease_release`, `item_result`, `badge_add`, `source_tags`,
 * `mailbox_create`, `mail_wait`) plus:
 * - `badge_verify`: native Node `fetch()` refresh + live page verification
 * - `batch_get` compact mode (`compact` defaults to `true`)
 * - Lazy credential checks so Supermanager actions work even without `CLOUDMAIL_TOKEN`.
 */
import { BacklinksError } from "../host/backlinks/types.js";
import { DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS, DEFAULT_PREFLIGHT_CONCURRENCY, DEFAULT_PREFLIGHT_TIMEOUT_MS, STANDARD_BLOCKING_TAGS, } from "../host/backlinks/standards.js";
import { collectPublishedSourceIds, compactBatchDetail, compactBatchSummary, parseItemResult, parseTags, readClampedInt, readHttpUrl, readNonEmpty, readOptionalNonNegativeInt, readOptionalPositiveInt, readOptionalString, readPositiveInt, } from "../host/backlinks/validation.js";
import { CloudMailMailbox } from "../host/cloud-mail/provider.js";
import { SupermanagerBatchSource } from "../host/supermanager/provider.js";
import { assertNever } from "../shared/backlinks-types.js";
import { PublishSessionGuard } from "./circuit-breaker.js";
import { isPlaceholderValue, redactSecrets } from "./config.js";
import { runBatchPreflight } from "./preflight.js";
export const BACKLINKS_ACTIONS = [
    'batch_list',
    'batch_get',
    'batch_preflight',
    'batch_claim',
    'lease_heartbeat',
    'lease_release',
    'item_result',
    'badge_add',
    'badge_verify',
    'badge_deactivate',
    'source_tags',
    'mailbox_create',
    'mail_wait',
];
export const BACKLINKS_TOOL_DEFINITION = {
    name: 'backlinks',
    description: 'Run the publish-batch workflow against Supermanager & Cloud-mail: list/get/preflight/claim batches, heartbeat/release leases, report item results (with session same-template circuit breaker), add/verify/deactivate reciprocal badges, tag sources, and create/poll verification mailboxes.',
    inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
            action: {
                type: 'string',
                enum: [...BACKLINKS_ACTIONS],
                description: `Action to perform: ${BACKLINKS_ACTIONS.join(', ')}.`,
            },
            batchId: { type: 'integer', description: 'Batch ID for batch_get / batch_preflight / batch_claim.' },
            compact: {
                type: 'boolean',
                description: 'For batch_list and batch_get: return compact payload (default true); pass false for full raw objects.',
            },
            onlyPending: {
                type: 'boolean',
                description: 'For batch_list: only return batches with pending items (default true; pass false for all batches).',
            },
            pendingOnly: {
                type: 'boolean',
                description: 'For batch_get: only return items with status=pending (default false). Always includes publishedSourceIds computed across the full batch to prevent duplicate-sourceId publishing.',
            },
            limit: {
                type: 'integer',
                description: 'Pagination page size: for batch_list defaults to 20 (clamped 1-100); for batch_get optional positive integer.',
            },
            offset: {
                type: 'integer',
                description: 'Pagination start offset (non-negative integer, default 0) for batch_list and batch_get.',
            },
            itemIds: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Optional subset of plan item IDs for batch_claim (recommended 1-5 per slice) or batch_preflight.',
            },
            leaseId: { type: 'integer', description: 'Lease ID for lease_heartbeat / lease_release.' },
            itemId: { type: 'integer', description: 'Plan item ID for item_result.' },
            websiteId: { type: 'integer', description: 'Website ID for badge_add / badge_deactivate.' },
            badgeId: { type: 'integer', description: 'Badge ID (returned as backlinkId by badge_add) for badge_deactivate.' },
            remove: {
                type: 'boolean',
                description: 'For badge_deactivate: when true, hard-delete via DELETE instead of PATCH isActive=false (default false).',
            },
            sourceId: { type: 'integer', description: 'Target source ID for source_tags.' },
            status: {
                type: 'string',
                enum: ['live', 'submitted', 'failed', 'skipped'],
                description: 'Outcome status for item_result.',
            },
            publicUrl: { type: 'string', description: 'Verified public listing URL (required for live).' },
            anchorText: { type: 'string', description: 'Anchor text used (for live / submitted).' },
            targetUrl: { type: 'string', description: 'Target URL used (for live / submitted).' },
            evidence: { type: 'string', description: 'One-line evidence note stored with item_result.' },
            failureMode: {
                type: 'string',
                enum: ['retryable', 'manual_required'],
                description: 'Failure classification for item_result when status=failed.',
            },
            failureReason: { type: 'string', description: 'Reason when status=failed.' },
            skipReason: { type: 'string', description: 'Reason when status=skipped.' },
            templateSignature: {
                type: 'string',
                description: 'Optional template/failure signature for item_result circuit breaker tracking (e.g. submitmatic:verify_badge_fail, blog:secureimg_captcha).',
            },
            name: { type: 'string', description: 'Badge name for badge_add / badge_deactivate.' },
            html: { type: 'string', description: 'Badge HTML snippet for badge_add / badge_deactivate.' },
            isActive: { type: 'boolean', description: 'Activate badge immediately (default true).' },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: `1-10 source tag names for source_tags (standard blocking tags: ${STANDARD_BLOCKING_TAGS.join(', ')}; plus descriptive tags like 免徽章, 要徽章, 可复用).`,
            },
            autoSkip: {
                type: 'boolean',
                description: 'For batch_preflight: when true, automatically report skipped and tag dead_site for definitive dead/paused/parked sites (default false).',
            },
            autoSkipTagged: {
                type: 'boolean',
                description: 'For batch_preflight: when true, automatically report skipped for items already carrying hard blocking tags (paid_only, dead_site, no_form, comments_closed) without HTTP requests (default false).',
            },
            skipTags: {
                type: 'array',
                items: { type: 'string' },
                description: 'For batch_preflight: optional override list of blocking tag names treated as hard-skip tags.',
            },
            concurrency: {
                type: 'integer',
                description: `For batch_preflight: concurrent HTTP probe count (1-12, default ${DEFAULT_PREFLIGHT_CONCURRENCY}).`,
            },
            localPart: { type: 'string', description: 'Mailbox local part for mailbox_create.' },
            domain: { type: 'string', description: 'Mailbox domain for mailbox_create (e.g. screwdom.org).' },
            mailEmail: { type: 'string', description: 'Mailbox email address for mail_wait.' },
            subjectContains: { type: 'string', description: 'Optional subject filter for mail_wait.' },
            fromContains: { type: 'string', description: 'Optional sender filter for mail_wait.' },
            waitTimeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds for mail_wait (default 30000).' },
            siteUrl: { type: 'string', description: 'Promoted website homepage URL to verify in badge_verify.' },
            expectedTarget: { type: 'string', description: 'Target site domain or href substring expected in siteUrl HTML for badge_verify.' },
            refreshUrl: { type: 'string', description: 'Optional site refresh callback URL (e.g. https://site.example/footer/refresh) triggered in badge_verify or after badge_deactivate.' },
            retries: { type: 'integer', description: 'Max fetch verification attempts in badge_verify (1-5, default 3).' },
            retryDelayMs: { type: 'integer', description: 'Delay between badge_verify retries in ms (0-30000, default 5000).' },
            timeoutMs: {
                type: 'integer',
                description: `Per-request timeout in ms for batch_preflight (1000-30000, default ${DEFAULT_PREFLIGHT_TIMEOUT_MS}) or badge_verify / badge_deactivate refresh (1000-60000, default 15000).`,
            },
        },
    },
};
function defaultSleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject(new BacklinksError('request aborted', 'BACKLINKS_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new BacklinksError('request aborted', 'BACKLINKS_ABORTED'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function assertHttpBaseUrl(value, label) {
    if (isPlaceholderValue(value)) {
        throw new BacklinksError(`${label} is not configured (missing or placeholder). Please configure it in your MCP server env.`, 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE');
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('protocol');
        }
    }
    catch {
        throw new BacklinksError(`${label} must be an http(s) URL.`, 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE');
    }
}
function requireSupermanagerConfigured(config) {
    assertHttpBaseUrl(config.supermanagerBaseUrl, 'SUPERMANAGER_BASE_URL');
    if (isPlaceholderValue(config.supermanagerToken)) {
        throw new BacklinksError('SUPERMANAGER_TOKEN is not configured (missing or placeholder). Create a dedicated smag_ token in Supermanager and set it in your MCP server env.', 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE');
    }
}
function requireMailboxConfigured(config) {
    assertHttpBaseUrl(config.cloudMailBaseUrl, 'CLOUDMAIL_BASE_URL');
    if (isPlaceholderValue(config.cloudMailToken)) {
        throw new BacklinksError('CLOUDMAIL_TOKEN is not configured (missing or placeholder). Supermanager actions remain usable, but mailbox_create and mail_wait require CLOUDMAIL_TOKEN in your MCP server env.', 'BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE');
    }
}
async function fetchWithTimeout(fetchImpl, url, timeoutMs, outerSignal) {
    if (outerSignal?.aborted) {
        throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const onOuterAbort = () => { controller.abort(); };
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
        return await fetchImpl(url, {
            method: 'GET',
            headers: {
                'user-agent': 'backlinks-publisher-mcp/1.0',
                'cache-control': 'no-cache',
            },
            redirect: 'follow',
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
    }
}
function findMatchedSnippet(html, expectedTarget) {
    const lowerHtml = html.toLowerCase();
    const candidates = [expectedTarget.trim()];
    const stripped = expectedTarget.trim().replace(/\/+$/u, '');
    if (stripped.length > 0 && stripped !== candidates[0]) {
        candidates.push(stripped);
    }
    for (const needle of candidates) {
        if (needle.length === 0)
            continue;
        const idx = lowerHtml.indexOf(needle.toLowerCase());
        if (idx >= 0) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(html.length, idx + needle.length + 60);
            return html.slice(start, end).replace(/\s+/gu, ' ').trim();
        }
    }
    return undefined;
}
function readBoundedInt(value, field, fallback, min, max) {
    if (value === undefined || value === null)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`backlinks ${field} must be an integer between ${min} and ${max}.`);
    }
    return parsed;
}
export function createBacklinksToolHandler(deps) {
    const { config } = deps;
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const sleepImpl = deps.sleepImpl ?? defaultSleep;
    const sessionGuard = new PublishSessionGuard(deps.circuitBreakerThreshold);
    const batchSource = deps.batchSource ?? new SupermanagerBatchSource(() => ({
        baseUrl: config.supermanagerBaseUrl,
        token: config.supermanagerToken,
        requestTimeoutMs: config.supermanagerTimeoutMs,
    }));
    const mailbox = deps.mailbox ?? new CloudMailMailbox(() => ({
        baseUrl: config.cloudMailBaseUrl,
        token: config.cloudMailToken,
        requestTimeoutMs: config.cloudMailTimeoutMs,
    }));
    function ensureBatchSourceReady() {
        if (deps.batchSource === undefined) {
            requireSupermanagerConfigured(config);
        }
        else if (!deps.batchSource.available()) {
            requireSupermanagerConfigured(config);
        }
    }
    function ensureMailboxReady() {
        if (deps.mailbox === undefined) {
            requireMailboxConfigured(config);
        }
        else if (!deps.mailbox.available()) {
            requireMailboxConfigured(config);
        }
    }
    return async function handleBacklinksTool(args, signal) {
        try {
            const action = readNonEmpty(args.action, 'action');
            let summary;
            let data;
            switch (action) {
                case 'batch_list': {
                    ensureBatchSourceReady();
                    if (args.compact !== undefined && typeof args.compact !== 'boolean') {
                        throw new Error('backlinks compact must be a boolean.');
                    }
                    if (args.onlyPending !== undefined && typeof args.onlyPending !== 'boolean') {
                        throw new Error('backlinks onlyPending must be a boolean.');
                    }
                    const compact = args.compact !== false;
                    const onlyPending = args.onlyPending !== false;
                    const limit = readClampedInt(args.limit, 'limit', 20, 1, 100);
                    const offset = readOptionalNonNegativeInt(args.offset, 'offset') ?? 0;
                    const allBatches = await batchSource.listBatches(signal);
                    const total = allBatches.length;
                    const filtered = onlyPending ? allBatches.filter(batch => batch.counts.pending > 0) : allBatches;
                    const matched = filtered.length;
                    const sliced = filtered.slice(offset, offset + limit);
                    const hasMore = offset + sliced.length < matched;
                    const batches = compact ? sliced.map(compactBatchSummary) : sliced;
                    summary = onlyPending && matched === 0 && total > 0
                        ? `0 pending batch(es) (${total} total; pass onlyPending=false for all)`
                        : `${sliced.length} of ${matched} ${onlyPending ? 'pending ' : ''}batch(es) (${total} total, offset=${offset}, limit=${limit}${hasMore ? ', hasMore=true' : ''})`;
                    data = { total, matched, offset, limit, hasMore, onlyPending, compact, batches };
                    break;
                }
                case 'batch_get': {
                    ensureBatchSourceReady();
                    if (args.compact !== undefined && typeof args.compact !== 'boolean') {
                        throw new Error('backlinks compact must be a boolean.');
                    }
                    if (args.pendingOnly !== undefined && typeof args.pendingOnly !== 'boolean') {
                        throw new Error('backlinks pendingOnly must be a boolean.');
                    }
                    const compact = args.compact !== false;
                    const pendingOnly = args.pendingOnly === true;
                    const hasPagination = args.limit !== undefined || args.offset !== undefined;
                    const limit = readOptionalPositiveInt(args.limit, 'limit');
                    const offset = readOptionalNonNegativeInt(args.offset, 'offset') ?? 0;
                    const detail = await batchSource.getBatch(readPositiveInt(args.batchId, 'batchId'), signal);
                    sessionGuard.recordBatchDetail(detail);
                    const totalItems = detail.items.length;
                    const pendingItems = detail.items.filter(item => item.status === 'pending').length;
                    const publishedSourceIds = collectPublishedSourceIds(detail.items);
                    const filteredItems = pendingOnly ? detail.items.filter(item => item.status === 'pending') : detail.items;
                    const slicedItems = limit === undefined
                        ? filteredItems.slice(offset)
                        : filteredItems.slice(offset, offset + limit);
                    const returnedItems = slicedItems.length;
                    const hasMore = offset + returnedItems < filteredItems.length;
                    if (!pendingOnly && !hasPagination) {
                        summary = `${detail.batch.name}: ${detail.items.length} item(s)${compact ? ' (compact; pass compact=false for full)' : ' (full)'}`;
                        data = compact
                            ? {
                                ...compactBatchDetail(detail),
                                publishedSourceIds,
                                totalItems,
                                pendingItems,
                                returnedItems,
                                hasMore,
                            }
                            : detail;
                    }
                    else {
                        summary = `${detail.batch.name}: ${returnedItems}/${filteredItems.length} ${pendingOnly ? 'pending ' : ''}item(s) (${totalItems} total, ${pendingItems} pending, ${publishedSourceIds.length} published source(s))${compact ? ' (compact; pass compact=false for full)' : ' (full)'}`;
                        const base = compact
                            ? compactBatchDetail({ ...detail, items: slicedItems })
                            : { ...detail, items: slicedItems };
                        data = {
                            ...base,
                            publishedSourceIds,
                            totalItems,
                            pendingItems,
                            returnedItems,
                            hasMore,
                            pendingOnly,
                            offset,
                            ...(limit === undefined ? {} : { limit }),
                        };
                    }
                    break;
                }
                case 'batch_preflight': {
                    ensureBatchSourceReady();
                    const batchId = readPositiveInt(args.batchId, 'batchId');
                    if (args.autoSkip !== undefined && typeof args.autoSkip !== 'boolean') {
                        throw new Error('backlinks autoSkip must be a boolean.');
                    }
                    if (args.autoSkipTagged !== undefined && typeof args.autoSkipTagged !== 'boolean') {
                        throw new Error('backlinks autoSkipTagged must be a boolean.');
                    }
                    let itemIds;
                    if (args.itemIds !== undefined) {
                        if (!Array.isArray(args.itemIds)) {
                            throw new Error('backlinks itemIds must be an array of positive integers.');
                        }
                        itemIds = args.itemIds.map((entry, idx) => readPositiveInt(entry, `itemIds[${idx}]`));
                    }
                    let skipTags;
                    if (args.skipTags !== undefined) {
                        if (!Array.isArray(args.skipTags)
                            || args.skipTags.some(tag => typeof tag !== 'string' || tag.trim().length === 0)) {
                            throw new Error('backlinks skipTags must be an array of non-empty strings.');
                        }
                        skipTags = args.skipTags.map(tag => tag.trim());
                    }
                    const timeoutMs = readBoundedInt(args.timeoutMs, 'timeoutMs', DEFAULT_PREFLIGHT_TIMEOUT_MS, 1_000, 30_000);
                    const concurrency = readBoundedInt(args.concurrency, 'concurrency', DEFAULT_PREFLIGHT_CONCURRENCY, 1, 12);
                    const detail = await batchSource.getBatch(batchId, signal);
                    sessionGuard.recordBatchDetail(detail);
                    const preflight = await runBatchPreflight(batchSource, detail, {
                        timeoutMs,
                        concurrency,
                        autoSkip: args.autoSkip === true,
                        autoSkipTagged: args.autoSkipTagged === true,
                        ...(skipTags === undefined ? {} : { skipTags }),
                        ...(itemIds === undefined ? {} : { itemIds }),
                        fetchImpl,
                        sleepImpl,
                    }, signal);
                    for (const id of [...preflight.skippedDeadItemIds, ...preflight.skippedTaggedItemIds]) {
                        sessionGuard.markItemTerminal(id, 'skipped');
                    }
                    summary = preflight.summary;
                    data = preflight.data;
                    break;
                }
                case 'batch_claim': {
                    ensureBatchSourceReady();
                    const batchId = readPositiveInt(args.batchId, 'batchId');
                    let itemIds;
                    if (args.itemIds !== undefined) {
                        if (!Array.isArray(args.itemIds)) {
                            throw new Error('backlinks itemIds must be an array of positive integers.');
                        }
                        itemIds = args.itemIds.map((entry, idx) => readPositiveInt(entry, `itemIds[${idx}]`));
                    }
                    const claim = await batchSource.claim(batchId, itemIds, signal);
                    sessionGuard.recordClaimedItems(batchId, claim.items);
                    const circuitBreakerAlerts = sessionGuard.getClaimAlerts(batchId, claim.items);
                    summary = `lease ${claim.leaseId} over ${claim.items.length} item(s)`
                        + (circuitBreakerAlerts.length > 0
                            ? ` [CIRCUIT BREAKER TRIPPED: ${circuitBreakerAlerts.map(a => a.fingerprint).join(', ')}]`
                            : '');
                    data = circuitBreakerAlerts.length > 0
                        ? { ...claim, circuitBreakerAlerts }
                        : claim;
                    break;
                }
                case 'lease_heartbeat': {
                    ensureBatchSourceReady();
                    const heartbeat = await batchSource.heartbeat(readPositiveInt(args.leaseId, 'leaseId'), signal);
                    summary = `lease ${heartbeat.leaseId} renewed`;
                    data = heartbeat;
                    break;
                }
                case 'lease_release': {
                    ensureBatchSourceReady();
                    const leaseId = readPositiveInt(args.leaseId, 'leaseId');
                    await batchSource.release(leaseId, signal);
                    summary = `lease ${leaseId} released`;
                    data = { leaseId };
                    break;
                }
                case 'item_result': {
                    ensureBatchSourceReady();
                    const itemId = readPositiveInt(args.itemId, 'itemId');
                    const templateSignature = readOptionalString(args.templateSignature, 'templateSignature');
                    const result = parseItemResult(args);
                    const outcome = await batchSource.reportItemResult(itemId, result, signal);
                    const circuitBreaker = sessionGuard.recordItemResult({
                        itemId,
                        status: result.status,
                        ...(result.status === 'failed'
                            ? { failureReason: result.failureReason, ...(result.evidence === undefined ? {} : { evidence: result.evidence }) }
                            : {}),
                        ...(result.status === 'skipped' ? { skipReason: result.skipReason } : {}),
                        ...(templateSignature === undefined ? {} : { templateSignature }),
                    });
                    const badgeContext = result.status === 'failed'
                        ? `${result.failureReason} ${result.evidence ?? ''}`
                        : result.status === 'skipped'
                            ? result.skipReason
                            : '';
                    const badgeRollbackReminder = result.status === 'failed' || result.status === 'skipped'
                        ? sessionGuard.findActiveBadgeForItem(itemId, badgeContext)
                        : undefined;
                    summary = `item ${outcome.itemStatus}`
                        + (circuitBreaker ? ` [CIRCUIT BREAKER TRIPPED: ${circuitBreaker.fingerprint}]` : '')
                        + (badgeRollbackReminder ? ` [ROLLBACK BADGE ${badgeRollbackReminder.badgeId}]` : '');
                    data = circuitBreaker === undefined && badgeRollbackReminder === undefined
                        ? outcome
                        : {
                            ...outcome,
                            ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
                            ...(badgeRollbackReminder === undefined ? {} : { badgeRollbackReminder }),
                        };
                    break;
                }
                case 'badge_add': {
                    ensureBatchSourceReady();
                    if (args.isActive !== undefined && typeof args.isActive !== 'boolean') {
                        throw new Error('backlinks isActive must be a boolean.');
                    }
                    const websiteId = readPositiveInt(args.websiteId, 'websiteId');
                    const badge = {
                        name: readNonEmpty(args.name, 'name'),
                        html: readNonEmpty(args.html, 'html'),
                        ...(args.isActive === undefined ? {} : { isActive: args.isActive }),
                    };
                    const outcome = await batchSource.addBadge(websiteId, badge, signal);
                    if (badge.isActive !== false) {
                        sessionGuard.recordBadgeAdded({
                            badgeId: outcome.backlinkId,
                            websiteId,
                            name: badge.name,
                            html: badge.html,
                        });
                    }
                    summary = `badge ${outcome.backlinkId} created; `
                        + (outcome.callbackTriggered
                            ? 'site refresh callback fired — run backlinks action=badge_verify to confirm the badge is live'
                            : 'site refresh callback did NOT fire — run backlinks action=badge_verify with refreshUrl to trigger refresh and confirm live');
                    data = outcome;
                    break;
                }
                case 'badge_verify': {
                    const siteUrl = readHttpUrl(args.siteUrl, 'siteUrl');
                    const expectedTarget = readNonEmpty(args.expectedTarget, 'expectedTarget');
                    const refreshUrlRaw = readOptionalString(args.refreshUrl, 'refreshUrl');
                    const refreshUrl = refreshUrlRaw === undefined ? undefined : readHttpUrl(refreshUrlRaw, 'refreshUrl');
                    const retries = readBoundedInt(args.retries, 'retries', 3, 1, 5);
                    const retryDelayMs = readBoundedInt(args.retryDelayMs, 'retryDelayMs', 5_000, 0, 30_000);
                    const timeoutMs = readBoundedInt(args.timeoutMs, 'timeoutMs', 15_000, 1_000, 60_000);
                    let refresh;
                    if (refreshUrl !== undefined) {
                        try {
                            const res = await fetchWithTimeout(fetchImpl, refreshUrl, timeoutMs, signal);
                            refresh = { triggered: true, url: refreshUrl, status: res.status, ok: res.ok };
                        }
                        catch (error) {
                            if (signal?.aborted)
                                throw error;
                            refresh = {
                                triggered: true,
                                url: refreshUrl,
                                ok: false,
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                    }
                    let lastStatus;
                    let lastError;
                    for (let attempt = 1; attempt <= retries; attempt++) {
                        try {
                            const res = await fetchWithTimeout(fetchImpl, siteUrl, timeoutMs, signal);
                            lastStatus = res.status;
                            const html = await res.text();
                            if (res.ok) {
                                const matchedSnippet = findMatchedSnippet(html, expectedTarget);
                                if (matchedSnippet !== undefined) {
                                    summary = `badge verified on ${siteUrl} (attempt ${attempt}/${retries}, HTTP ${res.status})`;
                                    data = {
                                        verified: true,
                                        siteUrl,
                                        expectedTarget,
                                        attempts: attempt,
                                        httpStatus: res.status,
                                        matchedSnippet,
                                        ...(refresh === undefined ? {} : { refresh }),
                                    };
                                    return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }] };
                                }
                                lastError = `expected target "${expectedTarget}" not found in HTML`;
                            }
                            else {
                                lastError = `HTTP ${res.status}`;
                            }
                        }
                        catch (error) {
                            if (signal?.aborted)
                                throw error;
                            lastError = error instanceof Error ? error.message : String(error);
                        }
                        if (attempt < retries) {
                            await sleepImpl(retryDelayMs, signal);
                        }
                    }
                    summary = `badge NOT found on ${siteUrl} after ${retries} attempt(s)`;
                    data = {
                        verified: false,
                        siteUrl,
                        expectedTarget,
                        attempts: retries,
                        ...(lastStatus === undefined ? {} : { httpStatus: lastStatus }),
                        ...(lastError === undefined ? {} : { lastError }),
                        ...(refresh === undefined ? {} : { refresh }),
                    };
                    break;
                }
                case 'badge_deactivate': {
                    ensureBatchSourceReady();
                    const websiteId = readPositiveInt(args.websiteId, 'websiteId');
                    const badgeId = readOptionalPositiveInt(args.badgeId, 'badgeId');
                    const nameRaw = readOptionalString(args.name, 'name');
                    const htmlRaw = readOptionalString(args.html, 'html');
                    const name = nameRaw !== undefined && nameRaw.trim().length > 0 ? nameRaw.trim() : undefined;
                    const html = htmlRaw !== undefined && htmlRaw.trim().length > 0 ? htmlRaw.trim() : undefined;
                    if (badgeId === undefined && name === undefined && html === undefined) {
                        throw new Error('backlinks badge_deactivate requires badgeId, name, or html.');
                    }
                    if (args.remove !== undefined && typeof args.remove !== 'boolean') {
                        throw new Error('backlinks remove must be a boolean.');
                    }
                    const remove = args.remove === true;
                    const refreshUrlRaw = readOptionalString(args.refreshUrl, 'refreshUrl');
                    const refreshUrl = refreshUrlRaw === undefined ? undefined : readHttpUrl(refreshUrlRaw, 'refreshUrl');
                    const timeoutMs = readBoundedInt(args.timeoutMs, 'timeoutMs', 15_000, 1_000, 60_000);
                    if (!batchSource.deactivateBadge) {
                        throw new BacklinksError('batch source provider does not support badge deactivation', 'BACKLINKS_API_ERROR');
                    }
                    const outcome = await batchSource.deactivateBadge(websiteId, {
                        ...(badgeId === undefined ? {} : { badgeId }),
                        ...(name === undefined ? {} : { name }),
                        ...(html === undefined ? {} : { html }),
                        ...(remove ? { remove: true } : {}),
                    }, signal);
                    const effectiveBadgeId = badgeId ?? outcome.backlinkId ?? undefined;
                    sessionGuard.recordBadgeDeactivated({
                        websiteId,
                        ...(effectiveBadgeId === undefined ? {} : { badgeId: effectiveBadgeId }),
                        ...(name === undefined ? {} : { name }),
                        ...(html === undefined ? {} : { html }),
                    });
                    let refresh;
                    if (refreshUrl !== undefined) {
                        try {
                            const res = await fetchWithTimeout(fetchImpl, refreshUrl, timeoutMs, signal);
                            refresh = { triggered: true, url: refreshUrl, status: res.status, ok: res.ok };
                        }
                        catch (error) {
                            if (signal?.aborted)
                                throw error;
                            refresh = {
                                triggered: true,
                                url: refreshUrl,
                                ok: false,
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                    }
                    summary = `badge ${outcome.backlinkId ?? name ?? 'matched'} ${outcome.deleted ? 'deleted' : 'deactivated'} (isActive=false)`;
                    data = {
                        ...outcome,
                        ...(refresh === undefined ? {} : { refresh }),
                    };
                    break;
                }
                case 'source_tags': {
                    ensureBatchSourceReady();
                    const sourceId = readPositiveInt(args.sourceId, 'sourceId');
                    const unique = parseTags(args.tags);
                    const outcome = await batchSource.tagSource(sourceId, unique, signal);
                    summary = `tags ${unique.join(', ')} attached to source ${sourceId}`;
                    data = outcome;
                    break;
                }
                case 'mailbox_create': {
                    ensureMailboxReady();
                    const localPart = readNonEmpty(args.localPart, 'localPart');
                    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(localPart)) {
                        throw new Error('backlinks localPart may contain only letters, digits, dots, underscores, and dashes.');
                    }
                    const address = await mailbox.createMailbox({
                        localPart,
                        domain: readNonEmpty(args.domain, 'domain'),
                    }, signal);
                    summary = address.email;
                    data = address;
                    break;
                }
                case 'mail_wait': {
                    ensureMailboxReady();
                    const email = readNonEmpty(args.mailEmail, 'mailEmail');
                    const waitTimeoutMs = readOptionalPositiveInt(args.waitTimeoutMs, 'waitTimeoutMs') ?? config.mailWaitTimeoutMs;
                    const subjectContains = readOptionalString(args.subjectContains, 'subjectContains');
                    const fromContains = readOptionalString(args.fromContains, 'fromContains');
                    const mail = await mailbox.pollMail({ email }, {
                        ...(subjectContains === undefined ? {} : { subjectContains }),
                        ...(fromContains === undefined ? {} : { fromContains }),
                        timeoutMs: waitTimeoutMs,
                        intervalMs: DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS,
                    }, signal);
                    summary = mail === null ? 'no matching mail before timeout' : (mail.subject || 'mail received');
                    data = mail ?? { timedOut: true };
                    break;
                }
                default:
                    return assertNever(action, `backlinks action must be one of ${BACKLINKS_ACTIONS.join(', ')}.`);
            }
            return {
                content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }],
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
