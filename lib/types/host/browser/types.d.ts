/**
 * Vocabulary for the browser automation capability seam (`ctx.browser`).
 */
import { CodedError } from '../../shared/errors.ts';
export type BrowserCommand = BrowserNavigateCommand | BrowserSnapshotCommand | BrowserBringToFrontCommand | BrowserClickCommand | BrowserFillCommand | BrowserSelectCommand | BrowserCheckCommand | BrowserPressCommand | BrowserUploadCommand | BrowserScreenshotCommand | BrowserWaitForCommand | BrowserProbeCommand | BrowserCommentPublishCommand | BrowserClosePageCommand;
export interface BrowserPageAddress {
    readonly page?: string;
}
export interface BrowserNavigateCommand extends BrowserPageAddress {
    readonly kind: 'navigate';
    readonly url: string;
    readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    readonly maxChars?: number;
    readonly timeoutMs?: number;
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
export type CommentPublishSiteType = 'wordpress' | 'wix' | 'other';
export type CommentPublishOutcome = 'live' | 'submitted' | 'uncertain_after_submit' | 'comments_closed' | 'blocked_captcha' | 'no_form' | 'needs_llm_fallback' | 'form_ready';
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
    readonly timeoutMs?: number;
    readonly verifyReload?: boolean;
    readonly probeOnly?: boolean;
}
export interface BrowserClosePageCommand extends BrowserPageAddress {
    readonly kind: 'closePage';
}
export type BrowserResult = BrowserPageResult | BrowserAckedResult | BrowserScreenshotResult | BrowserProbeResult | BrowserCommentPublishResult;
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
export interface BrowserCommentPublishResult {
    readonly kind: 'comment_publish';
    readonly page: string;
    readonly outcome: CommentPublishOutcome;
    readonly siteType: CommentPublishSiteType;
    readonly title: string;
    readonly finalUrl: string;
    readonly publicUrl?: string;
    readonly evidence?: string;
    readonly skipReason?: string;
    readonly templateSignature?: string;
    readonly suggestedTags?: readonly string[];
    readonly submitTriggered: boolean;
    readonly probeOnly?: boolean;
    readonly formSummary?: CommentPublishFormSummary;
    readonly bottomSnapshot?: string;
}
export interface BrowserSession {
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    close(): Promise<void>;
}
export interface BrowserAutomationProvider {
    readonly id: string;
    available(): boolean;
    open(signal?: AbortSignal): Promise<BrowserSession>;
}
export type BrowserErrorCode = 'BROWSER_DUPLICATE_PROVIDER' | 'BROWSER_PROVIDER_CONFIGURED_MISSING' | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' | 'BROWSER_PROVIDER_UNAVAILABLE' | 'BROWSER_PROVIDER_AMBIGUOUS' | 'BROWSER_LAUNCH_FAILED' | 'BROWSER_ABORTED' | 'BROWSER_ACTION_FAILED';
export declare class BrowserError extends CodedError<BrowserErrorCode> {
}
