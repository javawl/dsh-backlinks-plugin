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
export declare const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 9000;
export declare const DEFAULT_WIX_EXPAND_WAIT_MAX_MS = 4000;
export declare const DEFAULT_WIX_POST_SUBMIT_WAIT_MS = 2500;
export interface WordPressInspection {
    readonly found: boolean;
    readonly collapsedTriggerSelector?: string;
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
export interface GenericCommentInspection {
    readonly found: boolean;
    readonly kind?: 'typecho' | 'custom_blog';
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
    readonly hasGuestEditor: boolean;
    readonly hasLazyPlaceholder: boolean;
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
    readonly captchaDetected?: boolean;
    readonly snippet?: string;
}
export interface WixPostSubmitInspection {
    readonly hasCaptcha: boolean;
    readonly hasLoginDialog: boolean;
    readonly moderationNotice?: string;
    readonly dialogText?: string;
    readonly loginInfo?: CommentPublishLoginInfo;
}
/** Strip unapproved/moderation query parameters before public reload verification (preserving `#comment-ID`). */
export declare function stripWpModerationParams(rawUrl: string): string;
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
/** Post-Publish Wix inspection checking visible `role=dialog` for reCAPTCHA, login/signup, or moderation. */
export declare const INSPECT_WIX_POST_SUBMIT_SCRIPT: string;
/** Lightweight self-contained script run inside non-ad child frames. */
export declare const INSPECT_CHILD_FRAME_SCRIPT: string;
/** Script evaluated inside `iframe[src*="blogger.com/comment"]`. */
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
    readonly wixExpandWaitMaxMs?: number;
    readonly wixPostSubmitWaitMs?: number;
    readonly sleepImpl?: SleepLike;
    readonly signal?: AbortSignal;
}
export declare const CAPTCHA_FRAME_URL_PATTERN: RegExp;
export declare const KNOWN_COMMENT_FRAME_URL_PATTERN: RegExp;
export declare const NON_COMMENT_FRAME_URL_PATTERN: RegExp;
export declare function isNavigationContextError(error: unknown): boolean;
export declare function inspectChildFrames(page: Page): Promise<ChildFramesInspection>;
export declare function executeCommentPublish(page: Page, ref: string, command: BrowserCommentPublishCommand, options: ExecuteCommentPublishOptions): Promise<BrowserCommentPublishResult>;
