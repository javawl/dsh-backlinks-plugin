/**
 * Standalone cross-platform Stdio MCP Server (`backlinks-publisher`).
 *
 * Never write anything to `stdout` outside `StdioServerTransport` (use `stderr`
 * for diagnostics). Registers two tools: `backlinks` and `browser`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { BacklinkBatchSourceProvider, MailboxProvider } from '../host/backlinks/types.ts';
import { type FetchLike, type SleepLike } from './backlinks-tool.ts';
import { BrowserSessionManager } from './browser-tool.ts';
import { type McpConfig } from './config.ts';
export declare const MCP_SERVER_NAME = "backlinks-publisher";
export declare const MCP_SERVER_VERSION = "1.0.0";
export interface BacklinksMcpServerOptions {
    readonly config?: McpConfig;
    readonly sessionManager?: BrowserSessionManager;
    readonly batchSource?: BacklinkBatchSourceProvider;
    readonly mailbox?: MailboxProvider;
    readonly fetchImpl?: FetchLike;
    readonly sleepImpl?: SleepLike;
}
export interface BacklinksMcpServerInstance {
    readonly server: Server;
    readonly sessionManager: BrowserSessionManager;
    readonly config: McpConfig;
}
export declare function createBacklinksMcpServer(options?: BacklinksMcpServerOptions): BacklinksMcpServerInstance;
export declare function runStdioServer(options?: BacklinksMcpServerOptions): Promise<void>;
