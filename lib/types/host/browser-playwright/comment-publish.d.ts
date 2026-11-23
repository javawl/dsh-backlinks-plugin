/**
 * Deterministic Playwright fast-path for standard WordPress and Wix blog comment
 * publishing (`browser action="comment_publish"`).
 *
 * Strictly enforces:
 * - Zero CAPTCHA bypass: detects reCAPTCHA/hCaptcha/Turnstile/SecureImg/math
 *   captchas and returns `blocked_captcha` (`submitTriggered: false`).
 * - Idempotency: once a submit action is triggered (`submitTriggered: true`),
 *   any post-submit uncertainty returns `uncertain_after_submit` and never retries.
 * - Rich-editor safety: never types raw `<a>` markup into `contenteditable` editors.
 */
import type { Page } from 'playwright-core';
import type { BrowserCommentPublishCommand, BrowserCommentPublishResult, CommentPublishFormSummary } from '../browser/types.ts';
import type { SleepLike } from '../../mcp/backlinks-tool.ts';
export declare const DEFAULT_LAZY_WAIT_MAX_MS = 2500;
export declare const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 5000;
export declare const DEFAULT_WIX_EXPAND_WAIT_MAX_MS = 4000;
export interface WordPressInspection {
    readonly found: boolean;
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
}
export interface ChildFramesInspection {
    readonly frames: readonly string[];
    readonly hasActionableCommentFrame: boolean;
    readonly hasUnknownInteractiveFrame: boolean;
    readonly captchaDetected: boolean;
    readonly commentsClosedPhrase?: string;
}
export interface CommentPageInspection {
    readonly title: string;
    readonly finalUrl: string;
    readonly isWix: boolean;
    readonly isWordPress: boolean;
    readonly readyState?: string;
    readonly scrollHeight?: number;
    readonly commentsClosed: {
        readonly matched: boolean;
        readonly phrase?: string;
    };
    readonly wordpress: WordPressInspection;
    readonly wix: WixInspection;
    readonly childFrames?: ChildFramesInspection;
    readonly formSummary: CommentPublishFormSummary;
    readonly bottomSnapshot?: string;
}
export interface CommentVerifyOutcome {
    readonly liveLinkFound: boolean;
    readonly matchedHref?: string;
    readonly matchedAnchor?: string;
    readonly escapedHtmlDetected: boolean;
    readonly moderationNotice?: string;
    readonly wpErrorMessage?: string;
}
/** Strip unapproved/moderation query parameters before public reload verification. */
export declare function stripWpModerationParams(rawUrl: string): string;
/** Build WordPress comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
export declare function buildWpCommentContent(commentText: string, websiteUrl: string | undefined, anchorText: string | undefined, hasUrlField: boolean): string;
/** Strip raw `<a>` markup before typing into a `contenteditable` rich editor. */
export declare function stripHtmlLinkForRichEditor(commentText: string, anchorText?: string, websiteUrl?: string): {
    readonly plainText: string;
    readonly anchorText?: string;
    readonly websiteUrl?: string;
};
/**
 * Self-contained browser evaluation script inspecting WordPress, Wix,
 * comments-closed banners, CAPTCHAs, and minimal fallback form metadata.
 */
export declare const INSPECT_COMMENT_PAGE_SCRIPT: string;
/** Lightweight self-contained script run inside non-ad child frames. */
export declare const INSPECT_CHILD_FRAME_SCRIPT: string;
/**
 * Self-contained browser evaluation function checking post-submit / post-reload
 * live clickable links, escaped HTML `<a>` text, moderation notices, and WP errors.
 */
export declare function verifyCommentResultInDom(params: {
    readonly websiteUrl?: string;
    readonly anchorText?: string;
    readonly commentText?: string;
    readonly authorName?: string;
}): CommentVerifyOutcome;
export interface ExecuteCommentPublishOptions {
    readonly defaultTimeoutMs: number;
    readonly lazyWaitMaxMs?: number;
    readonly wixLazyWaitMaxMs?: number;
    readonly wixExpandWaitMaxMs?: number;
    readonly sleepImpl?: SleepLike;
    readonly signal?: AbortSignal;
}
export declare function executeCommentPublish(page: Page, ref: string, command: BrowserCommentPublishCommand, options: ExecuteCommentPublishOptions): Promise<BrowserCommentPublishResult>;
