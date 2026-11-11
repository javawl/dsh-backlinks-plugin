import { n as BacklinksError } from "./backlinks-BYBQXviM.js";
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
// lib/types/host/supermanager/provider.js
/**
* The supermanager implementation of the batch work-source seam (`/api/agent/*`).
*/
const SUPERMANAGER_BATCH_SOURCE_ID = "supermanager";
function asRecord(value) {
	return value;
}
function str(value) {
	return typeof value === "string" ? value : "";
}
function toNumber(value) {
	return Number(value);
}
function toNullableString(value) {
	return typeof value === "string" ? value : null;
}
function toCounts(value) {
	const counts = asRecord(value);
	return {
		pending: toNumber(counts.pending),
		executed: toNumber(counts.executed),
		skipped: toNumber(counts.skipped),
		failed: toNumber(counts.failed),
		total: toNumber(counts.total)
	};
}
function profileField(source, field) {
	const value = source[field];
	return typeof value === "string" && value.length > 0 ? { [field]: value } : {};
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
		executing: row.executing === true
	};
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
		tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
		paymentType: str(row.paymentType),
		linkType: str(row.linkType),
		status: str(row.status),
		failureMode: toNullableString(row.failureMode),
		failureReason: toNullableString(row.failureReason),
		publishedUrl: toNullableString(row.publishedUrl),
		publishStatus: toNullableString(row.publishStatus),
		plannedAt: str(row.plannedAt)
	};
}
function toAnchor(value) {
	const row = asRecord(value);
	return {
		id: toNumber(row.id),
		anchorText: String(row.anchorText),
		targetUrl: String(row.targetUrl)
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
			...profileField(website, "shortDescription"),
			...profileField(website, "longDescription"),
			...profileField(website, "logoUrl"),
			...profileField(website, "screenshotUrl"),
			...profileField(website, "keyFeatures"),
			...profileField(website, "pricingType")
		},
		anchors: Array.isArray(value.anchors) ? value.anchors.map(toAnchor) : [],
		items: Array.isArray(value.items) ? value.items.map(toItem) : []
	};
}
function httpError(path, response, bodyText) {
	const retryAfter = Number(response.headers.get("retry-after") ?? "");
	const retryAfterSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null;
	const detail = bodyText.slice(0, 300);
	switch (response.status) {
		case 400: return new BacklinksError(`supermanager rejected ${path}: ${detail}`, "BACKLINKS_INVALID_REQUEST", null);
		case 401:
		case 403: return new BacklinksError(`supermanager denied ${path} (${response.status}): ${detail}`, "BACKLINKS_UNAUTHORIZED");
		case 404: return new BacklinksError(`supermanager has no resource for ${path}: ${detail}`, "BACKLINKS_NOT_FOUND");
		case 409: return new BacklinksError(`supermanager conflict on ${path}: ${detail}`, "BACKLINKS_CONFLICT", retryAfterSeconds);
		default: return new BacklinksError(`supermanager ${path} failed (HTTP ${response.status}): ${detail}`, "BACKLINKS_API_ERROR");
	}
}
var SupermanagerBatchSource = class {
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
		const batches = asRecord(await this.requestJson("/api/agent/batches", { method: "GET" }, signal)).batches;
		return Array.isArray(batches) ? batches.map(toBatchSummary) : [];
	}
	async getBatch(batchId, signal) {
		return toDetail(asRecord(await this.requestJson(`/api/agent/batches/${batchId}`, { method: "GET" }, signal)));
	}
	async claim(batchId, itemIds, signal) {
		const payload = itemIds === void 0 ? {} : { itemIds: [...itemIds] };
		const record = asRecord(await this.requestJson(`/api/agent/batches/${batchId}/claim`, {
			method: "POST",
			payload
		}, signal));
		return {
			leaseId: toNumber(record.leaseId),
			leaseExpiresAt: str(record.leaseExpiresAt),
			items: Array.isArray(record.items) ? record.items.map(toItem) : []
		};
	}
	async heartbeat(leaseId, signal) {
		const record = asRecord(await this.requestJson(`/api/agent/leases/${leaseId}/heartbeat`, { method: "POST" }, signal));
		return {
			leaseId: toNumber(record.leaseId),
			leaseExpiresAt: str(record.leaseExpiresAt)
		};
	}
	async release(leaseId, signal) {
		await this.requestJson(`/api/agent/leases/${leaseId}/release`, { method: "POST" }, signal);
	}
	async reportItemResult(itemId, result, signal) {
		const record = asRecord(await this.requestJson(`/api/agent/items/${itemId}/result`, {
			method: "POST",
			payload: this.resultPayload(result)
		}, signal));
		return {
			itemStatus: str(record.itemStatus),
			publishRecordId: record.publishRecordId === void 0 || record.publishRecordId === null ? null : toNumber(record.publishRecordId)
		};
	}
	async addBadge(websiteId, badge, signal) {
		const record = asRecord(await this.requestJson(`/api/agent/websites/${websiteId}/footer-backlinks`, {
			method: "POST",
			payload: {
				name: badge.name,
				html: badge.html,
				...badge.isActive === void 0 ? {} : { isActive: badge.isActive }
			}
		}, signal));
		return {
			backlinkId: toNumber(record.backlinkId),
			callbackTriggered: record.callbackTriggered === true
		};
	}
	async tagSource(sourceId, names, signal) {
		const record = asRecord(await this.requestJson(`/api/agent/sources/${sourceId}/tags`, {
			method: "POST",
			payload: { tags: [...names] }
		}, signal));
		const attached = Array.isArray(record.attached) ? record.attached.map((entry) => {
			const row = asRecord(entry);
			return {
				id: toNumber(row.id),
				name: str(row.name),
				created: row.created === true
			};
		}) : [];
		return {
			sourceId: toNumber(record.sourceId),
			attached
		};
	}
	resultPayload(result) {
		switch (result.status) {
			case "live": return {
				status: "live",
				publicUrl: result.publicUrl,
				anchorText: result.anchorText,
				targetUrl: result.targetUrl,
				...result.evidence === void 0 ? {} : { evidenceZh: result.evidence }
			};
			case "submitted": return {
				status: "submitted",
				...result.publicUrl === void 0 ? {} : { publicUrl: result.publicUrl },
				anchorText: result.anchorText,
				targetUrl: result.targetUrl,
				...result.evidence === void 0 ? {} : { evidenceZh: result.evidence }
			};
			case "failed": return {
				status: "failed",
				failureMode: result.failureMode,
				failureReason: result.failureReason,
				...result.evidence === void 0 ? {} : { evidenceZh: result.evidence }
			};
			case "skipped": return {
				status: "skipped",
				skipReason: result.skipReason
			};
		}
	}
	async requestJson(path, init, signal) {
		if (signal?.aborted) throw new BacklinksError("request aborted", "BACKLINKS_ABORTED");
		const { baseUrl, token, requestTimeoutMs } = this.resolveConfig();
		const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
		const timeout = new AbortController();
		const timer = setTimeout(() => {
			timeout.abort();
		}, requestTimeoutMs);
		const onOuterAbort = () => {
			timeout.abort();
		};
		signal?.addEventListener("abort", onOuterAbort, { once: true });
		try {
			let response;
			try {
				response = await fetch(`${cleanBase}${path}`, {
					method: init.method,
					headers: {
						authorization: `Bearer ${token}`,
						...init.payload === void 0 ? {} : { "content-type": "application/json" }
					},
					...init.payload === void 0 ? {} : { body: JSON.stringify(init.payload) },
					signal: timeout.signal
				});
			} catch (error) {
				if (signal?.aborted) throw new BacklinksError("request aborted", "BACKLINKS_ABORTED");
				if (timeout.signal.aborted) throw new BacklinksError(`supermanager ${path} timed out after ${requestTimeoutMs}ms`, "BACKLINKS_TIMEOUT");
				throw new BacklinksError(`supermanager ${path} transport failure: ${String(error instanceof Error ? error.message : error)}`, "BACKLINKS_TRANSPORT", null, { cause: error });
			}
			const bodyText = await response.text();
			if (!response.ok) throw httpError(path, response, bodyText);
			return JSON.parse(bodyText);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
		}
	}
};
// lib/types/host/supermanager/index.js
/**
* Service Provider for the supermanager batch work-source seam.
* Settings namespace: `backlinks-supermanager`.
*/
const name = "backlinks-supermanager";
const inject = ["backlinks"];
const BACKLINKS_SUPERMANAGER_SETTINGS_NAMESPACE = "backlinks-supermanager";
const Config = z.object({
	baseUrl: z.string().default("").volatile(),
	token: z.string().role("secret").volatile(),
	requestTimeoutMs: z.number().default(15e3).volatile()
});
function assertHttpBaseUrl(baseUrl) {
	if (baseUrl.length > 0 && !/^https?:\/\//u.test(baseUrl)) throw new Error(`backlinks-supermanager: baseUrl must be an http(s) URL, got ${baseUrl}`);
}
function apply(ctx, config) {
	const resolve = () => {
		const requestTimeoutMs = config.requestTimeoutMs.get();
		if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error(`backlinks-supermanager: requestTimeoutMs must be a positive integer, got ${requestTimeoutMs}`);
		const baseUrl = config.baseUrl.get();
		assertHttpBaseUrl(baseUrl);
		const declared = config.token.get();
		return {
			baseUrl,
			token: declared !== void 0 && declared.length > 0 ? declared : launchEnvironmentOf(ctx).get("SUPERMANAGER_TOKEN")?.value ?? "",
			requestTimeoutMs
		};
	};
	ctx.effect(() => ctx.backlinks.registerBatchSourceProvider(new SupermanagerBatchSource(resolve)), "backlinks-supermanager: provider");
}
export { BACKLINKS_SUPERMANAGER_SETTINGS_NAMESPACE, Config, SUPERMANAGER_BATCH_SOURCE_ID, SupermanagerBatchSource, apply, inject, name };
