/**
 * The supermanager implementation of the batch work-source seam (`/api/agent/*`).
 */
import { BacklinksError } from "../backlinks/types.js";
export const SUPERMANAGER_BATCH_SOURCE_ID = 'supermanager';
function asRecord(value) {
    return value;
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
function toNumber(value) {
    return Number(value);
}
function toNullableString(value) {
    return typeof value === 'string' ? value : null;
}
function toCounts(value) {
    const counts = asRecord(value);
    return {
        pending: toNumber(counts.pending),
        executed: toNumber(counts.executed),
        skipped: toNumber(counts.skipped),
        failed: toNumber(counts.failed),
        total: toNumber(counts.total),
    };
}
function profileField(source, field) {
    const value = source[field];
    return typeof value === 'string' && value.length > 0 ? { [field]: value } : {};
}
function toBatchSummary(value) {
    const row = asRecord(value);
    return {
        id: toNumber(row.id),
        name: str(row.name),
        websiteId: toNumber(row.websiteId),
        websiteName: str(row.websiteName),
        websiteHost: str(row.websiteHost),
        plannedAt: str(row.plannedAt),
        counts: toCounts(asRecord(row.counts)),
        executing: row.executing === true,
    };
}
function toStringTags(row) {
    const raw = Array.isArray(row.tags)
        ? row.tags
        : Array.isArray(row.sourceTags)
            ? row.sourceTags
            : [];
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        let text = '';
        if (typeof entry === 'string') {
            text = entry.trim();
        }
        else if (typeof entry === 'object' && entry !== null) {
            const name = entry.name;
            if (typeof name === 'string')
                text = name.trim();
        }
        if (text.length > 0 && !seen.has(text)) {
            seen.add(text);
            out.push(text);
        }
    }
    return out;
}
function toItem(value) {
    const row = asRecord(value);
    return {
        id: toNumber(row.id),
        sourceId: toNumber(row.sourceId),
        sourceName: str(row.sourceName),
        sourceUrl: str(row.sourceUrl),
        sourceHost: str(row.sourceHost),
        submitUrl: toNullableString(row.submitUrl),
        sourceNotes: toNullableString(row.sourceNotes),
        category: toNullableString(row.category),
        tags: toStringTags(row),
        paymentType: str(row.paymentType),
        linkType: str(row.linkType),
        status: str(row.status),
        failureMode: toNullableString(row.failureMode),
        failureReason: toNullableString(row.failureReason),
        publishedUrl: toNullableString(row.publishedUrl),
        publishStatus: toNullableString(row.publishStatus),
        plannedAt: str(row.plannedAt),
    };
}
function toAnchor(value) {
    const row = asRecord(value);
    return {
        id: toNumber(row.id),
        anchorText: String(row.anchorText),
        targetUrl: String(row.targetUrl),
    };
}
function toDetail(value) {
    const website = asRecord(value.website);
    return {
        batch: toBatchSummary(value.batch),
        website: {
            id: toNumber(website.id),
            name: String(website.name),
            siteUrl: String(website.siteUrl),
            siteHost: String(website.siteHost),
            ...profileField(website, 'shortDescription'),
            ...profileField(website, 'longDescription'),
            ...profileField(website, 'logoUrl'),
            ...profileField(website, 'screenshotUrl'),
            ...profileField(website, 'keyFeatures'),
            ...profileField(website, 'pricingType'),
        },
        anchors: Array.isArray(value.anchors) ? value.anchors.map(toAnchor) : [],
        items: Array.isArray(value.items) ? value.items.map(toItem) : [],
    };
}
function httpError(path, response, bodyText) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    const retryAfterSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null;
    const detail = bodyText.slice(0, 300);
    switch (response.status) {
        case 400:
            return new BacklinksError(`supermanager rejected ${path}: ${detail}`, 'BACKLINKS_INVALID_REQUEST', null);
        case 401:
        case 403:
            return new BacklinksError(`supermanager denied ${path} (${response.status}): ${detail}`, 'BACKLINKS_UNAUTHORIZED');
        case 404:
            return new BacklinksError(`supermanager has no resource for ${path}: ${detail}`, 'BACKLINKS_NOT_FOUND');
        case 409:
            return new BacklinksError(`supermanager conflict on ${path}: ${detail}`, 'BACKLINKS_CONFLICT', retryAfterSeconds);
        default:
            return new BacklinksError(`supermanager ${path} failed (HTTP ${response.status}): ${detail}`, 'BACKLINKS_API_ERROR');
    }
}
export class SupermanagerBatchSource {
    resolveConfig;
    id = SUPERMANAGER_BATCH_SOURCE_ID;
    constructor(resolveConfig) {
        this.resolveConfig = resolveConfig;
    }
    available() {
        const { baseUrl, token } = this.resolveConfig();
        return baseUrl.length > 0 && token.length > 0;
    }
    async listBatches(signal) {
        const body = await this.requestJson('/api/agent/batches', { method: 'GET' }, signal);
        const batches = asRecord(body).batches;
        return Array.isArray(batches) ? batches.map(toBatchSummary) : [];
    }
    async getBatch(batchId, signal) {
        const body = await this.requestJson(`/api/agent/batches/${batchId}`, { method: 'GET' }, signal);
        return toDetail(asRecord(body));
    }
    async claim(batchId, itemIds, signal) {
        const payload = itemIds === undefined ? {} : { itemIds: [...itemIds] };
        const body = await this.requestJson(`/api/agent/batches/${batchId}/claim`, { method: 'POST', payload }, signal);
        const record = asRecord(body);
        return {
            leaseId: toNumber(record.leaseId),
            leaseExpiresAt: str(record.leaseExpiresAt),
            items: Array.isArray(record.items) ? record.items.map(toItem) : [],
        };
    }
    async heartbeat(leaseId, signal) {
        const body = await this.requestJson(`/api/agent/leases/${leaseId}/heartbeat`, { method: 'POST' }, signal);
        const record = asRecord(body);
        return {
            leaseId: toNumber(record.leaseId),
            leaseExpiresAt: str(record.leaseExpiresAt),
        };
    }
    async release(leaseId, signal) {
        await this.requestJson(`/api/agent/leases/${leaseId}/release`, { method: 'POST' }, signal);
    }
    async reportItemResult(itemId, result, signal) {
        const body = await this.requestJson(`/api/agent/items/${itemId}/result`, {
            method: 'POST',
            payload: this.resultPayload(result),
        }, signal);
        const record = asRecord(body);
        return {
            itemStatus: str(record.itemStatus),
            publishRecordId: record.publishRecordId === undefined || record.publishRecordId === null
                ? null
                : toNumber(record.publishRecordId),
        };
    }
    async addBadge(websiteId, badge, signal) {
        const body = await this.requestJson(`/api/agent/websites/${websiteId}/footer-backlinks`, {
            method: 'POST',
            payload: {
                name: badge.name,
                html: badge.html,
                ...(badge.isActive === undefined ? {} : { isActive: badge.isActive }),
            },
        }, signal);
        const record = asRecord(body);
        return {
            backlinkId: toNumber(record.backlinkId),
            callbackTriggered: record.callbackTriggered === true,
        };
    }
    async deactivateBadge(websiteId, input, signal) {
        const hasBadgeId = input.badgeId !== undefined;
        const cleanName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : undefined;
        const cleanHtml = typeof input.html === 'string' && input.html.trim().length > 0 ? input.html.trim() : undefined;
        if (!hasBadgeId && cleanName === undefined && cleanHtml === undefined) {
            throw new BacklinksError('badge deactivation requires badgeId, name, or html', 'BACKLINKS_INVALID_REQUEST');
        }
        const endpoint = hasBadgeId
            ? `/api/agent/websites/${websiteId}/footer-backlinks/${input.badgeId}`
            : `/api/agent/websites/${websiteId}/footer-backlinks`;
        try {
            if (hasBadgeId) {
                if (input.remove === true) {
                    const body = await this.requestJson(endpoint, { method: 'DELETE' }, signal);
                    const record = asRecord(body);
                    return {
                        backlinkId: input.badgeId,
                        isActive: false,
                        deleted: true,
                        callbackTriggered: record.callbackTriggered === true,
                        strategy: 'delete_by_id',
                    };
                }
                const body = await this.requestJson(endpoint, {
                    method: 'PATCH',
                    payload: { isActive: false },
                }, signal);
                const record = asRecord(body);
                return {
                    backlinkId: record.backlinkId !== undefined && record.backlinkId !== null
                        ? toNumber(record.backlinkId)
                        : input.badgeId,
                    isActive: false,
                    deleted: false,
                    callbackTriggered: record.callbackTriggered === true,
                    strategy: 'patch_by_id',
                };
            }
            const body = await this.requestJson(endpoint, {
                method: 'PATCH',
                payload: {
                    ...(cleanName === undefined ? {} : { name: cleanName }),
                    ...(cleanHtml === undefined ? {} : { html: cleanHtml }),
                    isActive: false,
                    ...(input.remove === true ? { remove: true } : {}),
                },
            }, signal);
            const record = asRecord(body);
            return {
                backlinkId: record.backlinkId !== undefined && record.backlinkId !== null
                    ? toNumber(record.backlinkId)
                    : null,
                isActive: false,
                deleted: record.deleted === true || input.remove === true,
                callbackTriggered: record.callbackTriggered === true,
                strategy: 'patch_by_match',
            };
        }
        catch (error) {
            if (error instanceof BacklinksError
                && (error.code === 'BACKLINKS_NOT_FOUND'
                    || (error.code === 'BACKLINKS_API_ERROR' && error.message.includes('HTTP 405')))) {
                throw new BacklinksError(`${error.message} (Supermanager backend may not yet expose ${input.remove === true && hasBadgeId ? 'DELETE' : 'PATCH'} ${endpoint})`, error.code, error.retryAfterSeconds, { cause: error });
            }
            throw error;
        }
    }
    async tagSource(sourceId, names, signal) {
        const body = await this.requestJson(`/api/agent/sources/${sourceId}/tags`, {
            method: 'POST',
            payload: { tags: [...names] },
        }, signal);
        const record = asRecord(body);
        const attached = Array.isArray(record.attached)
            ? record.attached.map((entry) => {
                const row = asRecord(entry);
                return {
                    id: toNumber(row.id),
                    name: str(row.name),
                    created: row.created === true,
                };
            })
            : [];
        return { sourceId: toNumber(record.sourceId), attached };
    }
    resultPayload(result) {
        switch (result.status) {
            case 'live':
                return {
                    status: 'live',
                    publicUrl: result.publicUrl,
                    anchorText: result.anchorText,
                    targetUrl: result.targetUrl,
                    ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
                };
            case 'submitted':
                return {
                    status: 'submitted',
                    ...(result.publicUrl === undefined ? {} : { publicUrl: result.publicUrl }),
                    anchorText: result.anchorText,
                    targetUrl: result.targetUrl,
                    ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
                };
            case 'failed':
                return {
                    status: 'failed',
                    failureMode: result.failureMode,
                    failureReason: result.failureReason,
                    ...(result.evidence === undefined ? {} : { evidenceZh: result.evidence }),
                };
            case 'skipped':
                return { status: 'skipped', skipReason: result.skipReason };
        }
    }
    async requestJson(path, init, signal) {
        if (signal?.aborted)
            throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
        const { baseUrl, token, requestTimeoutMs } = this.resolveConfig();
        const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const timeout = new AbortController();
        const timer = setTimeout(() => { timeout.abort(); }, requestTimeoutMs);
        const onOuterAbort = () => { timeout.abort(); };
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
            let response;
            try {
                response = await fetch(`${cleanBase}${path}`, {
                    method: init.method,
                    headers: {
                        authorization: `Bearer ${token}`,
                        ...(init.payload === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    ...(init.payload === undefined ? {} : { body: JSON.stringify(init.payload) }),
                    signal: timeout.signal,
                });
            }
            catch (error) {
                if (signal?.aborted)
                    throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
                if (timeout.signal.aborted) {
                    throw new BacklinksError(`supermanager ${path} timed out after ${requestTimeoutMs}ms`, 'BACKLINKS_TIMEOUT');
                }
                throw new BacklinksError(`supermanager ${path} transport failure: ${String(error instanceof Error ? error.message : error)}`, 'BACKLINKS_TRANSPORT', null, { cause: error });
            }
            const bodyText = await response.text();
            if (!response.ok)
                throw httpError(path, response, bodyText);
            if (response.status === 204 || bodyText.trim().length === 0)
                return {};
            return JSON.parse(bodyText);
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
        }
    }
}
