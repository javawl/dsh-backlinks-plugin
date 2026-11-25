/**
 * Deterministic Playwright fast-path for WordPress, Wix, Typecho, custom blog,
 * and Blogger iframe comment publishing (`browser action="comment_publish"`).
 *
 * Strictly enforces:
 * - Zero CAPTCHA bypass: detects reCAPTCHA/hCaptcha/Turnstile/SecureImg/math
 *   captchas and returns `blocked_captcha` (`submitTriggered: false`).
 * - Idempotency: once a submit action is triggered (`submitTriggered: true`),
 *   any post-submit uncertainty returns `uncertain_after_submit` and never retries.
 * - Rich-editor safety: never types raw `<a>` markup into `contenteditable` editors;
 *   on Wix Ricos/Tiptap without a toolbar link button, enters URL + Space and
 *   verifies an `<a href>` was created before clicking Publish.
 * - Anti-optimistic-DOM guardrail: Wix post-submit checks `role=dialog` for 2-3s
 *   and reloads the clean URL before declaring `live`.
 */
import type { Page } from 'playwright-core';
import type { BrowserCommentPublishCommand, BrowserCommentPublishResult, CommentPublishFormSummary, CommentPublishLoginInfo } from '../browser/types.ts';
import type { SleepLike } from '../../mcp/backlinks-tool.ts';
export declare const DEFAULT_LAZY_WAIT_MAX_MS = 2500;
export declare const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 20000;
export declare const DEFAULT_WIX_NAV_TIMEOUT_MS = 20000;
export declare const DEFAULT_COMMENT_NAV_TIMEOUT_MS = 15000;
export declare const DEFAULT_WIX_DOM_READY_WAIT_MS = 6000;
export declare const DEFAULT_NON_WIX_DOM_READY_WAIT_MS = 7000;
export declare const DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS = 10000;
export declare const DEFAULT_WIX_EXPAND_WAIT_MAX_MS = 4000;
export declare const DEFAULT_WIX_POST_SUBMIT_WAIT_MS = 2500;
export declare const DEFAULT_CONTEXT_DESTROYED_RETRY_MS = 2000;
export declare const DEFAULT_WIX_SSO_POPUP_TIMEOUT_MS = 4000;
export declare const DEFAULT_WIX_SSO_COMPLETE_WAIT_MS = 8000;
export interface WordPressInspection {
    readonly found: boolean;
    readonly collapsedTriggerSelector?: string;
    readonly formSelector?: string;
    readonly commentSelector?: string;
    readonly commentIsContentEditable?: boolean;
    readonly authorSelector?: string;
    readonly authorRequired?: boolean;
    readonly emailSelector?: string;
    readonly emailRequired?: boolean;
    readonly urlSelector?: string;
    readonly submitSelector?: string;
    readonly guestToggleSelector?: string;
    readonly captcha?: {
        readonly detected: boolean;
        readonly kind?: string;
        readonly templateSignature?: string;
    };
}
export interface GenericCommentInspection {
    readonly found: boolean;
    readonly kind?: 'typecho' | 'valine' | 'custom_blog';
    readonly formSelector?: string;
    readonly commentSelector?: string;
    readonly authorSelector?: string;
    readonly authorRequired?: boolean;
    readonly emailSelector?: string;
    readonly emailRequired?: boolean;
    readonly urlSelector?: string;
    readonly submitSelector?: string;
    readonly captcha?: {
        readonly detected: boolean;
        readonly kind?: string;
        readonly templateSignature?: string;
    };
}
export interface WixInspection {
    readonly hasCommentSection: boolean;
    readonly loginRequired: boolean;
    readonly captchaDetected: boolean;
    readonly signupRecaptchaAlways?: boolean;
    readonly hasGuestEditor: boolean;
    readonly hasLazyPlaceholder: boolean;
    readonly hasEmptyCommentPlaceholder?: boolean;
    readonly hasLoadingIndicator?: boolean;
    readonly hasCommentListOrCount?: boolean;
    readonly hasWriteCommentPrompt?: boolean;
    readonly hasCommentCountOnly: boolean;
    readonly hasBlogPostStructure: boolean;
    readonly isBlogListPage: boolean;
    readonly isComplexWixLayout: boolean;
    readonly commentHooks?: readonly string[];
    readonly editorSelector?: string;
    readonly editorIsContentEditable?: boolean;
    readonly triggerSelector?: string;
    readonly nameSelector?: string;
    readonly emailSelector?: string;
    readonly websiteSelector?: string;
    readonly submitSelector?: string;
    readonly linkButtonSelector?: string;
    readonly loginInfo?: CommentPublishLoginInfo;
}
export interface ChildFramesInspection {
    readonly frames: readonly string[];
    readonly hasActionableCommentFrame: boolean;
    readonly hasUnknownInteractiveFrame: boolean;
    readonly captchaDetected: boolean;
    readonly commentsClosedPhrase?: string;
    readonly bloggerFrameUrl?: string;
}
export interface CommentPageInspection {
    readonly title: string;
    readonly finalUrl: string;
    readonly isWix: boolean;
    readonly isWordPress: boolean;
    readonly isTypecho?: boolean;
    readonly hasBloggerCommentIframe?: boolean;
    readonly readyState?: string;
    readonly scrollHeight?: number;
    readonly commentsClosed: {
        readonly matched: boolean;
        readonly phrase?: string;
    };
    readonly wordpress: WordPressInspection;
    readonly genericComment?: GenericCommentInspection;
    readonly wix: WixInspection;
    readonly childFrames?: ChildFramesInspection;
    readonly formSummary: CommentPublishFormSummary;
    readonly bottomSnapshot?: string;
}
export interface CommentVerifyOutcome {
    readonly liveLinkFound: boolean;
    readonly commentNodeLinkFound?: boolean;
    readonly matchedHref?: string;
    readonly matchedAnchor?: string;
    readonly escapedHtmlDetected: boolean;
    readonly moderationNotice?: string;
    readonly wpErrorMessage?: string;
    readonly hasWpDieDom?: boolean;
    readonly captchaDetected?: boolean;
    readonly snippet?: string;
}
export interface WixPostSubmitInspection {
    readonly hasCaptcha: boolean;
    readonly hasLoginDialog: boolean;
    readonly signupRecaptchaAlways?: boolean;
    readonly moderationNotice?: string;
    readonly ackButtonSelector?: string;
    readonly dialogText?: string;
    readonly loginInfo?: CommentPublishLoginInfo;
}
/** Matches Wix warmupData / viewerModel `"signupRecaptchaOption": "ALWAYS"` in plain or escaped JSON (case-insensitive). */
export declare const WIX_SIGNUP_RECAPTCHA_ALWAYS_PATTERN: RegExp;
export declare function hasWixSignupRecaptchaAlways(raw: string): boolean;
/** Strip unapproved/moderation query parameters before public reload verification (preserving `#comment-ID`). */
export declare function stripWpModerationParams(rawUrl: string): string;
/** Extract positive numeric WordPress comment ID from a URL hash (`#comment-123`) or token (`comment-123`). */
export declare function extractCommentNumericId(raw: string | undefined): number | undefined;
/** Append a lightweight cache-busting query parameter while preserving any `#comment-ID` hash. */
export declare function appendCacheBustParam(rawUrl: string, nonce?: number): string;
/**
 * Decide whether a request during `comment_publish` navigation should be aborted.
 * Never blocks `document`, `stylesheet` (protects `:visible`), `xhr`/`fetch`, or
 * Wix / Google OAuth / reCAPTCHA / hCaptcha / Turnstile / LeanCloud / Blogger domains.
 */
export declare function shouldAbortCommentPublishRequest(url: string, resourceType: string): boolean;
export declare const WIX_GOOGLE_SSO_TECHNICAL_ISSUE_PATTERN: RegExp;
/** Build plain/HTML comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
export declare function buildWpCommentContent(commentText: string, websiteUrl: string | undefined, anchorText: string | undefined, hasUrlField: boolean): string;
/** Strip raw `<a>` markup before typing into a `contenteditable` rich editor. */
export declare function stripHtmlLinkForRichEditor(commentText: string, anchorText?: string, websiteUrl?: string): {
    readonly plainText: string;
    readonly anchorText?: string;
    readonly websiteUrl?: string;
};
/**
 * Self-contained browser evaluation script inspecting WordPress (including
 * collapsed comment triggers), Typecho, custom blog forms, Wix (with member-wall
 * fast detection & multilingual triggers), Blogger iframes, comments-closed
 * banners, CAPTCHAs, and minimal fallback form metadata.
 */
export declare const INSPECT_COMMENT_PAGE_SCRIPT: string;
/** Post-Publish Wix inspection checking visible `role=dialog` for reCAPTCHA, login/signup, or moderation (incl. Thai 'รับทราบ'). */
export declare const INSPECT_WIX_POST_SUBMIT_SCRIPT: string;
/** Lightweight self-contained script run inside non-ad child frames. */
export declare const INSPECT_CHILD_FRAME_SCRIPT: string;
/** Script evaluated inside Blogger `#comment-editor` / `iframe[src*="blogger.com/comment"]`. */
export declare const INSPECT_BLOGGER_FRAME_SCRIPT: string;
/**
 * Self-contained browser evaluation function checking post-submit / post-reload
 * live clickable links (including specific `#comment-<id>` nodes with author or
 * body `<a href>`), escaped HTML `<a>` text, multilingual moderation notices
 * (EN/ES/FR/DE/PT/FA/ZH), WP errors, and compact post-submit snippet.
 */
export declare function verifyCommentResultInDom(params: {
    readonly websiteUrl?: string;
    readonly anchorText?: string;
    readonly commentText?: string;
    readonly authorName?: string;
    readonly commentId?: string;
}): CommentVerifyOutcome;
export interface ExecuteCommentPublishOptions {
    readonly defaultTimeoutMs: number;
    readonly lazyWaitMaxMs?: number;
    readonly wixLazyWaitMaxMs?: number;
    readonly wixDomReadyWaitMs?: number;
    readonly nonWixDomReadyWaitMs?: number;
    readonly wixReloadVerifyWaitMs?: number;
    readonly wixExpandWaitMaxMs?: number;
    readonly wixPostSubmitWaitMs?: number;
    readonly contextRetryDelayMs?: number;
    readonly wixSsoPopupTimeoutMs?: number;
    readonly wixSsoCompleteWaitMs?: number;
    readonly sleepImpl?: SleepLike;
    readonly signal?: AbortSignal;
}
export declare const CAPTCHA_FRAME_URL_PATTERN: RegExp;
export declare const KNOWN_COMMENT_FRAME_URL_PATTERN: RegExp;
export declare const NON_COMMENT_FRAME_URL_PATTERN: RegExp;
export declare const POST_SUBMIT_WAF_FINGERPRINT_PATTERN: RegExp;
/** Detect whether an HTTP 403 response is a WordPress `wp_die` form-validation error (e.g. missing rating) rather than a WAF block. */
export declare function isWpDieFormValidationError(text: string, rawHtml?: string, hasWpDieDom?: boolean): boolean;
export interface PostSubmitWafDetectionInput {
    readonly httpStatus?: number;
    readonly responseHeaders?: Readonly<Record<string, string>>;
    readonly responseSnippet?: string;
    readonly rawResponseBody?: string;
    readonly hasWpDieDom?: boolean;
    readonly postSubmitUrl?: string;
    readonly postSubmitSnippet?: string;
    readonly title?: string;
}
export interface PostSubmitWafDetection {
    readonly blocked: boolean;
    readonly httpStatus?: number;
    readonly provider?: string;
    readonly snippet?: string;
    readonly isWpDieValidation?: boolean;
    readonly wpDieMessage?: string;
}
/** Detect HTTP 403 or 406/429 WAF-fingerprinted blocks returned after comment submission (distinguishing WP `wp_die` validation 403s). */
export declare function detectPostSubmitWafBlock(input: PostSubmitWafDetectionInput): PostSubmitWafDetection;
export declare function isNavigationContextError(error: unknown): boolean;
export declare function isTimeoutError(error: unknown): boolean;
export declare function isBrowserErrorPageUrl(rawUrl: string): boolean;
/**
 * Commit-first navigation for slow/weak-network Wix sites (`siteHint === 'wix_blog'`):
 * enters as soon as response headers commit (20s timeout), waits best-effort for
 * `domcontentloaded` / visible body content without failing when SSR DOM is already
 * usable, and still throws cleanly on `commit` timeout, `chrome-error://`, or empty docs.
 */
export declare function navigateWixWithCommit(page: Page, url: string, options: {
    readonly timeoutMs: number;
    readonly domReadyWaitMs?: number;
    readonly sleep?: SleepLike;
    readonly signal?: AbortSignal;
}): Promise<void>;
/**
 * Commit-first navigation for non-Wix `comment_publish` (WordPress / Valine / Typecho / custom blogs):
 * navigates with `waitUntil: 'commit'` (default 15s, respecting higher caller timeoutMs), then polls
 * up to 6-8s for comment form / textarea / `#comment` / `form` / error DOM readiness so slow third-party
 * scripts or 13MB pages do not fail with `domcontentloaded` timeouts.
 */
export declare function navigateCommentPageWithCommit(page: Page, url: string, options: {
    readonly timeoutMs: number;
    readonly domReadyWaitMs?: number;
    readonly sleep?: SleepLike;
    readonly signal?: AbortSignal;
}): Promise<void>;
/** Collect max existing numeric `#comment-<ID>` currently present in the DOM before WordPress comment submit. */
export declare function collectMaxExistingCommentId(page: Page): Promise<number>;
export declare function inspectChildFrames(page: Page): Promise<ChildFramesInspection>;
export declare function executeCommentPublish(page: Page, ref: string, command: BrowserCommentPublishCommand, options: ExecuteCommentPublishOptions): Promise<BrowserCommentPublishResult>;
