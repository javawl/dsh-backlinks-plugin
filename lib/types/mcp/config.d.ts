/**
 * Environment configuration, cross-platform home-path expansion, and secret
 * redaction helpers for the `backlinks-publisher` Stdio MCP Server.
 */
import path from 'node:path';
export declare const DEFAULT_CLOUDMAIL_BASE_URL = "https://mail.screwdom.org/api";
export declare const DEFAULT_MAX_OUTPUT_CHARS_CLAMP = 16000;
export declare const DEFAULT_MAX_OUTPUT_CHARS = 16000;
export declare const DEFAULT_SNAPSHOT_MAX_CHARS = 8000;
export declare const DEFAULT_NAVIGATE_MAX_CHARS = 3000;
export declare const DEFAULT_BROWSER_TIMEOUT_MS = 15000;
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export interface McpConfig {
    readonly supermanagerBaseUrl: string;
    readonly supermanagerToken: string;
    readonly supermanagerTimeoutMs: number;
    readonly cloudMailBaseUrl: string;
    readonly cloudMailToken: string;
    readonly cloudMailTimeoutMs: number;
    readonly browserProfileDir: string;
    readonly maxOutputChars: number;
    readonly snapshotMaxChars: number;
    readonly navigateMaxChars: number;
    readonly browserHeadless: boolean;
    readonly browserChannel: string;
    readonly browserTimeoutMs: number;
    readonly browserWindowPosition: string | undefined;
    readonly browserExecutablePath: string | undefined;
}
export interface ResolveMcpConfigOptions {
    readonly homeDir?: string;
    readonly pathImpl?: Pick<typeof path, 'join'>;
}
export declare function isPlaceholderValue(value: unknown): boolean;
export declare function expandHomePath(raw: string, homeDir?: string, pathImpl?: Pick<typeof path, 'join'>): string;
export declare function resolveMcpConfig(env?: NodeJS.ProcessEnv, options?: ResolveMcpConfigOptions): McpConfig;
export declare function redactSecrets(text: string, config: Pick<McpConfig, 'supermanagerToken' | 'cloudMailToken'>): string;
