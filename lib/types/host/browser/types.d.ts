/**
 * Vocabulary for the browser automation capability seam (`ctx.browser`).
 */
import { CodedError } from '../../shared/errors.ts';
export type BrowserCommand = BrowserNavigateCommand | BrowserSnapshotCommand | BrowserBringToFrontCommand | BrowserClickCommand | BrowserFillCommand | BrowserSelectCommand | BrowserCheckCommand | BrowserPressCommand | BrowserUploadCommand | BrowserScreenshotCommand | BrowserWaitForCommand | BrowserProbeCommand | BrowserCommentPublishCommand | BrowserDirectoryAutofillCommand | BrowserListPagesCommand | BrowserClosePageCommand;
export interface BrowserPageAddress {
    readonly page?: string;
}
export interface BrowserNavigateCommand extends BrowserPageAddress {
    readonly kind: 'navigate';
    readonly url: string;
    readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    readonly maxChars?: number;
    readonly timeoutMs?: number;
    readonly siteHint?: string;
}
export interface BrowserSnapshotCommand extends BrowserPageAddress {
    readonly kind: 'snapshot';
    /** Scope text/aria to a selector; interactive always inspects the whole page. */
    readonly selector?: string;
    /** Interactive exposes icon-only controls, sign-in evidence, and click targets. */
    readonly format?: 'text' | 'aria' | 'interactive';
    readonly maxChars?: number;
    readonly compact?: boolean;
}
export interface BrowserBringToFrontCommand extends BrowserPageAddress {
    readonly kind: 'bringToFront';
}
export interface BrowserClickCommand extends BrowserPageAddress {
    readonly kind: 'click';
    readonly selector: string;
    readonly nth?: number;
    /** When true, listens for native dialogs, XHR/fetch responses, and post-click DOM notices. */
    readonly captureSubmitFeedback?: boolean;
    /** Optional wait duration (ms) for post-submit feedback capture (default ~2000ms). */
    readonly feedbackWaitMs?: number;
}
export interface BrowserFillCommand extends BrowserPageAddress {
    readonly kind: 'fill';
    readonly selector: string;
    readonly value: string;
    readonly nth?: number;
}
export interface BrowserSelectCommand extends BrowserPageAddress {
    readonly kind: 'select';
    readonly selector: string;
    readonly value: string;
    readonly nth?: number;
}
export interface BrowserCheckCommand extends BrowserPageAddress {
    readonly kind: 'check';
    readonly selector: string;
    readonly nth?: number;
}
export interface BrowserPressCommand extends BrowserPageAddress {
    readonly kind: 'press';
    readonly key: string;
}
export interface BrowserUploadCommand extends BrowserPageAddress {
    readonly kind: 'upload';
    readonly selector: string;
    readonly files: readonly string[];
    readonly nth?: number;
}
export interface BrowserScreenshotCommand extends BrowserPageAddress {
    readonly kind: 'screenshot';
}
export interface BrowserWaitForCommand extends BrowserPageAddress {
    readonly kind: 'waitFor';
    readonly selector?: string;
    readonly url?: string;
    readonly timeoutMs?: number;
    readonly nth?: number;
}
export interface BrowserProbeCommand extends BrowserPageAddress {
    readonly kind: 'probe';
    readonly selector?: string;
}
export type CommentPublishSiteType = 'wordpress' | 'wix' | 'typecho' | 'blogger' | 'other';
export type CommentPublishOutcome = 'live' | 'submitted' | 'uncertain_after_submit' | 'comments_closed' | 'blocked_captcha' | 'blocked_waf' | 'needs_login' | 'no_form' | 'needs_llm_fallback' | 'form_ready';
export interface CommentPublishLoginInfo {
    readonly loginButtons: readonly string[];
    readonly ssoProviders: readonly string[];
    readonly hasEmailForm?: boolean;
    readonly dialogText?: string;
}
export interface CommentPublishFormSummary {
    readonly forms: number;
    readonly textareas: number;
    readonly inputs: readonly string[];
    readonly buttons: readonly string[];
    readonly iframes: number;
    readonly hasLoginWall: boolean;
    readonly snippet?: string;
    readonly bottomSnapshot?: string;
    readonly commentHooks?: readonly string[];
    readonly childFrames?: readonly string[];
}
export interface BrowserCommentPublishCommand extends BrowserPageAddress {
    readonly kind: 'comment_publish';
    readonly url: string;
    readonly commentText: string;
    readonly authorName?: string;
    readonly authorEmail?: string;
    readonly websiteUrl?: string;
    readonly anchorText?: string;
    readonly siteHint?: string;
    readonly timeoutMs?: number;
    readonly verifyReload?: boolean;
    readonly probeOnly?: boolean;
}
export interface BrowserDirectoryAutofillCommand extends BrowserPageAddress {
    readonly kind: 'directory_autofill';
    readonly url?: string;
    readonly websiteUrl: string;
    readonly name?: string;
    readonly tagline?: string;
    readonly description?: string;
    readonly email?: string;
    readonly waitAfterFetchMs?: number;
    readonly timeoutMs?: number;
}
export interface BrowserListPagesCommand extends BrowserPageAddress {
    readonly kind: 'listPages';
}
export interface BrowserClosePageCommand extends BrowserPageAddress {
    readonly kind: 'closePage';
}
export interface BrowserPageInfo {
    readonly ref: string;
    readonly url: string;
    readonly title: string;
    readonly isPopup?: boolean;
    readonly active?: boolean;
}
export interface BrowserSubmitFeedbackDialog {
    readonly type: string;
    readonly message: string;
}
export interface BrowserSubmitFeedbackResponse {
    readonly url: string;
    readonly status: number;
    readonly contentType?: string;
    readonly bodySnippet?: string;
}
export interface BrowserSubmitFeedback {
    readonly dialogs?: readonly BrowserSubmitFeedbackDialog[];
    readonly networkResponses?: readonly BrowserSubmitFeedbackResponse[];
    readonly domNotices?: readonly string[];
    readonly finalUrl?: string;
    readonly title?: string;
}
export type BrowserResult = BrowserPageResult | BrowserAckedResult | BrowserScreenshotResult | BrowserProbeResult | BrowserCommentPublishResult | BrowserDirectoryAutofillResult | BrowserPagesResult;
export interface BrowserPageResult {
    readonly kind: 'page';
    readonly page: string;
    readonly url: string;
    readonly title: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly compactSummary?: string;
}
export interface BrowserAckedResult {
    readonly kind: 'acked';
    readonly popupPageRef?: string;
    readonly openedPages?: readonly BrowserPageInfo[];
    readonly submitFeedback?: BrowserSubmitFeedback;
}
export interface BrowserScreenshotResult {
    readonly kind: 'screenshot';
    readonly pngBase64: string;
}
export interface BrowserProbeResult {
    readonly kind: 'probe';
    readonly page: string;
    readonly url: string;
    readonly title: string;
    readonly selectorVisible?: boolean;
}
export interface BrowserPagesResult {
    readonly kind: 'pages';
    readonly pages: readonly BrowserPageInfo[];
}
export interface DirectoryAutofillFieldState {
    readonly role: string;
    readonly selector: string;
    readonly filled: boolean;
    readonly required: boolean;
    readonly valuePreview?: string;
}
export type DirectoryAutofillOutcome = 'ready_to_submit' | 'partial_filled' | 'needs_login' | 'blocked_captcha' | 'no_form';
export interface BrowserDirectoryAutofillResult {
    readonly kind: 'directory_autofill';
    readonly page: string;
    readonly outcome: DirectoryAutofillOutcome;
    readonly url: string;
    readonly title: string;
    readonly autofillTriggered: boolean;
    readonly autofillConfirmClicked?: boolean;
    readonly autofilledFields: readonly string[];
    readonly filledFields: readonly string[];
    readonly remainingRequired: readonly string[];
    readonly fields: readonly DirectoryAutofillFieldState[];
    readonly selects?: readonly string[];
    readonly fileInputs?: readonly string[];
    readonly submitSelector?: string;
    readonly evidence?: string;
}
export interface BrowserCommentPublishResult {
    readonly kind: 'comment_publish';
    readonly page: string;
    readonly outcome: CommentPublishOutcome;
    readonly siteType: CommentPublishSiteType;
    readonly title: string;
    readonly finalUrl: string;
    readonly publicUrl?: string;
    readonly evidence?: string;
    readonly reason?: string;
    readonly skipReason?: string;
    readonly templateSignature?: string;
    readonly suggestedTags?: readonly string[];
    readonly submitTriggered: boolean;
    readonly probeOnly?: boolean;
    readonly loginInfo?: CommentPublishLoginInfo;
    readonly httpStatus?: number;
    readonly postSubmitUrl?: string;
    readonly postSubmitSnippet?: string;
    readonly popupPageRef?: string;
    readonly openedPages?: readonly BrowserPageInfo[];
    readonly formSummary?: CommentPublishFormSummary;
    readonly bottomSnapshot?: string;
}
export interface BrowserSession {
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    close(): Promise<void>;
    isClosed?(): boolean;
}
export interface BrowserAutomationProvider {
    readonly id: string;
    available(): boolean;
    open(signal?: AbortSignal): Promise<BrowserSession>;
}
export type BrowserErrorCode = 'BROWSER_DUPLICATE_PROVIDER' | 'BROWSER_PROVIDER_CONFIGURED_MISSING' | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' | 'BROWSER_PROVIDER_UNAVAILABLE' | 'BROWSER_PROVIDER_AMBIGUOUS' | 'BROWSER_LAUNCH_FAILED' | 'BROWSER_ABORTED' | 'BROWSER_ACTION_FAILED';
export declare class BrowserError extends CodedError<BrowserErrorCode> {
}
