import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
// lib/types/host/backlinks/types.js
/**
* Host-side provider interfaces and error class for `ctx.backlinks`.
*/
var BacklinksError = class extends HarnessError {
	retryAfterSeconds;
	constructor(message, code, retryAfterSeconds = null, options) {
		super(message, code, options);
		this.retryAfterSeconds = retryAfterSeconds;
	}
};
// lib/types/host/backlinks/index.js
/**
* Service Definition for the backlinks capability seam (`ctx.backlinks`).
*/
var BacklinksRuntime = class extends Service {
	static Config = z.object({
		batchSourceProvider: z.string(),
		mailboxProvider: z.string()
	});
	batchSources = /* @__PURE__ */ new Map();
	mailboxes = /* @__PURE__ */ new Map();
	batchSourceId;
	mailboxId;
	constructor(ctx, config = {}) {
		super(ctx, "backlinks");
		this.batchSourceId = config.batchSourceProvider ?? process.env.DSH_BACKLINKS_BATCH_SOURCE;
		this.mailboxId = config.mailboxProvider ?? process.env.DSH_BACKLINKS_MAILBOX;
	}
	registerBatchSourceProvider(provider) {
		return this.registerProvider(this.batchSources, provider, "batch source");
	}
	registerMailboxProvider(provider) {
		return this.registerProvider(this.mailboxes, provider, "mailbox");
	}
	registerProvider(store, provider, kind) {
		if (store.has(provider.id)) throw new BacklinksError(`a ${kind} provider with id "${provider.id}" is already registered`, "BACKLINKS_DUPLICATE_PROVIDER");
		const dispose = this.ctx.effect(function* () {
			store.set(provider.id, provider);
			yield () => store.delete(provider.id);
		}, "backlinks.registerProvider()");
		return () => void dispose();
	}
	async listBatches(signal) {
		return this.resolveBatchSource().listBatches(signal);
	}
	async getBatch(batchId, signal) {
		return this.resolveBatchSource().getBatch(batchId, signal);
	}
	async claim(batchId, itemIds, signal) {
		return this.resolveBatchSource().claim(batchId, itemIds, signal);
	}
	async heartbeat(leaseId, signal) {
		return this.resolveBatchSource().heartbeat(leaseId, signal);
	}
	async release(leaseId, signal) {
		await this.resolveBatchSource().release(leaseId, signal);
	}
	async reportItemResult(itemId, result, signal) {
		return this.resolveBatchSource().reportItemResult(itemId, result, signal);
	}
	async addBadge(websiteId, badge, signal) {
		return this.resolveBatchSource().addBadge(websiteId, badge, signal);
	}
	async tagSource(sourceId, names, signal) {
		return this.resolveBatchSource().tagSource(sourceId, names, signal);
	}
	async createMailbox(options, signal) {
		return this.resolveMailbox().createMailbox(options, signal);
	}
	async pollMail(address, options, signal) {
		return this.resolveMailbox().pollMail(address, options, signal);
	}
	resolveBatchSource() {
		return resolveProvider({
			providers: this.batchSources,
			...this.batchSourceId !== void 0 ? { configuredId: this.batchSourceId } : {}
		});
	}
	resolveMailbox() {
		return resolveProvider({
			providers: this.mailboxes,
			...this.mailboxId !== void 0 ? { configuredId: this.mailboxId } : {}
		});
	}
};
function resolveProvider(selection) {
	const { configuredId, providers } = selection;
	if (configuredId !== void 0) {
		const provider = providers.get(configuredId);
		if (!provider) throw new BacklinksError(`configured backlinks provider "${configuredId}" is not registered`, "BACKLINKS_PROVIDER_CONFIGURED_MISSING");
		if (!provider.available()) throw new BacklinksError(`configured backlinks provider "${configuredId}" is registered but unavailable`, "BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE");
		return provider;
	}
	const usable = [...providers.values()].filter((provider) => provider.available());
	const [single] = usable;
	if (single === void 0) throw new BacklinksError("no usable backlinks provider is registered", "BACKLINKS_PROVIDER_UNAVAILABLE");
	if (usable.length > 1) throw new BacklinksError(`multiple usable backlinks providers are registered (${usable.map((provider) => provider.id).join(", ")}); configure one explicitly`, "BACKLINKS_PROVIDER_AMBIGUOUS");
	return single;
}
export { BacklinksError as n, BacklinksRuntime as t };
