import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { BacklinksError } from '../src/host/backlinks/types.ts'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import {
  DEFAULT_LARGE_WP_FORM_WAIT_MAX_MS,
  executeCommentPublish,
  matchesGoogleSsoButtonLabel,
  navigateCommentPageWithCommit,
} from '../src/host/browser-playwright/comment-publish.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'
import {
  PAID_REDIRECT_HOST_SUFFIXES,
  detectPaidRedirectTarget,
  matchPaidRedirectHostname,
  runBatchPreflight,
} from '../src/mcp/preflight.ts'

interface V231MockResponse {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface V231PopupStep {
  url: string
  html: string
  onClick?: (selector: string) => { nextStep?: boolean; close?: boolean; mutateParentHtml?: string } | void
}

interface V231PopupSpec {
  steps: V231PopupStep[]
}

interface V231Route {
  html: string
  readyState?: 'loading' | 'interactive' | 'complete'
  scrollHeight?: number
  onAction?: (
    kind: string,
    selector: string,
    value?: string,
    element?: Element | null,
  ) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponses?: readonly V231MockResponse[]
    openPopup?: V231PopupSpec
    throwError?: Error
  } | void
}

function createV231MockPage(
  routes: Record<string, V231Route>,
  options?: {
    readonly onSleepTick?: (
      tick: number,
      totalMs: number,
      ctx: { setHtml: (html: string, readyState?: 'loading' | 'interactive' | 'complete') => void; getUrl: () => string },
    ) => void
  },
) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2400
  let currentScrollY = 0
  let currentReadyState: 'loading' | 'interactive' | 'complete' = routes[currentUrl]?.readyState ?? 'complete'
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const scrollIntoViewCalls: string[] = []
  const gotoCalls: Array<{ url: string; timeout?: number; waitUntil?: string }> = []
  const responseListeners = new Set<(resp: unknown) => void>()
  let pendingPopupResolve: ((popup: unknown) => void) | undefined

  const buildDom = (html: string, url: string, readyState: 'loading' | 'interactive' | 'complete') => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : 'http://localhost/'
    const next = new JSDOM(html, { url: safeUrl, runScripts: 'outside-only' })
    Object.defineProperty(next.window.document, 'readyState', {
      get: () => readyState,
      configurable: true,
    })
    Object.defineProperty(next.window.document.documentElement, 'scrollHeight', {
      get: () => currentScrollHeight,
      configurable: true,
    })
    Object.defineProperty(next.window.document.body, 'scrollHeight', {
      get: () => currentScrollHeight,
      configurable: true,
    })
    Object.defineProperty(next.window, 'innerHeight', { get: () => 800, configurable: true })
    Object.defineProperty(next.window, 'scrollY', { get: () => currentScrollY, configurable: true })
    next.window.scrollTo = (_x: number, y: number) => {
      currentScrollY = y
    }
    next.window.HTMLElement.prototype.scrollIntoView = function () {}
    return next
  }

  let dom = buildDom(routes[currentUrl]?.html ?? '<html><body></body></html>', currentUrl, currentReadyState)
  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false }
  const resolveRoute = (targetUrl: string): V231Route | undefined => {
    const noHash = targetUrl.split('#')[0]!
    const noQuery = noHash.split('?')[0]!
    return routes[targetUrl] ?? routes[noHash] ?? routes[noQuery]
  }
  const activeRoute = () => resolveRoute(currentUrl)

  const loadRoute = (targetUrl: string) => {
    const route = resolveRoute(targetUrl)
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    currentScrollHeight = route.scrollHeight ?? 2400
    currentScrollY = 0
    currentReadyState = route.readyState ?? 'complete'
    dom = buildDom(route.html, targetUrl, currentReadyState)
  }

  const setDomOnly = (html: string, readyState?: 'loading' | 'interactive' | 'complete') => {
    const r = activeRoute()
    if (r) {
      r.html = html
      if (readyState !== undefined) r.readyState = readyState
    }
    if (readyState !== undefined) currentReadyState = readyState
    dom = buildDom(html, currentUrl, currentReadyState)
  }

  const emitResponse = (spec: V231MockResponse) => {
    const mockResp = {
      url: () => spec.url,
      status: () => spec.status,
      headers: () => spec.headers ?? {},
      text: async () => spec.body ?? '',
      request: () => ({
        method: () => spec.method ?? 'POST',
        resourceType: () => spec.resourceType ?? 'document',
      }),
    }
    for (const listener of responseListeners) {
      listener(mockResp)
    }
  }

  const createMockPopup = (spec: V231PopupSpec) => {
    let stepIndex = 0
    let closed = false
    const getStep = () => spec.steps[Math.min(stepIndex, spec.steps.length - 1)]!
    let popupDom = buildDom(getStep().html, getStep().url, 'complete')
    const popupActions: Array<{ kind: string; selector?: string }> = []

    const popup = {
      isClosed: () => closed,
      url: () => getStep().url,
      title: async () => popupDom.window.document.title || '',
      waitForLoadState: async () => {},
      evaluate: async (fnOrScript: unknown) => {
        if (typeof fnOrScript === 'string') {
          return popupDom.window.eval(fnOrScript)
        }
        return undefined
      },
      locator: (selector: string) => {
        const resolveAll = () => Array.from(popupDom.window.document.querySelectorAll(selector))
        const click = async () => {
          popupActions.push({ kind: 'click', selector })
          const eff = getStep().onClick?.(selector)
          if (eff?.mutateParentHtml) {
            setDomOnly(eff.mutateParentHtml)
          }
          if (eff?.close) {
            closed = true
            return
          }
          if (eff?.nextStep && stepIndex + 1 < spec.steps.length) {
            stepIndex++
            popupDom = buildDom(getStep().html, getStep().url, 'complete')
          }
        }
        const single = { click }
        return { ...single, first: () => single, count: async () => resolveAll().length }
      },
      actions: popupActions,
    }
    return popup
  }

  const runWithDomGlobals = <T>(fn: () => T): T => {
    const prevDoc = globalThis.document
    const prevLoc = globalThis.location
    const prevWin = globalThis.window
    const prevNF = globalThis.NodeFilter
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
    Object.defineProperty(globalThis, 'location', { value: dom.window.location, configurable: true })
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
    Object.defineProperty(globalThis, 'NodeFilter', { value: dom.window.NodeFilter, configurable: true })
    try {
      return fn()
    } finally {
      if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document
      else Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true })
      if (prevLoc === undefined) delete (globalThis as Record<string, unknown>).location
      else Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true })
      if (prevWin === undefined) delete (globalThis as Record<string, unknown>).window
      else Object.defineProperty(globalThis, 'window', { value: prevWin, configurable: true })
      if (prevNF === undefined) delete (globalThis as Record<string, unknown>).NodeFilter
      else Object.defineProperty(globalThis, 'NodeFilter', { value: prevNF, configurable: true })
    }
  }

  const isNodeVisible = (el: Element | null): boolean => {
    if (!el) return false
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const h = cur as HTMLElement
      if (h.hidden) return false
      if (h.getAttribute('aria-hidden') === 'true') return false
      const style = dom.window.getComputedStyle(h)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    }
    return true
  }

  const makeSingleLocatorApi = (selector: string, resolveNode: () => Element | null) => ({
    isVisible: async () => isNodeVisible(resolveNode()),
    isDisabled: async () => {
      const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
      return Boolean(el && (el.disabled === true || el.hasAttribute('disabled')))
    },
    getAttribute: async (attr: string) => resolveNode()?.getAttribute(attr) ?? null,
    evaluate: async <R>(fn: (node: unknown) => R) => fn(resolveNode()),
    scrollIntoViewIfNeeded: async () => {
      scrollIntoViewCalls.push(selector)
    },
    fill: async (val: string) => {
      actions.push({ kind: 'fill', selector, value: val })
      const el = resolveNode() as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
      if (!el) throw new Error(`Missing element for fill: ${selector}`)
      if (!isNodeVisible(el)) throw new Error(`locator.fill: element is not visible: ${selector}`)
      if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) {
        ;(el as HTMLInputElement).value = val
      } else {
        el.textContent = val
      }
      const eff = activeRoute()?.onAction?.('fill', selector, val, el)
      if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
    },
    click: async () => {
      actions.push({ kind: 'click', selector })
      const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
      if (!el) throw new Error(`Missing element for click: ${selector}`)
      const eff = activeRoute()?.onAction?.('click', selector, undefined, el)
      if (eff?.emitResponses) {
        for (const r of eff.emitResponses) emitResponse(r)
      }
      if (eff?.openPopup) {
        const popup = createMockPopup(eff.openPopup)
        pendingPopupResolve?.(popup)
        pendingPopupResolve = undefined
      }
      if (eff?.throwError) throw eff.throwError
      if (eff?.navigateTo) loadRoute(eff.navigateTo)
      else if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
    },
    press: async (key: string) => {
      actions.push({ kind: 'press', selector, value: key })
      const eff = activeRoute()?.onAction?.('press', selector, key, resolveNode())
      if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
    },
  })

  const page = {
    url: () => currentUrl,
    title: async () => dom.window.document.title || '',
    mainFrame: () => mainFrameStub,
    frames: () => [mainFrameStub],
    on: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.add(fn)
    },
    off: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.delete(fn)
    },
    route: async () => {},
    unroute: async () => {},
    waitForEvent: async (ev: string) => {
      if (ev !== 'popup') return null
      return await new Promise<unknown>((resolve) => {
        pendingPopupResolve = resolve
        setTimeout(() => {
          if (pendingPopupResolve === resolve) {
            pendingPopupResolve = undefined
            resolve(null)
          }
        }, 30)
      })
    },
    goto: async (url: string, opts?: { timeout?: number; waitUntil?: string }) => {
      gotoCalls.push({ url, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }), ...(opts?.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }) })
      loadRoute(url)
    },
    waitForLoadState: async () => {},
    waitForNavigation: async () => null,
    keyboard: {
      press: async (key: string) => {
        actions.push({ kind: 'keyboard.press', value: key })
      },
    },
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      if (typeof fnOrScript === 'string') {
        return dom.window.eval(fnOrScript)
      }
      if (typeof fnOrScript === 'function') {
        return runWithDomGlobals(() => (fnOrScript as (input: unknown) => unknown)(arg))
      }
      return undefined
    },
    locator: (selector: string) => {
      const resolveAll = () => Array.from(dom.window.document.querySelectorAll(selector))
      const firstApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null)
      return {
        ...firstApi,
        first: () => firstApi,
        count: async () => resolveAll().length,
        nth: (idx: number) => makeSingleLocatorApi(`${selector} >> nth=${idx}`, () => resolveAll()[idx] ?? null),
      }
    },
  }

  let sleepTicks = 0
  let totalSleepMs = 0
  const sleepImpl = async (ms: number) => {
    sleepTicks++
    totalSleepMs += ms
    options?.onSleepTick?.(sleepTicks, totalSleepMs, {
      setHtml: setDomOnly,
      getUrl: () => currentUrl,
    })
  }

  return {
    page,
    actions,
    scrollIntoViewCalls,
    gotoCalls,
    sleepImpl,
    getSleepStats: () => ({ ticks: sleepTicks, totalMs: totalSleepMs }),
    setDomOnly,
  }
}

function makeResponseWithUrl(body: string, init: { status: number; url: string; headers?: Record<string, string> }): Response {
  const resp = new Response(body, {
    status: init.status,
    headers: { 'content-type': 'text/html', ...(init.headers ?? {}) },
  })
  Object.defineProperty(resp, 'url', { value: init.url, configurable: true })
  return resp
}

describe('v2.3.1 Fix 1: batch_preflight paid PBN redirect blocking (cvgorilla.com & rankwithdaniel.com)', () => {
  it('matches root and subdomains for known paid redirect domains without false positives', () => {
    expect(PAID_REDIRECT_HOST_SUFFIXES).toContain('cvgorilla.com')
    expect(PAID_REDIRECT_HOST_SUFFIXES).toContain('rankwithdaniel.com')

    expect(matchPaidRedirectHostname('cvgorilla.com')).toBe('cvgorilla.com')
    expect(matchPaidRedirectHostname('www.cvgorilla.com')).toBe('www.cvgorilla.com')
    expect(matchPaidRedirectHostname('rankwithdaniel.com')).toBe('rankwithdaniel.com')
    expect(matchPaidRedirectHostname('sub.rankwithdaniel.com')).toBe('sub.rankwithdaniel.com')
    expect(matchPaidRedirectHostname('A.B.RANKWITHDANIEL.COM.')).toBe('a.b.rankwithdaniel.com')

    // Zero false positives on lookalike/substring domains.
    expect(matchPaidRedirectHostname('not-cvgorilla.com')).toBeUndefined()
    expect(matchPaidRedirectHostname('myrankwithdaniel.com')).toBeUndefined()
    expect(matchPaidRedirectHostname('cvgorilla.com.evil.org')).toBeUndefined()
    expect(matchPaidRedirectHostname('example.org')).toBeUndefined()

    // HTML meta refresh (including reversed attrs & protocol-relative URL) and JS redirects.
    expect(
      detectPaidRedirectTarget({
        originalUrl: 'https://source1.example.org/p',
        finalUrl: 'https://source1.example.org/p',
        body: '<html><head><meta content="0; URL=\'//www.cvgorilla.com/buy\'" http-equiv="Refresh"></head></html>',
      }),
    ).toMatchObject({
      matched: true,
      targetHost: 'www.cvgorilla.com',
      matchedVia: 'meta_refresh',
      reason: 'paid_redirect: www.cvgorilla.com',
    })

    expect(
      detectPaidRedirectTarget({
        originalUrl: 'https://source2.example.org/p',
        finalUrl: 'https://source2.example.org/p',
        body: '<html><body><script>window.location.replace("https://sub.rankwithdaniel.com/offer");</script></body></html>',
      }),
    ).toMatchObject({
      matched: true,
      targetHost: 'sub.rankwithdaniel.com',
      matchedVia: 'js_redirect',
      reason: 'paid_redirect: sub.rankwithdaniel.com',
    })

    // Normal blog mentioning cvgorilla.com in a prose <a href> link must NOT be false-positived.
    expect(
      detectPaidRedirectTarget({
        originalUrl: 'https://clean-blog.example.org/review',
        finalUrl: 'https://clean-blog.example.org/review',
        body: '<html><body><p>Read <a href="https://cvgorilla.com">this review</a>.</p><form id="commentform"></form></body></html>',
      }),
    ).toEqual({ matched: false })
  })

  it('blocks direct, finalUrl, meta-refresh, and JS paid redirects, auto-skips with paid_redirect & non-fatally tags paid_only, preserves normal domains, and respects autoSkip=false', async () => {
    const detail: BacklinkBatchDetail = {
      batch: { id: 1257, name: 'FreeCreate #1257', websiteId: 1, status: 'open', counts: { total: 6, pending: 6, live: 0, submitted: 0, failed: 0, skipped: 0 } } as never,
      website: { id: 1, name: 'FreeCreate', url: 'https://freecreate.example.com' } as never,
      anchors: [],
      items: [
        { id: 1, sourceId: 201, sourceHost: 'cvgorilla.com', sourceUrl: 'https://cvgorilla.com/start', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 2, sourceId: 202, sourceHost: 'redir-http.example.org', sourceUrl: 'https://redir-http.example.org/post', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 3, sourceId: 203, sourceHost: 'redir-meta.example.org', sourceUrl: 'https://redir-meta.example.org/post', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 4, sourceId: 204, sourceHost: 'redir-js.example.org', sourceUrl: 'https://redir-js.example.org/post', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 5, sourceId: 205, sourceHost: 'not-cvgorilla.com', sourceUrl: 'https://not-cvgorilla.com/post', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 6, sourceId: 206, sourceHost: 'clean-wp.example.org', sourceUrl: 'https://clean-wp.example.org/post', submitUrl: null, status: 'pending', tags: [] } as never,
      ],
    }

    const skippedCalls: Array<{ itemId: number; skipReason: string }> = []
    const tagCalls: Array<{ sourceId: number; tags: readonly string[] }> = []

    const mockSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [],
      getBatch: async () => detail,
      claim: async () => ({ leaseId: 1, items: [] } as never),
      heartbeat: async () => ({ leaseId: 1 } as never),
      release: async () => {},
      reportItemResult: async (itemId, result) => {
        if (result.status === 'skipped') {
          skippedCalls.push({ itemId, skipReason: result.skipReason })
        }
        return { itemId, itemStatus: result.status } as never
      },
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false } as never),
      tagSource: async (sourceId, names) => {
        tagCalls.push({ sourceId, tags: names })
        // Simulate Supermanager 500 rejecting paid_only on source 202 -> must degrade non-fatally and NEVER block skipping!
        if (sourceId === 202) {
          throw new BacklinksError('HTTP 500 tag error', 'BACKLINKS_API_ERROR')
        }
      },
    }

    const probedUrls: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input)
      probedUrls.push(url)
      if (url.includes('redir-http.example.org')) {
        return makeResponseWithUrl('<html><title>Buy Links</title><body>Pricing</body></html>', {
          status: 200,
          url: 'https://www.cvgorilla.com/pricing',
        })
      }
      if (url.includes('redir-meta.example.org')) {
        return makeResponseWithUrl(
          '<html><head><meta http-equiv="refresh" content="0; url=https://sub.rankwithdaniel.com/links"></head><body>Redirecting...</body></html>',
          { status: 200, url },
        )
      }
      if (url.includes('redir-js.example.org')) {
        return makeResponseWithUrl(
          '<html><body><script>location.href = "https://rankwithdaniel.com/buy";</script></body></html>',
          { status: 200, url },
        )
      }
      return makeResponseWithUrl(
        '<html><head><title>Healthy Blog</title></head><body><p>Mention <a href="https://cvgorilla.com">link</a></p><form id="commentform" action="/wp-comments-post.php"><textarea name="comment"></textarea></form></body></html>',
        { status: 200, url },
      )
    }

    const preflight = await runBatchPreflight(mockSource, detail, {
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    })

    // Direct paid domain cvgorilla.com was blocked pre-HTTP (zero network call), while not-cvgorilla.com was probed normally.
    expect(probedUrls.some(u => u.startsWith('https://cvgorilla.com/'))).toBe(false)
    expect(probedUrls.some(u => u.startsWith('https://not-cvgorilla.com/'))).toBe(true)
    expect(preflight.summary).toContain('4 paid_redirect')
    expect(preflight.data.counts).toMatchObject({
      runnable: 2,
      paidRedirectBlocked: 4,
      autoSkipped: 4,
    })
    expect(preflight.data.runnableItemIds).toEqual([5, 6])
    expect(preflight.skippedPaidRedirectItemIds).toEqual([1, 2, 3, 4])
    expect(preflight.data.paidRedirectBlocked?.map(p => [p.id, p.targetHost, p.matchedVia])).toEqual([
      [1, 'cvgorilla.com', 'original_url'],
      [2, 'www.cvgorilla.com', 'final_url'],
      [3, 'sub.rankwithdaniel.com', 'meta_refresh'],
      [4, 'rankwithdaniel.com', 'js_redirect'],
    ])
    expect(skippedCalls).toEqual([
      { itemId: 1, skipReason: 'paid_redirect: cvgorilla.com' },
      { itemId: 2, skipReason: 'paid_redirect: www.cvgorilla.com' },
      { itemId: 3, skipReason: 'paid_redirect: sub.rankwithdaniel.com' },
      { itemId: 4, skipReason: 'paid_redirect: rankwithdaniel.com' },
    ])
    // Attempted paid_only tag for all 4 blocked sources; source 202 retried Chinese fallback '付费' and did not fail skip.
    expect(tagCalls.filter(c => c.tags.includes('paid_only')).map(c => c.sourceId).sort()).toEqual([201, 202, 203, 204])
    expect(tagCalls.some(c => c.sourceId === 202 && c.tags.includes('付费'))).toBe(true)

    // Explicit autoSkip=false via MCP backlinks tool handler reports paidRedirectBlocked without mutating Supermanager.
    skippedCalls.length = 0
    tagCalls.length = 0
    const handler = createBacklinksToolHandler({
      config: resolveMcpConfig({}),
      batchSource: mockSource,
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    })
    const dryRes = await handler({ action: 'batch_preflight', batchId: 1257, autoSkip: false })
    expect(dryRes.isError).toBeUndefined()
    expect(skippedCalls).toHaveLength(0)
    expect(tagCalls).toHaveLength(0)

    // Default (omitted autoSkip) via MCP backlinks tool handler auto-skips paid redirects.
    const defaultRes = await handler({ action: 'batch_preflight', batchId: 1257 })
    expect(defaultRes.isError).toBeUndefined()
    expect(skippedCalls).toHaveLength(4)

    // preflightSkip API path: sends tags=['paid_only'] and gracefully retries without paid_only on Supermanager 500.
    const preflightSkipPayloads: Array<readonly { itemId: number; skipReason: string; tags?: readonly string[] }[]> = []
    const apiTagCalls: Array<{ sourceId: number; tags: readonly string[] }> = []
    let preflightSkipAttempts = 0
    const apiSource: BacklinkBatchSourceProvider = {
      ...mockSource,
      tagSource: async (sourceId, names) => {
        apiTagCalls.push({ sourceId, tags: names })
      },
      preflightSkip: async (_batchId, items) => {
        preflightSkipAttempts++
        preflightSkipPayloads.push(items)
        if (preflightSkipAttempts === 1) {
          throw new BacklinksError('HTTP 500 tag rejected', 'BACKLINKS_API_ERROR')
        }
        return {
          batchId: 1257,
          skippedCount: items.length,
          unchangedCount: 0,
          results: items.map(entry => ({
            itemId: entry.itemId,
            sourceId: 200 + entry.itemId,
            itemStatus: 'skipped',
            changed: true,
            attachedTags: [],
          })),
        }
      },
    }
    const apiPreflight = await runBatchPreflight(apiSource, detail, {
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    })
    expect(preflightSkipAttempts).toBe(2)
    expect(preflightSkipPayloads[0]?.every(p => p.tags?.includes('paid_only'))).toBe(true)
    expect(preflightSkipPayloads[1]?.every(p => p.tags === undefined)).toBe(true)
    expect(apiPreflight.skippedPaidRedirectItemIds).toEqual([1, 2, 3, 4])
    expect(apiTagCalls.filter(c => c.tags.includes('paid_only')).map(c => c.sourceId).sort()).toEqual([201, 202, 203, 204])
  })
})

describe('v2.3.1 Fix 2: Wix Korean/multilingual autoGoogleSso & logged-in comment-box-placeholder expand (with logged-out redline)', () => {
  it('matches Korean and ES/FR/DE/IT/PT/RU/JA/ZH/EN Google SSO button labels case-insensitively without false positives', () => {
    const validLabels = [
      'Google 로그인',
      'google 로그인',
      'Google로 로그인',
      'Google 계정으로 로그인',
      'Google로 계속하기',
      'Iniciar sesión con Google',
      'Continuar con Google',
      'Se connecter avec Google',
      'Continuer avec Google',
      'Mit Google anmelden',
      'Mit Google fortfahren',
      'Accedi con Google',
      'Entrar com o Google',
      'Войти через Google',
      'Google でログイン',
      '使用 Google 登录',
      'Continue with Google',
      'Log in with Google',
    ]
    for (const label of validLabels) {
      expect(matchesGoogleSsoButtonLabel(label), label).toBe(true)
    }

    const nonGoogleLabels = [
      'Log in with Email',
      'Continue with Facebook',
      'Sign up with Apple',
      'Publish Comment',
      '댓글 게시',
      'Cancel',
    ]
    for (const label of nonGoogleLabels) {
      expect(matchesGoogleSsoButtonLabel(label), label).toBe(false)
    }
  })

  it('recognizes Korean "Google 로그인" in Wix autoGoogleSso, completes OAuth popup + post-SSO collapsed placeholder expand, and publishes live', async () => {
    const wixUrl = 'https://bk21pol.yonsei.ac.kr/post/research-seminar'
    let published = false

    const routes: Record<string, V231Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comments-section">
                  <button data-hook="login-as-member-text-button">로그인하여 댓글 작성</button>
                </div>
              </article>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('login-as-member-text-button')) {
            return {
              mutateHtml: `
                <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <h2>회원 로그인</h2>
                    <button id="ko-google-sso">Google 로그인</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('ko-google-sso')) {
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/o/oauth2/v2/accountchooser',
                    html: `
                      <html><head><title>계정 선택</title></head><body>
                        <div data-identifier="publisher@gmail.com">publisher@gmail.com</div>
                      </body></html>
                    `,
                    onClick: () => ({ nextStep: true }),
                  },
                  {
                    url: 'https://accounts.google.com/signin/oauth/consent',
                    html: `
                      <html><head><title>권한 확인</title></head><body>
                        <button id="ko-consent">계속</button>
                      </body></html>
                    `,
                    onClick: () => ({
                      close: true,
                      // After Google SSO succeeds, Wix renders a collapsed comment-box-placeholder!
                      mutateParentHtml: `
                        <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                          <div id="SITE_CONTAINER">
                            <article data-hook="post">
                              <div data-hook="comment-box">
                                <div data-hook="comment-box-placeholder" role="button">댓글 작성...</div>
                              </div>
                            </article>
                          </div>
                        </body></html>
                      `,
                    }),
                  },
                ],
              },
            }
          }
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SITE_CONTAINER">
                    <article data-hook="post">
                      <div data-hook="comment-box">
                        <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                        <button data-hook="primary-btn">게시</button>
                      </div>
                    </article>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'press' && (selector.includes('comment-box') || selector.includes('contenteditable'))) {
            return {
              mutateHtml: `
                <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SITE_CONTAINER">
                    <article data-hook="post">
                      <div data-hook="comment-box">
                        <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox">Great seminar! <a href="https://demo.example.com">https://demo.example.com</a> </div></div>
                        <button data-hook="primary-btn">게시</button>
                      </div>
                    </article>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            published = true
            routes[wixUrl]!.html = `
              <html><head><title>Yonsei BK21</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item"><p>Great seminar! <a href="https://demo.example.com">https://demo.example.com</a></p></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions, sleepImpl } = createV231MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-ko',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Great seminar!',
        websiteUrl: 'https://demo.example.com',
        autoGoogleSso: true,
        verifyReload: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl },
    )

    expect(published).toBe(true)
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('ko-google-sso'))).toBe(true)
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('comment-box-placeholder'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('auto-clicks collapsed [data-hook="comment-box-placeholder"] when already logged in on Wix (including role=textbox fake placeholder) and publishes cleanly', async () => {
    const wixUrl = 'https://logged-in-79539.wixsite.com/blog/post/ai-tools'
    let expandPending = false
    let expandPolls = 0

    const routes: Record<string, V231Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>Wix Logged-In Collapsed</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comment-box">
                  <div data-hook="comment-box-placeholder" role="textbox" aria-label="Write a comment...">Write a comment...</div>
                </div>
              </article>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            expandPending = true
            return
          }
          if (kind === 'press' && (selector.includes('comment-box') || selector.includes('contenteditable'))) {
            return {
              mutateHtml: `
                <html><head><title>Wix Logged-In Collapsed</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box">
                    <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox">Useful overview <a href="https://demo.example.com">https://demo.example.com</a> </div></div>
                    <button data-hook="primary-btn">Publish</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            routes[wixUrl]!.html = `
              <html><head><title>Wix Logged-In Collapsed</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item"><p>Useful overview <a href="https://demo.example.com">https://demo.example.com</a></p></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions, sleepImpl } = createV231MockPage(routes, {
      onSleepTick: (_tick, _totalMs, ctx) => {
        if (expandPending) {
          expandPolls++
          // Mounts expanded RCE + Publish after 2 polls (~800ms <= 3000ms).
          if (expandPolls === 2) {
            expandPending = false
            ctx.setHtml(`
              <html><head><title>Wix Logged-In Collapsed</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comment-box">
                  <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                  <button data-hook="primary-btn">Publish</button>
                </div>
              </body></html>
            `)
          }
        }
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p-wix-79539',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Useful overview',
        websiteUrl: 'https://demo.example.com',
        verifyReload: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl },
    )

    expect(actions[0]).toMatchObject({ kind: 'click', selector: '[data-hook="comment-box-placeholder"]' })
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('strictly preserves logged-out redline: never clicks placeholder or fills comment-box-rce-wrapper when login-as-member-text-button is visible, and aborts to needs_login if clicking placeholder opens a login wall', async () => {
    // Case A: login-as-member-text-button visible alongside comment-box-placeholder & comment-box-rce-wrapper -> MUST NOT fill or click placeholder.
    const loggedOutUrl = 'https://member-wall.wixsite.com/blog/post/gated'
    const routesA: Record<string, V231Route> = {
      [loggedOutUrl]: {
        html: `
          <html><head><title>Gated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <button data-hook="login-as-member-text-button">Log in to comment</button>
              <div data-hook="comment-box-placeholder">Write a comment...</div>
              <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
              <button data-hook="primary-btn">Publish</button>
            </div>
          </body></html>
        `,
      },
    }
    const mockA = createV231MockPage(routesA)
    const resA = await executeCommentPublish(
      mockA.page as never,
      'p-wix-redline-a',
      {
        kind: 'comment_publish',
        url: loggedOutUrl,
        siteHint: 'wix_blog',
        commentText: 'Should never be filled',
        websiteUrl: 'https://demo.example.com',
        autoGoogleSso: false,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: mockA.sleepImpl },
    )
    expect(resA).toMatchObject({
      outcome: 'needs_login',
      siteType: 'wix',
      submitTriggered: false,
    })
    expect(mockA.actions).toHaveLength(0)

    // Case B: Clicking placeholder pops up a login wall (with autoGoogleSso=false) -> immediately returns needs_login, never fills editor.
    const popupWallUrl = 'https://placeholder-wall.wixsite.com/blog/post/gated2'
    const routesB: Record<string, V231Route> = {
      [popupWallUrl]: {
        html: `
          <html><head><title>Popup Wall Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comment-box">
              <div data-hook="comment-box-placeholder">Write a comment...</div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>Popup Wall Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <h2>Log in to comment</h2>
                    <button>Continue with Google</button>
                  </div>
                  <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                </body></html>
              `,
            }
          }
        },
      },
    }
    const mockB = createV231MockPage(routesB)
    const resB = await executeCommentPublish(
      mockB.page as never,
      'p-wix-redline-b',
      {
        kind: 'comment_publish',
        url: popupWallUrl,
        siteHint: 'wix_blog',
        commentText: 'Should never be filled after wall',
        websiteUrl: 'https://demo.example.com',
        autoGoogleSso: false,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: mockB.sleepImpl },
    )
    expect(resB).toMatchObject({
      outcome: 'needs_login',
      siteType: 'wix',
      submitTriggered: false,
    })
    expect(mockB.actions.filter(a => a.kind === 'fill')).toHaveLength(0)
  })
})

describe('v2.3.1 Fix 3: 10,000-comment WordPress streaming large-page tolerance & fast early-exit for normal pages', () => {
  function buildManyCommentsHtml(count: number, includeForm: boolean): string {
    const items = Array.from({ length: count }, (_, idx) => `<li id="comment-${1000 + idx}"><p>History comment #${idx + 1}</p></li>`).join('')
    const formHtml = includeForm
      ? `<form id="commentform" action="/wp-comments-post.php" method="post">
           <textarea id="comment" name="comment"></textarea>
           <input id="author" name="author" type="text" />
           <input id="email" name="email" type="email" />
           <input id="url" name="url" type="url" />
           <button id="submit" type="submit">Post Comment</button>
         </form>`
      : ''
    return `
      <html>
        <head>
          <title>Huge WP Post</title>
          <link rel="stylesheet" href="/wp-content/themes/blog/style.css" />
        </head>
        <body>
          <header><form role="search" action="/"><input name="s" /></form></header>
          <main>
            <article><h1>Mega Discussion</h1></article>
            <div id="comments" class="comments-area">
              <ol class="comment-list">${items}</ol>
              ${formHtml}
            </div>
          </main>
        </body>
      </html>
    `
  }

  it('dynamically extends form wait window up to 15000ms for streaming high-comment WP pages (>8s <=15s), scrolls #commentform into view immediately once mounted, and submits cleanly', async () => {
    expect(DEFAULT_LARGE_WP_FORM_WAIT_MAX_MS).toBe(15_000)

    const wpUrl = 'https://mega-wp.example.org/post-77998/'
    const redirectedUrl = 'https://mega-wp.example.org/post-77998/#comment-99999'

    const routes: Record<string, V231Route> = {
      [wpUrl]: {
        readyState: 'loading',
        html: buildManyCommentsHtml(40, false),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return { navigateTo: redirectedUrl }
          }
        },
      },
      [redirectedUrl]: {
        readyState: 'complete',
        html: `
          <html><head><title>Huge WP Post</title></head><body>
            <div id="comments">
              <li id="comment-99999"><a href="https://demo.example.com">Alex</a><p>Helpful breakdown!</p></li>
            </div>
          </body></html>
        `,
      },
    }

    let formMountedAtMs = 0
    const { page, scrollIntoViewCalls, sleepImpl, getSleepStats } = createV231MockPage(routes, {
      onSleepTick: (tick, totalMs, ctx) => {
        if (ctx.getUrl() !== wpUrl) return
        // Stream more comments as time progresses; mount #commentform at tick 22 (~9,900ms: > 8s and <= 15s) while readyState is STILL 'loading'!
        if (tick < 22) {
          ctx.setHtml(buildManyCommentsHtml(40 + tick * 5, false), 'loading')
        } else if (tick === 22) {
          formMountedAtMs = totalMs
          ctx.setHtml(buildManyCommentsHtml(200, true), 'loading')
        }
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p-wp-77998',
      {
        kind: 'comment_publish',
        url: wpUrl,
        siteHint: 'wordpress_comment',
        commentText: 'Helpful breakdown!',
        authorName: 'Alex',
        authorEmail: 'alex@screwdom.org',
        websiteUrl: 'https://demo.example.com',
        verifyReload: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl },
    )

    expect(formMountedAtMs).toBeGreaterThan(8_000)
    expect(formMountedAtMs).toBeLessThanOrEqual(15_000)
    // Stopped immediately once #commentform mounted (did not stall until 15s cap or readyState=complete).
    expect(getSleepStats().totalMs).toBeLessThan(12_000)
    expect(scrollIntoViewCalls.some(s => s.includes('commentform') || s.includes('comment'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: redirectedUrl,
      submitTriggered: true,
    })
  })

  it('fast early-exits on normal complete no-form pages with 0ms commit wait (no slowdown)', async () => {
    const staticUrl = 'https://static-site.example.org/about'
    const routes: Record<string, V231Route> = {
      [staticUrl]: {
        readyState: 'complete',
        html: '<html><head><title>About Us</title></head><body><main><h1>About</h1><p>Static company page with no comments.</p></main></body></html>',
      },
    }

    const { page, sleepImpl, getSleepStats } = createV231MockPage(routes)
    await navigateCommentPageWithCommit(page as never, staticUrl, {
      timeoutMs: 15_000,
      sleep: sleepImpl,
    })

    // Zero polls / zero sleep during commit wait on already-complete no-form pages.
    expect(getSleepStats()).toEqual({ ticks: 0, totalMs: 0 })

    // Full comment_publish also finishes quickly using only base lazy wait (never extending to 15s).
    const res = await executeCommentPublish(
      page as never,
      'p-static-fast',
      { kind: 'comment_publish', url: staticUrl, commentText: 'Hi', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl },
    )
    expect(res.outcome).toBe('needs_llm_fallback')
    expect(getSleepStats().totalMs).toBeLessThanOrEqual(3_000)
  })

  it('remains fully compatible with WP new #comment-ID cached submission and wp_die 403 validation on large WP pages', async () => {
    // 1. Cached new #comment-ID on large WP page -> submitted (wp_new_comment_id_assigned)
    const cachedWpUrl = 'https://cached-mega.example.org/post-77994/'
    const newCommentUrl = 'https://cached-mega.example.org/post-77994/#comment-50001'
    const routesCached: Record<string, V231Route> = {
      [cachedWpUrl]: {
        readyState: 'loading',
        html: buildManyCommentsHtml(35, true),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return { navigateTo: newCommentUrl }
          }
        },
      },
      [newCommentUrl]: {
        readyState: 'complete',
        html: buildManyCommentsHtml(35, true), // stale full-page cache without #comment-50001
      },
    }
    const mockCached = createV231MockPage(routesCached)
    const resCached = await executeCommentPublish(
      mockCached.page as never,
      'p-wp-77994',
      {
        kind: 'comment_publish',
        url: cachedWpUrl,
        commentText: 'Great post',
        authorName: 'Alex',
        authorEmail: 'alex@screwdom.org',
        websiteUrl: 'https://demo.example.com',
        verifyReload: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: mockCached.sleepImpl },
    )
    expect(resCached).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      reason: 'wp_new_comment_id_assigned',
      publicUrl: newCommentUrl,
      submitTriggered: true,
    })

    // 2. wp_die 403 form validation on large WP page -> needs_llm_fallback (wp_die_validation_error, not blocked_waf)
    const wpDieUrl = 'https://wpdie-mega.example.org/post-78000/'
    const wpDiePostUrl = 'https://wpdie-mega.example.org/wp-comments-post.php'
    const routesDie: Record<string, V231Route> = {
      [wpDieUrl]: {
        readyState: 'complete',
        html: buildManyCommentsHtml(35, true),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              emitResponses: [
                {
                  url: wpDiePostUrl,
                  status: 403,
                  body: '<body id="error-page"><div class="wp-die-message">Error: Please add a rating before submitting.</div></body>',
                },
              ],
              navigateTo: wpDiePostUrl,
            }
          }
        },
      },
      [wpDiePostUrl]: {
        readyState: 'complete',
        html: '<html lang="en"><head><title>Comment Submission Failure</title></head><body id="error-page"><div class="wp-die-message">Error: Please add a rating before submitting.</div></body></html>',
      },
    }
    const mockDie = createV231MockPage(routesDie)
    const resDie = await executeCommentPublish(
      mockDie.page as never,
      'p-wp-78000',
      {
        kind: 'comment_publish',
        url: wpDieUrl,
        commentText: 'Great post',
        authorName: 'Alex',
        authorEmail: 'alex@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: mockDie.sleepImpl },
    )
    expect(resDie).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wordpress',
      reason: 'wp_die_validation_error',
      httpStatus: 403,
      submitTriggered: false,
    })
  })
})
