import { t as assertNever } from "./backlinks-types-C6425y97.js";
import { t as BrowserError } from "./types-DhIxLWiv.js";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { chromium } from "playwright-core";
// lib/types/host/browser-playwright/interactive.js
const VISIBLE_CONTROLS_SCRIPT = String.raw`(() => {
  const probe = 'a[href],button,iframe,summary,input[type=submit],input[type=button],input[type=image],[role=button],[role=link]';
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const roots = [document];
  const candidates = [];
  let passwordFields = 0, emailFields = 0, forms = 0, emailLinks = 0;

  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.matches('input[type=password]')) passwordFields++;
      if (el.matches('input[type=email],input[name*="email" i],input[id*="email" i]')) emailFields++;
      if (el.matches('form')) forms++;
      if (el.matches('a[href^="mailto:" i]')) emailLinks++;
      // A script-driven logo link may have neither href nor an ARIA role.
      if (el.matches(probe) || el.localName === 'a') candidates.push(el);
    }
  }

  function unique(el, selector) {
    if (selector !== clean(selector)) return false;
    try {
      // Playwright CSS pierces open shadow roots, so check the whole locator scope.
      return roots.every(root => {
        const matches = root.querySelectorAll(selector);
        return root === el.getRootNode()
          ? matches.length === 1 && matches[0] === el
          : matches.length === 0;
      });
    } catch {
      return false;
    }
  }

  function selectorFor(el) {
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      if (unique(el, byId)) return byId;
    }
    const classes = Array.from(el.classList).filter(name => /^[-_a-zA-Z][\w-]*$/.test(name)).slice(0, 3);
    if (classes.length) {
      const byClass = el.localName + '.' + classes.map(name => CSS.escape(name)).join('.');
      if (unique(el, byClass)) return byClass;
    }
    let path = '';
    for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const tag = node.localName;
      const siblings = Array.from(node.parentNode.children).filter(sibling => sibling.localName === tag);
      const segment = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? segment + ' > ' + path : segment;
      if (unique(el, path)) return path;
    }
    return '';
  }

  const controls = [];
  let truncated = false;
  for (const el of candidates) {
    if (el.disabled === true || el.matches(':disabled')) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.05) continue;
    const background = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(style.backgroundImage);
    if (!el.matches(probe) && !background) continue;
    if (controls.length === 300) {
      truncated = true;
      break;
    }

    const attr = name => el.getAttribute(name);
    const tag = el.localName;
    const inputType = tag === 'input' ? el.type : '';
    const image = tag === 'img' || inputType === 'image' ? el : el.querySelector('img');
    controls.push({
      tag: clean(tag), role: clean(attr('role')), inputType: clean(inputType),
      text: clean(el.innerText) || clean(el.textContent),
      // Button captions are useful; live form values can contain credentials.
      value: tag === 'button' || /^(submit|button|image)$/.test(inputType) ? clean(attr('value')) : '',
      ariaLabel: clean(attr('aria-label')), title: clean(attr('title')), alt: clean(attr('alt')),
      imageAlt: clean(image?.getAttribute('alt')), imageSrc: clean(image?.getAttribute('src')),
      href: clean(attr('href')), src: clean(attr('src')), id: clean(el.id), classes: clean(attr('class')),
      data: clean(Array.from(el.attributes)
        .filter(({ name }) => /^data-.*(?:provider|service|oauth|auth|login|signin|sign-in|action|testid|name|label|idp|sso)/i.test(name))
        .map(({ name, value }) => name + '=' + clean(value)).join(' ')),
      background: clean(background?.[1] ?? background?.[2] ?? background?.[3]),
      formAction: clean((el.form ?? el.closest('form'))?.getAttribute('action')),
      selector: selectorFor(el),
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      hasImage: !!image, hasSvg: tag === 'svg' || !!el.querySelector('svg'),
    });
  }
  return { controls, passwordFields, emailFields, forms, emailLinks, truncated };
})()`;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function readNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readBoolean(value) {
	return value === true;
}
function parseControlReport(report) {
	const data = isRecord(report) ? report : {};
	const controls = [];
	for (const row of Array.isArray(data.controls) ? data.controls : []) {
		if (!isRecord(row)) continue;
		const tag = readString(row.tag);
		if (!tag) continue;
		controls.push({
			tag,
			role: readString(row.role),
			inputType: readString(row.inputType),
			text: readString(row.text),
			value: readString(row.value),
			ariaLabel: readString(row.ariaLabel),
			title: readString(row.title),
			alt: readString(row.alt),
			imageAlt: readString(row.imageAlt),
			imageSrc: readString(row.imageSrc),
			href: readString(row.href),
			src: readString(row.src),
			id: readString(row.id),
			classes: readString(row.classes),
			data: readString(row.data),
			background: readString(row.background),
			formAction: readString(row.formAction),
			selector: readString(row.selector),
			x: readNumber(row.x),
			y: readNumber(row.y),
			inViewport: readBoolean(row.inViewport),
			hasImage: readBoolean(row.hasImage),
			hasSvg: readBoolean(row.hasSvg)
		});
	}
	return {
		controls,
		passwordFields: readNumber(data.passwordFields),
		emailFields: readNumber(data.emailFields),
		forms: readNumber(data.forms),
		emailLinks: readNumber(data.emailLinks),
		truncated: readBoolean(data.truncated)
	};
}
const PROVIDERS = {
	google: /\bgoogle\b|googleapis|gstatic|googleusercontent|accounts\.google|\bgsi\b|gsi\/button|g\.co\//,
	facebook: /\bfacebook\b|fb-login|fbconnect|\bfb\b/,
	github: /\bgithub\b/,
	apple: /\bapple\b|appleid|signin\.apple/,
	microsoft: /\bmicrosoft\b|live\.com|outlook|msal|\bazure(ad)?\b/,
	"x-twitter": /\btwitter\b|\bx\.com\b|\btwitter\.com\b/,
	discord: /\bdiscord\b/,
	linkedin: /\blinkedin\b/,
	amazon: /\bamazon\b|amazoncognito/,
	steam: /\bsteam\b/,
	twitch: /\btwitch\b/,
	yahoo: /\byahoo\b/,
	wordpress: /wordpress\.com/,
	reddit: /\breddit\b/,
	tiktok: /\btiktok\b/,
	telegram: /\btelegram\b/
};
const AUTH_PATTERN = /\b(?:sign[ -]?(?:in|up|on)|log[ -]?(?:in|on)|continue|oauth|authori[sz]e|sso|auth|connect|callback|gsi|provider|idp)\b/;
const AUTH_URL_PATTERN = /oauth|openid|authori[sz]e|sso|\bauth\b|\/auth|login|signin|sign-in|connect|gsi|callback/;
const NON_AUTH_URL_PATTERN = /play\.google\.com|plus\.google\.com|\/share(?:\/|[?#\s]|$)|sharer|intent\/tweet|\/maps\//;
const EMAIL_SIGN_IN = {
	provider: "email-password",
	strength: "auth"
};
function evidenceText(...fields) {
	return fields.map((field) => {
		try {
			return decodeURIComponent(field);
		} catch {
			return field;
		}
	}).join(" ").toLowerCase().replace(/_/g, "-");
}
function readSignIn(control) {
	if (control.inputType === "password") return EMAIL_SIGN_IN;
	const labelled = evidenceText(control.text, control.value, control.ariaLabel, control.title, control.alt, control.imageAlt, control.imageSrc, control.id, control.classes, control.data, control.background);
	const linked = evidenceText(control.href, control.src, control.formAction);
	if (NON_AUTH_URL_PATTERN.test(linked)) return void 0;
	const authLabel = AUTH_PATTERN.test(labelled);
	const haystack = labelled + " " + linked;
	const provider = Object.entries(PROVIDERS).find(([, pattern]) => pattern.test(haystack))?.[0];
	if (provider !== void 0) {
		if (authLabel || AUTH_URL_PATTERN.test(linked)) return {
			provider,
			strength: "auth"
		};
		if ([
			"button",
			"summary",
			"input"
		].includes(control.tag) || control.role === "button" || !control.text && (control.hasImage || control.hasSvg || control.background)) return {
			provider,
			strength: "provider"
		};
		return;
	}
	if (authLabel && /\bemail\b/.test(evidenceText(control.text, control.value, control.ariaLabel, control.title))) return EMAIL_SIGN_IN;
}
function renderPageControls(title, report) {
	const counts = /* @__PURE__ */ new Map();
	const lines = report.controls.map((control, index) => {
		const signIn = readSignIn(control);
		if (signIn) counts.set(signIn.provider, (counts.get(signIn.provider) ?? 0) + 1);
		const type = control.tag === "iframe" ? "iframe" : control.tag === "a" || control.role === "link" ? "link" : control.tag;
		const label = control.text || control.value || control.imageAlt || control.alt || control.ariaLabel || control.title;
		const fields = [
			`#${index + 1} ${type}`,
			label ? JSON.stringify(label) : control.hasImage || control.hasSvg || control.background ? "(icon only)" : "",
			signIn ? `signin=${signIn.provider}${signIn.strength === "provider" ? "?" : ""}` : "",
			control.selector ? `css=${quote(control.selector)}` : "",
			`xy=${control.x},${control.y}${control.inViewport ? "" : " (scroll first)"}`
		];
		for (const [key, value] of Object.entries({
			alt: control.imageAlt || control.alt,
			aria: control.ariaLabel,
			title: control.title,
			href: control.href,
			src: control.src || control.imageSrc,
			id: control.id,
			cls: control.classes,
			bg: control.background,
			form: control.formAction
		})) if (value) fields.push(`${key}=${quote(value)}`);
		if (control.data) fields.push(/^data-[\w-]+=[^\s"]+$/i.test(control.data) ? control.data : `data=${quote(control.data)}`);
		return fields.filter(Boolean).join(" ");
	});
	const fieldCount = (count) => count ? `yes ×${count}` : "no";
	const stats = [
		`${report.forms} ${report.forms === 1 ? "form" : "forms"}`,
		`password field: ${fieldCount(report.passwordFields)}`,
		`email field: ${fieldCount(report.emailFields)}`,
		`mailto links: ×${report.emailLinks}`
	];
	return [
		`interactive: ${report.controls.length} visible controls on ${title.trim() ? JSON.stringify(title.trim()) : "(untitled)"} (${stats.join(", ")})`,
		`sign-in candidates: ${Array.from(counts, ([provider, count]) => `${provider} ×${count}`).join(", ") || "none"}`,
		...lines
	].join("\n");
}
function quote(value) {
	return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}
// lib/types/host/browser-playwright/provider.js
/**
* Playwright persistent-Chromium implementation of the browser automation seam.
*/
const PLAYWRIGHT_BROWSER_PROVIDER_ID = "playwright";
const DEFAULT_SNAPSHOT_MAX_CHARS = 6e4;
async function bringPageWindowToFront(page) {
	try {
		const client = await page.context().newCDPSession(page);
		try {
			const info = await client.send("Browser.getWindowForTarget");
			const windowId = info?.windowId;
			const bounds = info?.bounds;
			if (windowId !== void 0 && bounds !== void 0) {
				if (bounds.windowState !== void 0 && bounds.windowState !== "normal") await client.send("Browser.setWindowBounds", {
					windowId,
					bounds: { windowState: "normal" }
				});
				if (bounds.left === void 0 || bounds.top === void 0 || bounds.left < 0 || bounds.top < 0 || bounds.left > 4e3 || bounds.top > 4e3) await client.send("Browser.setWindowBounds", {
					windowId,
					bounds: {
						left: 80,
						top: 80,
						width: Math.max(bounds.width ?? 1280, 1024),
						height: Math.max(bounds.height ?? 860, 720)
					}
				});
			}
		} finally {
			await client.detach().catch(() => void 0);
		}
	} catch {}
	await page.bringToFront();
}
function assertPositiveInteger(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`browser-playwright: ${name} must be a positive integer, got ${value}`);
}
function truncate(text, maxChars) {
	if (text.length <= maxChars) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, maxChars),
		truncated: true
	};
}
function parseSelector(raw) {
	let rest = raw;
	const frames = [];
	while (true) {
		const frame = /^frame\((.+)\)>>/u.exec(rest);
		if (frame === null) break;
		frames.push(frame[1]);
		rest = rest.slice(frame[0].length);
	}
	const prefixed = /^(role|label|placeholder|text|xy):(.*)$/su.exec(rest);
	if (prefixed === null) return {
		mode: "css",
		frames,
		value: rest
	};
	const kind = prefixed[1];
	const body = prefixed[2];
	if (kind === "xy") {
		const xy = /^(\d+),(\d+)$/u.exec(body);
		if (xy === null) throw new BrowserError(`browser xy selector must be xy:<x>,<y> with non-negative integers, got "${raw}"`, "BROWSER_ACTION_FAILED");
		return {
			mode: "xy",
			frames,
			x: Number(xy[1]),
			y: Number(xy[2])
		};
	}
	if (kind === "role") {
		const split = body.indexOf("|");
		if (split < 0) return {
			mode: "role",
			frames,
			value: body
		};
		const role = body.slice(0, split);
		const name = body.slice(split + 1);
		if (role.length === 0 || name.length === 0) throw new BrowserError(`browser role selector must be role:<role>|<name> with both non-empty, got "${raw}"`, "BROWSER_ACTION_FAILED");
		return {
			mode: "role",
			frames,
			value: role,
			name
		};
	}
	if (body.length === 0) throw new BrowserError(`browser ${kind} selector must be ${kind}:<text> with non-empty text`, "BROWSER_ACTION_FAILED");
	return {
		mode: kind,
		frames,
		value: body
	};
}
function buildLocator(page, addressing) {
	if (addressing.mode === "xy") return void 0;
	let root = page;
	for (const frame of addressing.frames) root = root.frameLocator(frame);
	switch (addressing.mode) {
		case "css": return root.locator(addressing.value);
		case "role": return root.getByRole(addressing.value, ...addressing.name === void 0 ? [] : [{ name: addressing.name }]);
		case "label": return root.getByLabel(addressing.value);
		case "placeholder": return root.getByPlaceholder(addressing.value);
		case "text": return root.getByText(addressing.value);
		default: return assertNever(addressing, "unhandled selector addressing");
	}
}
function elementLocator(page, addressing) {
	const locator = buildLocator(page, addressing);
	if (locator === void 0) throw new BrowserError("browser xy addressing supports click only", "BROWSER_ACTION_FAILED");
	return locator;
}
function throwIfAborted(signal, commandKind) {
	if (signal?.aborted) throw new BrowserError(`browser ${commandKind} aborted`, "BROWSER_ABORTED");
}
var PlaywrightSession = class {
	context;
	defaultTimeoutMs;
	defaultMaxChars;
	closed = false;
	pages = /* @__PURE__ */ new Map();
	chains = /* @__PURE__ */ new Map();
	legacyTail = Promise.resolve();
	lastRef;
	refSeq = 0;
	constructor(context, defaultTimeoutMs, defaultMaxChars) {
		this.context = context;
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.defaultMaxChars = defaultMaxChars;
		this.context.on("close", () => {
			this.closed = true;
		});
		for (const existing of this.context.pages()) this.adopt(existing);
	}
	async act(command, signal) {
		throwIfAborted(signal, command.kind);
		if (this.closed) throw new BrowserError("browser session is closed", "BROWSER_ACTION_FAILED");
		return await (command.page === void 0 ? this.chained(this.legacyTail, (tail) => {
			this.legacyTail = tail;
		}, command, signal) : this.chained(this.chains.get(command.page) ?? Promise.resolve(), (tail) => {
			this.chains.set(command.page, tail);
		}, command, signal));
	}
	chained(previous, store, command, signal) {
		const next = previous.then(() => this.execute(command, signal));
		store(next.catch(() => void 0));
		return next;
	}
	async execute(command, signal) {
		throwIfAborted(signal, command.kind);
		try {
			switch (command.kind) {
				case "navigate": {
					const { page, ref } = await this.resolveForNavigate(command.page);
					await page.goto(command.url, {
						timeout: this.defaultTimeoutMs,
						...command.waitUntil === void 0 ? {} : { waitUntil: command.waitUntil }
					});
					return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
				}
				case "snapshot": {
					const { page, ref } = await this.requirePage(command.page);
					const maxChars = command.maxChars ?? this.defaultMaxChars;
					if (command.format === "aria") {
						const { text, truncated } = truncate(await page.locator(command.selector ?? "body").ariaSnapshot(), maxChars);
						return {
							kind: "page",
							page: ref,
							url: page.url(),
							title: await page.title(),
							text,
							truncated
						};
					}
					if (command.format === "interactive") {
						const report = parseControlReport(await page.evaluate(VISIBLE_CONTROLS_SCRIPT));
						const title = await page.title();
						const { text, truncated } = truncate(renderPageControls(title, report), maxChars);
						return {
							kind: "page",
							page: ref,
							url: page.url(),
							title,
							text,
							truncated: truncated || report.truncated
						};
					}
					return await this.pageResult(page, ref, maxChars, command.selector);
				}
				case "click": {
					const { page } = await this.requirePage(command.page);
					const addressing = parseSelector(command.selector);
					if (addressing.mode === "xy") {
						await page.mouse.click(addressing.x, addressing.y);
						return { kind: "acked" };
					}
					await buildLocator(page, addressing)?.click({ timeout: this.defaultTimeoutMs });
					return { kind: "acked" };
				}
				case "fill": {
					const { page } = await this.requirePage(command.page);
					await elementLocator(page, parseSelector(command.selector)).fill(command.value, { timeout: this.defaultTimeoutMs });
					return { kind: "acked" };
				}
				case "select": {
					const { page } = await this.requirePage(command.page);
					await elementLocator(page, parseSelector(command.selector)).selectOption(command.value, { timeout: this.defaultTimeoutMs });
					return { kind: "acked" };
				}
				case "check": {
					const { page } = await this.requirePage(command.page);
					await elementLocator(page, parseSelector(command.selector)).check({ timeout: this.defaultTimeoutMs });
					return { kind: "acked" };
				}
				case "press": {
					const { page } = await this.requirePage(command.page);
					await page.keyboard.press(command.key);
					return { kind: "acked" };
				}
				case "upload": {
					const { page } = await this.requirePage(command.page);
					await elementLocator(page, parseSelector(command.selector)).setInputFiles([...command.files], { timeout: this.defaultTimeoutMs });
					return { kind: "acked" };
				}
				case "screenshot": {
					const { page } = await this.requirePage(command.page);
					return {
						kind: "screenshot",
						pngBase64: (await page.screenshot({
							type: "png",
							timeout: this.defaultTimeoutMs
						})).toString("base64")
					};
				}
				case "waitFor": {
					if (command.selector === void 0 && command.url === void 0) throw new BrowserError("waitFor requires a selector or a url", "BROWSER_ACTION_FAILED");
					const { page } = await this.requirePage(command.page);
					const timeout = command.timeoutMs ?? this.defaultTimeoutMs;
					if (command.selector !== void 0) await elementLocator(page, parseSelector(command.selector)).waitFor({
						state: "visible",
						timeout
					});
					else await page.waitForURL(command.url, { timeout });
					return { kind: "acked" };
				}
				case "probe": {
					const { page, ref } = await this.requirePage(command.page);
					const url = page.url();
					const title = await page.title().catch(() => "");
					const selectorVisible = command.selector === void 0 ? void 0 : await elementLocator(page, parseSelector(command.selector)).first().isVisible().catch(() => false);
					return {
						kind: "probe",
						page: ref,
						url,
						title,
						...selectorVisible === void 0 ? {} : { selectorVisible }
					};
				}
				case "bringToFront": {
					const { page } = await this.requirePage(command.page);
					await bringPageWindowToFront(page);
					return { kind: "acked" };
				}
				case "closePage": {
					const { page, ref } = await this.requirePage(command.page);
					await page.close();
					this.pages.delete(ref);
					this.chains.delete(ref);
					return { kind: "acked" };
				}
				default: return assertNever(command, "unhandled browser command kind");
			}
		} catch (error) {
			if (error instanceof BrowserError) throw error;
			throw new BrowserError(`playwright ${command.kind} failed: ${String(error instanceof Error ? error.message : error)}`, "BROWSER_ACTION_FAILED", { cause: error });
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.context.close();
		} catch {}
	}
	adopt(page) {
		const ref = `p${++this.refSeq}`;
		this.pages.set(ref, page);
		this.lastRef = ref;
		page.on("close", () => {
			this.pages.delete(ref);
		});
		return ref;
	}
	async requirePage(ref) {
		if (ref === void 0) {
			const pages = this.context.pages();
			const last = pages[pages.length - 1];
			if (last) {
				if (this.pages.get(this.lastRef ?? "") !== last) this.adopt(last);
				return {
					page: last,
					ref: this.lastRef
				};
			}
			const page = await this.context.newPage();
			return {
				page,
				ref: this.adopt(page)
			};
		}
		const page = this.pages.get(ref);
		if (page === void 0 || page.isClosed()) throw new BrowserError(`browser page "${ref}" is not open`, "BROWSER_ACTION_FAILED");
		this.lastRef = ref;
		return {
			page,
			ref
		};
	}
	async resolveForNavigate(ref) {
		if (ref !== void 0) {
			const existing = this.pages.get(ref);
			if (existing !== void 0 && !existing.isClosed()) {
				this.lastRef = ref;
				return {
					page: existing,
					ref
				};
			}
			const page = await this.context.newPage();
			this.pages.set(ref, page);
			this.lastRef = ref;
			page.on("close", () => {
				this.pages.delete(ref);
			});
			return {
				page,
				ref
			};
		}
		return await this.requirePage(void 0);
	}
	async pageResult(page, ref, maxChars, selector) {
		const [url, title, rawText] = await Promise.all([
			Promise.resolve(page.url()),
			page.title(),
			page.innerText(selector ?? "body")
		]);
		const { text, truncated } = truncate(rawText, maxChars);
		return {
			kind: "page",
			page: ref,
			url,
			title,
			text,
			truncated
		};
	}
};
var PlaywrightBrowserProvider = class {
	config;
	id = PLAYWRIGHT_BROWSER_PROVIDER_ID;
	constructor(config) {
		this.config = config;
	}
	available() {
		return true;
	}
	async open(signal) {
		throwIfAborted(signal, "launch");
		assertPositiveInteger("defaultTimeoutMs", this.config.defaultTimeoutMs);
		let context;
		try {
			context = await chromium.launchPersistentContext(this.config.userDataDir, {
				headless: this.config.headless,
				timeout: this.config.defaultTimeoutMs,
				...this.config.channel.length > 0 ? { channel: this.config.channel } : {},
				...this.config.executablePath !== void 0 && this.config.executablePath.length > 0 ? { executablePath: this.config.executablePath } : {},
				...this.config.ignoreDefaultArgs.length > 0 ? { ignoreDefaultArgs: [...this.config.ignoreDefaultArgs] } : {},
				args: [...this.config.windowPosition === void 0 ? [] : [`--window-position=${this.config.windowPosition}`], ...this.config.launchArgs]
			});
		} catch (error) {
			throw new BrowserError(`failed to launch the persistent browser profile at ${this.config.userDataDir}: ${String(error instanceof Error ? error.message : error)}`, "BROWSER_LAUNCH_FAILED", { cause: error });
		}
		return new PlaywrightSession(context, this.config.defaultTimeoutMs, DEFAULT_SNAPSHOT_MAX_CHARS);
	}
};
// lib/types/host/browser-playwright/index.js
/**
* Service Provider for the Playwright persistent-Chromium browser seam.
*/
const name = "browser-playwright";
const inject = ["browser"];
const Config = z.object({
	userDataDir: z.string(),
	headless: z.boolean().default(false),
	channel: z.string().default("chrome"),
	defaultTimeoutMs: z.number().default(15e3),
	launchArgs: z.array(z.string()).default([]),
	ignoreDefaultArgs: z.array(z.string()).default([]),
	windowPosition: z.string()
});
function apply(ctx, config) {
	const userDataDir = (config.userDataDir ?? process.env.DSH_BACKLINK_BROWSER_PROFILE ?? dshHomePath("backlink-browser-profile")).trim();
	if (userDataDir.length === 0) throw new Error("browser-playwright: userDataDir must not be empty");
	const defaultTimeoutMs = config.defaultTimeoutMs ?? 15e3;
	if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new Error(`browser-playwright: defaultTimeoutMs must be a positive integer, got ${defaultTimeoutMs}`);
	const resolved = {
		userDataDir,
		headless: config.headless ?? false,
		channel: config.channel ?? "chrome",
		defaultTimeoutMs,
		launchArgs: config.launchArgs ?? [],
		ignoreDefaultArgs: config.ignoreDefaultArgs ?? [],
		windowPosition: config.windowPosition
	};
	ctx.effect(() => ctx.browser.registerProvider(new PlaywrightBrowserProvider(resolved)), "browser-playwright: provider");
}
export { Config, PLAYWRIGHT_BROWSER_PROVIDER_ID, PlaywrightBrowserProvider, apply, inject, name };
