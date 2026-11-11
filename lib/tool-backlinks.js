import { t as assertNever } from "./backlinks-types-C6425y97.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
// lib/types/host/tool-backlinks/backlinks.js
/**
* Model-facing `backlinks` tool and `tool:backlinks` system-prompt section.
*/
const ACTIONS = [
	"batch_list",
	"batch_get",
	"batch_claim",
	"lease_heartbeat",
	"lease_release",
	"item_result",
	"badge_add",
	"source_tags",
	"mailbox_create",
	"mail_wait"
];
function readAction(args) {
	return args.action;
}
function readId(args, field) {
	const parsed = Number(args[field]);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`backlinks ${field} must be a positive integer.`);
	return parsed;
}
function readNonEmpty(args, field) {
	const value = args[field];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`backlinks ${field} must be a non-empty string.`);
	return value.trim();
}
function readOptionalString(args, field) {
	const value = args[field];
	if (value === void 0 || value === null || value === "") return void 0;
	if (typeof value !== "string") throw new Error(`backlinks ${field} must be a string.`);
	return value;
}
function parseItemResult(args) {
	const evidence = readOptionalString(args, "evidence");
	switch (args.status) {
		case "live": return {
			status: "live",
			publicUrl: readNonEmpty(args, "publicUrl"),
			anchorText: readNonEmpty(args, "anchorText"),
			targetUrl: readNonEmpty(args, "targetUrl"),
			...evidence === void 0 ? {} : { evidence }
		};
		case "submitted": {
			const publicUrl = readOptionalString(args, "publicUrl");
			return {
				status: "submitted",
				...publicUrl === void 0 ? {} : { publicUrl },
				anchorText: readNonEmpty(args, "anchorText"),
				targetUrl: readNonEmpty(args, "targetUrl"),
				...evidence === void 0 ? {} : { evidence }
			};
		}
		case "failed": {
			const failureMode = args.failureMode;
			if (failureMode !== "retryable" && failureMode !== "manual_required") throw new Error("backlinks failureMode must be retryable or manual_required.");
			return {
				status: "failed",
				failureMode,
				failureReason: readNonEmpty(args, "failureReason"),
				...evidence === void 0 ? {} : { evidence }
			};
		}
		case "skipped": return {
			status: "skipped",
			skipReason: readNonEmpty(args, "skipReason")
		};
		default: throw new Error("backlinks item_result requires status live, submitted, failed, or skipped.");
	}
}
function renderBacklinksValue(value) {
	const record = value ?? {};
	const summary = typeof record.summary === "string" ? record.summary : "";
	const data = record.data === void 0 ? null : record.data;
	return `${summary}\n${JSON.stringify(data)}`;
}
function presentBacklinksCall(args) {
	const action = typeof args.action === "string" ? args.action : "backlinks";
	const target = args.batchId ?? args.leaseId ?? args.itemId ?? args.websiteId ?? args.mailEmail;
	const rawInput = typeof target === "string" ? target : typeof target === "number" ? String(target) : void 0;
	return {
		card: "generic",
		title: `backlinks ${action}`,
		kind: "execute",
		...rawInput === void 0 ? {} : { rawInput }
	};
}
function backlinksMetaFromValue(value) {
	const record = value ?? {};
	return {
		kind: "backlinks",
		action: typeof record.action === "string" ? record.action : "unknown",
		summary: typeof record.summary === "string" ? record.summary : ""
	};
}
function backlinksMetaFromMeta(meta) {
	if (meta === void 0 || typeof meta !== "object" || meta === null) return void 0;
	const candidate = meta;
	return candidate.kind === "backlinks" && typeof candidate.summary === "string" ? { summary: candidate.summary } : void 0;
}
function presentBacklinksResult(_args, result) {
	const meta = backlinksMetaFromMeta(result.meta);
	return meta === void 0 ? void 0 : {
		card: "generic",
		title: meta.summary
	};
}
function backlinksIsConcurrencySafe() {
	return false;
}
function applyBacklinksTool(ctx, timeoutMs) {
	ctx.systemPrompt.section({
		name: "tool:backlinks",
		order: 113,
		text: [
			"Use the backlinks tool to run the publish-batch workflow against the backlink management backend:",
			"batch_list → batch_get (pick a batch) → batch_claim (grants a lease; heartbeat every ~30s while working)",
			"→ per item: browser publishes on the target site, then item_result reports live/submitted/failed/skipped",
			"→ lease_release when done. mailbox_create + mail_wait receive site verification codes (returns code and first link).",
			"badge_add installs a reciprocal footer badge when a site requires exchange.",
			"source_tags attaches tags to the target site by name after a publish attempt (免徽章/要徽章/可复用/有盾…); idempotent add-only.",
			"Verify before publishing: an item whose publishStatus is submitted or live, or whose publishedUrl is set, is already published — never claim or re-submit it, and a source with such a record on any item of the batch is done too; an existing link to the promoted website found on the target site also means already published — report skipped with the reason.",
			"Never re-submit an item whose outcome is unknown: report failed with failureMode manual_required instead."
		].join(" ")
	});
	ctx.tools.register(defineTool({
		name: "backlinks",
		description: "Run the publish-batch workflow: list/detail/claim batches, keep the lease alive, report per-item results, create verification mailboxes, wait for verification mail, and add reciprocal badges.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: `One of ${ACTIONS.join(", ")}.`
			},
			batchId: {
				type: "number",
				description: "Batch id for batch_get / batch_claim."
			},
			itemIds: {
				type: "array",
				items: { type: "number" },
				description: "Optional explicit plan-item subset for batch_claim; omitted claims pending + retryable."
			},
			leaseId: {
				type: "number",
				description: "Lease id for lease_heartbeat / lease_release."
			},
			itemId: {
				type: "number",
				description: "Plan item id for item_result."
			},
			websiteId: {
				type: "number",
				description: "Website id for badge_add."
			},
			sourceId: {
				type: "number",
				description: "Source id (target site) for source_tags; from batch item sourceId."
			},
			status: {
				type: "string",
				description: "item_result status: live, submitted, failed, or skipped."
			},
			publicUrl: {
				type: "string",
				description: "Verified public listing URL (required for live)."
			},
			anchorText: {
				type: "string",
				description: "Anchor text used (live/submitted)."
			},
			targetUrl: {
				type: "string",
				description: "Target URL used (live/submitted)."
			},
			evidence: {
				type: "string",
				description: "One-line evidence note stored with the result."
			},
			failureMode: {
				type: "string",
				description: "failed classification: retryable or manual_required."
			},
			failureReason: {
				type: "string",
				description: "Why the item failed."
			},
			skipReason: {
				type: "string",
				description: "Why the item is skipped."
			},
			name: {
				type: "string",
				description: "Badge name for badge_add."
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "source_tags: 1-10 tag names to attach to the target site, e.g. [可复用, 免徽章]."
			},
			html: {
				type: "string",
				description: "Badge HTML for badge_add."
			},
			isActive: {
				type: "boolean",
				description: "Activate the badge immediately (default true)."
			},
			localPart: {
				type: "string",
				description: "Mailbox local part for mailbox_create."
			},
			domain: {
				type: "string",
				description: "Mail domain for mailbox_create."
			},
			mailEmail: {
				type: "string",
				description: "Mailbox address for mail_wait."
			},
			subjectContains: {
				type: "string",
				description: "Subject filter for mail_wait."
			},
			fromContains: {
				type: "string",
				description: "Sender filter for mail_wait."
			},
			waitTimeoutMs: {
				type: "number",
				description: "Total wait bound for mail_wait in milliseconds."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: {
						type: "string",
						required: true
					},
					summary: {
						type: "string",
						required: true
					},
					data: {
						type: "json",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderBacklinksValue(value)
			}],
			presentationMeta: (_args, value) => backlinksMetaFromValue(value)
		},
		timeoutMs,
		isConcurrencySafe: backlinksIsConcurrencySafe,
		async execute(args, exec) {
			const action = readAction(args);
			let summary;
			let data;
			switch (action) {
				case "batch_list": {
					const batches = await ctx.backlinks.listBatches(exec.signal);
					summary = `${batches.length} batch(es)`;
					data = { batches };
					break;
				}
				case "batch_get": {
					const detail = await ctx.backlinks.getBatch(readId(args, "batchId"), exec.signal);
					summary = `${detail.batch.name}: ${detail.items.length} item(s)`;
					data = detail;
					break;
				}
				case "batch_claim": {
					const itemIds = Array.isArray(args.itemIds) ? args.itemIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : void 0;
					const claim = await ctx.backlinks.claim(readId(args, "batchId"), itemIds, exec.signal);
					summary = `lease ${claim.leaseId} over ${claim.items.length} item(s)`;
					data = claim;
					break;
				}
				case "lease_heartbeat": {
					const heartbeat = await ctx.backlinks.heartbeat(readId(args, "leaseId"), exec.signal);
					summary = `lease ${heartbeat.leaseId} renewed`;
					data = heartbeat;
					break;
				}
				case "lease_release": {
					const leaseId = readId(args, "leaseId");
					await ctx.backlinks.release(leaseId, exec.signal);
					summary = `lease ${leaseId} released`;
					data = { leaseId };
					break;
				}
				case "item_result": {
					const result = parseItemResult(args);
					const outcome = await ctx.backlinks.reportItemResult(readId(args, "itemId"), result, exec.signal);
					summary = `item ${outcome.itemStatus}`;
					data = outcome;
					break;
				}
				case "badge_add": {
					const badge = {
						name: readNonEmpty(args, "name"),
						html: readNonEmpty(args, "html"),
						...args.isActive === void 0 ? {} : { isActive: args.isActive !== false }
					};
					const outcome = await ctx.backlinks.addBadge(readId(args, "websiteId"), badge, exec.signal);
					summary = `badge ${outcome.backlinkId} created; ` + (outcome.callbackTriggered ? "site refresh callback fired — still curl the site page to confirm the badge is live" : "site refresh callback did NOT fire — curl the website footer refresh URL, then verify the badge on the live page");
					data = outcome;
					break;
				}
				case "source_tags": {
					const names = args.tags;
					if (!Array.isArray(names) || names.length === 0 || names.length > 10 || names.some((name) => typeof name !== "string" || name.trim().length === 0 || name.trim().length > 100)) throw new Error("backlinks source_tags requires a tags array of 1-10 non-empty names.");
					const unique = [...new Set(names.map((name) => name.trim()))];
					const outcome = await ctx.backlinks.tagSource(readId(args, "sourceId"), unique, exec.signal);
					summary = `tags ${unique.join(", ")} attached to source ${readId(args, "sourceId")}`;
					data = outcome;
					break;
				}
				case "mailbox_create": {
					const localPart = readNonEmpty(args, "localPart");
					if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(localPart)) throw new Error("backlinks localPart may contain only letters, digits, dots, underscores, and dashes.");
					const address = await ctx.backlinks.createMailbox({
						localPart,
						domain: readNonEmpty(args, "domain")
					}, exec.signal);
					summary = address.email;
					data = address;
					break;
				}
				case "mail_wait": {
					const email = readNonEmpty(args, "mailEmail");
					const waitTimeoutMs = args.waitTimeoutMs === void 0 ? 12e4 : Number(args.waitTimeoutMs);
					if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0) throw new Error("backlinks waitTimeoutMs must be a positive integer.");
					const subjectContains = readOptionalString(args, "subjectContains");
					const fromContains = readOptionalString(args, "fromContains");
					const mail = await ctx.backlinks.pollMail({ email }, {
						...subjectContains === void 0 ? {} : { subjectContains },
						...fromContains === void 0 ? {} : { fromContains },
						timeoutMs: waitTimeoutMs,
						intervalMs: 5e3
					}, exec.signal);
					summary = mail === null ? "no matching mail before timeout" : mail.subject || "mail received";
					data = mail ?? { timedOut: true };
					break;
				}
				default: return assertNever(action, `backlinks action must be one of ${ACTIONS.join(", ")}.`);
			}
			return {
				action,
				summary,
				data
			};
		},
		presentCall: presentBacklinksCall,
		presentResult: presentBacklinksResult
	}));
}
// lib/types/host/tool-backlinks/index.js
/**
* Consumer for the backlinks capability seam: model-facing `backlinks` tool over `ctx.backlinks`.
*/
const name = "tool-backlinks";
const inject = [
	"tools",
	"backlinks",
	"systemPrompt"
];
const DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS = 3e5;
const Config = z.object({ timeoutMs: z.number().default(DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS) });
function apply(ctx, config) {
	const resolved = config;
	if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) throw new Error(`tool-backlinks: timeoutMs must be a positive integer, got ${resolved.timeoutMs}`);
	applyBacklinksTool(ctx, resolved.timeoutMs);
}
export { Config, DEFAULT_BACKLINKS_TOOL_TIMEOUT_MS, apply, inject, name, parseItemResult, renderBacklinksValue };
