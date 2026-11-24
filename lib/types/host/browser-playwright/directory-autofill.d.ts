/**
 * Deterministic fast-path for MkDirs / AI-Autofill and standard directory
 * submission pages (`browser action="directory_autofill"`).
 *
 * Performs URL fill -> optional Fetch/AI-Autofill trigger + wait for
 * auto-population -> backfill missing Name/Tagline/Description/Email ->
 * returns a compact form-state summary without blindly submitting.
 */
import type { Page } from 'playwright-core';
import type { BrowserDirectoryAutofillCommand, BrowserDirectoryAutofillResult } from '../browser/types.ts';
import type { SleepLike } from '../../mcp/backlinks-tool.ts';
export declare const DEFAULT_AUTOFILL_WAIT_MS = 4000;
interface RawDirectoryField {
    readonly role: 'url' | 'name' | 'tagline' | 'description' | 'email';
    readonly selector: string;
    readonly value: string;
    readonly required: boolean;
}
export interface DirectoryPageInspection {
    readonly url: string;
    readonly title: string;
    readonly captchaDetected: boolean;
    readonly loginRequired: boolean;
    readonly autofillButtonSelector?: string;
    readonly autofillButtonBusy?: boolean;
    readonly submitSelector?: string;
    readonly fields: readonly RawDirectoryField[];
    readonly selects: readonly string[];
    readonly fileInputs: readonly string[];
    readonly extraRequiredEmpty: readonly string[];
}
export declare const INSPECT_DIRECTORY_AUTOFILL_SCRIPT: string;
export interface ExecuteDirectoryAutofillOptions {
    readonly defaultTimeoutMs: number;
    readonly waitAfterFetchMs?: number;
    readonly sleepImpl?: SleepLike;
    readonly signal?: AbortSignal;
}
export declare function executeDirectoryAutofill(page: Page, ref: string, command: BrowserDirectoryAutofillCommand, options: ExecuteDirectoryAutofillOptions): Promise<BrowserDirectoryAutofillResult>;
export {};
