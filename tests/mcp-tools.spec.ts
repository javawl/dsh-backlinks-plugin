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
  DEFAULT_NAVIGATE_MAX_CHARS,
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

  it('resolves defaults (16000 / 3000 / cloudmail URL / profile) and overrides', () => {
    const defaults = resolveMcpConfig({}, { homeDir: 'C:\\Users\\zlb', pathImpl: path.win32 })
    expect(defaults.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS)
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
        BACKLINKS_NAVIGATE_MAX_CHARS: '2500',
        BACKLINKS_BROWSER_WINDOW_POSITION: '-32000,-32000',
      },
      { homeDir: '/Users/zlb', pathImpl: path.posix },
    )
    expect(custom.browserProfileDir).toBe('/Users/zlb/custom-chrome-profile')
    expect(custom.maxOutputChars).toBe(12_000)
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

  it('caps navigate output at 3000 chars and snapshot at BACKLINKS_MAX_OUTPUT_CHARS (default 16000)', async () => {
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
    expect(commands[1]).toMatchObject({ kind: 'snapshot', maxChars: 16_000 })
    const snapText = snap.content[0]?.type === 'text' ? snap.content[0].text : ''
    expect(snapText).toContain('… (truncated)')
    expect(snapText.length).toBeLessThan(16_200)
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
