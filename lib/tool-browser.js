import { t as assertNever } from "./backlinks-types-C6425y97.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
// lib/types/host/tool-browser/browser.js
/**
* Model-facing `browser` tool and `tool:browser` system-prompt section.
*/
const ACTIONS = [
	"navigate",
	"snapshot",
	"click",
	"fill",
	"select",
	"press",
	"upload",
	"screenshot",
	"waitFor",
	"closePage",
	"bringToFront",
	"closeBrowser"
];
function parseBrowserArgs(args) {
	const action = args.action;
	const page = readNonEmpty(args.page, "page");
	const url = readNonEmpty(args.url, "url");
	const selector = readSelector(args.selector);
	const value = readNonEmpty(args.value, "value");
	const waitUntil = readWaitUntil(args.waitUntil);
	const timeoutMs = readPositiveInt(args.timeoutMs, "timeoutMs");
	const addressed = (command) => page === void 0 ? command : {
		...command,
		page
	};
	switch (action) {
		case "bringToFront": return addressed({ kind: "bringToFront" });
		case "navigate": {
			const target = readUrl(args.url);
			if (target === void 0) throw new Error("browser navigate requires an http(s) url.");
			return addressed({
				kind: "navigate",
				url: target,
				...waitUntil === void 0 ? {} : { waitUntil }
			});
		}
		case "snapshot": return addressed({
			kind: "snapshot",
			...selector === void 0 ? {} : { selector },
			...args.format === "aria" ? { format: "aria" } : {}
		});
		case "click":
			if (selector === void 0) throw new Error("browser click requires a selector.");
			return addressed({
				kind: "click",
				selector
			});
		case "fill":
			if (selector === void 0) throw new Error("browser fill requires a selector.");
			if (value === void 0) throw new Error("browser fill requires a value.");
			return addressed({
				kind: "fill",
				selector,
				value
			});
		case "select":
			if (selector === void 0) throw new Error("browser select requires a selector.");
			if (value === void 0) throw new Error("browser select requires a value.");
			return addressed({
				kind: "select",
				selector,
				value
			});
		case "press":
			if (typeof args.key !== "string" || args.key.trim().length === 0) throw new Error("browser press requires a key (for example Enter, Tab).");
			return addressed({
				kind: "press",
				key: args.key.trim()
			});
		case "upload":
			if (selector === void 0) throw new Error("browser upload requires a selector.");
			if (!Array.isArray(args.files) || args.files.length === 0 || args.files.some((file) => typeof file !== "string" || file.trim().length === 0)) throw new Error("browser upload requires a non-empty files array of paths.");
			return addressed({
				kind: "upload",
				selector,
				files: args.files.map((file) => String(file))
			});
		case "screenshot": return addressed({ kind: "screenshot" });
		case "waitFor":
			if (selector === void 0 && url === void 0) throw new Error("browser waitFor requires a selector or a url.");
			return addressed({
				kind: "waitFor",
				...selector === void 0 ? {} : { selector },
				...url === void 0 ? {} : { url },
				...timeoutMs === void 0 ? {} : { timeoutMs }
			});
		case "closePage": return addressed({ kind: "closePage" });
		case "closeBrowser": return { kind: "closeBrowser" };
		default: return assertNever(action, `browser action must be one of ${ACTIONS.join(", ")}.`);
	}
}
function readSelector(value) {
	const raw = readNonEmpty(value, "selector");
	if (raw === void 0) return void 0;
	if (/^xy:(?!\d+,\d+$).*/u.test(raw)) throw new Error("browser xy selector must be xy:<x>,<y> with non-negative integers.");
	if (/^role:[^|]*\|$/u.test(raw) || /^role:\|/u.test(raw)) throw new Error("browser role selector must be role:<role>|<name> with both parts non-empty.");
	if (/^(label|placeholder|text):$/u.test(raw)) throw new Error(`browser ${raw.slice(0, -1)} selector must be ${raw}:<text> with non-empty text.`);
	return raw;
}
function readNonEmpty(value, field) {
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`browser ${field} must be a non-empty string.`);
	return value.trim();
}
function readUrl(value) {
	const raw = readNonEmpty(value, "url");
	if (raw === void 0) return void 0;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
		return url.toString();
	} catch {
		throw new Error("browser url must be an absolute http(s) URL.");
	}
}
function readWaitUntil(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value;
	throw new Error("browser waitUntil must be load, domcontentloaded, or networkidle.");
}
function readPositiveInt(value, field) {
	if (value === void 0 || value === null) return void 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`browser ${field} must be a positive integer.`);
	return parsed;
}
function formatBrowserOutput(result, maxChars) {
	switch (result.kind) {
		case "page": return `${`[page ${result.page}] ${result.title}\n${result.url}`}\n\n${result.text.length > maxChars ? `${result.text.slice(0, maxChars)}\n… (truncated)` : result.text}`;
		case "acked": return "ok";
		case "screenshot": return `screenshot captured (${result.pngBase64.length} base64 characters)`;
		default: return assertNever(result, "unhandled browser result kind");
	}
}
function browserIsConcurrencySafe() {
	return false;
}
function presentBrowserCall(args) {
	const action = typeof args.action === "string" ? args.action : "browser";
	const target = typeof args.url === "string" && args.url.length > 0 ? args.url : typeof args.selector === "string" && args.selector.length > 0 ? args.selector : typeof args.key === "string" && args.key.length > 0 ? args.key : void 0;
	return {
		card: "generic",
		title: `browser ${action}`,
		kind: "execute",
		...target === void 0 ? {} : { rawInput: target }
	};
}
function presentBrowserResult(_args, result) {
	const meta = browserMetaFromMeta(result.meta);
	return meta === void 0 ? void 0 : {
		card: "generic",
		title: meta.title
	};
}
function browserMetaFromValue(value) {
	const outcome = value?.result;
	if (outcome?.kind === "page" && typeof outcome.title === "string" && typeof outcome.url === "string") return {
		kind: "browser-page",
		title: outcome.title,
		url: outcome.url,
		...typeof outcome.page === "string" ? { page: outcome.page } : {}
	};
	return {
		kind: "browser",
		outcome: outcome?.kind ?? "unknown"
	};
}
function browserMetaFromMeta(meta) {
	if (meta === void 0 || typeof meta !== "object" || meta === null) return void 0;
	const candidate = meta;
	return candidate.kind === "browser-page" && typeof candidate.title === "string" ? { title: candidate.title } : void 0;
}
function applyBrowserTool(ctx, timeoutMs, maxOutputChars) {
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 112,
		text: [
			"Use the browser tool to drive one shared, persistent real-browser session across tabs.",
			"Tabs: navigate returns a page ref like p2; pass that page on every later command for the tab you are working. Work several sites in parallel by giving each its own ref. Omit page only for single-tab serial work.",
			"Selectors address semantically first: role:<role>|<name> (for example role:button|Submit), label:<text>, placeholder:<text>, text:<text>, or bare CSS as fallback; prefix frame(<iframe css>)>> to reach inside an iframe; click also takes xy:<x>,<y> viewport coordinates from a screenshot.",
			"Prefer snapshot with format=aria to read element roles and names, then address them by role/label/placeholder — far more reliable than guessing CSS.",
			"The window may run offscreen; when a human must step in (CAPTCHA, login), call bringToFront first so the window surfaces.",
			"Actions: navigate (absolute http(s) url), snapshot (url/title/text of the page or a selector), click/fill/select (CSS selector; fill and select need value), press (key like Enter), upload (selector + files), screenshot (PNG base64), waitFor (selector or url), closePage, closeBrowser.",
			"closeBrowser ends the whole browser session; cookies and logins persist in the profile and the next command relaunches it. Use it once browser work is done and no parked tab is waiting for a human, so the browser does not idle on memory.",
			"The session persists cookies and logins across calls and runs; prefer it for sites that need JavaScript, logins, or form submission. Confirm outcomes with snapshot or waitFor after state-changing actions."
		].join(" ")
	});
	ctx.tools.register(defineTool({
		name: "browser",
		description: "Drive one shared persistent real-browser session: navigate, read page text, click, fill forms, select options, press keys, upload files, screenshot, wait, close tabs, and end the browser session when done.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: `One of ${ACTIONS.join(", ")}.`
			},
			page: {
				type: "string",
				description: "Tab ref from a navigate result. Pass it on EVERY command while working a tab: navigate with a new ref opens that tab, later commands address it. Omit only for single-tab serial work."
			},
			url: {
				type: "string",
				description: "Absolute http(s) URL for navigate; target for waitFor."
			},
			selector: {
				type: "string",
				description: "Element addressing: role:<role>|<name>, label:<text>, placeholder:<text>, text:<text>, bare CSS, optionally prefixed frame(<iframe css>)>>; click also accepts xy:<x>,<y>."
			},
			format: {
				type: "string",
				description: "snapshot capture shape: text (visible text) or aria (accessibility tree with roles and names)."
			},
			value: {
				type: "string",
				description: "Value for fill; option value for select."
			},
			key: {
				type: "string",
				description: "Keyboard key for press, for example Enter or Tab."
			},
			files: {
				type: "array",
				items: { type: "string" },
				description: "File paths for upload."
			},
			waitUntil: {
				type: "string",
				description: "navigate load state: load, domcontentloaded, or networkidle."
			},
			timeoutMs: {
				type: "number",
				description: "waitFor timeout in milliseconds."
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
					result: { oneOf: [
						{
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true,
									const: "page"
								},
								page: {
									type: "string",
									required: true
								},
								url: {
									type: "string",
									required: true
								},
								title: {
									type: "string",
									required: true
								},
								text: {
									type: "string",
									required: true
								},
								truncated: {
									type: "boolean",
									required: true
								}
							}
						},
						{
							type: "object",
							additionalProperties: false,
							properties: { kind: {
								type: "string",
								required: true,
								const: "acked"
							} }
						},
						{
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true,
									const: "screenshot"
								},
								pngBase64: {
									type: "string",
									required: true
								}
							}
						}
					] }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatBrowserOutput(value.result, maxOutputChars)
			}],
			presentationMeta: (_args, value) => browserMetaFromValue(value)
		},
		timeoutMs,
		isConcurrencySafe: browserIsConcurrencySafe,
		async execute(args, exec) {
			const command = parseBrowserArgs(args);
			if (command.kind === "closeBrowser") {
				await ctx.browser.closeSession();
				return {
					action: String(args.action),
					result: { kind: "acked" }
				};
			}
			const bounded = command.kind === "navigate" || command.kind === "snapshot" ? {
				...command,
				maxChars: maxOutputChars
			} : command;
			const result = await ctx.browser.act(bounded, exec.signal);
			return {
				action: String(args.action),
				result
			};
		},
		presentCall: presentBrowserCall,
		presentResult: presentBrowserResult
	}));
}
// lib/types/host/tool-browser/index.js
/**
* Consumer for the browser automation seam: model-facing `browser` tool over `ctx.browser`.
*/
const name = "tool-browser";
const inject = [
	"tools",
	"browser",
	"systemPrompt"
];
const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 18e4;
const DEFAULT_BROWSER_MAX_OUTPUT_CHARS = 6e4;
const Config = z.object({
	maxOutputChars: z.number().default(DEFAULT_BROWSER_MAX_OUTPUT_CHARS),
	timeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS)
});
function apply(ctx, config) {
	const resolved = config;
	if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) throw new Error(`tool-browser: maxOutputChars must be a positive integer, got ${resolved.maxOutputChars}`);
	if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) throw new Error(`tool-browser: timeoutMs must be a positive integer, got ${resolved.timeoutMs}`);
	applyBrowserTool(ctx, resolved.timeoutMs, resolved.maxOutputChars);
}
export { Config, DEFAULT_BROWSER_MAX_OUTPUT_CHARS, DEFAULT_BROWSER_TOOL_TIMEOUT_MS, apply, formatBrowserOutput, inject, name, parseBrowserArgs };
