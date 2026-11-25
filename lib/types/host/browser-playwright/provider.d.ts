/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */
import type { BrowserContext, Locator } from 'playwright-core';
import type { BrowserAutomationProvider, BrowserCommand, BrowserResult, BrowserSession } from '../browser/types.ts';
import { BrowserError } from '../browser/types.ts';
export declare const PLAYWRIGHT_BROWSER_PROVIDER_ID = "playwright";
export declare const DEFAULT_SNAPSHOT_MAX_CHARS = 60000;
export declare const STRICT_MODE_INSPECT_TIMEOUT_MS = 1500;
export declare const STRICT_MODE_MAX_CANDIDATES = 5;
export declare const DEFAULT_SUBMIT_FEEDBACK_WAIT_MS = 2000;
export interface StrictModeCandidate {
    readonly index: number;
    readonly tag: string;
    readonly role?: string;
    readonly text?: string;
    readonly ariaLabel?: string;
    readonly name?: string;
    readonly type?: string;
    readonly visible?: boolean;
}
export interface StrictModeInspection {
    readonly total: number;
    readonly candidates: readonly StrictModeCandidate[];
}
export interface ResolvedPlaywrightConfig {
    readonly userDataDir: string;
    readonly headless: boolean;
    readonly channel: string;
    readonly defaultTimeoutMs: number;
    readonly launchArgs: readonly string[];
    readonly ignoreDefaultArgs: readonly string[];
    readonly windowPosition: string | undefined;
    readonly executablePath?: string;
}
/**
 * Resolve a visible, non-CAPTCHA-response locator when `nth` is omitted so hidden
 * modals and hidden `textarea[name="g-recaptcha-response"]` fields never trigger
 * strict-mode conflicts while preserving exact unique visible selectors and
 * multi-visible strict-mode diagnostics.
 */
export declare function resolvePreferredVisibleLocator(locator: Locator, nth: number | undefined): Promise<Locator>;
export declare function inspectStrictModeCandidates(locator: Locator, timeoutMs?: number): Promise<StrictModeInspection | undefined>;
export declare function enrichStrictModeError(commandKind: BrowserCommand['kind'], locator: Locator, error: unknown, timeoutMs?: number): Promise<BrowserError | undefined>;
export declare class PlaywrightSession implements BrowserSession {
    private readonly context;
    private readonly defaultTimeoutMs;
    private readonly defaultMaxChars;
    private closed;
    private readonly pages;
    private readonly pageToRef;
    private readonly pageMeta;
    private readonly chains;
    private readonly popupCollectors;
    private keeperPage;
    private creatingInternalPage;
    private legacyTail;
    private lastRef;
    private refSeq;
    private popupSeq;
    constructor(context: BrowserContext, defaultTimeoutMs: number, defaultMaxChars: number);
    isClosed(): boolean;
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    private chained;
    private execute;
    private runLocatorAction;
    close(): Promise<void>;
    private withPopupCapture;
    private runClickWithSubmitFeedback;
    private createInternalPage;
    private registerPage;
    private removePageMapping;
    private findFallbackBusinessRef;
    private adopt;
    private requirePage;
    private resolveForNavigate;
    private pageResult;
}
export declare class PlaywrightBrowserProvider implements BrowserAutomationProvider {
    private readonly config;
    readonly id = "playwright";
    constructor(config: ResolvedPlaywrightConfig);
    available(): boolean;
    open(signal?: AbortSignal): Promise<BrowserSession>;
}
