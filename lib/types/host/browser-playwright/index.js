/**
 * Service Provider for the Playwright persistent-Chromium browser seam.
 */
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { PlaywrightBrowserProvider } from "./provider.js";
export const name = 'browser-playwright';
export const inject = ['browser'];
export const Config = z.object({
    userDataDir: z.string(),
    headless: z.boolean().default(false),
    channel: z.string().default('chrome'),
    defaultTimeoutMs: z.number().default(15_000),
    launchArgs: z.array(z.string()).default([]),
    ignoreDefaultArgs: z.array(z.string()).default([]),
    windowPosition: z.string(),
});
export function apply(ctx, config) {
    const userDataDir = (config.userDataDir ?? process.env.DSH_BACKLINK_BROWSER_PROFILE ?? dshHomePath('backlink-browser-profile')).trim();
    if (userDataDir.length === 0) {
        throw new Error('browser-playwright: userDataDir must not be empty');
    }
    const defaultTimeoutMs = config.defaultTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
        throw new Error(`browser-playwright: defaultTimeoutMs must be a positive integer, got ${defaultTimeoutMs}`);
    }
    const resolved = {
        userDataDir,
        headless: config.headless ?? false,
        channel: config.channel ?? 'chrome',
        defaultTimeoutMs,
        launchArgs: config.launchArgs ?? [],
        ignoreDefaultArgs: config.ignoreDefaultArgs ?? [],
        windowPosition: config.windowPosition,
    };
    ctx.effect(() => ctx.browser.registerProvider(new PlaywrightBrowserProvider(resolved)), 'browser-playwright: provider');
}
export { PLAYWRIGHT_BROWSER_PROVIDER_ID, PlaywrightBrowserProvider } from "./provider.js";
