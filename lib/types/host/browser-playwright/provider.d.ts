/**
 * Playwright persistent-Chromium implementation of the browser automation seam.
 */
import type { BrowserAutomationProvider, BrowserSession } from '../browser/index.ts';
export declare const PLAYWRIGHT_BROWSER_PROVIDER_ID = "playwright";
export declare const DEFAULT_SNAPSHOT_MAX_CHARS = 60000;
export interface ResolvedPlaywrightConfig {
    readonly userDataDir: string;
    readonly headless: boolean;
    readonly channel: string;
    readonly defaultTimeoutMs: number;
    readonly launchArgs: readonly string[];
    readonly ignoreDefaultArgs: readonly string[];
    readonly windowPosition: string | undefined;
}
export declare class PlaywrightBrowserProvider implements BrowserAutomationProvider {
    private readonly config;
    readonly id = "playwright";
    constructor(config: ResolvedPlaywrightConfig);
    available(): boolean;
    open(signal?: AbortSignal): Promise<BrowserSession>;
}
