import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WIX_LAZY_WAIT_MAX_MS,
  DEFAULT_WIX_NAV_TIMEOUT_MS,
  detectPostSubmitWafBlock,
  executeCommentPublish,
  INSPECT_COMMENT_PAGE_SCRIPT,
  type CommentPageInspection,
} from '../src/host/browser-playwright/comment-publish.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import { BrowserSessionManager, createBrowserToolHandler, formatMcpBrowserOutput } from '../src/mcp/browser-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'
import { detectTimeoutClusters, type PreflightRetryableItem } from '../src/mcp/preflight.ts'

interface MockResponseSpec {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface MockFrameRoute {
  url: string
  name?: string
  html: string
  onAction?: (kind: string, selector: string, value?: string) => { mutateHtml?: string } | void
}

interface MockPageRoute {
  html: string
  frames?: MockFrameRoute[]
  onScroll?: (fraction: number, count: number) => string | void
  onInspect?: (count: number) => string | void
  onAction?: (kind: string, selector: string, value?: string) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponse?: MockResponseSpec
    navResponse?: MockResponseSpec
    throwOnClick?: Error
  } | void
}

function createV221MockPage(routes: Record<string, MockPageRoute>) {
  const buildDom = (html: string, url: string) => {
    const next = new JSDOM(html, { url, runScripts: 'outside-only' })
    next.window.scrollTo = () => {}
    next.window.HTMLElement.prototype.scrollIntoView = () => {}
    return next
  }

  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let dom = buildDom(routes[currentUrl]?.html ?? '<html></html>', currentUrl)
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const gotoCalls: Array<{ url: string; timeout?: number; waitUntil?: string }> = []
  const pageHandlers: Record<string, Array<(arg: unknown) => void>> = {}
  let scrollCount = 0
  let inspectCount = 0
  let pendingNavResponse: MockResponseSpec | undefined

  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false }
  const activeRoute = () => routes[currentUrl] ?? routes[currentUrl.split('#')[0]!]

  const loadRoute = (targetUrl: string) => {
    const cleanTarget = targetUrl.split('#')[0]!
    const route = routes[targetUrl] ?? routes[cleanTarget]
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    dom = buildDom(route.html, targetUrl)
  }

  const runWithDomGlobals = <T>(targetDom: JSDOM, fn: () => T): T => {
    const prevDoc = globalThis.document
    const prevLoc = globalThis.location
    const prevWin = globalThis.window
    const prevNF = globalThis.NodeFilter
    Object.defineProperty(globalThis, 'document', { value: targetDom.window.document, configurable: true })
    Object.defineProperty(globalThis, 'location', { value: targetDom.window.location, configurable: true })
    Object.defineProperty(globalThis, 'window', { value: targetDom.window, configurable: true })
    Object.defineProperty(globalThis, 'NodeFilter', { value: targetDom.window.NodeFilter, configurable: true })
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

  const makeDisabledChecks = (resolveEl: () => Element | null) => ({
    isDisabled: async () => {
      const el = resolveEl() as (HTMLElement & { disabled?: boolean }) | null
      if (!el) return false
      return el.disabled === true || el.hasAttribute('disabled')
    },
    getAttribute: async (attr: string) => {
      const el = resolveEl()
      return el ? el.getAttribute(attr) : null
    },
    evaluate: async <R>(fn: (node: unknown) => R) => fn(resolveEl()),
  })

  const makeFrameApi = (spec: MockFrameRoute) => {
    let frameDom = buildDom(spec.html, spec.url)
    return {
      url: () => spec.url,
      name: () => spec.name ?? '',
      isDetached: () => false,
      evaluate: async (scriptOrFn: unknown, arg?: unknown) => {
        if (typeof scriptOrFn === 'string') return frameDom.window.eval(scriptOrFn)
        return runWithDomGlobals(frameDom, () => (scriptOrFn as (a?: unknown) => unknown)(arg))
      },
      locator: (selector: string) => {
        const resolveEl = () => frameDom.window.document.querySelector(selector)
        const api = {
          ...makeDisabledChecks(resolveEl),
          fill: async (val: string) => {
            actions.push({ kind: 'frame:fill', selector, value: val })
            const el = resolveEl() as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
            if (!el) throw new Error(`Missing frame element for fill: ${selector}`)
            if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) {
              ;(el as HTMLInputElement).value = val
            } else {
              el.textContent = val
            }
            const eff = spec.onAction?.('fill', selector, val)
            if (eff?.mutateHtml) {
              spec.html = eff.mutateHtml
              frameDom = buildDom(eff.mutateHtml, spec.url)
            }
          },
          selectOption: async (val: string) => {
            actions.push({ kind: 'frame:select', selector, value: val })
            const el = resolveEl() as HTMLSelectElement | null
            if (el) el.value = val
            const eff = spec.onAction?.('select', selector, val)
            if (eff?.mutateHtml) {
              spec.html = eff.mutateHtml
              frameDom = buildDom(eff.mutateHtml, spec.url)
            }
          },
          click: async () => {
            actions.push({ kind: 'frame:click', selector })
            const el = resolveEl() as (HTMLElement & { disabled?: boolean }) | null
            if (!el) throw new Error(`Missing frame element for click: ${selector}`)
            if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
              throw new Error(`locator.click: Timeout 10000ms exceeded (element is disabled: ${selector})`)
            }
            const eff = spec.onAction?.('click', selector)
            if (eff?.mutateHtml) {
              spec.html = eff.mutateHtml
              frameDom = buildDom(eff.mutateHtml, spec.url)
            }
          },
        }
        return { ...api, first: () => api }
      },
    }
  }

  const frameApisCache = new WeakMap<MockFrameRoute, ReturnType<typeof makeFrameApi>>()

  const emitResponse = (spec: MockResponseSpec) => {
    const respObj = {
      url: () => spec.url,
      status: () => spec.status,
      headers: () => spec.headers ?? {},
      text: async () => spec.body ?? '',
      request: () => ({
        method: () => spec.method ?? 'POST',
        resourceType: () => spec.resourceType ?? 'document',
      }),
    }
    for (const fn of pageHandlers.response ?? []) {
      fn(respObj)
    }
    return respObj
  }

  const page = {
    isClosed: () => false,
    on: (ev: string, fn: (arg: unknown) => void) => {
      ;(pageHandlers[ev] ??= []).push(fn)
    },
    off: (ev: string, fn: (arg: unknown) => void) => {
      const list = pageHandlers[ev]
      if (!list) return
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    },
    url: () => currentUrl,
    title: async () => dom.window.document.title || '',
    mainFrame: () => mainFrameStub,
    frames: () => {
      const specs = activeRoute()?.frames ?? []
      return [
        mainFrameStub,
        ...specs.map(spec => {
          let cached = frameApisCache.get(spec)
          if (!cached) {
            cached = makeFrameApi(spec)
            frameApisCache.set(spec, cached)
          }
          return cached
        }),
      ]
    },
    keyboard: {
      press: async (key: string) => {
        actions.push({ kind: 'keyboard:press', value: key })
      },
    },
    goto: async (url: string, opts?: { timeout?: number; waitUntil?: string }) => {
      gotoCalls.push({
        url,
        ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
        ...(opts?.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }),
      })
      actions.push({ kind: 'goto', value: url })
      loadRoute(url)
    },
    waitForNavigation: async () => {
      await Promise.resolve()
      if (!pendingNavResponse) return null
      const spec = pendingNavResponse
      pendingNavResponse = undefined
      return {
        url: () => spec.url,
        status: () => spec.status,
        headers: () => spec.headers ?? {},
      }
    },
    waitForLoadState: async () => {},
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      const route = activeRoute()
      if (typeof fnOrScript === 'function' && typeof arg === 'number') {
        const idx = scrollCount++
        const mutated = route?.onScroll?.(arg, idx)
        if (mutated) {
          route!.html = mutated
          dom = buildDom(mutated, currentUrl)
        }
      }
      if (typeof fnOrScript === 'string') {
        if (fnOrScript.includes('wixHasCommentSection')) {
          const mutated = route?.onInspect?.(++inspectCount)
          if (mutated) {
            route!.html = mutated
            dom = buildDom(mutated, currentUrl)
          }
        }
        return dom.window.eval(fnOrScript)
      }
      return runWithDomGlobals(dom, () => (fnOrScript as (a?: unknown) => unknown)(arg))
    },
    locator: (selector: string) => {
      const resolveFirst = () => dom.window.document.querySelector(selector)
      const count = async () => dom.window.document.querySelectorAll(selector).length
      const firstApi = {
        ...makeDisabledChecks(resolveFirst),
        scrollIntoViewIfNeeded: async () => {},
        fill: async (val: string) => {
          actions.push({ kind: 'fill', selector, value: val })
          const el = resolveFirst() as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
          if (!el) throw new Error(`Missing element for fill: ${selector}`)
          if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) {
            ;(el as HTMLInputElement).value = val
          } else {
            el.textContent = val
          }
          const eff = activeRoute()?.onAction?.('fill', selector, val)
          if (eff?.mutateHtml) {
            activeRoute()!.html = eff.mutateHtml
            dom = buildDom(eff.mutateHtml, currentUrl)
          }
        },
        click: async () => {
          actions.push({ kind: 'click', selector })
          const el = resolveFirst() as (HTMLElement & { disabled?: boolean }) | null
          if (el && (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')) {
            throw new Error(`locator.click: Timeout 10000ms exceeded (element is disabled: ${selector})`)
          }
          const eff = activeRoute()?.onAction?.('click', selector)
          if (eff?.throwOnClick) {
            throw eff.throwOnClick
          }
          if (eff?.emitResponse) {
            emitResponse(eff.emitResponse)
          }
          if (eff?.navResponse) {
            pendingNavResponse = eff.navResponse
          }
          if (eff?.mutateHtml) {
            activeRoute()!.html = eff.mutateHtml
            dom = buildDom(eff.mutateHtml, currentUrl)
          }
          if (eff?.navigateTo) {
            loadRoute(eff.navigateTo)
          }
        },
        press: async (key: string) => {
          actions.push({ kind: 'press', selector, value: key })
          const eff = activeRoute()?.onAction?.('press', selector, key)
          if (eff?.mutateHtml) {
            activeRoute()!.html = eff.mutateHtml
            dom = buildDom(eff.mutateHtml, currentUrl)
          }
        },
      }
      return { ...firstApi, first: () => firstApi, count }
    },
  }

  return { page, actions, gotoCalls, getScrollCount: () => scrollCount }
}

describe('v2.2.1 Fix 1: Wix slow lazy-load, logged-in RCE, empty placeholder no_form, disabled button & Thai moderation dialog', () => {
  it('waits up to 14-15s for 11-13s slow Wix comments, early-exits immediately once ready, and relaxes initial goto to 15000ms for siteHint=wix_blog', async () => {
    expect(DEFAULT_WIX_LAZY_WAIT_MAX_MS).toBeGreaterThanOrEqual(14_000)
    expect(DEFAULT_WIX_LAZY_WAIT_MAX_MS).toBeLessThanOrEqual(15_000)
    expect(DEFAULT_WIX_NAV_TIMEOUT_MS).toBe(15_000)

    const slowUrl = 'https://slow-freecreate-wix.example.com/post/guide-2026'
    let simulatedElapsedMs = 0
    let pollsBeforeReady = 0
    let triggerClicked = false

    const routes: Record<string, MockPageRoute> = {
      [slowUrl]: {
        html: `
          <html><head><title>Slow Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER"><article data-hook="post"><div data-hook="comments-section-placeholder"></div></article></div>
          </body></html>
        `,
        onScroll: (_fraction, scrollIdx) => {
          // Simulates rendering `Write a comment...` at ~12s (poll index 29 * 400ms = 11.6-12s).
          if (scrollIdx === 29) {
            return `
              <html><head><title>Slow Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div id="SITE_CONTAINER">
                  <article data-hook="post">
                    <div data-hook="comment-box">
                      <button data-hook="comment-box-placeholder">Write a comment...</button>
                    </div>
                  </article>
                </div>
              </body></html>
            `
          }
        },
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            triggerClicked = true
            return {
              mutateHtml: `
                <html><head><title>Slow Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box">
                    <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                    <button data-hook="primary-btn">Publish</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }

    const { page, gotoCalls } = createV221MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-slow',
      {
        kind: 'comment_publish',
        url: slowUrl,
        siteHint: 'wix_blog',
        commentText: 'Great walkthrough!',
        probeOnly: true,
      },
      {
        defaultTimeoutMs: 10_000,
        sleepImpl: async (ms) => {
          simulatedElapsedMs += ms
          if (!triggerClicked) pollsBeforeReady++
        },
      },
    )

    // Initial domcontentloaded timeout relaxed to 15000ms for siteHint === 'wix_blog'.
    expect(gotoCalls[0]).toMatchObject({ url: slowUrl, timeout: 15_000, waitUntil: 'domcontentloaded' })
    // Waited past the old 9s cap (~12s) and exited immediately on poll #30 without running all 38 polls.
    expect(pollsBeforeReady).toBe(30)
    expect(simulatedElapsedMs).toBeGreaterThanOrEqual(11_600)
    expect(simulatedElapsedMs).toBeLessThan(14_000)
    expect(triggerClicked).toBe(true)
    expect(res).toMatchObject({ outcome: 'form_ready', siteType: 'wix', submitTriggered: false })

    // Fast Wix site exits immediately with 0 lazy-wait polls.
    const fastUrl = 'https://fast-wix.example.com/post/instant'
    let fastSleeps = 0
    const { page: fastPage } = createV221MockPage({
      [fastUrl]: {
        html: `
          <html><head><title>Fast Wix</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
            <button data-hook="primary-btn">Publish</button>
          </body></html>
        `,
      },
    })
    const fastRes = await executeCommentPublish(
      fastPage as never,
      'p-wix-fast',
      { kind: 'comment_publish', url: fastUrl, siteHint: 'wix_blog', commentText: 'Quick', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => { fastSleeps++ } },
    )
    expect(fastSleeps).toBe(0)
    expect(fastRes).toMatchObject({ outcome: 'form_ready', siteType: 'wix' })

    // MCP browser tool also relaxes navigate timeout to 15000ms when siteHint=wix_blog.
    const capturedCmds: Array<Record<string, unknown>> = []
    const mgr = new BrowserSessionManager({
      id: 'mock-wix-nav',
      available: () => true,
      open: async () => ({
        act: async (cmd) => {
          capturedCmds.push(cmd as unknown as Record<string, unknown>)
          return {
            kind: 'page',
            page: 'p1',
            url: slowUrl,
            title: 'Wix',
            text: 'ok',
            truncated: false,
          }
        },
        close: async () => {},
      }),
    })
    const handle = createBrowserToolHandler({ sessionManager: mgr, config: resolveMcpConfig({}) })
    await handle({ action: 'navigate', url: slowUrl, siteHint: 'wix_blog' })
    expect(capturedCmds[0]).toMatchObject({ kind: 'navigate', siteHint: 'wix_blog', timeoutMs: 15_000 })
  })

  it('prioritizes visible logged-in Wix comment-box-rce-wrapper + Publish without being blocked by leftover comment-count or placeholder', async () => {
    const url = 'https://connectedbrighton.com/post/community-update'
    // Deeply nested (10 divs inside comment-box-rce-wrapper) + leftover comment-count + leftover placeholder.
    const nestedOpen = '<div>'.repeat(10)
    const nestedClose = '</div>'.repeat(10)
    const routes: Record<string, MockPageRoute> = {
      [url]: {
        html: `
          <html><head><title>Connected Brighton</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <header><a href="/login">Log in to comment</a></header>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <span data-hook="comment-count">4 comments</span>
                <div data-hook="comments-section-placeholder"></div>
                <section class="comments-host">
                  <div data-hook="comment-box-rce-wrapper">
                    ${nestedOpen}<div contenteditable="true" role="textbox" class="tiptap ProseMirror"></div>${nestedClose}
                  </div>
                  <button type="button" data-hook="primary-btn">Publish</button>
                </section>
              </article>
            </div>
          </body></html>
        `,
        onAction: (kind, _selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: routes[url]!.html.replace(
                '<div contenteditable="true" role="textbox" class="tiptap ProseMirror"></div>',
                '<div contenteditable="true" role="textbox" class="tiptap ProseMirror">Great local roundup <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && _selector.includes('primary-btn')) {
            routes[url]!.html = `
              <html><head><title>Connected Brighton</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="comment-item">Great local roundup <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createV221MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-loggedin',
      {
        kind: 'comment_publish',
        url,
        siteHint: 'wix_blog',
        commentText: 'Great local roundup',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('primary-btn'))).toBe(true)
  })

  it('safely classifies permanently empty Wix comments-section-placeholder as no_form while preserving guardrails against loading/count/login/Write a comment', async () => {
    // 1. Closed-comments Wix blog (#1281): empty comments-section-placeholder after full wait -> no_form!
    const closedWixUrl = 'https://closed-wix-blog.example.com/post/no-comments-enabled'
    const { page: closedPage, getScrollCount } = createV221MockPage({
      [closedWixUrl]: {
        html: `
          <html><head><title>Closed Wix Post</title><script src="https://static.parastorage.com/communities-blog-ooi/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <h1 data-hook="post-title">Announcement</h1>
                <p>Standard article content without comments enabled.</p>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
      },
    })

    const closedRes = await executeCommentPublish(
      closedPage as never,
      'p-wix-empty-placeholder',
      { kind: 'comment_publish', url: closedWixUrl, siteHint: 'wix_blog', commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 1_200, sleepImpl: async () => {} },
    )

    expect(getScrollCount()).toBeGreaterThanOrEqual(3)
    expect(closedRes).toMatchObject({
      outcome: 'no_form',
      siteType: 'wix',
      suggestedTags: ['no_form'],
      submitTriggered: false,
    })

    // 2. Guardrail A: non-zero comment-count alongside empty placeholder -> MUST NOT return no_form!
    const withCountUrl = 'https://hascount-wix.example.com/post/active'
    const { page: withCountPage } = createV221MockPage({
      [withCountUrl]: {
        html: `
          <html><head><title>Has Count</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <span data-hook="comment-count">3 comments</span>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
      },
    })
    const withCountRes = await executeCommentPublish(
      withCountPage as never,
      'p-wix-with-count',
      { kind: 'comment_publish', url: withCountUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 800, sleepImpl: async () => {} },
    )
    expect(withCountRes.outcome).toBe('needs_llm_fallback')
    expect(withCountRes.suggestedTags).toBeUndefined()

    // 3. Guardrail B: loading spinner / skeleton alongside empty placeholder -> MUST NOT return no_form!
    const loadingUrl = 'https://loading-wix.example.com/post/loading'
    const { page: loadingPage } = createV221MockPage({
      [loadingUrl]: {
        html: `
          <html><head><title>Loading</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comments-section-placeholder"></div>
                <div role="progressbar" aria-busy="true"></div>
              </article>
            </div>
          </body></html>
        `,
      },
    })
    const loadingRes = await executeCommentPublish(
      loadingPage as never,
      'p-wix-loading',
      { kind: 'comment_publish', url: loadingUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 800, sleepImpl: async () => {} },
    )
    expect(loadingRes.outcome).toBe('needs_llm_fallback')

    // 4. Guardrail C: login wall alongside empty placeholder -> needs_login, never no_form!
    const loginWallUrl = 'https://loginwall-wix.example.com/post/members'
    const { page: loginWallPage } = createV221MockPage({
      [loginWallUrl]: {
        html: `
          <html><head><title>Members Only</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comments-section-placeholder"></div>
                <button data-hook="login-as-member-text-button">Log in to comment</button>
              </article>
            </div>
          </body></html>
        `,
      },
    })
    const loginWallRes = await executeCommentPublish(
      loginWallPage as never,
      'p-wix-loginwall',
      { kind: 'comment_publish', url: loginWallUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 800, sleepImpl: async () => {} },
    )
    expect(loginWallRes.outcome).toBe('needs_login')

    // 5. Guardrail D: non-empty placeholder containing text or "Write a comment" -> MUST NOT return no_form!
    const promptUrl = 'https://prompt-wix.example.com/post/prompt'
    const { page: promptPage } = createV221MockPage({
      [promptUrl]: {
        html: `
          <html><head><title>Prompt</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <p>Write a comment below</p>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
      },
    })
    const promptRes = await executeCommentPublish(
      promptPage as never,
      'p-wix-prompt',
      { kind: 'comment_publish', url: promptUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 800, sleepImpl: async () => {} },
    )
    expect(promptRes.outcome).toBe('needs_llm_fallback')
  })

  it('gracefully degrades disabled submit buttons without throwing click timeout (needs_llm_fallback or needs_login)', async () => {
    // 1. Migrated React comment box with leftover wixstatic image and disabled Post button (no login UI) -> curefipeurope.com case.
    const reactUrl = 'https://curefipeurope.com/blog/fip-guide'
    const { page: reactPage, actions: reactActions } = createV221MockPage({
      [reactUrl]: {
        html: `
          <html><head><title>Cure FIP Europe</title></head><body>
            <img src="https://static.wixstatic.com/media/banner.png" />
            <main>
              <form class="react-comments">
                <textarea placeholder="Write a comment..."></textarea>
                <input name="website" type="url" />
                <button type="submit" id="react-post-btn" disabled>Post</button>
              </form>
            </main>
          </body></html>
        `,
      },
    })

    const reactRes = await executeCommentPublish(
      reactPage as never,
      'p-disabled-react',
      {
        kind: 'comment_publish',
        url: reactUrl,
        siteHint: 'wix_blog',
        commentText: 'Helpful medical resource.',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(reactRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      reason: 'submit_button_disabled',
      submitTriggered: false,
    })
    expect(reactActions.some(a => a.kind === 'click' && a.selector?.includes('react-post-btn'))).toBe(false)

    // 2. aria-disabled="true" submit button with explicit login prompt -> needs_login!
    const ariaDisabledUrl = 'https://aria-login.example.com/blog/post'
    const { page: ariaPage, actions: ariaActions } = createV221MockPage({
      [ariaDisabledUrl]: {
        html: `
          <html><head><title>Login Required Blog</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <p>You must be logged in to post a comment.</p>
              <a href="/wp-login.php">Sign in</a>
              <textarea name="comment"></textarea>
              <button type="submit" id="submit" aria-disabled="true">Post Comment</button>
            </form>
          </body></html>
        `,
      },
    })
    const ariaRes = await executeCommentPublish(
      ariaPage as never,
      'p-aria-disabled-login',
      {
        kind: 'comment_publish',
        url: ariaDisabledUrl,
        commentText: 'Great article.',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(ariaRes).toMatchObject({
      outcome: 'needs_login',
      siteType: 'wordpress',
      submitTriggered: false,
    })
    expect(ariaActions.some(a => a.kind === 'click' && a.selector?.includes('submit'))).toBe(false)
  })

  it('recognizes Thai Wix moderation dialog ("รับทราบ") as submitted and cleanly dismisses it', async () => {
    for (const variant of [
      {
        name: 'Thai moderation text + รับทราบ button',
        dialogHtml: '<div role="dialog"><p>ความคิดเห็นของคุณรอการอนุมัติจากเจ้าของเว็บไซต์</p><button id="thai-ack-btn">รับทราบ</button></div>',
      },
      {
        name: 'Thai dialog with รับทราบ confirm button only (no English copy)',
        dialogHtml: '<div role="dialog"><p>ส่งความคิดเห็นเรียบร้อยแล้ว</p><button id="thai-ack-btn">รับทราบ</button></div>',
      },
    ]) {
      const thUrl = 'https://th-blog.wixsite.com/site/post/thai-guide'
      let dialogClosed = false
      const routes: Record<string, MockPageRoute> = {
        [thUrl]: {
          html: `
            <html><head><title>Thai Wix Blog</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
              <div data-hook="comments-section">
                <div data-hook="comment-box">
                  <textarea placeholder="Write a comment..."></textarea>
                  <input name="website" type="url" />
                  <button data-hook="submit-comment-button">เผยแพร่</button>
                </div>
              </div>
            </body></html>
          `,
          onAction: (kind, selector) => {
            if (kind === 'click' && selector.includes('submit-comment-button')) {
              return {
                mutateHtml: `<html><head><title>Thai Wix Blog</title></head><body>${variant.dialogHtml}</body></html>`,
              }
            }
            if (kind === 'click' && selector.includes('thai-ack-btn')) {
              dialogClosed = true
              return {
                mutateHtml: '<html><head><title>Thai Wix Blog</title></head><body><main>Done</main></body></html>',
              }
            }
          },
        },
      }

      const { page } = createV221MockPage(routes)
      const res = await executeCommentPublish(
        page as never,
        'p-wix-thai',
        {
          kind: 'comment_publish',
          url: thUrl,
          commentText: 'บทความดีมาก',
          websiteUrl: 'https://demo.example.com',
        },
        { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
      )

      expect(res, variant.name).toMatchObject({
        outcome: 'submitted',
        siteType: 'wix',
        submitTriggered: true,
      })
      expect(dialogClosed, variant.name).toBe(true)
    }
  })
})

describe('v2.2.1 Fix 2: WordPress POST /wp-comments-post.php 403 / WAF -> blocked_waf', () => {
  it('directly returns blocked_waf with httpStatus, postSubmitSnippet, and waf_403 tag on HTTP 403 from /wp-comments-post.php', async () => {
    const postUrl = 'https://nichenest.xyz/best-ai-tools/'
    const wpPostEndpoint = 'https://nichenest.xyz/wp-comments-post.php'

    const routes: Record<string, MockPageRoute> = {
      [postUrl]: {
        html: `
          <html><head><title>NicheNest Blog</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea name="comment"></textarea>
              <input name="author" type="text" />
              <input name="email" type="email" />
              <input name="url" type="url" />
              <button type="submit" id="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              emitResponse: {
                url: wpPostEndpoint,
                status: 403,
                headers: { server: 'LiteSpeed' },
                body: '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><p>Access to this resource on the server is denied! Proudly powered by LiteSpeed Web Server.</p></body></html>',
              },
              navigateTo: wpPostEndpoint,
            }
          }
        },
      },
      [wpPostEndpoint]: {
        html: `
          <html><head><title>403 Forbidden</title></head><body>
            <h1>403 Forbidden</h1>
            <p>Access to this resource on the server is denied! Proudly powered by LiteSpeed Web Server.</p>
          </body></html>
        `,
      },
    }

    const { page, gotoCalls } = createV221MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wp-403',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Useful comparison.',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'blocked_waf',
      siteType: 'wordpress',
      httpStatus: 403,
      postSubmitUrl: wpPostEndpoint,
      reason: 'waf_http_403',
      templateSignature: 'wordpress:waf_litespeed',
      suggestedTags: ['waf_403'],
      submitTriggered: true,
    })
    expect(res.postSubmitSnippet).toContain('403 Forbidden')
    expect(res.postSubmitSnippet).toContain('LiteSpeed')
    // Did NOT waste a reload round-trip after 403 WAF block.
    expect(gotoCalls).toHaveLength(1)

    // MCP formatter serializes blocked_waf and httpStatus cleanly.
    const formatted = formatMcpBrowserOutput(res, 4_500)
    expect(formatted).toContain('comment_publish: blocked_waf (wordpress)')
    expect(formatted).toContain('"httpStatus":403')
  })

  it('classifies HTTP 406/429 with WAF fingerprints and DOM-only /wp-comments-post.php 403 pages as blocked_waf', () => {
    expect(detectPostSubmitWafBlock({
      httpStatus: 406,
      responseHeaders: { server: 'Apache' },
      postSubmitSnippet: 'Not Acceptable - ModSecurity Action: Access Denied',
    })).toMatchObject({ blocked: true, httpStatus: 406, provider: 'modsecurity' })

    expect(detectPostSubmitWafBlock({
      httpStatus: 429,
      responseHeaders: { 'cf-ray': '8abc-SJC' },
      postSubmitSnippet: 'Attention Required! Cloudflare - Too Many Requests',
    })).toMatchObject({ blocked: true, httpStatus: 429, provider: 'cloudflare' })

    expect(detectPostSubmitWafBlock({
      httpStatus: 429,
      responseHeaders: { server: 'nginx' },
      postSubmitSnippet: 'Please slow down and try again in a minute.',
    })).toEqual({ blocked: false })

    expect(detectPostSubmitWafBlock({
      postSubmitUrl: 'https://site.example.com/wp-comments-post.php',
      title: '403 Forbidden',
      postSubmitSnippet: '403 Forbidden - Sucuri WebSite Firewall - Access Denied',
    })).toMatchObject({ blocked: true, httpStatus: 403, provider: 'sucuri' })
  })
})

describe('v2.2.1 Fix 3: batch_preflight timeoutClusters prefix + mid-slug n-gram merging', () => {
  it('merges /nano-banana-pro-* prefix timeouts with mid-slug /how-nano-banana-pro-*, /the-science-behind-nano-banana-pro/, and /discover-the-power-of-nano-banana-pro/ into one cluster', () => {
    const items: PreflightRetryableItem[] = [
      // 10 prefix URLs (like #1183)
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: idx + 1,
        sourceId: 100 + idx,
        host: `farm${idx + 1}.example.org`,
        url: `https://farm${idx + 1}.example.org/nano-banana-pro-variant-${idx + 1}`,
        reason: 'timeout' as const,
      })),
      // 3 mid-slug URLs previously missed by prefix-only clustering
      {
        id: 11,
        sourceId: 111,
        host: 'mid1.example.org',
        url: 'https://mid1.example.org/how-nano-banana-pro-transforms-editing',
        reason: 'timeout',
      },
      {
        id: 12,
        sourceId: 112,
        host: 'mid2.example.org',
        url: 'https://mid2.example.org/the-science-behind-nano-banana-pro/',
        reason: 'timeout',
      },
      {
        id: 13,
        sourceId: 113,
        host: 'mid3.example.org',
        url: 'https://mid3.example.org/discover-the-power-of-nano-banana-pro/',
        reason: 'timeout',
      },
      // Separate unrelated cluster
      {
        id: 21,
        sourceId: 121,
        host: 'other1.example.org',
        url: 'https://other1.example.org/blog/flux-kontext-studio-guide',
        reason: 'timeout',
      },
      {
        id: 22,
        sourceId: 122,
        host: 'other2.example.org',
        url: 'https://other2.example.org/articles/why-flux-kontext-studio-wins',
        reason: 'timeout',
      },
      {
        id: 23,
        sourceId: 123,
        host: 'other3.example.org',
        url: 'https://other3.example.org/flux-kontext-studio-review/',
        reason: 'timeout',
      },
    ]

    const clusters = detectTimeoutClusters(items)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toMatchObject({
      pattern: '/*nano-banana-pro*',
      count: 13,
      itemIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    })
    expect(clusters[1]).toMatchObject({
      pattern: '/*flux-kontext-studio*',
      count: 3,
      itemIds: [21, 22, 23],
    })

    // Numeric dates / short stopwords do not create false clusters.
    const noisyItems: PreflightRetryableItem[] = [
      { id: 31, sourceId: 201, host: 'n1.example.org', url: 'https://n1.example.org/2026-01-alpha', reason: 'timeout' },
      { id: 32, sourceId: 202, host: 'n2.example.org', url: 'https://n2.example.org/2026-01-beta', reason: 'timeout' },
      { id: 33, sourceId: 203, host: 'n3.example.org', url: 'https://n3.example.org/2026-01-gamma', reason: 'timeout' },
      { id: 34, sourceId: 204, host: 'n4.example.org', url: 'https://n4.example.org/how-the-of-one', reason: 'timeout' },
      { id: 35, sourceId: 205, host: 'n5.example.org', url: 'https://n5.example.org/how-the-of-two', reason: 'timeout' },
      { id: 36, sourceId: 206, host: 'n6.example.org', url: 'https://n6.example.org/how-the-of-three', reason: 'timeout' },
    ]
    expect(detectTimeoutClusters(noisyItems)).toEqual([])
  })
})

describe('v2.2.1 Fix 4: Blogger #comment-editor role="button" Publish & WP Jetpack Verbum guest flow', () => {
  it('clicks Blogger #comment-editor Material role="button" Publish (case-insensitive & multilingual) and verifies outcome', async () => {
    const postUrl = 'https://www.bentleyspotting.com/2026/11/classic-tourer.html'
    let publishClicked = false

    const routes: Record<string, MockPageRoute> = {
      [postUrl]: {
        html: `
          <html><head><title>Bentley Spotting</title></head><body>
            <article><h1>Classic Tourer</h1></article>
            <iframe id="comment-editor" name="comment-editor" src="https://www.blogger.com/comment/frame/987654"></iframe>
          </body></html>
        `,
        frames: [
          {
            url: 'https://www.blogger.com/comment/frame/987654',
            name: 'comment-editor',
            html: `
              <html><body>
                <textarea aria-label="Enter comment"></textarea>
                <div role="button" aria-label="Preview"><span>Preview</span></div>
                <div role="button" jsname="publishBtn" aria-disabled="true"><span>PUBLISH</span></div>
              </body></html>
            `,
            onAction: (kind, selector) => {
              if (kind === 'fill') {
                // Filling the comment enables the Material role="button" Publish button.
                return {
                  mutateHtml: `
                    <html><body>
                      <textarea aria-label="Enter comment"></textarea>
                      <div role="button" aria-label="Preview"><span>Preview</span></div>
                      <div role="button" jsname="publishBtn"><span>PUBLISH</span></div>
                    </body></html>
                  `,
                }
              }
              if (kind === 'click' && selector.includes('publishBtn')) {
                publishClicked = true
                routes[postUrl]!.html = `
                  <html><head><title>Bentley Spotting</title></head><body>
                    <div id="comments">
                      <p>Lovely classic <a href="https://demo.example.com">DemoSite</a></p>
                    </div>
                  </body></html>
                `
                return {
                  mutateHtml: '<html><body><p>Comment published.</p></body></html>',
                }
              }
            },
          },
        ],
      },
    }

    const { page } = createV221MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-blogger-rolebtn',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Lovely classic DemoSite',
        websiteUrl: 'https://demo.example.com',
        anchorText: 'DemoSite',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(publishClicked).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'blogger',
      submitTriggered: true,
    })

    // Also verifies multilingual Blogger role="button" (Spanish "Publicar").
    const esUrl = 'https://es-demo.blogspot.com/2026/11/entrada.html'
    let esClicked = false
    const { page: esPage } = createV221MockPage({
      [esUrl]: {
        html: `<html><head><title>ES Blog</title></head><body><iframe id="comment-editor" src="https://www.blogger.com/comment/frame/444"></iframe></body></html>`,
        frames: [
          {
            url: 'https://www.blogger.com/comment/frame/444',
            name: 'comment-editor',
            html: `
              <html><body>
                <textarea id="commentBody"></textarea>
                <div role="button" aria-label="Publicar">Publicar</div>
              </body></html>
            `,
            onAction: (kind, selector) => {
              if (kind === 'click' && selector.includes('Publicar')) {
                esClicked = true
                return { mutateHtml: '<html><body><p>Your comment will be published after approval.</p></body></html>' }
              }
            },
          },
        ],
      },
    })
    const esRes = await executeCommentPublish(
      esPage as never,
      'p-blogger-es',
      { kind: 'comment_publish', url: esUrl, commentText: 'Muy útil', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(esClicked).toBe(true)
    expect(esRes).toMatchObject({ outcome: 'submitted', siteType: 'blogger', submitTriggered: true })
  })

  it('expands WP Jetpack Verbum guest flow ("Add your name" / "Continue as a guest"), fills name/email/url, waits for #submit enabled, and degrades gracefully if still disabled', async () => {
    // 1. Success flow: Gutenberg contenteditable + disabled #submit + "Continue as a guest" button (#79907 thefatherlife.com).
    const verbumUrl = 'https://thefatherlife.com/blog/family-routines/'
    const publishedUrl = 'https://thefatherlife.com/blog/family-routines/#comment-901'
    let guestExpanded = false
    let filledAuthor = false
    let filledEmail = false
    let filledUrl = false

    const renderVerbumHtml = () => {
      const canSubmit = guestExpanded && filledAuthor && filledEmail
      return `
        <html><head><title>The Father Life</title><link href="/wp-content/themes/x/style.css" /></head><body>
          <div id="respond" class="comment-respond verbum-comments">
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment" style="display:none"></textarea>
              <div class="verbum-editor">
                <div contenteditable="true" role="textbox" class="block-editor-rich-text__editable"></div>
              </div>
              ${guestExpanded ? `
                <div class="verbum-guest-fields">
                  <input id="author" name="author" type="text" placeholder="Name" required />
                  <input id="email" name="email" type="email" placeholder="Email" required />
                  <input id="url" name="url" type="url" placeholder="Website" />
                </div>
              ` : `
                <button type="button" id="verbum-guest-btn">Continue as a guest</button>
              `}
              <button type="submit" id="submit" ${canSubmit ? '' : 'disabled'}>Comment</button>
            </form>
          </div>
        </body></html>
      `
    }

    const routes: Record<string, MockPageRoute> = {
      [verbumUrl]: {
        html: renderVerbumHtml(),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('verbum-guest-btn')) {
            guestExpanded = true
            return { mutateHtml: renderVerbumHtml() }
          }
          if (kind === 'fill' && selector.includes('author')) {
            filledAuthor = true
            return { mutateHtml: renderVerbumHtml() }
          }
          if (kind === 'fill' && selector.includes('email')) {
            filledEmail = true
            return { mutateHtml: renderVerbumHtml() }
          }
          if (kind === 'fill' && selector.includes('url')) {
            filledUrl = true
            return { mutateHtml: renderVerbumHtml() }
          }
          if (kind === 'click' && selector.includes('submit')) {
            routes[publishedUrl] = {
              html: `
                <html><head><title>The Father Life</title></head><body>
                  <div id="comments">
                    <li id="comment-901"><a href="https://demo.example.com">Alice</a><p>Really helpful routine ideas.</p></li>
                  </div>
                </body></html>
              `,
            }
            return { navigateTo: publishedUrl }
          }
        },
      },
    }

    const { page, actions } = createV221MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-verbum-ok',
      {
        kind: 'comment_publish',
        url: verbumUrl,
        commentText: 'Really helpful routine ideas.',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(guestExpanded).toBe(true)
    expect(filledAuthor).toBe(true)
    expect(filledEmail).toBe(true)
    expect(filledUrl).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: publishedUrl,
      submitTriggered: true,
    })
    // Rich contenteditable received plain text, never raw <a> HTML.
    expect(actions.find(a => a.kind === 'fill')?.value).toBe('Really helpful routine ideas.')

    // 2. Fallback when "Add your name" expands guest form but #submit stays disabled -> needs_llm_fallback (NEVER throws click timeout).
    const stuckUrl = 'https://stuck-verbum.example.com/post/'
    let addNameClicked = false
    const stuckRoutes: Record<string, MockPageRoute> = {
      [stuckUrl]: {
        html: `
          <html><head><title>Stuck Verbum</title><link href="/wp-content/style.css" /></head><body>
            <div id="respond" class="verbum-comments">
              <form id="commentform" action="/wp-comments-post.php" method="post">
                <div class="verbum-editor"><div contenteditable="true" role="textbox"></div></div>
                <button type="button" id="add-name-btn">Add your name</button>
                <button type="submit" id="submit" disabled>Comment</button>
              </form>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('add-name-btn')) {
            addNameClicked = true
            return {
              mutateHtml: `
                <html><head><title>Stuck Verbum</title><link href="/wp-content/style.css" /></head><body>
                  <div id="respond" class="verbum-comments">
                    <form id="commentform" action="/wp-comments-post.php" method="post">
                      <div class="verbum-editor"><div contenteditable="true" role="textbox">Filled</div></div>
                      <input id="author" name="author" type="text" />
                      <input id="email" name="email" type="email" />
                      <button type="submit" id="submit" disabled>Comment</button>
                    </form>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }

    const { page: stuckPage, actions: stuckActions } = createV221MockPage(stuckRoutes)
    const stuckRes = await executeCommentPublish(
      stuckPage as never,
      'p-verbum-stuck',
      {
        kind: 'comment_publish',
        url: stuckUrl,
        commentText: 'Thoughtful notes.',
        authorName: 'Bob',
        authorEmail: 'bob@screwdom.org',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(addNameClicked).toBe(true)
    expect(stuckRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wordpress',
      reason: 'submit_button_disabled',
      submitTriggered: false,
    })
    expect(stuckActions.some(a => a.kind === 'click' && a.selector?.includes('submit'))).toBe(false)
  })

  it('PlaywrightSession.navigate relaxes domcontentloaded timeout to 15000ms for siteHint=wix_blog', async () => {
    const recordedOpts: Array<Record<string, unknown>> = []
    const mockPage = {
      isClosed: () => false,
      on: () => {},
      url: () => 'https://slow.wixsite.com/blog/post/1',
      title: async () => 'Slow Wix',
      innerText: async () => 'Content',
      goto: vi.fn(async (_url: string, opts?: Record<string, unknown>) => {
        recordedOpts.push(opts ?? {})
      }),
    }
    const session = new PlaywrightSession({
      pages: () => [mockPage],
      on: () => {},
      close: async () => {},
    } as never, 10_000, 4_500)

    await session.act({ kind: 'navigate', url: 'https://slow.wixsite.com/blog/post/1', siteHint: 'wix_blog' })
    expect(recordedOpts[0]).toMatchObject({ timeout: 15_000, waitUntil: 'domcontentloaded' })
  })

  it('INSPECT_COMMENT_PAGE_SCRIPT exposes Wix empty placeholder & logged-in RCE fields cleanly', () => {
    const dom = new JSDOM(`
      <html><head><title>Inspect Test</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
        <article data-hook="post">
          <div data-hook="comments-section-placeholder"></div>
        </article>
      </body></html>
    `, { url: 'https://demo.wixsite.com/blog/post/p1', runScripts: 'outside-only' })
    const inspected = dom.window.eval(INSPECT_COMMENT_PAGE_SCRIPT) as CommentPageInspection
    expect(inspected.wix.hasEmptyCommentPlaceholder).toBe(true)
    expect(inspected.wix.hasLoadingIndicator).toBe(false)
    expect(inspected.wix.hasCommentListOrCount).toBe(false)
    expect(inspected.wix.hasWriteCommentPrompt).toBe(false)
  })
})
