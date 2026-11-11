/**
 * Service Provider for the Playwright persistent-Chromium browser seam.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "browser-playwright";
export declare const inject: string[];
export interface Config {
    readonly userDataDir?: string;
    readonly headless?: boolean;
    readonly channel?: string;
    readonly defaultTimeoutMs?: number;
    readonly launchArgs?: string[];
    readonly windowPosition?: string;
    readonly ignoreDefaultArgs?: string[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { PLAYWRIGHT_BROWSER_PROVIDER_ID, PlaywrightBrowserProvider } from './provider.ts';
