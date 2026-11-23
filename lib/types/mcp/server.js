/**
 * Standalone cross-platform Stdio MCP Server (`backlinks-publisher`).
 *
 * Never write anything to `stdout` outside `StdioServerTransport` (use `stderr`
 * for diagnostics). Registers two tools: `backlinks` and `browser`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BACKLINKS_TOOL_DEFINITION, createBacklinksToolHandler, } from "./backlinks-tool.js";
import { BROWSER_TOOL_DEFINITION, BrowserSessionManager, createBrowserToolHandler, } from "./browser-tool.js";
import { resolveMcpConfig } from "./config.js";
export const MCP_SERVER_NAME = 'backlinks-publisher';
export const MCP_SERVER_VERSION = '1.0.0';
export function createBacklinksMcpServer(options = {}) {
    const config = options.config ?? resolveMcpConfig();
    const sessionManager = options.sessionManager ?? BrowserSessionManager.fromConfig(config);
    const handleBacklinks = createBacklinksToolHandler({
        config,
        ...(options.batchSource === undefined ? {} : { batchSource: options.batchSource }),
        ...(options.mailbox === undefined ? {} : { mailbox: options.mailbox }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.sleepImpl === undefined ? {} : { sleepImpl: options.sleepImpl }),
    });
    const handleBrowser = createBrowserToolHandler({
        sessionManager,
        config,
        ...(options.sleepImpl === undefined ? {} : { sleepImpl: options.sleepImpl }),
    });
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [BACKLINKS_TOOL_DEFINITION, BROWSER_TOOL_DEFINITION],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {});
        if (name === 'backlinks') {
            return await handleBacklinks(args, extra.signal);
        }
        if (name === 'browser') {
            return await handleBrowser(args, extra.signal);
        }
        return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    });
    return { server, sessionManager, config };
}
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
export async function runStdioServer(options = {}) {
    const { server, sessionManager } = createBacklinksMcpServer(options);
    const transport = new StdioServerTransport();
    let shuttingDown = false;
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.stdin.removeListener('end', onStdinEnd);
        process.stdin.removeListener('close', onStdinEnd);
        try {
            await withTimeout(sessionManager.closeSession(), 5_000);
        }
        catch {
            // ignore cleanup errors on shutdown
        }
        try {
            await withTimeout(server.close(), 2_000);
        }
        catch {
            // ignore server close errors on shutdown
        }
        resolveDone();
    };
    const onSignal = () => {
        void shutdown();
    };
    const onStdinEnd = () => {
        void shutdown();
    };
    transport.onclose = () => {
        void shutdown();
    };
    transport.onerror = (error) => {
        process.stderr.write(`[${MCP_SERVER_NAME}] transport error: ${error.message}\n`);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.stdin.on('end', onStdinEnd);
    process.stdin.on('close', onStdinEnd);
    await server.connect(transport);
    await done;
}
function isMainModule() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    const selfPath = path.resolve(fileURLToPath(import.meta.url));
    const entryPath = path.resolve(entry);
    return process.platform === 'win32'
        ? selfPath.toLowerCase() === entryPath.toLowerCase()
        : selfPath === entryPath;
}
if (isMainModule()) {
    runStdioServer().catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`[${MCP_SERVER_NAME}] fatal: ${message}\n`);
        process.exitCode = 1;
    });
}
