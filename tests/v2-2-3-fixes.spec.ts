import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import {
  DEFAULT_WIX_LAZY_WAIT_MAX_MS,
  executeCommentPublish,
  hasWixSignupRecaptchaAlways,
  isTimeoutError,
} from '../src/host/browser-playwright/comment-publish.ts'
import { detectWixSignupRecaptchaAlways, runBatchPreflight } from '../src/mcp/preflight.ts'

interface V223MockResponse {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface V223Route {
  html: string
  scrollHeight?: number
  gotoTimeoutOnReload?: boolean
  onScroll?: (
    fraction: number,
    count: number,
    ctx: { setScrollHeight: (h: number) => void; setHtml: (h: string) => void; scrollY: number },
  ) => void
  onAction?: (
    kind: string,
    selector: string,
    value?: string,
    element?: Element | null,
  ) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponses?: readonly V223MockResponse[]
    throwError?: Error
  } | void
}

function createV223MockPage(routes: Record<string, V223Route>) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2400
  let currentScrollY = 0
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const gotoCalls: Array<{ url: string; timeout?: number; waitUntil?: string }> = []
  const responseListeners = new Set<(resp: unknown) => void>()
  let scrollCount = 0

  const applyScrollProps = (targetDom: JSDOM) => {
    Object.defineProperty(targetDom.window.document.documentElement, 'scrollHeight', {
      get: () => currentScrollHeight,
      configurable: true,
    })
    Object.defineProperty(targetDom.window.document.body, 'scrollHeight', {
      get: () => currentScrollHeight,
      configurable: true,
    })
    Object.defineProperty(targetDom.window, 'innerHeight', {
      get: () => 800,
      configurable: true,
    })
    Object.defineProperty(targetDom.window, 'scrollY', {
      get: () => currentScrollY,
      configurable: true,
    })
    targetDom.window.scrollTo = (_x: number, y: number) => {
      currentScrollY = y
    }
    targetDom.window.HTMLElement.prototype.scrollIntoView = function () {}
  }

  const buildDom = (html: string, url: string) => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : 'http://localhost/'
    const next = new JSDOM(html, { url: safeUrl, runScripts: 'outside-only' })
    applyScrollProps(next)
    return next
  }

  let dom = buildDom(routes[currentUrl]?.html ?? '<html><body></body></html>', currentUrl)
  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false }
  const activeRoute = () => routes[currentUrl] ?? routes[currentUrl.split('#')[0]!]

  const loadRoute = (targetUrl: string) => {
    const cleanTarget = targetUrl.split('#')[0]!
    const route = routes[targetUrl] ?? routes[cleanTarget]
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    currentScrollHeight = route.scrollHeight ?? 2400
    currentScrollY = 0
    dom = buildDom(route.html, targetUrl)
  }

  const setDomOnly = (html: string) => {
    dom = buildDom(html, currentUrl)
  }

  const setHtml = (html: string) => {
    const r = activeRoute()
    if (r) r.html = html
    dom = buildDom(html, currentUrl)
  }

  const emitResponse = (spec: V223MockResponse) => {
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
    const h = el as HTMLElement
    if (h.hidden) return false
    const style = dom.window.getComputedStyle(h)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    if (h.closest('[hidden], [aria-hidden="true"]')) return false
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
    scrollIntoViewIfNeeded: async () => {},
    fill: async (val: string) => {
      actions.push({ kind: 'fill', selector, value: val })
      const el = resolveNode() as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
      if (!el) throw new Error(`Missing element for fill: ${selector}`)
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
      if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
      if (eff?.navigateTo) loadRoute(eff.navigateTo)
      if (eff?.throwError) throw eff.throwError
    },
    press: async (key: string) => {
      actions.push({ kind: 'press', selector, value: key })
      const eff = activeRoute()?.onAction?.('press', selector, key, resolveNode())
      if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
    },
  })

  const page = {
    isClosed: () => false,
    on: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.add(fn)
    },
    off: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.delete(fn)
    },
    url: () => currentUrl,
    title: async () => dom.window.document.title || '',
    innerText: async (sel = 'body') => dom.window.document.querySelector(sel)?.textContent?.trim() ?? '',
    mainFrame: () => mainFrameStub,
    frames: () => [mainFrameStub],
    keyboard: {
      press: async (key: string) => {
        actions.push({ kind: 'keyboard:press', value: key })
        if (key === 'End') currentScrollY = currentScrollHeight
      },
    },
    goto: async (url: string, opts?: { timeout?: number; waitUntil?: string }) => {
      gotoCalls.push({
        url,
        ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
        ...(opts?.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }),
      })
      actions.push({ kind: 'goto', value: url })
      const route = routes[url] ?? routes[url.split('#')[0]!]
      if (gotoCalls.length >= 2 && route?.gotoTimeoutOnReload) {
        const err = new Error('page.goto: Timeout 10000ms exceeded.')
        err.name = 'TimeoutError'
        throw err
      }
      loadRoute(url)
    },
    waitForNavigation: async () => null,
    waitForLoadState: async () => {},
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      const route = activeRoute()
      if (typeof fnOrScript === 'function' && typeof arg === 'number') {
        const res = runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
        route?.onScroll?.(arg, scrollCount++, {
          setScrollHeight: (h) => { currentScrollHeight = h },
          setHtml,
          scrollY: currentScrollY,
        })
        return res
      }
      if (typeof fnOrScript === 'string') {
        return dom.window.eval(fnOrScript)
      }
      return runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
    },
    locator: (selector: string) => {
      const resolveAll = () => Array.from(dom.window.document.querySelectorAll(selector))
      const count = async () => resolveAll().length
      const firstApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null)
      const nth = (index: number) => makeSingleLocatorApi(selector, () => resolveAll()[index] ?? null)
      return { ...firstApi, first: () => firstApi, nth, count }
    },
  }

  return {
    page,
    actions,
    gotoCalls,
    getScrollCount: () => scrollCount,
  }
}

describe('v2.2.3 Fix 1: Wix signupRecaptchaOption=ALWAYS logged-out blocked_captcha & logged-in redline', () => {
  it('matches plain, case-insensitive, escaped JSON, and HTML-encoded signupRecaptchaOption=ALWAYS without false positives', () => {
    expect(hasWixSignupRecaptchaAlways('{"signupRecaptchaOption":"ALWAYS"}')).toBe(true)
    expect(hasWixSignupRecaptchaAlways('{"signupRecaptchaOption" : "always"}')).toBe(true)
    expect(hasWixSignupRecaptchaAlways('{\\"signupRecaptchaOption\\":\\"ALWAYS\\"}')).toBe(true)
    expect(hasWixSignupRecaptchaAlways('{\\\\"signupRecaptchaOption\\\\" : \\\\"Always\\\\"}')).toBe(true)
    expect(hasWixSignupRecaptchaAlways('&quot;signupRecaptchaOption&quot;:&quot;ALWAYS&quot;')).toBe(true)
    expect(detectWixSignupRecaptchaAlways('{\\"signupRecaptchaOption\\":\\"ALWAYS\\"}')).toBe(true)

    expect(hasWixSignupRecaptchaAlways('{"signupRecaptchaOption":"NEVER"}')).toBe(false)
    expect(hasWixSignupRecaptchaAlways('{"signupRecaptchaOption":"VISIBLE"}')).toBe(false)
    expect(hasWixSignupRecaptchaAlways('{"signupRecaptchaOption":"AUTO"}')).toBe(false)
    expect(hasWixSignupRecaptchaAlways('{"other":"ALWAYS"}')).toBe(false)
  })

  it('immediately returns blocked_captcha (wix_signup_recaptcha_always) on logged-out Wix sites with plain or escaped signupRecaptchaOption=ALWAYS (0 extra wait)', async () => {
    // 1. Plain JSON in wix-warmup-data + visible login wall -> instant blocked_captcha with 0 scroll polls.
    const urlPlain = 'https://batch1275-a.wixsite.com/blog/post/recaptcha-always'
    let plainSleeps = 0
    const { page: plainPage, getScrollCount } = createV223MockPage({
      [urlPlain]: {
        html: `
          <html><head>
            <title>Batch 1275 Wix Blog</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script id="wix-warmup-data" type="application/json">{"appsWarmupData":{"siteMembers":{"signupRecaptchaOption":"ALWAYS"}}}</script>
          </head><body>
            <div id="SITE_CONTAINER">
              <div data-hook="comments-section">
                <button data-hook="login-as-member-text-button">Log in to publish as a member</button>
              </div>
            </div>
          </body></html>
        `,
      },
    })

    const plainRes = await executeCommentPublish(
      plainPage as never,
      'p-wix-always-plain',
      { kind: 'comment_publish', url: urlPlain, siteHint: 'wix_blog', commentText: 'Great post', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => { plainSleeps++ } },
    )

    expect(getScrollCount()).toBe(0)
    expect(plainSleeps).toBe(0)
    expect(plainRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      reason: 'wix_signup_recaptcha_always',
      templateSignature: 'wix:signup_recaptcha',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })

    // 2. Escaped JSON (\"signupRecaptchaOption\":\"always\") + clicking Write a comment opens Wix Sign Up modal -> instant blocked_captcha.
    const urlEscaped = 'https://batch1274-b.wixsite.com/blog/post/escaped-recaptcha'
    let expandSleeps = 0
    const escapedRoutes: Record<string, V223Route> = {
      [urlEscaped]: {
        html: `
          <html><head>
            <title>Batch 1274 Wix Blog</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script>window.__WARMUP__ = "{\\\\"signupRecaptchaOption\\\\": \\\\"always\\\\"}";</script>
          </head><body>
            <div id="SITE_CONTAINER">
              <div data-hook="comment-box">
                <button data-hook="comment-box-placeholder">Write a comment...</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head>
                  <title>Batch 1274 Wix Blog</title>
                  <script src="https://static.wixstatic.com/app.js"></script>
                  <script>window.__WARMUP__ = "{\\\\"signupRecaptchaOption\\\\": \\\\"always\\\\"}";</script>
                </head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <h2 data-testid="signUp.headline">Sign Up</h2>
                    <button data-testid="google-sso">Sign up with Google</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }

    const { page: escapedPage, getScrollCount: getEscapedScrolls } = createV223MockPage(escapedRoutes)
    const escapedRes = await executeCommentPublish(
      escapedPage as never,
      'p-wix-always-escaped',
      { kind: 'comment_publish', url: urlEscaped, siteHint: 'wix_blog', commentText: 'Great post', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => { expandSleeps++ } },
    )

    expect(getEscapedScrolls()).toBe(0)
    // Early-exits on the very first expand poll without waiting for the second sawLoginWithoutCaptcha poll.
    expect(expandSleeps).toBe(1)
    expect(escapedRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      reason: 'wix_signup_recaptcha_always',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })

    // 3. Post-Publish Sign Up dialog with signupRecaptchaOption=ALWAYS -> blocked_captcha (submitTriggered: false).
    const urlPostDialog = 'https://batch1274-c.wixsite.com/blog/post/post-dialog'
    const postDialogRoutes: Record<string, V223Route> = {
      [urlPostDialog]: {
        html: `
          <html><head>
            <title>Post Dialog Wix</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
          </head><body>
            <div data-hook="comment-box">
              <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
              <button data-hook="primary-btn">Publish</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: postDialogRoutes[urlPostDialog]!.html.replace(
                '<div contenteditable="true" role="textbox"></div>',
                '<div contenteditable="true" role="textbox">Nice post <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            return {
              mutateHtml: `
                <html><head>
                  <title>Post Dialog Wix</title>
                  <script src="https://static.wixstatic.com/app.js"></script>
                  <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
                </head><body>
                  <div id="SM_ROOT_COMP9" role="dialog">
                    <h2>Sign Up</h2>
                    <button>Continue with Google</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }
    const { page: postDialogPage } = createV223MockPage(postDialogRoutes)
    const postDialogRes = await executeCommentPublish(
      postDialogPage as never,
      'p-wix-post-dialog',
      { kind: 'comment_publish', url: urlPostDialog, siteHint: 'wix_blog', commentText: 'Nice post', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 100, sleepImpl: async () => {} },
    )
    expect(postDialogRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      reason: 'wix_signup_recaptcha_always',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
  })

  it('never false-positives already logged-in Wix sites (visible comment-box-rce-wrapper or expanded RCE) even when source has signupRecaptchaOption=ALWAYS', async () => {
    // 1. Direct visible logged-in comment-box-rce-wrapper + Publish with signupRecaptchaOption=ALWAYS in warmupData.
    const loggedInUrl = 'https://logged-in-old.wixsite.com/blog/post/member-session'
    const routes: Record<string, V223Route> = {
      [loggedInUrl]: {
        html: `
          <html><head>
            <title>Logged-in Wix Site</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script id="wix-warmup-data" type="application/json">{"appsWarmupData":{"siteMembers":{"signupRecaptchaOption":"ALWAYS"}}}</script>
          </head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comment-box">
                  <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                  <button data-hook="primary-btn">Publish</button>
                </div>
              </article>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: routes[loggedInUrl]!.html.replace(
                '<div contenteditable="true" role="textbox"></div>',
                '<div contenteditable="true" role="textbox">Helpful insights <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            routes[loggedInUrl]!.html = `
              <html><head>
                <title>Logged-in Wix Site</title>
                <script src="https://static.wixstatic.com/app.js"></script>
                <script id="wix-warmup-data" type="application/json">{"appsWarmupData":{"siteMembers":{"signupRecaptchaOption":"ALWAYS"}}}</script>
              </head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item">Helpful insights <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV223MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-loggedin-always',
      {
        kind: 'comment_publish',
        url: loggedInUrl,
        siteHint: 'wix_blog',
        commentText: 'Helpful insights',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // 2. Logged-in Wix site starting collapsed at Write a comment... that expands comment-box-rce-wrapper cleanly.
    const collapsedLoggedInUrl = 'https://logged-in-collapsed.wixsite.com/blog/post/expand-rce'
    const collapsedRoutes: Record<string, V223Route> = {
      [collapsedLoggedInUrl]: {
        html: `
          <html><head>
            <title>Collapsed Logged-in Wix</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
          </head><body>
            <div data-hook="comment-box">
              <button data-hook="comment-box-placeholder">Write a comment...</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head>
                  <title>Collapsed Logged-in Wix</title>
                  <script src="https://static.wixstatic.com/app.js"></script>
                  <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
                </head><body>
                  <div data-hook="comment-box">
                    <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                    <button data-hook="primary-btn">Publish</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: `
                <html><head>
                  <title>Collapsed Logged-in Wix</title>
                  <script src="https://static.wixstatic.com/app.js"></script>
                  <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
                </head><body>
                  <div data-hook="comment-box">
                    <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox">Solid guide <a href="https://demo.example.com">https://demo.example.com</a> </div></div>
                    <button data-hook="primary-btn">Publish</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            collapsedRoutes[collapsedLoggedInUrl]!.html = `
              <html><head>
                <title>Collapsed Logged-in Wix</title>
                <script src="https://static.wixstatic.com/app.js"></script>
              </head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item">Solid guide <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }
    const { page: collapsedPage } = createV223MockPage(collapsedRoutes)
    const collapsedRes = await executeCommentPublish(
      collapsedPage as never,
      'p-wix-collapsed-loggedin',
      {
        kind: 'comment_publish',
        url: collapsedLoggedInUrl,
        siteHint: 'wix_blog',
        commentText: 'Solid guide',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
    )
    expect(collapsedRes).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('surfaces non-destructive wixSignupRecaptchaAlways hint in batch_preflight without auto-failing or auto-skipping', async () => {
    const detail: BacklinkBatchDetail = {
      batch: {
        id: 1275,
        name: 'Wix Batch 1275',
        websiteId: 1,
        websiteName: 'Demo',
        websiteDomain: 'demo.example.com',
        status: 'pending',
        counts: { total: 2, pending: 2, completed: 0, failed: 0, skipped: 0 },
        createdAt: '2026-11-24T00:00:00Z',
        updatedAt: '2026-11-24T00:00:00Z',
      },
      items: [
        {
          id: 901,
          sourceId: 5001,
          sourceName: 'Wix Always',
          sourceUrl: 'https://always-wix.example.com/post/1',
          sourceHost: 'always-wix.example.com',
          submitUrl: 'https://always-wix.example.com/post/1',
          sourceNotes: null,
          category: '博客',
          tags: [],
          paymentType: 'free',
          linkType: 'nofollow',
          status: 'pending',
          failureMode: null,
          failureReason: null,
          publishedUrl: null,
          publishStatus: null,
          plannedAt: '2026-11-24T00:00:00Z',
        },
        {
          id: 902,
          sourceId: 5002,
          sourceName: 'Wix Normal',
          sourceUrl: 'https://normal-wix.example.com/post/2',
          sourceHost: 'normal-wix.example.com',
          submitUrl: 'https://normal-wix.example.com/post/2',
          sourceNotes: null,
          category: '博客',
          tags: [],
          paymentType: 'free',
          linkType: 'nofollow',
          status: 'pending',
          failureMode: null,
          failureReason: null,
          publishedUrl: null,
          publishStatus: null,
          plannedAt: '2026-11-24T00:00:00Z',
        },
      ],
    }

    const reported: Array<unknown> = []
    const provider: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [],
      getBatch: async () => detail,
      claim: async () => ({ leaseId: 1, expiresAt: '', items: [] }),
      heartbeat: async () => ({ leaseId: 1, expiresAt: '' }),
      release: async () => {},
      reportItemResult: async (id, res) => {
        reported.push({ id, res })
        return { itemStatus: res.status }
      },
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async () => ({ sourceId: 1, tags: [] }),
    }

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('always-wix.example.com')) {
        return new Response(
          '<html><head><script src="https://static.wixstatic.com/a.js"></script><script id="wix-warmup-data">{\\"signupRecaptchaOption\\":\\"ALWAYS\\"}</script></head><body>ok</body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      return new Response(
        '<html><head><script src="https://static.wixstatic.com/a.js"></script><script id="wix-warmup-data">{"signupRecaptchaOption":"NEVER"}</script></head><body>ok</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )
    }

    const res = await runBatchPreflight(provider, detail, {
      autoSkip: true,
      autoFailWaf: true,
      fetchImpl,
      sleepImpl: async () => {},
    })

    expect(reported).toHaveLength(0)
    expect(res.data.runnableItemIds).toEqual([901, 902])
    expect(res.data.runnableItems).toEqual([
      { itemId: 901, domain: 'always-wix.example.com', siteHint: 'wix_blog', wixSignupRecaptchaAlways: true },
      { itemId: 902, domain: 'normal-wix.example.com', siteHint: 'wix_blog' },
    ])
  })
})

describe('v2.2.3 Fix 2: Wix lazy-load wait window relaxed from 15s to 20s with immediate early exit', () => {
  it('captures slow Wix comment-box-placeholder mounting at 17-18s (past old 15s cap) instead of falling back to needs_llm_fallback', async () => {
    expect(DEFAULT_WIX_LAZY_WAIT_MAX_MS).toBe(20_000)

    const slowWixUrl = 'https://slow-18s.wixsite.com/blog/post/delayed-mount'
    let simulatedWaitMs = 0
    let pollsBeforeReady = 0
    let ready = false

    const routes: Record<string, V223Route> = {
      [slowWixUrl]: {
        scrollHeight: 4800,
        html: `
          <html><head><title>18s Slow Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <p>Long slow Wix blog post</p>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
        onScroll: (_fraction, idx, ctx) => {
          // Mounts `Write a comment...` on scroll #44 -> 45 * 400ms = 18,000ms (would have failed under 15s cap!).
          if (idx === 44) {
            ready = true
            ctx.setHtml(`
              <html><head><title>18s Slow Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div id="SITE_CONTAINER">
                  <article data-hook="post">
                    <div data-hook="comment-box">
                      <button data-hook="comment-box-placeholder">Write a comment...</button>
                    </div>
                  </article>
                </div>
              </body></html>
            `)
          }
        },
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>18s Slow Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
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

    const { page } = createV223MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-18s',
      { kind: 'comment_publish', url: slowWixUrl, siteHint: 'wix_blog', commentText: 'Great post', probeOnly: true },
      {
        defaultTimeoutMs: 10_000,
        sleepImpl: async (ms) => {
          if (!ready) {
            pollsBeforeReady++
            simulatedWaitMs += ms
          }
        },
      },
    )

    // Waited past the old 15s cap (~17.6s-18s) and early-exited immediately once mounted (below 50-poll / 20s ceiling).
    expect(pollsBeforeReady).toBe(44)
    expect(simulatedWaitMs).toBeGreaterThanOrEqual(17_200)
    expect(simulatedWaitMs).toBeLessThan(20_000)
    expect(res).toMatchObject({
      outcome: 'form_ready',
      siteType: 'wix',
      submitTriggered: false,
    })

    // Also verifies slow login wall at ~17.6s is caught directly (needs_login without ALWAYS, blocked_captcha with ALWAYS).
    const slowLoginUrl = 'https://slow-17s-login.wixsite.com/blog/post/delayed-wall'
    const slowLoginRoutes: Record<string, V223Route> = {
      [slowLoginUrl]: {
        scrollHeight: 4200,
        html: `
          <html><head>
            <title>17.6s Slow Login Wix</title>
            <script src="https://static.wixstatic.com/app.js"></script>
            <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
          </head><body>
            <div id="SITE_CONTAINER"><article data-hook="post"><div data-hook="comments-section-placeholder"></div></article></div>
          </body></html>
        `,
        onScroll: (_fraction, idx, ctx) => {
          if (idx === 43) {
            ctx.setHtml(`
              <html><head>
                <title>17.6s Slow Login Wix</title>
                <script src="https://static.wixstatic.com/app.js"></script>
                <script id="wix-warmup-data" type="application/json">{"signupRecaptchaOption":"ALWAYS"}</script>
              </head><body>
                <div id="SITE_CONTAINER">
                  <div data-hook="comments-section">
                    <button data-hook="login-as-member-text-button">Log in to comment</button>
                  </div>
                </div>
              </body></html>
            `)
          }
        },
      },
    }
    const { page: slowLoginPage, getScrollCount: getSlowLoginScrolls } = createV223MockPage(slowLoginRoutes)
    const slowLoginRes = await executeCommentPublish(
      slowLoginPage as never,
      'p-wix-17s-login',
      { kind: 'comment_publish', url: slowLoginUrl, siteHint: 'wix_blog', commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(getSlowLoginScrolls()).toBe(44)
    expect(slowLoginRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      reason: 'wix_signup_recaptcha_always',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
  })
})

describe('v2.2.3 Fix 3: WP & generic blog submit click TimeoutError recovery via URL / #comment-ID / DOM verification', () => {
  it('recognizes Playwright TimeoutError without matching closed-session errors', () => {
    const pwTimeout = new Error('locator.click: Timeout 10000ms exceeded.')
    pwTimeout.name = 'TimeoutError'
    expect(isTimeoutError(pwTimeout)).toBe(true)
    expect(isTimeoutError(new Error('locator.click: Timeout 10000ms exceeded.'))).toBe(true)
    expect(isTimeoutError(new Error('Target page, context or browser has been closed'))).toBe(false)
    expect(isTimeoutError(new Error('browser session is closed'))).toBe(false)
  })

  it('recovers when WP #submit click() throws TimeoutError after 302 redirect to #comment-240331 and returns live', async () => {
    const postUrl = 'https://slow-wp.example.com/2026/guide/'
    const commentUrl = 'https://slow-wp.example.com/2026/guide/#comment-240331'
    const timeoutErr = new Error('locator.click: Timeout 10000ms exceeded.')
    timeoutErr.name = 'TimeoutError'

    const routes: Record<string, V223Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Slow WP Post</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" type="text" required />
              <input id="email" name="email" type="email" required />
              <input id="url" name="url" type="url" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('#submit')) {
            return {
              navigateTo: commentUrl,
              throwError: timeoutErr,
            }
          }
        },
      },
      [commentUrl]: {
        html: `
          <html><head><title>Slow WP Post</title></head><body>
            <div id="comments">
              <article id="comment-240331">
                <a href="https://demo.example.com">Alice</a>
                <p>Really practical breakdown!</p>
              </article>
            </div>
          </body></html>
        `,
      },
    }

    const { page } = createV223MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wp-timeout-live',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Really practical breakdown!',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: commentUrl,
      submitTriggered: true,
    })
  })

  it('recovers when WP #submit click() throws TimeoutError after 302 redirect to ?unapproved=...#comment-432507 and returns submitted', async () => {
    const postUrl = 'https://mod-wp.example.com/2026/article/'
    const modUrl = 'https://mod-wp.example.com/2026/article/?unapproved=432507&moderation-hash=deadbeef#comment-432507'
    const cleanCommentUrl = 'https://mod-wp.example.com/2026/article/#comment-432507'
    const timeoutErr = new Error('locator.click: Timeout 10000ms exceeded.')
    timeoutErr.name = 'TimeoutError'

    const routes: Record<string, V223Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Moderated Slow WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" type="text" required />
              <input id="email" name="email" type="email" required />
              <input id="url" name="url" type="url" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('#submit')) {
            return {
              navigateTo: modUrl,
              throwError: timeoutErr,
            }
          }
        },
      },
      [modUrl]: {
        html: `
          <html><head><title>Moderated Slow WP</title></head><body>
            <div id="comments">
              <article id="comment-432507">
                <em class="comment-awaiting-moderation">Your comment is awaiting moderation.</em>
                <a href="https://demo.example.com">Alice</a>
              </article>
            </div>
          </body></html>
        `,
      },
    }

    const { page, gotoCalls } = createV223MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wp-timeout-mod',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Helpful tutorial!',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(gotoCalls).toHaveLength(1)
    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      publicUrl: cleanCommentUrl,
      postSubmitUrl: modUrl,
      submitTriggered: true,
    })
  })

  it('recovers to blocked_waf or post_submit_comment_id_cached on click timeout, and degrades to needs_llm_fallback when click genuinely failed with zero submit trace', async () => {
    const timeoutErr = new Error('locator.click: Timeout 10000ms exceeded.')
    timeoutErr.name = 'TimeoutError'

    // 1. Click timeout + HTTP 403 WAF on /wp-comments-post.php -> blocked_waf.
    const wafUrl = 'https://waf-wp.example.com/post/'
    const wafEndpoint = 'https://waf-wp.example.com/wp-comments-post.php'
    const { page: wafPage } = createV223MockPage({
      [wafUrl]: {
        html: `
          <html><head><title>WAF WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('#submit')) {
            return {
              emitResponses: [{
                url: wafEndpoint,
                status: 403,
                headers: { server: 'LiteSpeed' },
                body: '403 Forbidden - LiteSpeed Web Server',
              }],
              navigateTo: wafEndpoint,
              throwError: timeoutErr,
            }
          }
        },
      },
      [wafEndpoint]: {
        html: '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><p>LiteSpeed Web Server</p></body></html>',
      },
    })
    const wafRes = await executeCommentPublish(
      wafPage as never,
      'p-wp-timeout-waf',
      { kind: 'comment_publish', url: wafUrl, commentText: 'Hello', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(wafRes).toMatchObject({
      outcome: 'blocked_waf',
      siteType: 'wordpress',
      httpStatus: 403,
      suggestedTags: ['waf_403'],
      submitTriggered: true,
    })

    // 2. Click timeout + #comment-904860 link verified + reload timeout -> submitted (post_submit_comment_id_cached), never throws!
    const ultraSlowUrl = 'https://ultraslow-wp.example.com/post/'
    const ultraSlowCommentUrl = 'https://ultraslow-wp.example.com/post/#comment-904860'
    const { page: ultraSlowPage } = createV223MockPage({
      [ultraSlowUrl]: {
        html: `
          <html><head><title>Ultra Slow WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="url" name="url" type="url" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('#submit')) {
            return { navigateTo: ultraSlowCommentUrl, throwError: timeoutErr }
          }
        },
      },
      [ultraSlowCommentUrl]: {
        gotoTimeoutOnReload: true,
        html: `
          <html><head><title>Ultra Slow WP</title></head><body>
            <div id="comments"><li id="comment-904860"><a href="https://demo.example.com">Alice</a></li></div>
          </body></html>
        `,
      },
    })
    const ultraSlowRes = await executeCommentPublish(
      ultraSlowPage as never,
      'p-wp-ultraslow',
      { kind: 'comment_publish', url: ultraSlowUrl, commentText: 'Great!', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(ultraSlowRes).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      reason: 'post_submit_comment_id_cached',
      publicUrl: ultraSlowCommentUrl,
      submitTriggered: true,
    })

    // 3. Genuine click failure (obstructed by overlay): zero navigation, zero #comment-, zero submit trace -> needs_llm_fallback (submitTriggered: false).
    const blockedClickUrl = 'https://preloader-stuck.example.com/post/'
    const { page: stuckPage } = createV223MockPage({
      [blockedClickUrl]: {
        html: `
          <html><head><title>Preloader Stuck WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('#submit')) {
            return { throwError: timeoutErr }
          }
        },
      },
    })
    const stuckRes = await executeCommentPublish(
      stuckPage as never,
      'p-wp-stuck',
      { kind: 'comment_publish', url: blockedClickUrl, commentText: 'Hello', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(stuckRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wordpress',
      reason: 'submit_click_timeout',
      submitTriggered: false,
    })
  })
})
