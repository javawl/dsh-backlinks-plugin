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
    readonly loginReason?: string;
    readonly autofillButtonSelector?: string;
    readonly autofillButtonDisabled?: boolean;
    readonly autofillButtonBusy?: boolean;
    readonly submitSelector?: string;
    readonly fields: readonly RawDirectoryField[];
    readonly selects: readonly string[];
    readonly fileInputs: readonly string[];
    readonly extraRequiredEmpty: readonly string[];
}
export interface DirectoryConfirmDialogInspection {
    readonly detected: boolean;
    readonly buttonSelector?: string;
    readonly buttonLabel?: string;
    readonly urlInputSelector?: string;
    readonly urlInputValue?: string;
}
export declare const INSPECT_DIRECTORY_AUTOFILL_SCRIPT: string;
/**
 * Inspect visible confirmation dialogs triggered after clicking `AI Autofill` / `Auto Fill`
 * (e.g. MkDirs confirmation popup containing an `Analyze` / `Confirm` / `Continue` button).
 */
export declare const INSPECT_AUTOFILL_CONFIRM_DIALOG_SCRIPT: string;
export interface ExecuteDirectoryAutofillOptions {
    readonly defaultTimeoutMs: number;
    readonly deadlineMs?: number;
    readonly waitAfterFetchMs?: number;
    readonly sleepImpl?: SleepLike;
    readonly signal?: AbortSignal;
}
export declare function executeDirectoryAutofill(page: Page, ref: string, command: BrowserDirectoryAutofillCommand, options: ExecuteDirectoryAutofillOptions): Promise<BrowserDirectoryAutofillResult>;
export {};
