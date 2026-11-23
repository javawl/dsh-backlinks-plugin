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
  DEFAULT_CLOUDMAIL_BASE_URL,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS_CLAMP,
  DEFAULT_NAVIGATE_MAX_CHARS,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  expandHomePath,
  redactSecrets,
  resolveMcpConfig,
} from '../src/mcp/config.ts'

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
