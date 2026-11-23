/**
 * Standalone cross-platform Stdio MCP Server (`backlinks-publisher`).
 *
 * Never write anything to `stdout` outside `StdioServerTransport` (use `stderr`
 * for diagnostics). Registers two tools: `backlinks` and `browser`.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { BacklinkBatchSourceProvider, MailboxProvider } from '../host/backlinks/types.ts'
import {
  BACKLINKS_TOOL_DEFINITION,
  createBacklinksToolHandler,
  type FetchLike,
  type SleepLike,
} from './backlinks-tool.ts'
import {
  BROWSER_TOOL_DEFINITION,
  BrowserSessionManager,
  createBrowserToolHandler,
} from './browser-tool.ts'
import { resolveMcpConfig, type McpConfig } from './config.ts'

export const MCP_SERVER_NAME = 'backlinks-publisher'
export const MCP_SERVER_VERSION = '1.0.0'

export interface BacklinksMcpServerOptions {
  readonly config?: McpConfig
  readonly sessionManager?: BrowserSessionManager
  readonly batchSource?: BacklinkBatchSourceProvider
  readonly mailbox?: MailboxProvider
  readonly fetchImpl?: FetchLike
  readonly sleepImpl?: SleepLike
}

export interface BacklinksMcpServerInstance {
  readonly server: Server
  readonly sessionManager: BrowserSessionManager
  readonly config: McpConfig
}

export function createBacklinksMcpServer(
  options: BacklinksMcpServerOptions = {},
): BacklinksMcpServerInstance {
  const config = options.config ?? resolveMcpConfig()
  const sessionManager = options.sessionManager ?? BrowserSessionManager.fromConfig(config)

  const handleBacklinks = createBacklinksToolHandler({
    config,
    ...(options.batchSource === undefined ? {} : { batchSource: options.batchSource }),
    ...(options.mailbox === undefined ? {} : { mailbox: options.mailbox }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleepImpl === undefined ? {} : { sleepImpl: options.sleepImpl }),
  })

  const handleBrowser = createBrowserToolHandler({
    sessionManager,
    config,
    ...(options.sleepImpl === undefined ? {} : { sleepImpl: options.sleepImpl }),
  })

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [BACKLINKS_TOOL_DEFINITION, BROWSER_TOOL_DEFINITION],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    if (name === 'backlinks') {
      return await handleBacklinks(args, extra.signal)
    }
    if (name === 'browser') {
      return await handleBrowser(args, extra.signal)
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    }
  })

  return { server, sessionManager, config }
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function runStdioServer(
  options: BacklinksMcpServerOptions = {},
): Promise<void> {
  const { server, sessionManager } = createBacklinksMcpServer(options)
  const transport = new StdioServerTransport()

  let shuttingDown = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    process.stdin.removeListener('end', onStdinEnd)
    process.stdin.removeListener('close', onStdinEnd)
    try {
      await withTimeout(sessionManager.closeSession(), 5_000)
    } catch {
      // ignore cleanup errors on shutdown
    }
    try {
      await withTimeout(server.close(), 2_000)
    } catch {
      // ignore server close errors on shutdown
    }
    resolveDone()
  }

  const onSignal = (): void => {
    void shutdown()
  }
  const onStdinEnd = (): void => {
    void shutdown()
  }

  transport.onclose = () => {
    void shutdown()
  }
  transport.onerror = (error) => {
    process.stderr.write(`[${MCP_SERVER_NAME}] transport error: ${error.message}\n`)
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.stdin.on('end', onStdinEnd)
  process.stdin.on('close', onStdinEnd)

  await server.connect(transport)
  await done
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const selfPath = path.resolve(fileURLToPath(import.meta.url))
  const entryPath = path.resolve(entry)
  return process.platform === 'win32'
    ? selfPath.toLowerCase() === entryPath.toLowerCase()
    : selfPath === entryPath
}

if (isMainModule()) {
  runStdioServer().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`[${MCP_SERVER_NAME}] fatal: ${message}\n`)
    process.exitCode = 1
  })
}
