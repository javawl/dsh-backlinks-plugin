// lib/types/host/backlinks/standards.js
const HARD_BLOCKING_TAGS = [
	"paid_only",
	"dead_site",
	"no_form",
	"comments_closed"
];
const SOFT_BLOCKING_TAGS = [
	"has_captcha",
	"waf_403",
	"submitmatic_verify_fail"
];
const STANDARD_TAG_ALIASES = {
	"付费": "paid_only",
	"收费": "paid_only",
	"仅付费": "paid_only",
	"无表单": "no_form",
	"无提交入口": "no_form",
	"死链": "dead_site",
	"停服": "dead_site",
	"已停服": "dead_site",
	"关评": "comments_closed",
	"评论关闭": "comments_closed",
	"关闭评论": "comments_closed",
	"验证码": "has_captcha",
	"有验证码": "has_captcha",
	"有盾": "waf_403",
	"徽标校验失败": "submitmatic_verify_fail"
};
const DEFAULT_MAIL_WAIT_TIMEOUT_MS = 3e4;
const DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS = 3e3;
new Set(HARD_BLOCKING_TAGS);
new Set(SOFT_BLOCKING_TAGS);
/**
* Wire mapping for outbound Supermanager `/tags` / `/preflight-skip` requests.
* Live Supermanager currently rejects English `comments_closed` with HTTP 500,
* whereas Chinese `评论关闭` succeeds cleanly.
*/
const SUPERMANAGER_WIRE_TAG_MAP = { comments_closed: "评论关闭" };
/**
* Safe Chinese fallback aliases used when live Supermanager returns HTTP 5xx
* for English canonical blocking tag names.
*/
const SUPERMANAGER_SAFE_ZH_TAG_FALLBACK = {
	paid_only: "付费",
	no_form: "无表单",
	dead_site: "死链",
	has_captcha: "验证码",
	waf_403: "有盾",
	submitmatic_verify_fail: "徽标校验失败",
	comments_closed: "评论关闭",
	low_quality: "低质量"
};
/** Map outbound source tags to Supermanager wire-compatible names (deduped). */
function mapTagsForSupermanagerWire(tags) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of tags) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const mapped = SUPERMANAGER_WIRE_TAG_MAP[trimmed.toLowerCase()] ?? trimmed;
		if (!seen.has(mapped)) {
			seen.add(mapped);
			out.push(mapped);
		}
	}
	return out;
}
/** Map tags to safe Chinese aliases for Supermanager 5xx compatibility fallback. */
function mapTagsToSafeChineseFallback(tags) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of tags) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const canonical = normalizeBlockingTag(trimmed);
		const mapped = SUPERMANAGER_SAFE_ZH_TAG_FALLBACK[canonical] ?? trimmed;
		if (!seen.has(mapped)) {
			seen.add(mapped);
			out.push(mapped);
		}
	}
	return out;
}
/** Detect whether an error represents an HTTP 5xx response from Supermanager. */
function isSupermanager5xxError(error) {
	if (!(error instanceof Error)) return false;
	return /\bHTTP\s+5\d\d\b/iu.test(error.message);
}
/** Normalize a raw source tag name to its canonical blocking tag when known. */
function normalizeBlockingTag(raw) {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return "";
	const lower = trimmed.toLowerCase();
	return STANDARD_TAG_ALIASES[trimmed] ?? STANDARD_TAG_ALIASES[lower] ?? lower;
}
export { mapTagsToSafeChineseFallback as a, mapTagsForSupermanagerWire as i, DEFAULT_MAIL_WAIT_TIMEOUT_MS as n, isSupermanager5xxError as r, DEFAULT_MAIL_WAIT_POLL_INTERVAL_MS as t };
