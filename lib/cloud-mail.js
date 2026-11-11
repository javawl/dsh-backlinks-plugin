import { n as BacklinksError } from "./backlinks-BYBQXviM.js";
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
// lib/types/host/cloud-mail/provider.js
/**
* The cloud-mail implementation of the mailbox seam (`POST /public/addUser`, `POST /public/emailList`).
*/
const CLOUD_MAIL_MAILBOX_ID = "cloud-mail";
const FIRST_URL = /https?:\/\/[^\s<>"')]+/u;
function asRecord(value) {
	return value;
}
function str(value) {
	return typeof value === "string" ? value : "";
}
function toVerificationMail(row) {
	const text = typeof row.text === "string" && row.text.length > 0 ? row.text : str(row.content);
	const link = text.match(FIRST_URL)?.[0] ?? null;
	return {
		subject: str(row.subject),
		from: str(row.sendEmail),
		text,
		code: typeof row.code === "string" && row.code.length > 0 ? row.code : null,
		link,
		receivedAt: str(row.createTime)
	};
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new BacklinksError("mailbox wait aborted", "BACKLINKS_ABORTED"));
		}, { once: true });
	});
}
var CloudMailMailbox = class {
	resolveConfig;
	id = CLOUD_MAIL_MAILBOX_ID;
	constructor(resolveConfig) {
		this.resolveConfig = resolveConfig;
	}
	available() {
		const { baseUrl, token } = this.resolveConfig();
		return baseUrl.length > 0 && token.length > 0;
	}
	async createMailbox(options, signal) {
		const email = `${options.localPart}@${options.domain}`;
		await this.requestJson("/public/addUser", {
			method: "POST",
			payload: { list: [{ email }] }
		}, signal);
		return { email };
	}
	async pollMail(address, options, signal) {
		const deadline = Date.now() + options.timeoutMs;
		while (true) {
			const match = (await this.fetchMailRows(address, signal)).find((row) => this.matches(row, options));
			if (match !== void 0) return toVerificationMail(match);
			if (Date.now() + options.intervalMs >= deadline) return null;
			await sleep(options.intervalMs, signal);
		}
	}
	async fetchMailRows(address, signal) {
		const body = await this.requestJson("/public/emailList", {
			method: "POST",
			payload: {
				toEmail: address.email,
				size: 20,
				num: 1,
				type: 0,
				isDel: 0
			}
		}, signal);
		const data = asRecord(body).data ?? body;
		const rows = Array.isArray(data) ? data : asRecord(data).list;
		return Array.isArray(rows) ? rows.map(asRecord) : [];
	}
	matches(row, options) {
		if (options.subjectContains !== void 0 && !str(row.subject).toLowerCase().includes(options.subjectContains.toLowerCase())) return false;
		if (options.fromContains !== void 0 && !str(row.sendEmail).toLowerCase().includes(options.fromContains.toLowerCase())) return false;
		return true;
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
						authorization: token,
						"content-type": "application/json"
					},
					body: JSON.stringify(init.payload),
					signal: timeout.signal
				});
			} catch (error) {
				if (signal?.aborted) throw new BacklinksError("request aborted", "BACKLINKS_ABORTED");
				if (timeout.signal.aborted) throw new BacklinksError(`cloud-mail ${path} timed out after ${requestTimeoutMs}ms`, "BACKLINKS_TIMEOUT");
				throw new BacklinksError(`cloud-mail ${path} transport failure: ${String(error instanceof Error ? error.message : error)}`, "BACKLINKS_TRANSPORT", null, { cause: error });
			}
			const bodyText = await response.text();
			if (!response.ok) throw new BacklinksError(`cloud-mail ${path} failed (HTTP ${response.status}): ${bodyText.slice(0, 300)}`, response.status === 401 || response.status === 403 ? "BACKLINKS_UNAUTHORIZED" : "BACKLINKS_API_ERROR");
			return JSON.parse(bodyText);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
		}
	}
};
// lib/types/host/cloud-mail/index.js
/**
* Service Provider for the cloud-mail mailbox seam.
* Settings namespace: `backlinks-cloud-mail`.
*/
const name = "backlinks-cloud-mail";
const inject = ["backlinks"];
const BACKLINKS_CLOUD_MAIL_SETTINGS_NAMESPACE = "backlinks-cloud-mail";
const Config = z.object({
	baseUrl: z.string().default("").volatile(),
	token: z.string().role("secret").volatile(),
	requestTimeoutMs: z.number().default(15e3).volatile()
});
function assertHttpBaseUrl(baseUrl) {
	if (baseUrl.length > 0 && !/^https?:\/\//u.test(baseUrl)) throw new Error(`backlinks-cloud-mail: baseUrl must be an http(s) URL, got ${baseUrl}`);
}
function apply(ctx, config) {
	const resolve = () => {
		const requestTimeoutMs = config.requestTimeoutMs.get();
		if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error(`backlinks-cloud-mail: requestTimeoutMs must be a positive integer, got ${requestTimeoutMs}`);
		const baseUrl = config.baseUrl.get();
		assertHttpBaseUrl(baseUrl);
		const declared = config.token.get();
		return {
			baseUrl,
			token: declared !== void 0 && declared.length > 0 ? declared : launchEnvironmentOf(ctx).get("CLOUDMAIL_TOKEN")?.value ?? "",
			requestTimeoutMs
		};
	};
	ctx.effect(() => ctx.backlinks.registerMailboxProvider(new CloudMailMailbox(resolve)), "backlinks-cloud-mail: provider");
}
export { BACKLINKS_CLOUD_MAIL_SETTINGS_NAMESPACE, CLOUD_MAIL_MAILBOX_ID, CloudMailMailbox, Config, apply, inject, name };
