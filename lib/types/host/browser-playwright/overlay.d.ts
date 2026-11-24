/**
 * Safe dismissal helper for visible marketing popups, Klaviyo modals, cookie
 * consent banners, and blocking non-auth dialogs before clicking targets.
 *
 * Strictly preserves login/signup dialogs and CAPTCHA modals so downstream
 * classifiers can report `needs_login` or `blocked_captcha` accurately.
 */
import type { Page } from 'playwright-core';
export interface BlockingOverlayInspection {
    readonly detected: boolean;
    readonly kind?: string;
    readonly closeSelector?: string;
}
export declare const INSPECT_BLOCKING_OVERLAY_SCRIPT: string;
/**
 * Inspect for visible marketing/cookie overlays and dismiss via Escape and/or
 * close button so subsequent clicks are never intercepted.
 */
export declare function dismissBlockingOverlays(page: Page, timeoutMs: number): Promise<{
    readonly dismissed: boolean;
    readonly kind?: string;
}>;
