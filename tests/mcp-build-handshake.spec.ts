import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')
const mcpEntryPath = join(repoRoot, 'lib', 'mcp-server.mjs')

interface JsonRpcLine {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: unknown
}

describe('built MCP server artifact & stdio handshake', () => {
  it('contains zero @deepseek-ai/* imports or references in lib/mcp-server.mjs', () => {
    expect(existsSync(mcpEntryPath)).toBe(true)
    const bundle = readFileSync(mcpEntryPath, 'utf8')
    expect(bundle).not.toContain('@deepseek-ai/')
    expect(bundle).not.toContain('HarnessError')
  })

  it('completes real stdio initialize + tools/list handshake cleanly', async () => {
    const child = spawn(process.execPath, [mcpEntryPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    const messages = new Map<number, JsonRpcLine>()

    const waitForId = (id: number): Promise<JsonRpcLine> => new Promise((resolveMsg, rejectMsg) => {
      const deadline = setTimeout(() => {
        rejectMsg(new Error(`Timed out waiting for JSON-RPC response id=${id}. stderr=${stderrBuf}`))
      }, 10_000)

      const check = () => {
        const hit = messages.get(id)
        if (hit !== undefined) {
          clearTimeout(deadline)
          resolveMsg(hit)
          return true
        }
        return false
      }

      if (check()) return

      const onData = (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8')
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const parsed = JSON.parse(trimmed) as JsonRpcLine
          if (typeof parsed.id === 'number') {
            messages.set(parsed.id, parsed)
          }
        }
        if (check()) {
          child.stdout.off('data', onData)
        }
      }
      child.stdout.on('data', onData)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })

    const send = (payload: unknown) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest-mcp-handshake', version: '1.0.0' },
      },
    })

    const initResp = await waitForId(1)
    expect(initResp.error).toBeUndefined()
    expect(initResp.result?.serverInfo).toEqual({
      name: 'backlinks-publisher',
      version: '1.0.0',
    })

    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    const listResp = await waitForId(2)
    expect(listResp.error).toBeUndefined()
    const tools = (listResp.result as {
      tools: Array<{
        name: string
        inputSchema: {
          properties: Record<string, {
            enum?: string[]
            description?: string
            items?: { properties?: Record<string, unknown> }
          }>
        }
      }>
    }).tools
    expect(tools.map(t => t.name)).toEqual(['backlinks', 'browser'])

    const backlinksTool = tools[0]!
    expect(backlinksTool.inputSchema.properties.action?.enum).toContain('badge_verify')
    expect(backlinksTool.inputSchema.properties.action?.enum).toContain('batch_preflight')
    expect(backlinksTool.inputSchema.properties.action?.enum).toContain('badge_deactivate')
    expect(backlinksTool.inputSchema.properties.compact).toBeDefined()
    expect(backlinksTool.inputSchema.properties.onlyPending).toBeDefined()
    expect(backlinksTool.inputSchema.properties.pendingOnly).toBeDefined()
    expect(backlinksTool.inputSchema.properties.limit).toBeDefined()
    expect(backlinksTool.inputSchema.properties.offset).toBeDefined()
    expect(backlinksTool.inputSchema.properties.autoSkip).toBeDefined()
    expect(backlinksTool.inputSchema.properties.autoSkipTagged).toBeDefined()
    expect(backlinksTool.inputSchema.properties.skipSoftTagged).toBeDefined()
    expect(backlinksTool.inputSchema.properties.autoFailWaf).toBeDefined()
    expect(backlinksTool.inputSchema.properties.skipTags).toBeDefined()
    expect(backlinksTool.inputSchema.properties.concurrency).toBeDefined()
    expect(backlinksTool.inputSchema.properties.badgeId).toBeDefined()
    expect(backlinksTool.inputSchema.properties.sortOrder).toBeDefined()
    expect(backlinksTool.inputSchema.properties.remove).toBeDefined()
    expect(backlinksTool.inputSchema.properties.templateSignature).toBeDefined()
    expect(backlinksTool.inputSchema.properties.websiteId?.description).toContain('batch_list')
    expect(backlinksTool.inputSchema.properties.waitTimeoutMs?.description).toContain('30000')

    const browserTool = tools[1]!
    expect(browserTool.inputSchema.properties.action?.enum).toContain('batch_fill')
    expect(browserTool.inputSchema.properties.action?.enum).toContain('wait_for_login')
    expect(browserTool.inputSchema.properties.action?.enum).toContain('comment_publish')
    expect(browserTool.inputSchema.properties.action?.enum).toContain('listPages')
    expect(browserTool.inputSchema.properties.action?.enum).toContain('directory_autofill')
    expect(browserTool.inputSchema.properties.feedbackWaitMs).toBeDefined()
    expect(browserTool.inputSchema.properties.tagline).toBeDefined()
    expect(browserTool.inputSchema.properties.waitAfterFetchMs).toBeDefined()
    expect(browserTool.inputSchema.properties.nth).toBeDefined()
    expect(browserTool.inputSchema.properties.submitNth).toBeDefined()
    expect(browserTool.inputSchema.properties.full).toBeDefined()
    expect(browserTool.inputSchema.properties.commentText).toBeDefined()
    expect(browserTool.inputSchema.properties.authorName).toBeDefined()
    expect(browserTool.inputSchema.properties.authorEmail).toBeDefined()
    expect(browserTool.inputSchema.properties.websiteUrl).toBeDefined()
    expect(browserTool.inputSchema.properties.anchorText).toBeDefined()
    expect(browserTool.inputSchema.properties.verifyReload).toBeDefined()
    expect(browserTool.inputSchema.properties.probeOnly).toBeDefined()
    expect(browserTool.inputSchema.properties.siteHint).toBeDefined()
    expect(browserTool.inputSchema.properties.fields?.items?.properties?.nth).toBeDefined()
    expect(browserTool.inputSchema.properties.maxChars?.description).toContain('3000')
    expect(browserTool.inputSchema.properties.maxChars?.description).toContain('4500')
    expect(browserTool.inputSchema.properties.maxChars?.description).toContain('16000')
    expect(browserTool.inputSchema.properties.timeoutMs?.description).toContain('10000')

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        rejectExit(new Error(`MCP server did not exit on stdin EOF. stderr=${stderrBuf}`))
      }, 5_000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
      child.stdin.end()
    })

    expect(exitCode).toBe(0)
  }, 15_000)
})
