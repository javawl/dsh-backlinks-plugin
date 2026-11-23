/**
 * MCP `backlinks` tool definition and handler (zero DSH/Cordis dependencies).
 *
 * Exposes all 10 existing actions (`batch_list`, `batch_get`, `batch_claim`,
 * `lease_heartbeat`, `lease_release`, `item_result`, `badge_add`, `source_tags`,
 * `mailbox_create`, `mail_wait`) plus:
 * - `badge_verify`: native Node `fetch()` refresh + live page verification
 * - `batch_get` compact mode (`compact` defaults to `true`)
 * - Lazy credential checks so Supermanager actions work even without `CLOUDMAIL_TOKEN`.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BacklinkBatchSourceProvider, MailboxProvider } from '../host/backlinks/types.ts';
import { type McpConfig } from './config.ts';
export declare const BACKLINKS_ACTIONS: readonly ["batch_list", "batch_get", "batch_claim", "lease_heartbeat", "lease_release", "item_result", "badge_add", "badge_verify", "source_tags", "mailbox_create", "mail_wait"];
export type BacklinksAction = typeof BACKLINKS_ACTIONS[number];
export type McpToolResult = CallToolResult;
export type FetchLike = typeof fetch;
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;
export interface BacklinksToolDependencies {
    readonly config: McpConfig;
    readonly batchSource?: BacklinkBatchSourceProvider;
    readonly mailbox?: MailboxProvider;
    readonly fetchImpl?: FetchLike;
    readonly sleepImpl?: SleepLike;
}
export declare const BACKLINKS_TOOL_DEFINITION: Tool;
export declare function createBacklinksToolHandler(deps: BacklinksToolDependencies): (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolResult>;
