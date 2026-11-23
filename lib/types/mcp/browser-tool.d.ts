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
export declare const BROWSER_ACTIONS: readonly ["navigate", "snapshot", "click", "fill", "select", "press", "upload", "screenshot", "waitFor", "closePage", "bringToFront", "closeBrowser", "batch_fill", "wait_for_login"];
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
    constructor(provider: BrowserAutomationProvider);
    static fromConfig(config: McpConfig): BrowserSessionManager;
    act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
    closeSession(): Promise<void>;
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
