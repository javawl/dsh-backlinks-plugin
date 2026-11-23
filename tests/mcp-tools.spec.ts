import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CloudMailMailbox } from '../src/host/cloud-mail/provider.ts'
import { SupermanagerBatchSource } from '../src/host/supermanager/provider.ts'
import type {
  BacklinkBatchDetail,
  BacklinkBatchSourceProvider,
  MailboxProvider,
} from '../src/host/backlinks/types.ts'
import { BacklinksError } from '../src/host/backlinks/types.ts'
import { enrichStrictModeError, PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import type {
  BrowserAutomationProvider,
  BrowserCommand,
  BrowserResult,
  BrowserSession,
} from '../src/host/browser/types.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { BrowserSessionManager, createBrowserToolHandler } from '../src/mcp/browser-tool.ts'
import {
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_CLOUDMAIL_BASE_URL,
  DEFAULT_MAIL_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS_CLAMP,
  DEFAULT_NAVIGATE_MAX_CHARS,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  expandHomePath,
  redactSecrets,
  resolveMcpConfig,
} from '../src/mcp/config.ts'
import { STANDARD_BLOCKING_TAGS } from '../src/host/backlinks/standards.ts'

function parseToolPayload(result: { content: Array<{ type: string; text?: string }> }): {
  summary: string
  data: unknown
} {
  const text = result.content[0]?.text ?? ''
  const idx = text.indexOf('\n')
  if (idx < 0) return { summary: text, data: undefined }
  return {
    summary: text.slice(0, idx),
    data: JSON.parse(text.slice(idx + 1)) as unknown,
  }
}

function makeSampleDetail(): BacklinkBatchDetail {
  return {
    batch: {
      id: 42,
      name: 'Batch 42',
      websiteId: 7,
      websiteName: 'DemoSite',
      websiteHost: 'demo.example.com',
      plannedAt: '2026-11-20T00:00:00Z',
      counts: { pending: 2, executed: 1, skipped: 0, failed: 0, total: 3 },
      executing: false,
    },
    website: {
      id: 7,
      name: 'DemoSite',
      siteUrl: 'https://demo.example.com',
      siteHost: 'demo.example.com',
      shortDescription: 'Short pitch',
      longDescription: 'Long pitch for DemoSite',
      logoUrl: 'https://demo.example.com/logo.png',
      screenshotUrl: 'https://demo.example.com/shot.png',
      keyFeatures: 'Fast,Free',
      pricingType: 'Freemium',
    },
    anchors: [{ id: 1, anchorText: 'DemoSite', targetUrl: 'https://demo.example.com' }],
    items: [
      {
        id: 101,
        sourceId: 501,
        sourceName: 'DirOne',
        sourceUrl: 'https://dirone.example.org',
        sourceHost: 'dirone.example.org',
        submitUrl: 'https://dirone.example.org/submit',
        sourceNotes: 'A'.repeat(260),
        category: '导航站',
        tags: ['免徽章'],
        paymentType: 'free',
        linkType: 'dofollow',
        status: 'pending',
        failureMode: null,
        failureReason: null,
        publishedUrl: null,
        publishStatus: null,
        plannedAt: '2026-11-20T00:00:00Z',
      },
      {
        id: 102,
        sourceId: 502,
        sourceName: 'DirTwo',
        sourceUrl: 'https://dirtwo.example.org',
        sourceHost: 'dirtwo.example.org',
        submitUrl: null,
        sourceNotes: null,
        category: null,
        tags: [],
        paymentType: 'free',
        linkType: 'nofollow',
        status: 'executed',
        failureMode: null,
        failureReason: null,
        publishedUrl: 'https://dirtwo.example.org/demo',
        publishStatus: 'live',
        plannedAt: '2026-11-20T00:00:00Z',
      },
    ],
  }
}

describe('MCP config & cross-platform home path expansion', () => {
  it('expands ~ prefixes for both Windows and POSIX paths', () => {
    expect(expandHomePath('~', 'C:\\Users\\zlb', path.win32)).toBe('C:\\Users\\zlb')
    expect(expandHomePath('~/.dsh/backlink-browser-profile', 'C:\\Users\\zlb', path.win32))
      .toBe('C:\\Users\\zlb\\.dsh\\backlink-browser-profile')
    expect(expandHomePath('~\\.dsh\\backlink-browser-profile', 'C:\\Users\\zlb', path.win32))
      .toBe('C:\\Users\\zlb\\.dsh\\backlink-browser-profile')
    expect(expandHomePath('~/.dsh/backlink-browser-profile', '/Users/zlb', path.posix))
      .toBe('/Users/zlb/.dsh/backlink-browser-profile')
    expect(expandHomePath('C:\\Program Files\\Chrome\\profile', 'C:\\Users\\zlb', path.win32))
      .toBe('C:\\Program Files\\Chrome\\profile')
    expect(expandHomePath('~other/profile', '/Users/zlb', path.posix)).toBe('~other/profile')
  })

  it('resolves defaults (8000 snapshot / 16000 clamp / 3000 navigate / cloudmail URL / profile) and overrides', () => {
    const defaults = resolveMcpConfig({}, { homeDir: 'C:\\Users\\zlb', pathImpl: path.win32 })
    expect(defaults.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS)
    expect(defaults.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS_CLAMP)
    expect(defaults.snapshotMaxChars).toBe(DEFAULT_SNAPSHOT_MAX_CHARS)
    expect(defaults.snapshotMaxChars).toBe(8_000)
    expect(defaults.navigateMaxChars).toBe(DEFAULT_NAVIGATE_MAX_CHARS)
    expect(defaults.cloudMailBaseUrl).toBe(DEFAULT_CLOUDMAIL_BASE_URL)
    expect(defaults.browserProfileDir).toBe('C:\\Users\\zlb\\.dsh\\backlink-browser-profile')
    expect(defaults.browserHeadless).toBe(false)
    expect(defaults.browserChannel).toBe('chrome')
    expect(defaults.browserWindowPosition).toBeUndefined()

    const custom = resolveMcpConfig(
      {
        SUPERMANAGER_BASE_URL: 'https://sm.example.com',
        SUPERMANAGER_TOKEN: 'smag_secret_123',
        CLOUDMAIL_TOKEN: 'cm_secret_456',
        DSH_BACKLINK_BROWSER_PROFILE: '~/custom-chrome-profile',
        BACKLINKS_MAX_OUTPUT_CHARS: '12000',
        BACKLINKS_SNAPSHOT_MAX_CHARS: '6500',
        BACKLINKS_NAVIGATE_MAX_CHARS: '2500',
        BACKLINKS_BROWSER_WINDOW_POSITION: '-32000,-32000',
      },
      { homeDir: '/Users/zlb', pathImpl: path.posix },
    )
    expect(custom.browserProfileDir).toBe('/Users/zlb/custom-chrome-profile')
    expect(custom.maxOutputChars).toBe(12_000)
    expect(custom.snapshotMaxChars).toBe(6_500)
    expect(custom.navigateMaxChars).toBe(2_500)
    expect(custom.browserWindowPosition).toBe('-32000,-32000')
    expect(redactSecrets('failed with smag_secret_123 and cm_secret_456', custom))
      .toBe('failed with [REDACTED] and [REDACTED]')
  })
})

describe('MCP backlinks tool handler', () => {
  const baseConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_test_secret_token',
    CLOUDMAIL_TOKEN: '',
  })

  it('handles batch_get compact mode (default true) and full mode (compact=false)', async () => {
    const detail = makeSampleDetail()
    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async () => ({ leaseId: 9, leaseExpiresAt: '2026-11-20T01:00:00Z', items: detail.items }),
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-20T02:00:00Z' }),
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'executed', publishRecordId: 88 }),
      addBadge: async () => ({ backlinkId: 5, callbackTriggered: false }),
      tagSource: async (sourceId, names) => ({
        sourceId,
        attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })),
      }),
    }

    const handle = createBacklinksToolHandler({ config: baseConfig, batchSource })

    const compactRes = await handle({ action: 'batch_get', batchId: 42 })
    expect(compactRes.isError).toBeUndefined()
    const compactPayload = parseToolPayload(compactRes as never)
    expect(compactPayload.summary).toContain('(compact; pass compact=false for full)')
    const compactData = compactPayload.data as Record<string, unknown>
    expect(compactData.compact).toBe(true)
    expect(compactData.website).toEqual(detail.website)
    expect(compactData.anchors).toEqual(detail.anchors)
    expect(compactData.publishedSourceIds).toEqual([502])
    expect(compactData.totalItems).toBe(2)
    expect(compactData.pendingItems).toBe(1)
    expect(compactData.returnedItems).toBe(2)
    expect(compactData.hasMore).toBe(false)
    const items = compactData.items as Array<Record<string, unknown>>
    expect(items[0]?.plannedAt).toBeUndefined()
    expect(items[0]?.failureReason).toBeUndefined()
    expect(String(items[0]?.sourceNotes)).toHaveLength(201)
    expect(items[1]?.tags).toBeUndefined()
    expect(items[1]?.publishedUrl).toBe('https://dirtwo.example.org/demo')

    const fullRes = await handle({ action: 'batch_get', batchId: 42, compact: false })
    const fullPayload = parseToolPayload(fullRes as never)
    expect(fullPayload.summary).toContain('(full)')
    expect(fullPayload.data).toEqual(detail)
  })

  it('supports batch_list compact, onlyPending, and pagination defaults & overrides', async () => {
    const rawBatches = Array.from({ length: 28 }, (_, idx) => {
      const id = idx + 1
      const isPending = idx < 23
      return {
        id,
        name: `Batch ${id}`,
        websiteId: 100 + (id % 3),
        websiteName: `Site ${id % 3}`,
        websiteHost: `site${id % 3}.example.com`,
        plannedAt: '2026-11-20T00:00:00Z',
        counts: {
          pending: isPending ? 5 : 0,
          executed: isPending ? 0 : 10,
          skipped: idx === 0 ? 2 : 0,
          failed: 0,
          total: isPending ? 5 + (idx === 0 ? 2 : 0) : 10,
        },
        executing: idx === 1,
      }
    })

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => rawBatches,
      getBatch: async () => { throw new Error('unused') },
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => { throw new Error('unused') },
      addBadge: async () => { throw new Error('unused') },
      tagSource: async () => { throw new Error('unused') },
    }
    const handle = createBacklinksToolHandler({ config: baseConfig, batchSource })

    const defaultRes = await handle({ action: 'batch_list' })
    expect(defaultRes.isError).toBeUndefined()
    const defaultData = parseToolPayload(defaultRes as never).data as {
      total: number
      matched: number
      offset: number
      limit: number
      hasMore: boolean
      onlyPending: boolean
      compact: boolean
      batches: Array<Record<string, unknown>>
    }
    expect(defaultData).toMatchObject({
      total: 28,
      matched: 23,
      offset: 0,
      limit: 20,
      hasMore: true,
      onlyPending: true,
      compact: true,
    })
    expect(defaultData.batches).toHaveLength(20)
    expect(defaultData.batches[0]).toEqual({
      id: 1,
      name: 'Batch 1',
      websiteId: 101,
      websiteName: 'Site 1',
      websiteHost: 'site1.example.com',
      plannedAt: '2026-11-20T00:00:00Z',
      counts: { pending: 5, total: 7, skipped: 2 },
    })
    expect(defaultData.batches[1]).toMatchObject({ executing: true })

    const page2 = parseToolPayload(await handle({ action: 'batch_list', offset: 20, limit: 10 }) as never).data as {
      matched: number
      offset: number
      limit: number
      hasMore: boolean
      batches: Array<{ id: number }>
    }
    expect(page2).toMatchObject({ matched: 23, offset: 20, limit: 10, hasMore: false })
    expect(page2.batches.map(b => b.id)).toEqual([21, 22, 23])

    const allFull = parseToolPayload(await handle({
      action: 'batch_list',
      onlyPending: false,
      compact: false,
      limit: 200,
    }) as never).data as {
      total: number
      matched: number
      limit: number
      hasMore: boolean
      batches: unknown[]
    }
    expect(allFull).toMatchObject({ total: 28, matched: 28, limit: 100, hasMore: false })
    expect(allFull.batches).toEqual(rawBatches)

    const clampedMin = parseToolPayload(await handle({ action: 'batch_list', limit: 0 }) as never).data as {
      limit: number
      batches: unknown[]
    }
    expect(clampedMin.limit).toBe(1)
    expect(clampedMin.batches).toHaveLength(1)

    const badOffset = await handle({ action: 'batch_list', offset: -1 })
    expect(badOffset.isError).toBe(true)
    const badOnlyPending = await handle({ action: 'batch_list', onlyPending: 'false' })
    expect(badOnlyPending.isError).toBe(true)
  })

  it('batch_get pendingOnly and pagination always compute publishedSourceIds across the full batch', async () => {
    const baseDetail = makeSampleDetail()
    const fullDetail: BacklinkBatchDetail = {
      ...baseDetail,
      items: [
        {
          ...baseDetail.items[0]!,
          id: 201,
          sourceId: 502,
          sourceName: 'DupPendingSameSourceAsLive',
          status: 'pending',
          publishStatus: null,
          publishedUrl: null,
        },
        {
          ...baseDetail.items[1]!,
          id: 202,
          sourceId: 502,
          sourceName: 'AlreadyLiveSameSource',
          status: 'executed',
          publishStatus: 'live',
          publishedUrl: 'https://dirtwo.example.org/demo',
        },
        {
          ...baseDetail.items[0]!,
          id: 203,
          sourceId: 503,
          sourceName: 'PendingWithSubmittedRecord',
          status: 'pending',
          publishStatus: 'submitted',
          publishedUrl: null,
        },
        {
          ...baseDetail.items[0]!,
          id: 204,
          sourceId: 504,
          sourceName: 'CleanPendingTarget',
          status: 'pending',
          publishStatus: null,
          publishedUrl: null,
        },
      ],
    }

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [fullDetail.batch],
      getBatch: async () => fullDetail,
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => { throw new Error('unused') },
      addBadge: async () => { throw new Error('unused') },
      tagSource: async () => { throw new Error('unused') },
    }
    const handle = createBacklinksToolHandler({ config: baseConfig, batchSource })

    const pendingPage1 = parseToolPayload(await handle({
      action: 'batch_get',
      batchId: 42,
      pendingOnly: true,
      limit: 1,
      offset: 0,
    }) as never).data as {
      publishedSourceIds: number[]
      totalItems: number
      pendingItems: number
      returnedItems: number
      hasMore: boolean
      items: Array<{ id: number }>
    }
    expect(pendingPage1).toMatchObject({
      publishedSourceIds: [502, 503],
      totalItems: 4,
      pendingItems: 3,
      returnedItems: 1,
      hasMore: true,
    })
    expect(pendingPage1.items.map(item => item.id)).toEqual([201])

    const pendingPage2 = parseToolPayload(await handle({
      action: 'batch_get',
      batchId: 42,
      pendingOnly: true,
      compact: false,
      limit: 2,
      offset: 1,
    }) as never).data as {
      publishedSourceIds: number[]
      totalItems: number
      pendingItems: number
      returnedItems: number
      hasMore: boolean
      items: Array<{ id: number; plannedAt?: string }>
    }
    expect(pendingPage2).toMatchObject({
      publishedSourceIds: [502, 503],
      totalItems: 4,
      pendingItems: 3,
      returnedItems: 2,
      hasMore: false,
    })
    expect(pendingPage2.items.map(item => item.id)).toEqual([203, 204])
    expect(pendingPage2.items[0]?.plannedAt).toBe('2026-11-20T00:00:00Z')
  })

  it('supports badge_verify with refreshUrl, retries, and requires no tokens', async () => {
    const unauthConfig = resolveMcpConfig({})
    const calls: string[] = []
    let homeAttempts = 0

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/footer/refresh')) {
        return new Response('refreshed', { status: 200 })
      }
      homeAttempts++
      const html = homeAttempts === 1
        ? '<html><body><footer>empty</footer></body></html>'
        : '<html><body><footer><a href="https://partner.example.org">Partner</a></footer></body></html>'
      return new Response(html, { status: 200 })
    }) as unknown as typeof fetch

    const handle = createBacklinksToolHandler({
      config: unauthConfig,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })

    const res = await handle({
      action: 'badge_verify',
      siteUrl: 'https://demo.example.com/',
      expectedTarget: 'partner.example.org',
      refreshUrl: 'https://demo.example.com/footer/refresh',
      retries: 3,
      retryDelayMs: 10,
    })

    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([
      'https://demo.example.com/footer/refresh',
      'https://demo.example.com/',
      'https://demo.example.com/',
    ])
    const { data } = parseToolPayload(res as never)
    expect(data).toMatchObject({
      verified: true,
      attempts: 2,
      httpStatus: 200,
      refresh: { triggered: true, ok: true, status: 200 },
    })
    expect((data as { matchedSnippet: string }).matchedSnippet).toContain('partner.example.org')

    const missFetch = vi.fn(async () => new Response('<html>no badge</html>', { status: 200 })) as unknown as typeof fetch
    const missHandle = createBacklinksToolHandler({
      config: unauthConfig,
      fetchImpl: missFetch,
      sleepImpl: async () => {},
    })
    const missRes = await missHandle({
      action: 'badge_verify',
      siteUrl: 'https://demo.example.com/',
      expectedTarget: 'missing.example.org',
      retries: 2,
      retryDelayMs: 0,
    })
    expect(missRes.isError).toBeUndefined()
    expect(parseToolPayload(missRes as never).data).toMatchObject({
      verified: false,
      attempts: 2,
      httpStatus: 200,
    })
  })

  it('enforces lazy auth checks and never leaks tokens in error messages', async () => {
    const noCloudMailConfig = resolveMcpConfig({
      SUPERMANAGER_BASE_URL: 'https://sm.example.com',
      SUPERMANAGER_TOKEN: 'smag_top_secret_999',
      CLOUDMAIL_TOKEN: '',
    })

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => {
        throw new BacklinksError('denied for smag_top_secret_999', 'BACKLINKS_UNAUTHORIZED')
      },
      getBatch: async () => { throw new Error('unused') },
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => { throw new Error('unused') },
      addBadge: async () => { throw new Error('unused') },
      tagSource: async () => { throw new Error('unused') },
    }
    const mailbox: MailboxProvider = {
      id: 'mock-mail',
      available: () => false,
      createMailbox: async () => ({ email: 'a@screwdom.org' }),
      pollMail: async () => null,
    }

    const handle = createBacklinksToolHandler({ config: noCloudMailConfig, batchSource, mailbox })

    const mailErr = await handle({ action: 'mailbox_create', localPart: 'demo1', domain: 'screwdom.org' })
    expect(mailErr.isError).toBe(true)
    expect(mailErr.content[0]?.text).toContain('CLOUDMAIL_TOKEN')
    expect(mailErr.content[0]?.text).toContain('Supermanager actions remain usable')

    const smErr = await handle({ action: 'batch_list' })
    expect(smErr.isError).toBe(true)
    expect(smErr.content[0]?.text).not.toContain('smag_top_secret_999')
    expect(smErr.content[0]?.text).toContain('[REDACTED]')

    const placeholderCfg = resolveMcpConfig({
      SUPERMANAGER_BASE_URL: '<YOUR_SUPERMANAGER_BASE_URL>',
      SUPERMANAGER_TOKEN: '<YOUR_SUPERMANAGER_AGENT_TOKEN>',
    })
    const placeholderHandle = createBacklinksToolHandler({ config: placeholderCfg })
    const placeholderErr = await placeholderHandle({ action: 'batch_list' })
    expect(placeholderErr.isError).toBe(true)
    expect(placeholderErr.content[0]?.text).toContain('SUPERMANAGER_BASE_URL')
  })

  it('preserves Supermanager Bearer and Cloud-mail raw authorization header contracts', async () => {
    const recordedHeaders: Array<{ url: string; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      recordedHeaders.push({ url: String(input), auth: headers.get('authorization') })
      if (String(input).includes('/api/agent/batches')) {
        return new Response(JSON.stringify({ batches: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const cfg = resolveMcpConfig({
        SUPERMANAGER_BASE_URL: 'https://sm.example.com',
        SUPERMANAGER_TOKEN: 'smag_abc',
        CLOUDMAIL_BASE_URL: 'https://mail.screwdom.org/api',
        CLOUDMAIL_TOKEN: 'cm_raw_xyz',
      })
      const handle = createBacklinksToolHandler({
        config: cfg,
        batchSource: new SupermanagerBatchSource(() => ({
          baseUrl: cfg.supermanagerBaseUrl,
          token: cfg.supermanagerToken,
          requestTimeoutMs: cfg.supermanagerTimeoutMs,
        })),
        mailbox: new CloudMailMailbox(() => ({
          baseUrl: cfg.cloudMailBaseUrl,
          token: cfg.cloudMailToken,
          requestTimeoutMs: cfg.cloudMailTimeoutMs,
        })),
      })

      await handle({ action: 'batch_list' })
      await handle({ action: 'mailbox_create', localPart: 'user1', domain: 'screwdom.org' })

      expect(recordedHeaders).toEqual([
        { url: 'https://sm.example.com/api/agent/batches', auth: 'Bearer smag_abc' },
        { url: 'https://mail.screwdom.org/api/public/addUser', auth: 'cm_raw_xyz' },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('MCP browser tool handler', () => {
  function createMockManager(
    actImpl: (command: BrowserCommand, callIndex: number) => Promise<BrowserResult> | BrowserResult,
  ): { manager: BrowserSessionManager; commands: BrowserCommand[]; closed: () => boolean } {
    const commands: BrowserCommand[] = []
    let sessionClosed = false
    const provider: BrowserAutomationProvider = {
      id: 'mock-browser',
      available: () => true,
      open: async (): Promise<BrowserSession> => ({
        act: async (cmd) => {
          commands.push(cmd)
          return await actImpl(cmd, commands.length)
        },
        close: async () => {
          sessionClosed = true
        },
      }),
    }
    return {
      manager: new BrowserSessionManager(provider),
      commands,
      closed: () => sessionClosed,
    }
  }

  it('caps navigate at 3000 chars, snapshot default at 8000 chars, and respects explicit maxChars up to 16000 clamp', async () => {
    const longText = 'X'.repeat(20_000)
    const { manager, commands } = createMockManager(async (cmd) => ({
      kind: 'page',
      page: cmd.page ?? 'p1',
      url: 'https://example.org',
      title: 'Example',
      text: longText,
      truncated: false,
    }))

    const config = resolveMcpConfig({})
    const handle = createBrowserToolHandler({ sessionManager: manager, config })

    const nav = await handle({ action: 'navigate', url: 'https://example.org' })
    expect(commands[0]).toMatchObject({ kind: 'navigate', maxChars: 3_000 })
    const navText = nav.content[0]?.type === 'text' ? nav.content[0].text : ''
    expect(navText).toContain('… (truncated)')
    expect(navText.length).toBeLessThan(3_200)

    const snap = await handle({ action: 'snapshot', format: 'aria' })
    expect(commands[1]).toMatchObject({ kind: 'snapshot', maxChars: 8_000 })
    const snapText = snap.content[0]?.type === 'text' ? snap.content[0].text : ''
    expect(snapText).toContain('… (truncated)')
    expect(snapText.length).toBeLessThan(8_200)

    const snap16k = await handle({ action: 'snapshot', format: 'aria', maxChars: 16_000 })
    expect(commands[2]).toMatchObject({ kind: 'snapshot', maxChars: 16_000 })
    const snap16kText = snap16k.content[0]?.type === 'text' ? snap16k.content[0].text : ''
    expect(snap16kText.length).toBeGreaterThan(15_900)
    expect(snap16kText.length).toBeLessThan(16_200)

    const snapClamped = await handle({ action: 'snapshot', format: 'aria', maxChars: 30_000 })
    expect(commands[3]).toMatchObject({ kind: 'snapshot', maxChars: 16_000 })
    expect((snapClamped.content[0]?.type === 'text' ? snapClamped.content[0].text : '').length).toBeLessThan(16_200)

    const tightHandle = createBrowserToolHandler({
      sessionManager: manager,
      config: resolveMcpConfig({ BACKLINKS_MAX_OUTPUT_CHARS: '6000' }),
    })
    await tightHandle({ action: 'snapshot', format: 'aria' })
    await tightHandle({ action: 'snapshot', format: 'aria', maxChars: 16_000 })
    expect(commands[4]).toMatchObject({ kind: 'snapshot', maxChars: 6_000 })
    expect(commands[5]).toMatchObject({ kind: 'snapshot', maxChars: 6_000 })
  })

  it('forwards nth on single actions and fields[].nth / submitNth on batch_fill', async () => {
    const { manager, commands } = createMockManager(async () => ({ kind: 'acked' }))
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    await handle({ action: 'click', selector: 'text:Submit', nth: 0 })
    await handle({ action: 'fill', selector: 'label:Email', value: 'a@example.org', nth: 1 })
    await handle({ action: 'select', selector: 'label:Category', value: 'tools', nth: 2 })
    await handle({ action: 'upload', selector: 'input[type=file]', files: ['/tmp/logo.png'], nth: 0 })
    await handle({ action: 'waitFor', selector: 'text:Done', nth: 3 })
    await handle({
      action: 'batch_fill',
      page: 'p3',
      fields: [
        { target: 'label:Name', value: 'Tool', nth: 1 },
        { target: 'label:Agree', op: 'check', nth: 0 },
      ],
      submitTarget: 'role:button|Submit',
      submitNth: 2,
    })

    expect(commands).toEqual([
      { kind: 'click', selector: 'text:Submit', nth: 0 },
      { kind: 'fill', selector: 'label:Email', value: 'a@example.org', nth: 1 },
      { kind: 'select', selector: 'label:Category', value: 'tools', nth: 2 },
      { kind: 'upload', selector: 'input[type=file]', files: ['/tmp/logo.png'], nth: 0 },
      { kind: 'waitFor', selector: 'text:Done', nth: 3 },
      { kind: 'fill', page: 'p3', selector: 'label:Name', value: 'Tool', nth: 1 },
      { kind: 'check', page: 'p3', selector: 'label:Agree', nth: 0 },
      { kind: 'click', page: 'p3', selector: 'role:button|Submit', nth: 2 },
    ])

    const badNth = await handle({ action: 'click', selector: 'text:Submit', nth: -1 })
    expect(badNth.isError).toBe(true)
    const badSubmitNth = await handle({
      action: 'batch_fill',
      fields: [{ target: 'label:Name', value: 'Demo' }],
      submitTarget: 'role:button|Submit',
      submitNth: true,
    })
    expect(badSubmitNth.isError).toBe(true)
  })

  it('executes batch_fill serially and skips submitTarget when any field fails', async () => {
    const { manager, commands } = createMockManager(async (cmd) => {
      if (cmd.kind === 'fill' && cmd.selector === 'label:Broken') {
        throw new Error('element not found')
      }
      return { kind: 'acked' }
    })
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    const okRes = await handle({
      action: 'batch_fill',
      page: 'p2',
      fields: [
        { target: 'label:Title', value: 'Demo Tool' },
        { target: 'label:Pricing', value: 'free', op: 'select' },
        { target: 'label:Terms', op: 'check' },
      ],
      submitTarget: 'role:button|Submit',
    })
    expect(okRes.isError).toBeUndefined()
    expect(commands).toEqual([
      { kind: 'fill', page: 'p2', selector: 'label:Title', value: 'Demo Tool' },
      { kind: 'select', page: 'p2', selector: 'label:Pricing', value: 'free' },
      { kind: 'check', page: 'p2', selector: 'label:Terms' },
      { kind: 'click', page: 'p2', selector: 'role:button|Submit' },
    ])
    expect(parseToolPayload(okRes as never).data).toMatchObject({
      total: 3,
      succeeded: 3,
      failed: 0,
      submit: { attempted: true, ok: true },
    })

    commands.length = 0
    const failRes = await handle({
      action: 'batch_fill',
      fields: [
        { target: 'label:Title', value: 'Demo' },
        { target: 'label:Broken', value: 'oops' },
        { target: 'label:After', value: 'skip-if-stop', op: 'fill' },
      ],
      submitTarget: 'role:button|Submit',
      stopOnError: true,
    })
    expect(commands).toHaveLength(2)
    expect(parseToolPayload(failRes as never).data).toMatchObject({
      total: 3,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      submit: { attempted: false, ok: false, skippedReason: 'skipped because one or more fields failed' },
    })
  })

  it('waits for login inside wait_for_login, bringing window to front only when needed', async () => {
    let probes = 0
    const { manager, commands } = createMockManager(async (cmd) => {
      if (cmd.kind === 'probe') {
        probes++
        if (probes === 1) {
          return { kind: 'probe', page: 'p1', url: 'https://accounts.google.com/v3/signin', title: 'Sign in', selectorVisible: false }
        }
        if (probes === 2) {
          throw new Error('Execution context was destroyed during navigation')
        }
        return { kind: 'probe', page: 'p1', url: 'https://myaccount.google.com/', title: 'Google Account', selectorVisible: true }
      }
      return { kind: 'acked' }
    })

    const handle = createBrowserToolHandler({
      sessionManager: manager,
      config: resolveMcpConfig({}),
      sleepImpl: async () => {},
    })

    const res = await handle({
      action: 'wait_for_login',
      urlContains: 'myaccount.google.com',
      urlNotContains: 'signin',
      selector: 'img[alt*="Account"]',
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    })

    expect(res.isError).toBeUndefined()
    expect(commands.filter(cmd => cmd.kind === 'bringToFront')).toHaveLength(1)
    expect(parseToolPayload(res as never).data).toMatchObject({
      loggedIn: true,
      url: 'https://myaccount.google.com/',
      polls: 3,
    })

    // Already logged in on poll #1 -> does not call bringToFront.
    commands.length = 0
    probes = 0
    const immediateMgr = createMockManager(async () => ({
      kind: 'probe',
      page: 'p1',
      url: 'https://myaccount.google.com/',
      title: 'Google Account',
    }))
    const immediateHandle = createBrowserToolHandler({
      sessionManager: immediateMgr.manager,
      config: resolveMcpConfig({}),
      sleepImpl: async () => {},
    })
    const immediateRes = await immediateHandle({
      action: 'wait_for_login',
      urlContains: 'myaccount.google.com',
    })
    expect(immediateMgr.commands.filter(c => c.kind === 'bringToFront')).toHaveLength(0)
    expect(parseToolPayload(immediateRes as never).data).toMatchObject({ loggedIn: true, polls: 1 })
  })

  it('returns MCP image block on screenshot and closes browser on closeBrowser', async () => {
    const { manager, closed } = createMockManager(async () => ({
      kind: 'screenshot',
      pngBase64: 'iVBORw0KGgo=',
    }))
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    const shot = await handle({ action: 'screenshot' })
    expect(shot.content).toHaveLength(2)
    expect(shot.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })

    const closeRes = await handle({ action: 'closeBrowser' })
    expect(closeRes.content[0]?.text).toBe('ok')
    expect(closed()).toBe(true)
  })
})

describe('PlaywrightSession nth selection and strict mode diagnostics', () => {
  interface FakeNode {
    readonly tagName: string
    readonly textContent?: string
    readonly innerText?: string
    readonly attrs?: Record<string, string>
    readonly visible?: boolean
  }

  function createMockPlaywrightSession(options: {
    readonly nodes?: readonly FakeNode[]
    readonly clickError?: Error
    readonly countThrows?: boolean
    readonly stallEvaluateMs?: number
  }) {
    const calls: string[] = []
    const nodes = options.nodes ?? []

    const makeNthLocator = (index: number) => ({
      click: vi.fn(async () => {
        calls.push(`nth(${index}).click`)
      }),
      fill: vi.fn(async (value: string) => {
        calls.push(`nth(${index}).fill(${value})`)
      }),
      selectOption: vi.fn(async (value: string) => {
        calls.push(`nth(${index}).select(${value})`)
      }),
      check: vi.fn(async () => {
        calls.push(`nth(${index}).check`)
      }),
      waitFor: vi.fn(async () => {
        calls.push(`nth(${index}).waitFor`)
      }),
      isVisible: vi.fn(async () => nodes[index]?.visible ?? true),
      evaluate: vi.fn(async (fn: (node: unknown) => unknown) => {
        if (options.stallEvaluateMs !== undefined) {
          await new Promise(resolve => setTimeout(resolve, options.stallEvaluateMs))
        }
        const raw = nodes[index]
        if (!raw) return { tag: 'unknown' }
        const fakeEl = {
          tagName: raw.tagName,
          textContent: raw.textContent ?? null,
          innerText: raw.innerText,
          getAttribute: (key: string) => raw.attrs?.[key] ?? null,
        }
        return fn(fakeEl)
      }),
    })

    const rootLocator = {
      nth: vi.fn((index: number) => makeNthLocator(index)),
      count: vi.fn(async () => {
        if (options.countThrows) throw new Error('count exploded')
        return nodes.length
      }),
      click: vi.fn(async () => {
        if (options.clickError) throw options.clickError
        calls.push('root.click')
      }),
      fill: vi.fn(async () => {}),
      selectOption: vi.fn(async () => {}),
      check: vi.fn(async () => {}),
      setInputFiles: vi.fn(async () => {}),
      waitFor: vi.fn(async () => {}),
    }

    const mockPage = {
      isClosed: () => false,
      on: () => mockPage,
      getByText: vi.fn(() => rootLocator),
      getByRole: vi.fn(() => rootLocator),
      getByLabel: vi.fn(() => rootLocator),
      getByPlaceholder: vi.fn(() => rootLocator),
      locator: vi.fn(() => rootLocator),
    }

    const mockContext = {
      on: () => mockContext,
      pages: () => [mockPage],
      close: async () => {},
    }

    return {
      session: new PlaywrightSession(mockContext as never, 5_000, 8_000),
      calls,
      rootLocator,
    }
  }

  it('applies .nth(nth) before click, fill, select, check, and waitFor', async () => {
    const { session, calls, rootLocator } = createMockPlaywrightSession({})

    await session.act({ kind: 'click', selector: 'text:Submit', nth: 2 })
    await session.act({ kind: 'fill', selector: 'label:Email', value: 'user@example.com', nth: 1 })
    await session.act({ kind: 'select', selector: 'label:Category', value: 'ai', nth: 0 })
    await session.act({ kind: 'check', selector: 'label:Agree', nth: 1 })
    await session.act({ kind: 'waitFor', selector: 'text:Done', nth: 3 })

    expect(rootLocator.nth).toHaveBeenCalledWith(2)
    expect(calls).toEqual([
      'nth(2).click',
      'nth(1).fill(user@example.com)',
      'nth(0).select(ai)',
      'nth(1).check',
      'nth(3).waitFor',
    ])
  })

  it('enriches strict mode violation errors with up to 5 candidate elements and exact selector hints', async () => {
    const nodes: FakeNode[] = Array.from({ length: 7 }, (_, i) => ({
      tagName: i === 0 ? 'SPAN' : 'BUTTON',
      innerText: i === 0 ? 'Submit info' : i === 1 ? 'Submit' : `Submit #${i}`,
      attrs: {
        ...(i === 1 ? { type: 'submit', 'aria-label': 'Submit tool', name: 'submitBtn' } : {}),
        ...(i === 2 ? { role: 'button' } : {}),
      },
      visible: i !== 0,
    }))
    const { session } = createMockPlaywrightSession({
      nodes,
      clickError: new Error("locator.click: Error: strict mode violation: getByText('Submit') resolved to 7 elements"),
    })

    let caught: unknown
    try {
      await session.act({ kind: 'click', selector: 'text:Submit' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('strict mode violation')
    expect(msg).toContain('Matched 7 element(s) (showing first 5):')
    expect(msg).toContain('[0] <span> text="Submit info" visible=false')
    expect(msg).toContain('[1] <button> role=button type=submit text="Submit" aria-label="Submit tool" name="submitBtn" visible=true')
    expect(msg).toContain('[4] <button>')
    expect(msg).not.toContain('[5]')
    expect(msg).toContain('nth: 1')
    expect(msg).toContain('role:button|Submit tool')
  })

  it('never masks the original strict mode error when candidate inspection fails or times out', async () => {
    const throwingSession = createMockPlaywrightSession({
      countThrows: true,
      clickError: new Error('strict mode violation: resolved to 2 elements'),
    }).session

    await expect(throwingSession.act({ kind: 'click', selector: 'text:Sign in' })).rejects.toThrow(
      /strict mode violation: resolved to 2 elements[\s\S]*Hint: pass nth: <i>/,
    )

    const { rootLocator } = createMockPlaywrightSession({
      nodes: [{ tagName: 'BUTTON', innerText: 'Submit' }],
      stallEvaluateMs: 500,
    })
    const timedOut = await enrichStrictModeError(
      'click',
      rootLocator as never,
      new Error('strict mode violation: resolved to 1 elements'),
      25,
    )
    expect(timedOut?.message).toContain('strict mode violation: resolved to 1 elements')
    expect(timedOut?.message).toContain('Hint: pass nth: <i>')
  })
})

describe('Tightened timeouts & defaults (browser 10s, mail_wait 30s)', () => {
  it('defaults browserTimeoutMs to 10000 and mailWaitTimeoutMs to 30000 with env overrides', () => {
    const defaults = resolveMcpConfig({})
    expect(DEFAULT_BROWSER_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_MAIL_WAIT_TIMEOUT_MS).toBe(30_000)
    expect(defaults.browserTimeoutMs).toBe(10_000)
    expect(defaults.mailWaitTimeoutMs).toBe(30_000)

    const custom = resolveMcpConfig({
      BACKLINKS_BROWSER_TIMEOUT_MS: '8000',
      BACKLINKS_MAIL_WAIT_TIMEOUT_MS: '25000',
    })
    expect(custom.browserTimeoutMs).toBe(8_000)
    expect(custom.mailWaitTimeoutMs).toBe(25_000)
  })

  it('forwards per-call navigate timeoutMs through browser tool and PlaywrightSession', async () => {
    const commands: BrowserCommand[] = []
    const handle = createBrowserToolHandler({
      config: resolveMcpConfig({}),
      sessionManager: new BrowserSessionManager({
        id: 'mock',
        available: () => true,
        open: async () => ({
          act: async (cmd) => {
            commands.push(cmd)
            return {
              kind: 'page',
              page: cmd.page ?? 'p1',
              url: 'https://example.org',
              title: 'Example',
              text: 'ok',
              truncated: false,
            }
          },
          close: async () => {},
        }),
      }),
    })

    await handle({ action: 'navigate', url: 'https://example.org', timeoutMs: 8_000 })
    expect(commands[0]).toMatchObject({ kind: 'navigate', url: 'https://example.org/', timeoutMs: 8_000 })

    const gotoCalls: Array<{ url: string; timeout?: number }> = []
    const mockPage = {
      isClosed: () => false,
      on: () => mockPage,
      goto: vi.fn(async (url: string, opts?: { timeout?: number }) => {
        gotoCalls.push({ url, timeout: opts?.timeout })
      }),
      url: () => 'https://example.org/',
      title: async () => 'Example',
      innerText: async () => 'Hello',
    }
    const mockContext = {
      on: () => mockContext,
      pages: () => [mockPage],
      close: async () => {},
    }
    const session = new PlaywrightSession(mockContext as never, 10_000, 8_000)
    await session.act({ kind: 'navigate', url: 'https://example.org/' })
    await session.act({ kind: 'navigate', url: 'https://slow.example.org/', timeoutMs: 8_000 })
    expect(gotoCalls).toEqual([
      { url: 'https://example.org/', timeout: 10_000 },
      { url: 'https://slow.example.org/', timeout: 8_000 },
    ])
  })

  it('uses 30000ms default timeout and 3000ms poll interval in mail_wait', async () => {
    const pollCalls: Array<{ timeoutMs: number; intervalMs: number }> = []
    const mailbox: MailboxProvider = {
      id: 'mock-mail',
      available: () => true,
      createMailbox: async () => ({ email: 'test@screwdom.org' }),
      pollMail: async (_addr, opts) => {
        pollCalls.push({ timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs })
        return null
      },
    }
    const handle = createBacklinksToolHandler({
      config: resolveMcpConfig({
        SUPERMANAGER_BASE_URL: 'https://sm.example.com',
        SUPERMANAGER_TOKEN: 'smag_test',
        CLOUDMAIL_TOKEN: 'cm_test',
      }),
      mailbox,
    })

    const defaultWait = await handle({ action: 'mail_wait', mailEmail: 'test@screwdom.org' })
    expect(defaultWait.isError).toBeUndefined()
    await handle({ action: 'mail_wait', mailEmail: 'test@screwdom.org', waitTimeoutMs: 45_000 })
    expect(pollCalls).toEqual([
      { timeoutMs: 30_000, intervalMs: 3_000 },
      { timeoutMs: 45_000, intervalMs: 3_000 },
    ])
  })
})

describe('batch_preflight HTTP probes, blocking tag filtering & autoSkip', () => {
  const smConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_secret',
  })

  function makePreflightItem(
    id: number,
    sourceId: number,
    host: string,
    overrides: Partial<BacklinkBatchDetail['items'][number]> = {},
  ): BacklinkBatchDetail['items'][number] {
    return {
      id,
      sourceId,
      sourceName: `Site ${id}`,
      sourceUrl: `https://${host}`,
      sourceHost: host,
      submitUrl: `https://${host}/submit`,
      sourceNotes: null,
      category: '导航站',
      tags: [],
      paymentType: 'free',
      linkType: 'dofollow',
      status: 'pending',
      failureMode: null,
      failureReason: null,
      publishedUrl: null,
      publishStatus: null,
      plannedAt: '2026-11-23T00:00:00Z',
      ...overrides,
    }
  }

  it('classifies HTTP 404/410/5xx/DNS/TLS/paused/WAF-403/timeout, respects concurrency, and autoSkips only dead sites', async () => {
    const detail: BacklinkBatchDetail = {
      ...makeSampleDetail(),
      batch: { ...makeSampleDetail().batch, id: 99, name: 'Preflight Batch' },
      items: [
        makePreflightItem(1, 1001, 'alive.example.org', { tags: ['has_captcha'] }),
        makePreflightItem(2, 1002, 'notfound.example.org'),
        makePreflightItem(3, 1003, 'gone.example.org'),
        makePreflightItem(4, 1004, 'err503.example.org'),
        makePreflightItem(5, 1005, 'flaky503.example.org'),
        makePreflightItem(6, 1006, 'dnsdead.example.org'),
        makePreflightItem(7, 1007, 'tlsdead.example.org'),
        makePreflightItem(8, 1008, 'refused.example.org'),
        makePreflightItem(9, 1009, 'vercel-paused.example.org'),
        makePreflightItem(10, 1010, 'cpanel-suspended.example.org'),
        makePreflightItem(11, 1011, 'forsale.example.org'),
        makePreflightItem(12, 1012, 'cloudfront403.example.org'),
        makePreflightItem(13, 1013, 'slowtimeout.example.org'),
        makePreflightItem(14, 1014, 'ratelimit429.example.org'),
        makePreflightItem(15, 1015, 'published.example.org', { status: 'executed', publishStatus: 'live', publishedUrl: 'https://published.example.org/p' }),
        makePreflightItem(16, 1015, 'dupsource.example.org'),
      ],
    }

    let inFlight = 0
    let maxInFlight = 0
    let flakyAttempts = 0
    const probedUrls: string[] = []

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      probedUrls.push(url)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise(resolve => setTimeout(resolve, 5))
        if (url.includes('notfound.example.org')) return new Response('not found', { status: 404 })
        if (url.includes('gone.example.org')) return new Response('gone', { status: 410 })
        if (url.includes('err503.example.org')) return new Response('down', { status: 503 })
        if (url.includes('flaky503.example.org')) {
          flakyAttempts++
          return flakyAttempts === 1
            ? new Response('warm up', { status: 503 })
            : new Response('<html><title>Submit</title></html>', { status: 200, headers: { 'content-type': 'text/html' } })
        }
        if (url.includes('dnsdead.example.org')) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND dnsdead.example.org'), { code: 'ENOTFOUND' }),
          })
        }
        if (url.includes('tlsdead.example.org')) {
          throw new TypeError('fetch failed', {
            cause: new Error('ERR_SSL_VERSION_OR_CIPHER_MISMATCH'),
          })
        }
        if (url.includes('refused.example.org')) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          })
        }
        if (url.includes('vercel-paused.example.org')) {
          return new Response('<html><body>Vercel Deployment Paused</body></html>', {
            status: 402,
            headers: { 'content-type': 'text/html', 'x-vercel-error': 'DEPLOYMENT_PAUSED' },
          })
        }
        if (url.includes('cpanel-suspended.example.org')) {
          const resp = new Response('<html><h1>Account Suspended</h1></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
          Object.defineProperty(resp, 'url', { value: 'https://cpanel-suspended.example.org/cgi-sys/suspendedpage.cgi' })
          return resp
        }
        if (url.includes('forsale.example.org')) {
          return new Response('<html><title>Domain for Sale</title><body>Buy this domain</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        }
        if (url.includes('cloudfront403.example.org')) {
          return new Response('<html>Generated by cloudfront (CloudFront) Request blocked.</html>', {
            status: 403,
            headers: { 'content-type': 'text/html', 'x-amz-cf-id': 'abc123' },
          })
        }
        if (url.includes('slowtimeout.example.org')) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'))
            }, { once: true })
          })
        }
        if (url.includes('ratelimit429.example.org')) {
          return new Response('too many requests', { status: 429 })
        }
        return new Response('<html><body>Submit your site</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      } finally {
        inFlight--
      }
    }) as unknown as typeof fetch

    const reportedSkips: Array<{ itemId: number; skipReason: string }> = []
    const taggedSources: Array<{ sourceId: number; names: readonly string[] }> = []
    const claimedCalls: number[][] = []
    const releasedLeases: number[] = []
    let requireLeaseOnDirectSkip = false

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async (_batchId, itemIds) => {
        const ids = [...(itemIds ?? [])]
        claimedCalls.push(ids)
        return {
          leaseId: 777,
          leaseExpiresAt: '2026-11-23T01:00:00Z',
          items: detail.items.filter(item => ids.includes(item.id)),
        }
      },
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-23T02:00:00Z' }),
      release: async (leaseId) => { releasedLeases.push(leaseId) },
      reportItemResult: async (itemId, res) => {
        if (requireLeaseOnDirectSkip && claimedCalls.length === 0) {
          throw new BacklinksError('item must be claimed under an active lease', 'BACKLINKS_CONFLICT')
        }
        if (res.status === 'skipped') {
          reportedSkips.push({ itemId, skipReason: res.skipReason })
        }
        return { itemStatus: 'skipped', publishRecordId: null }
      },
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId, names) => {
        taggedSources.push({ sourceId, names })
        return { sourceId, attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })) }
      },
    }

    const handle = createBacklinksToolHandler({
      config: smConfig,
      batchSource,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })

    // 1. Default autoSkip=false does not mutate Supermanager.
    const dryRes = await handle({
      action: 'batch_preflight',
      batchId: 99,
      concurrency: 3,
      timeoutMs: 1_000,
    })
    expect(dryRes.isError).toBeUndefined()
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(reportedSkips).toHaveLength(0)
    expect(taggedSources).toHaveLength(0)
    expect(probedUrls.some(u => u.includes('dupsource'))).toBe(false)

    const dryData = parseToolPayload(dryRes as never).data as {
      counts: Record<string, number>
      runnableItemIds: number[]
      cautionItems: Array<{ id: number; tags: string[] }>
      deadItems: Array<{ id: number; reason: string }>
      wafBlocked: Array<{ id: number; provider: string }>
      retryableItems: Array<{ id: number; reason: string }>
      alreadyPublishedItemIds: number[]
    }
    expect(dryData.counts).toMatchObject({
      runnable: 2,
      dead: 9,
      wafBlocked: 1,
      retryable: 2,
      alreadyPublished: 1,
      autoSkipped: 0,
    })
    expect(dryData.runnableItemIds).toEqual([1, 5])
    expect(dryData.cautionItems).toEqual([{ id: 1, sourceId: 1001, host: 'alive.example.org', tags: ['has_captcha'] }])
    expect(dryData.deadItems.map(d => [d.id, d.reason])).toEqual([
      [2, 'http_404'],
      [3, 'http_410'],
      [4, 'http_5xx_persistent'],
      [6, 'dns_error'],
      [7, 'tls_error'],
      [8, 'connection_error'],
      [9, 'parked_or_suspended'],
      [10, 'parked_or_suspended'],
      [11, 'parked_or_suspended'],
    ])
    expect(dryData.wafBlocked).toEqual([
      { id: 12, sourceId: 1012, host: 'cloudfront403.example.org', url: 'https://cloudfront403.example.org/submit', httpStatus: 403, provider: 'cloudfront' },
    ])
    expect(dryData.retryableItems.map(r => [r.id, r.reason])).toEqual([
      [13, 'timeout'],
      [14, 'http_429'],
    ])
    expect(dryData.alreadyPublishedItemIds).toEqual([16])

    // 2. autoSkip=true with lease-required fallback skips & tags dead_site ONLY for dead items (never WAF 403 or retryable).
    flakyAttempts = 0
    requireLeaseOnDirectSkip = true
    const autoRes = await handle({
      action: 'batch_preflight',
      batchId: 99,
      autoSkip: true,
      timeoutMs: 1_000,
    })
    expect(autoRes.isError).toBeUndefined()
    expect(claimedCalls).toEqual([[2, 3, 4, 6, 7, 8, 9, 10, 11]])
    expect(releasedLeases).toEqual([777])
    expect(reportedSkips.map(s => s.itemId)).toEqual([2, 3, 4, 6, 7, 8, 9, 10, 11])
    expect(taggedSources.map(t => t.sourceId)).toEqual([1002, 1003, 1004, 1006, 1007, 1008, 1009, 1010, 1011])
    expect(taggedSources.every(t => t.names.includes('dead_site'))).toBe(true)
  })

  it('filters standard blocking tags zero-HTTP (including legacy aliases) and supports autoSkipTagged', async () => {
    expect(STANDARD_BLOCKING_TAGS).toEqual([
      'paid_only',
      'no_form',
      'dead_site',
      'has_captcha',
      'waf_403',
      'submitmatic_verify_fail',
      'comments_closed',
    ])

    const detail: BacklinkBatchDetail = {
      ...makeSampleDetail(),
      batch: { ...makeSampleDetail().batch, id: 100, name: 'Tag Filter Batch' },
      items: [
        makePreflightItem(1, 2001, 'paid.example.org', { tags: ['paid_only'] }),
        makePreflightItem(2, 2002, 'legacy-paid.example.org', { tags: ['付费'] }),
        makePreflightItem(3, 2003, 'noform.example.org', { tags: ['no_form'] }),
        makePreflightItem(4, 2004, 'closed.example.org', { tags: ['comments_closed'] }),
        makePreflightItem(5, 2005, 'dead.example.org', { tags: ['dead_site'] }),
        makePreflightItem(6, 2006, 'waf.example.org', { tags: ['waf_403'] }),
        makePreflightItem(7, 2007, 'clean.example.org', { tags: ['免徽章'] }),
      ],
    }

    const fetchedUrls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input))
      return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch

    const skippedIds: number[] = []
    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async (itemId) => {
        skippedIds.push(itemId)
        return { itemStatus: 'skipped', publishRecordId: null }
      },
      addBadge: async () => { throw new Error('unused') },
      tagSource: async () => { throw new Error('unused') },
    }

    const handle = createBacklinksToolHandler({
      config: smConfig,
      batchSource,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })

    const res = await handle({
      action: 'batch_preflight',
      batchId: 100,
      autoSkipTagged: true,
    })
    expect(res.isError).toBeUndefined()
    expect(fetchedUrls).toEqual([
      'https://waf.example.org/submit',
      'https://clean.example.org/submit',
    ])
    expect(skippedIds).toEqual([1, 2, 3, 4, 5])
    const data = parseToolPayload(res as never).data as {
      runnableItemIds: number[]
      cautionItems: Array<{ id: number; tags: string[] }>
      taggedBlocked: Array<{ id: number; matchedTags: string[] }>
    }
    expect(data.runnableItemIds).toEqual([6, 7])
    expect(data.cautionItems).toEqual([{ id: 6, sourceId: 2006, host: 'waf.example.org', tags: ['waf_403'] }])
    expect(data.taggedBlocked).toEqual([
      { id: 1, sourceId: 2001, host: 'paid.example.org', matchedTags: ['paid_only'] },
      { id: 2, sourceId: 2002, host: 'legacy-paid.example.org', matchedTags: ['paid_only'] },
      { id: 3, sourceId: 2003, host: 'noform.example.org', matchedTags: ['no_form'] },
      { id: 4, sourceId: 2004, host: 'closed.example.org', matchedTags: ['comments_closed'] },
      { id: 5, sourceId: 2005, host: 'dead.example.org', matchedTags: ['dead_site'] },
    ])

    // Explicit skipTags allows skipping waf_403 too.
    fetchedUrls.length = 0
    const customRes = await handle({
      action: 'batch_preflight',
      batchId: 100,
      skipTags: ['waf_403'],
    })
    expect(fetchedUrls.some(u => u.includes('waf.example.org'))).toBe(false)
    expect((parseToolPayload(customRes as never).data as { runnableItemIds: number[] }).runnableItemIds).toEqual([
      1, 2, 3, 4, 5, 7,
    ])
  })

  it('parses flexible tags, sourceTags, and blockingTags cleanly in SupermanagerBatchSource.getBatch and batch_get compact mode', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      batch: {
        id: 1,
        name: 'B1',
        websiteId: 7,
        websiteName: 'Demo',
        websiteHost: 'demo.example.com',
        plannedAt: '2026-11-23T00:00:00Z',
        counts: { pending: 4, executed: 0, skipped: 0, failed: 0, total: 4 },
        executing: false,
      },
      website: { id: 7, name: 'Demo', siteUrl: 'https://demo.example.com', siteHost: 'demo.example.com' },
      anchors: [],
      items: [
        { id: 1, sourceId: 1, sourceName: 'A', sourceUrl: 'https://a.test', sourceHost: 'a.test', tags: ['paid_only', ' paid_only '], blockingTags: ['paid_only'] },
        { id: 2, sourceId: 2, sourceName: 'B', sourceUrl: 'https://b.test', sourceHost: 'b.test', tags: [{ name: 'no_form' }, { name: '' }], sourceTags: ['无提交入口'], blockingTags: ['no_form'] },
        { id: 3, sourceId: 3, sourceName: 'C', sourceUrl: 'https://c.test', sourceHost: 'c.test', sourceTags: ['comments_closed', '有盾'], blockingTags: ['comments_closed', 'waf_403'] },
        { id: 4, sourceId: 4, sourceName: 'D', sourceUrl: 'https://d.test', sourceHost: 'd.test' },
      ],
    }), { status: 200 })) as unknown as typeof fetch

    try {
      const sm = new SupermanagerBatchSource(() => ({
        baseUrl: 'https://sm.example.com',
        token: 'smag_tok',
        requestTimeoutMs: 5_000,
      }))
      const detail = await sm.getBatch(1)
      expect(detail.items.map(i => i.tags)).toEqual([
        ['paid_only'],
        ['no_form', '无提交入口'],
        ['comments_closed', '有盾'],
        [],
      ])
      expect(detail.items.map(i => i.sourceTags)).toEqual([
        undefined,
        ['无提交入口'],
        ['comments_closed', '有盾'],
        undefined,
      ])
      expect(detail.items.map(i => i.blockingTags)).toEqual([
        ['paid_only'],
        ['no_form'],
        ['comments_closed', 'waf_403'],
        undefined,
      ])

      const handle = createBacklinksToolHandler({ config: smConfig, batchSource: sm })
      const compactRes = await handle({ action: 'batch_get', batchId: 1 })
      const compactData = parseToolPayload(compactRes as never).data as {
        items: Array<{ id: number; blockingTags?: string[] }>
      }
      expect(compactData.items[2]?.blockingTags).toEqual(['comments_closed', 'waf_403'])
      expect(compactData.items[3]?.blockingTags).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses Supermanager preflight-skip API atomically, respects 409 conflict, and downgrades on 404', async () => {
    const detail: BacklinkBatchDetail = {
      ...makeSampleDetail(),
      batch: { ...makeSampleDetail().batch, id: 101, name: 'Preflight Skip API Batch' },
      items: [
        makePreflightItem(1, 3001, 'dead404.example.org'),
        makePreflightItem(2, 3002, 'alias-paid.example.org', { sourceTags: ['仅付费'] }),
        makePreflightItem(3, 3003, 'server-blocked.example.org', { blockingTags: ['no_form'] }),
        makePreflightItem(4, 3004, 'alias-verify.example.org', { tags: ['徽标校验失败'] }),
      ],
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('dead404.example.org')) return new Response('not found', { status: 404 })
      return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch

    const preflightSkipCalls: Array<{ batchId: number; items: unknown[] }> = []
    const legacyClaims: number[][] = []
    const legacySkips: number[] = []
    const legacyTags: number[] = []

    const smProvider: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async (_batchId, itemIds) => {
        legacyClaims.push([...(itemIds ?? [])])
        return { leaseId: 500, leaseExpiresAt: '2026-11-23T01:00:00Z', items: detail.items.filter(i => itemIds?.includes(i.id)) }
      },
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-23T02:00:00Z' }),
      release: async () => {},
      reportItemResult: async (itemId) => {
        legacySkips.push(itemId)
        return { itemStatus: 'skipped', publishRecordId: null }
      },
      addBadge: async () => { throw new Error('unused') },
      preflightSkip: async (batchId, items) => {
        preflightSkipCalls.push({ batchId, items: [...items] })
        return {
          ok: true,
          batchId,
          skippedCount: 2,
          unchangedCount: 1,
          results: [
            { itemId: 1, sourceId: 3001, itemStatus: 'skipped', publishRecordId: 91, changed: true, attachedTags: ['dead_site'] },
            { itemId: 2, sourceId: 3002, itemStatus: 'skipped', publishRecordId: 92, changed: true, attachedTags: [] },
            { itemId: 3, sourceId: 3003, itemStatus: 'skipped', publishRecordId: 93, changed: false, attachedTags: [] },
          ],
        }
      },
      tagSource: async (sourceId, names) => {
        legacyTags.push(sourceId)
        return { sourceId, attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })) }
      },
    }

    const handle = createBacklinksToolHandler({
      config: smConfig,
      batchSource: smProvider,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })
    const apiRes = await handle({
      action: 'batch_preflight',
      batchId: 101,
      autoSkip: true,
      autoSkipTagged: true,
    })
    expect(apiRes.isError).toBeUndefined()
    expect(legacyClaims).toHaveLength(0)
    expect(legacySkips).toHaveLength(0)
    expect(legacyTags).toHaveLength(0)
    expect(preflightSkipCalls).toHaveLength(1)
    expect(preflightSkipCalls[0]?.items).toEqual([
      { itemId: 1, skipReason: '预检不可用(http_404, HTTP 404)', tags: ['dead_site'] },
      { itemId: 2, skipReason: '预检命中已有硬阻断标签: paid_only' },
      { itemId: 3, skipReason: '预检命中已有硬阻断标签: no_form' },
    ])
    const apiData = parseToolPayload(apiRes as never).data as {
      runnableItemIds: number[]
      cautionItems: Array<{ id: number; tags: string[] }>
      autoSkipResult: { mode: string; skippedItemIds: number[]; unchangedCount?: number; taggedSourceIds?: number[] }
    }
    expect(apiData.runnableItemIds).toEqual([4])
    expect(apiData.cautionItems).toEqual([{ id: 4, sourceId: 3004, host: 'alias-verify.example.org', tags: ['submitmatic_verify_fail'] }])
    expect(apiData.autoSkipResult).toEqual({
      mode: 'preflight_skip_api',
      skippedItemIds: [1, 2],
      unchangedCount: 1,
      taggedSourceIds: [3001],
    })

    // 409 LEASE_CONFLICT must NOT downgrade or stomp active lease.
    const conflictHandle = createBacklinksToolHandler({
      config: smConfig,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      batchSource: {
        ...smProvider,
        preflightSkip: async () => {
          throw new BacklinksError('conflict: active lease held by another token', 'BACKLINKS_CONFLICT')
        },
      },
    })
    const conflictRes = await conflictHandle({ action: 'batch_preflight', batchId: 101, autoSkip: true })
    expect(conflictRes.isError).toBeUndefined()
    expect(legacyClaims).toHaveLength(0)
    const conflictData = parseToolPayload(conflictRes as never).data as {
      autoSkipResult: { mode: string; skippedItemIds: number[]; errors?: Array<{ itemId: number; error: string }> }
    }
    expect(conflictData.autoSkipResult.mode).toBe('preflight_skip_api')
    expect(conflictData.autoSkipResult.skippedItemIds).toEqual([])
    expect(conflictData.autoSkipResult.errors?.[0]?.error).toContain('active lease')

    // 404 on older Supermanager downgrades cleanly to legacy item_result + tagSource.
    const downgradeHandle = createBacklinksToolHandler({
      config: smConfig,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      batchSource: {
        ...smProvider,
        preflightSkip: async () => {
          throw new BacklinksError('not found', 'BACKLINKS_NOT_FOUND')
        },
      },
    })
    const downRes = await downgradeHandle({ action: 'batch_preflight', batchId: 101, autoSkip: true })
    expect(downRes.isError).toBeUndefined()
    expect(legacySkips).toEqual([1])
    expect(legacyTags).toEqual([3001])
    const downData = parseToolPayload(downRes as never).data as {
      autoSkipResult: { mode: string; skippedItemIds: number[]; downgradeNotice?: string }
    }
    expect(downData.autoSkipResult.mode).toBe('legacy_fallback')
    expect(downData.autoSkipResult.skippedItemIds).toEqual([1])
    expect(downData.autoSkipResult.downgradeNotice).toContain('404/405')
  })

  it('sends POST /api/agent/batches/:id/preflight-skip via SupermanagerBatchSource', async () => {
    const originalFetch = globalThis.fetch
    let captured: { url: string; method?: string; body?: string } | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        method: init?.method,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      }
      return new Response(JSON.stringify({
        ok: true,
        batchId: 55,
        skippedCount: 1,
        unchangedCount: 0,
        results: [{ itemId: 10, sourceId: 90, itemStatus: 'skipped', publishRecordId: 501, changed: true, attachedTags: ['dead_site'] }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const sm = new SupermanagerBatchSource(() => ({
        baseUrl: 'https://sm.example.com',
        token: 'smag_tok',
        requestTimeoutMs: 5_000,
      }))
      const out = await sm.preflightSkip(55, [{ itemId: 10, skipReason: 'HTTP 404', tags: ['dead_site'] }])
      expect(captured).toEqual({
        url: 'https://sm.example.com/api/agent/batches/55/preflight-skip',
        method: 'POST',
        body: '{"items":[{"itemId":10,"skipReason":"HTTP 404","tags":["dead_site"]}]}',
      })
      expect(out).toMatchObject({ ok: true, batchId: 55, skippedCount: 1, unchangedCount: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Reciprocal badge rollback (badge_deactivate) & active badge guard', () => {
  const smConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_secret',
  })

  it('supports PATCH/DELETE /api/agent/badges/:badgeId, match fallback, and clear 404/405 errors in SupermanagerBatchSource', async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = []
    let mode: 'ok' | '204' | 'idempotentDelete' | '404' = 'ok'
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (mode === '404') return new Response('not found', { status: 404 })
      if (mode === '204') return new Response(null, { status: 204 })
      if (mode === 'idempotentDelete') {
        return new Response(JSON.stringify({
          ok: true,
          backlinkId: 88,
          websiteId: 7,
          isActive: false,
          deleted: true,
          alreadyDeleted: true,
          changed: false,
          callbackTriggered: false,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        ok: true,
        backlinkId: 88,
        websiteId: 7,
        isActive: false,
        deleted: false,
        changed: true,
        callbackTriggered: true,
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const sm = new SupermanagerBatchSource(() => ({
        baseUrl: 'https://sm.example.com',
        token: 'smag_tok',
        requestTimeoutMs: 5_000,
      }))

      const patched = await sm.deactivateBadge(7, { badgeId: 88 })
      expect(patched).toEqual({
        backlinkId: 88,
        websiteId: 7,
        isActive: false,
        deleted: false,
        changed: true,
        callbackTriggered: true,
        strategy: 'patch_by_id',
      })

      const patchedWithoutWebsite = await sm.deactivateBadge(undefined, { badgeId: 88 })
      expect(patchedWithoutWebsite.backlinkId).toBe(88)

      mode = '204'
      const deleted = await sm.deactivateBadge(7, { badgeId: 88, remove: true })
      expect(deleted).toEqual({
        backlinkId: 88,
        websiteId: 7,
        isActive: false,
        deleted: true,
        callbackTriggered: false,
        strategy: 'delete_by_id',
      })

      mode = 'idempotentDelete'
      const deletedAgain = await sm.deactivateBadge(undefined, { badgeId: 88, remove: true })
      expect(deletedAgain).toMatchObject({
        backlinkId: 88,
        websiteId: 7,
        isActive: false,
        deleted: true,
        alreadyDeleted: true,
        changed: false,
      })

      mode = 'ok'
      const matched = await sm.deactivateBadge(7, {
        name: 'DirOne',
        html: '<a href="https://dirone.example.org">DirOne</a>',
      })
      expect(matched.strategy).toBe('patch_by_match')
      expect(matched.isActive).toBe(false)

      expect(requests).toEqual([
        { method: 'PATCH', url: 'https://sm.example.com/api/agent/badges/88?websiteId=7', body: '{"isActive":false,"websiteId":7}' },
        { method: 'PATCH', url: 'https://sm.example.com/api/agent/badges/88', body: '{"isActive":false}' },
        { method: 'DELETE', url: 'https://sm.example.com/api/agent/badges/88?websiteId=7' },
        { method: 'DELETE', url: 'https://sm.example.com/api/agent/badges/88' },
        {
          method: 'PATCH',
          url: 'https://sm.example.com/api/agent/websites/7/footer-backlinks',
          body: '{"name":"DirOne","html":"<a href=\\"https://dirone.example.org\\">DirOne</a>","isActive":false}',
        },
      ])

      mode = '404'
      await expect(sm.deactivateBadge(7, { badgeId: 88 })).rejects.toThrow(
        /Supermanager backend may not yet expose PATCH \/api\/agent\/badges\/88\?websiteId=7/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('warns via badgeRollbackReminder when failing an item with an active badge, and clears after badge_deactivate', async () => {
    const detail = makeSampleDetail()
    const deactivateMock = vi.fn(async () => ({
      backlinkId: 55,
      isActive: false as const,
      deleted: false,
      callbackTriggered: true,
      strategy: 'patch_by_id' as const,
    }))

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async () => ({ leaseId: 1, leaseExpiresAt: '2026-11-23T01:00:00Z', items: [detail.items[0]!] }),
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-23T02:00:00Z' }),
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'failed', publishRecordId: null }),
      addBadge: async () => ({ backlinkId: 55, callbackTriggered: true }),
      deactivateBadge: deactivateMock,
      tagSource: async (sourceId, names) => ({
        sourceId,
        attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })),
      }),
    }

    const refreshedUrls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      refreshedUrls.push(String(input))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const handle = createBacklinksToolHandler({
      config: smConfig,
      batchSource,
      fetchImpl: fetchMock,
    })

    await handle({ action: 'batch_get', batchId: 42 })
    await handle({
      action: 'badge_add',
      websiteId: 7,
      name: 'DirOne',
      html: '<a href="https://dirone.example.org">DirOne</a>',
    })

    const failBeforeDeactivate = await handle({
      action: 'item_result',
      itemId: 101,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed on DirOne',
    })
    const failData1 = parseToolPayload(failBeforeDeactivate as never).data as {
      badgeRollbackReminder?: { badgeId: number; websiteId: number }
    }
    expect(failData1.badgeRollbackReminder).toMatchObject({ badgeId: 55, websiteId: 7 })

    const deactivateRes = await handle({
      action: 'badge_deactivate',
      websiteId: 7,
      badgeId: 55,
      refreshUrl: 'https://demo.example.com/footer/refresh',
    })
    expect(deactivateRes.isError).toBeUndefined()
    expect(deactivateMock).toHaveBeenCalledWith(7, { badgeId: 55 }, undefined)
    expect(refreshedUrls).toEqual(['https://demo.example.com/footer/refresh'])

    const failAfterDeactivate = await handle({
      action: 'item_result',
      itemId: 101,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed on DirOne',
    })
    const failData2 = parseToolPayload(failAfterDeactivate as never).data as {
      badgeRollbackReminder?: unknown
    }
    expect(failData2.badgeRollbackReminder).toBeUndefined()

    const invalidDeactivate = await handle({ action: 'badge_deactivate', websiteId: 7 })
    expect(invalidDeactivate.isError).toBe(true)

    const idOnlyRes = await handle({ action: 'badge_deactivate', badgeId: 55 })
    expect(idOnlyRes.isError).toBeUndefined()
    expect(deactivateMock).toHaveBeenLastCalledWith(undefined, { badgeId: 55 }, undefined)

    const missingSiteForName = await handle({ action: 'badge_deactivate', name: 'DirOne' })
    expect(missingSiteForName.isError).toBe(true)
  })
})

describe('Same-template 2-strike circuit breaker', () => {
  const smConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_secret',
  })

  function makeTemplateBatchDetail(): BacklinkBatchDetail {
    const base = makeSampleDetail()
    return {
      ...base,
      batch: { ...base.batch, id: 88, name: 'Template Batch' },
      items: [
        {
          ...base.items[0]!,
          id: 301,
          sourceId: 701,
          sourceName: 'SubDir 1',
          sourceHost: 'sub1.example.org',
          sourceUrl: 'https://sub1.example.org',
          submitUrl: 'https://sub1.example.org/submit',
          sourceNotes: '@submitmatic template directory',
          category: '导航站',
          status: 'pending',
        },
        {
          ...base.items[0]!,
          id: 302,
          sourceId: 702,
          sourceName: 'SubDir 2',
          sourceHost: 'sub2.example.org',
          sourceUrl: 'https://sub2.example.org',
          submitUrl: 'https://sub2.example.org/submit',
          sourceNotes: '@submitmatic template directory',
          category: '导航站',
          status: 'pending',
        },
        {
          ...base.items[0]!,
          id: 303,
          sourceId: 703,
          sourceName: 'SubDir 3',
          sourceHost: 'sub3.example.org',
          sourceUrl: 'https://sub3.example.org',
          submitUrl: 'https://sub3.example.org/submit',
          sourceNotes: '@submitmatic template directory',
          category: '导航站',
          status: 'pending',
        },
        {
          ...base.items[0]!,
          id: 401,
          sourceId: 801,
          sourceName: 'Blog 1',
          sourceHost: 'blog1.example.org',
          sourceUrl: 'https://blog1.example.org/post',
          submitUrl: null,
          sourceNotes: 'WordPress blog',
          category: '博客',
          status: 'pending',
        },
        {
          ...base.items[0]!,
          id: 402,
          sourceId: 802,
          sourceName: 'Blog 2',
          sourceHost: 'blog2.example.org',
          sourceUrl: 'https://blog2.example.org/post',
          submitUrl: null,
          sourceNotes: 'WordPress blog',
          category: '博客',
          status: 'pending',
        },
      ],
    }
  }

  function makeSource(detail: BacklinkBatchDetail): BacklinkBatchSourceProvider {
    return {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async (_batchId, itemIds) => ({
        leaseId: 12,
        leaseExpiresAt: '2026-11-23T01:00:00Z',
        items: detail.items.filter(item => itemIds === undefined || itemIds.includes(item.id)),
      }),
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-23T02:00:00Z' }),
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'failed', publishRecordId: null }),
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId, names) => ({
        sourceId,
        attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })),
      }),
    }
  }

  it('trips on 2 consecutive @submitmatic Verify Badge failures and warns on subsequent batch_claim', async () => {
    const detail = makeTemplateBatchDetail()
    const handle = createBacklinksToolHandler({ config: smConfig, batchSource: makeSource(detail) })

    await handle({ action: 'batch_get', batchId: 88 })

    const first = await handle({
      action: 'item_result',
      itemId: 301,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed on @submitmatic directory',
    })
    expect((parseToolPayload(first as never).data as { circuitBreaker?: unknown }).circuitBreaker).toBeUndefined()

    const second = await handle({
      action: 'item_result',
      itemId: 302,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed on @submitmatic directory',
    })
    const secondPayload = parseToolPayload(second as never)
    expect(secondPayload.summary).toContain('CIRCUIT BREAKER TRIPPED')
    expect((secondPayload.data as { circuitBreaker: unknown }).circuitBreaker).toMatchObject({
      tripped: true,
      fingerprint: 'submitmatic:verify_badge_fail',
      consecutiveFailures: 2,
      threshold: 2,
      failedItemIds: [301, 302],
      suggestedTag: 'submitmatic_verify_fail',
      affectedPendingItemIds: [303],
    })

    const claimNext = await handle({ action: 'batch_claim', batchId: 88, itemIds: [303] })
    const claimPayload = parseToolPayload(claimNext as never)
    expect(claimPayload.summary).toContain('CIRCUIT BREAKER TRIPPED')
    expect((claimPayload.data as { circuitBreakerAlerts: unknown[] }).circuitBreakerAlerts).toHaveLength(1)
  })

  it('trips on 2 consecutive blog SecureImg + reCAPTCHA failures and resets streak on live/submitted success', async () => {
    const detail = makeTemplateBatchDetail()
    const handle = createBacklinksToolHandler({ config: smConfig, batchSource: makeSource(detail) })

    await handle({ action: 'batch_get', batchId: 88 })

    // 1 @submitmatic failure -> 1 @submitmatic submitted -> 1 @submitmatic failure => does NOT trip!
    await handle({
      action: 'item_result',
      itemId: 301,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed',
    })
    await handle({
      action: 'item_result',
      itemId: 302,
      status: 'submitted',
      anchorText: 'DemoSite',
      targetUrl: 'https://demo.example.com',
    })
    const afterReset = await handle({
      action: 'item_result',
      itemId: 303,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Verify Badge failed',
    })
    expect((parseToolPayload(afterReset as never).data as { circuitBreaker?: unknown }).circuitBreaker).toBeUndefined()

    // 2 consecutive blog SecureImg + reCAPTCHA failures => trips with has_captcha!
    await handle({
      action: 'item_result',
      itemId: 401,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Blocked by SecureImg + reCAPTCHA',
    })
    const blogTrip = await handle({
      action: 'item_result',
      itemId: 402,
      status: 'failed',
      failureMode: 'manual_required',
      failureReason: 'Blocked by SecureImg + reCAPTCHA',
    })
    expect((parseToolPayload(blogTrip as never).data as { circuitBreaker: unknown }).circuitBreaker).toMatchObject({
      tripped: true,
      fingerprint: 'blog:secureimg_captcha',
      consecutiveFailures: 2,
      failedItemIds: [401, 402],
      suggestedTag: 'has_captcha',
    })
  })
})
