/**
 * MCP `browser` tool definition, session manager, and action handler (zero
 * DSH/Cordis dependencies).
 *
 * Exposes all 12 existing actions (`navigate`, `snapshot`, `click`, `fill`,
 * `select`, `press`, `upload`, `screenshot`, `waitFor`, `closePage`,
 * `bringToFront`, `closeBrowser`) plus:
 * - Lower default token limits (`navigate` summary 3,000; `snapshot` default 8,000; hard clamp `maxOutputChars` 16,000)
 * - Optional `nth` / `submitNth` disambiguation and Playwright strict-mode diagnostics
 * - `batch_fill`: serial multi-field form filling + optional submit in 1 round-trip
 * - `wait_for_login`: in-process polling waiting for manual login completion.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAutomationProvider, BrowserCommand, BrowserResult } from '../host/browser/types.ts';
import { type McpConfig } from './config.ts';
import type { SleepLike } from './backlinks-tool.ts';
export declare const DEFAULT_COMMENT_PUBLISH_DEADLINE_MS = 55000;
export declare const MAX_TOOL_DEADLINE_MS = 90000;
export declare const DEFAULT_NAVIGATE_DEADLINE_MS = 35000;
export declare const DEFAULT_SNAPSHOT_DEADLINE_MS = 25000;
export declare const DEFAULT_BATCH_FILL_DEADLINE_MS = 45000;
export declare const DEFAULT_DIRECTORY_AUTOFILL_DEADLINE_MS = 45000;
export declare const DEFAULT_SINGLE_ACTION_DEADLINE_MS = 30000;
export declare function resolveToolDeadlineMs(action: BrowserAction, explicitDeadlineMs?: number, timeoutMs?: number): number | undefined;
export declare const BROWSER_ACTIONS: readonly ["navigate", "snapshot", "click", "fill", "select", "press", "upload", "screenshot", "waitFor", "listPages", "closePage", "bringToFront", "closeBrowser", "batch_fill", "wait_for_login", "comment_publish", "directory_autofill"];
export type BrowserAction = typeof BROWSER_ACTIONS[number];
export type BatchFillOp = 'fill' | 'select' | 'click' | 'check';
export type McpBrowserToolResult = CallToolResult;
export interface BatchFillField {
    readonly target: string;
    readonly value?: string;
    readonly op: BatchFillOp;
    readonly nth?: number;
}
export declare const BROWSER_TOOL_DEFINITION: Tool;
export declare class BrowserSessionManager {
    private readonly provider;
    private session;
    private opening;
    private closing;
    constructor(provider: BrowserAutomationProvider);
    static fromConfig(config: McpConfig): BrowserSessionManager;
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    closeSession(): Promise<void>;
    recyclePage(page?: string): Promise<boolean>;
    private ensureSession;
    private launchSession;
    private discardSession;
}
export declare function formatMcpBrowserOutput(result: BrowserResult, maxChars: number): string;
export interface BrowserToolDependencies {
    readonly sessionManager: BrowserSessionManager;
    readonly config: McpConfig;
    readonly sleepImpl?: SleepLike;
}
export declare function createBrowserToolHandler(deps: BrowserToolDependencies): (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpBrowserToolResult>;
