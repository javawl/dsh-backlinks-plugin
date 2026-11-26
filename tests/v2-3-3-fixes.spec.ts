import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  executeCommentPublish,
  isAllowedWixLoginHref,
  isThirdPartyNonWixCommentFrameUrl,
  matchesMultilingualSubmitLabel,
} from '../src/host/browser-playwright/comment-publish.ts'

interface V233MockResponse {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface V233PopupStep {
  url: string
  html: string
  onClick?: (selector: string) => { nextStep?: boolean; close?: boolean; mutateParentHtml?: string } | void
}

interface V233ChildFrameSpec {
  readonly url: string
  readonly name?: string
  readonly html: string
  readonly parentUrl?: string
}

interface V233Route {
  html: string
  readyState?: 'loading' | 'interactive' | 'complete'
  scrollHeight?: number
  frames?: readonly V233ChildFrameSpec[]
  onScroll?: (scrollCount: number) => { mutateHtml?: string; frames?: readonly V233ChildFrameSpec[] } | void
  onAction?: (
    kind: string,
    selector: string,
    value?: string,
    element?: Element | null,
    doc?: Document,
  ) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponses?: readonly V233MockResponse[]
    openPopup?: { steps: V233PopupStep[] }
    throwError?: Error
  } | void
}

function createV233MockPage(routes: Record<string, V233Route>) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2400
  let currentScrollY = 0
  let scrollCount = 0
  let currentReadyState: 'loading' | 'interactive' | 'complete' = routes[currentUrl]?.readyState ?? 'complete'
  let currentFrames: readonly V233ChildFrameSpec[] = routes[currentUrl]?.frames ?? []
  const actions: Array<{ kind: string; selector?: string; value?: string; timeout?: number }> = []
  const responseListeners = new Set<(resp: unknown) => void>()
  let pendingPopupResolve: ((popup: unknown) => void) | undefined

  const buildDom = (html: string, url: string, readyState: 'loading' | 'interactive' | 'complete') => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : 'http://localhost/'
    const next = new JSDOM(html, { url: safeUrl, runScripts: 'outside-only' })
    Object.defineProperty(next.window.document, 'readyState', { get: () => readyState, configurable: true })
    Object.defineProperty(next.window.document.documentElement, 'scrollHeight', { get: () => currentScrollHeight, configurable: true })
    Object.defineProperty(next.window.document.body, 'scrollHeight', { get: () => currentScrollHeight, configurable: true })
    Object.defineProperty(next.window, 'innerHeight', { get: () => 800, configurable: true })
    Object.defineProperty(next.window, 'scrollY', { get: () => currentScrollY, configurable: true })
    next.window.scrollTo = (_x: number, y: number) => {
      currentScrollY = y
      scrollCount++
      const effect = activeRoute()?.onScroll?.(scrollCount)
      if (effect?.frames !== undefined) currentFrames = effect.frames
      if (effect?.mutateHtml !== undefined) setDomOnly(effect.mutateHtml)
    }
    next.window.HTMLElement.prototype.scrollIntoView = function () {}
    return next
  }

  const resolveRoute = (targetUrl: string): V233Route | undefined => {
    const noHash = targetUrl.split('#')[0]!
    const noQuery = noHash.split('?')[0]!
    return routes[targetUrl] ?? routes[noHash] ?? routes[noQuery]
  }
  const activeRoute = () => resolveRoute(currentUrl)

  let dom = buildDom(routes[currentUrl]?.html ?? '<html><body></body></html>', currentUrl, currentReadyState)
  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false, parentFrame: () => null }

  const loadRoute = (targetUrl: string) => {
    const route = resolveRoute(targetUrl)
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    currentScrollHeight = route.scrollHeight ?? 2400
    currentScrollY = 0
    currentReadyState = route.readyState ?? 'complete'
    currentFrames = route.frames ?? []
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

  const evalInDom = (targetDom: JSDOM, scriptOrFn: unknown, arg?: unknown) => {
    const g = globalThis as Record<string, unknown>
    const prev = {
      window: g.window,
      document: g.document,
      location: g.location,
      getComputedStyle: g.getComputedStyle,
      CSS: g.CSS,
      NodeFilter: g.NodeFilter,
      Event: g.Event,
    }
    g.window = targetDom.window
    g.document = targetDom.window.document
    g.location = targetDom.window.location
    g.getComputedStyle = targetDom.window.getComputedStyle.bind(targetDom.window)
    g.CSS = { escape: (s: string) => s.replace(/([^\w-])/gu, '\\$1') }
    g.NodeFilter = targetDom.window.NodeFilter
    g.Event = targetDom.window.Event
    try {
      if (typeof scriptOrFn === 'string') return targetDom.window.eval(scriptOrFn)
      if (typeof scriptOrFn === 'function') return (scriptOrFn as (a: unknown) => unknown)(arg)
      return undefined
    } finally {
      Object.assign(g, prev)
    }
  }

  const buildChildFrameStubs = () => {
    const stubByUrl = new Map<string, Record<string, unknown>>()
    const list = currentFrames.map(spec => {
      const fDom = buildDom(spec.html, spec.url, 'complete')
      const stub: Record<string, unknown> = {
        url: () => spec.url,
        name: () => spec.name ?? '',
        isDetached: () => false,
        parentFrame: () => (spec.parentUrl ? stubByUrl.get(spec.parentUrl) ?? { url: () => spec.parentUrl } : mainFrameStub),
        evaluate: async (scriptOrFn: unknown, arg?: unknown) => evalInDom(fDom, scriptOrFn, arg),
      }
      stubByUrl.set(spec.url, stub)
      return stub
    })
    return [mainFrameStub, ...list]
  }

  const emitResponse = (spec: V233MockResponse) => {
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

  const createMockPopup = (spec: { steps: V233PopupStep[] }) => {
    let stepIndex = 0
    let closed = false
    const getStep = () => spec.steps[Math.min(stepIndex, spec.steps.length - 1)]!
    let popupDom = buildDom(getStep().html, getStep().url, 'complete')
    return {
      url: () => getStep().url,
      isClosed: () => closed,
      waitForLoadState: async () => {},
      evaluate: async (scriptOrFn: unknown, arg?: unknown) => evalInDom(popupDom, scriptOrFn, arg),
      locator: (selector: string) => ({
        first: () => ({
          click: async () => {
            const out = getStep().onClick?.(selector)
            if (out?.mutateParentHtml !== undefined) setDomOnly(out.mutateParentHtml)
            if (out?.nextStep) {
              stepIndex = Math.min(stepIndex + 1, spec.steps.length - 1)
              popupDom = buildDom(getStep().html, getStep().url, 'complete')
            }
            if (out?.close) closed = true
          },
        }),
      }),
    }
  }

  const isVisibleNode = (el: Element | null): boolean => {
    if (!el) return false
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if ((cur as HTMLElement).hidden) return false
      if (cur.getAttribute('aria-hidden') === 'true') return false
      const st = dom.window.getComputedStyle(cur)
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false
    }
    return true
  }

  const runActionEffect = (
    kind: string,
    selector: string,
    value?: string,
    el?: Element | null,
  ) => {
    const res = activeRoute()?.onAction?.(kind, selector, value, el, dom.window.document)
    if (res?.throwError) throw res.throwError
    if (res?.emitResponses) {
      for (const spec of res.emitResponses) emitResponse(spec)
    }
    if (res?.openPopup && pendingPopupResolve) {
      const resolve = pendingPopupResolve
      pendingPopupResolve = undefined
      resolve(createMockPopup(res.openPopup))
    }
    if (res?.mutateHtml !== undefined) setDomOnly(res.mutateHtml)
    if (res?.navigateTo !== undefined) loadRoute(res.navigateTo)
  }

  const makeLocator = (selector: string, fixedIndex?: number) => {
    const queryAll = (): Element[] => {
      try {
        return Array.from(dom.window.document.querySelectorAll(selector))
      } catch {
        return []
      }
    }
    const targetEl = (): Element | null => {
      const list = queryAll()
      if (fixedIndex !== undefined) return list[fixedIndex] ?? null
      return list[0] ?? null
    }
    return {
      count: async () => queryAll().length,
      nth: (i: number) => makeLocator(selector, i),
      first: () => makeLocator(selector, fixedIndex ?? 0),
      isVisible: async () => isVisibleNode(targetEl()),
      isDisabled: async () => {
        const el = targetEl() as HTMLButtonElement | null
        if (!el) return false
        return Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
      },
      getAttribute: async (name: string) => targetEl()?.getAttribute(name) ?? null,
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async (fn: (node: unknown, arg?: unknown) => unknown, arg?: unknown) => fn(targetEl(), arg),
      fill: async (val: string, opts?: { timeout?: number }) => {
        actions.push({ kind: 'fill', selector, value: val, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
        const el = targetEl() as (HTMLInputElement | HTMLTextAreaElement | HTMLElement | null)
        if (el) {
          if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) {
            ;(el as HTMLInputElement).value = val
          } else {
            el.textContent = val
          }
        }
        runActionEffect('fill', selector, val, el)
      },
      click: async (opts?: { timeout?: number }) => {
        actions.push({ kind: 'click', selector, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
        const el = targetEl()
        runActionEffect('click', selector, undefined, el)
      },
      press: async (key: string, opts?: { timeout?: number }) => {
        actions.push({ kind: 'press', selector, value: key, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
        runActionEffect('press', selector, key, targetEl())
      },
    }
  }

  const page = {
    url: () => currentUrl,
    title: async () => dom.window.document.title,
    mainFrame: () => mainFrameStub,
    frames: () => buildChildFrameStubs(),
    on: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.add(fn)
    },
    off: (ev: string, fn: (arg: unknown) => void) => {
      if (ev === 'response') responseListeners.delete(fn)
    },
    waitForEvent: (ev: string, opts?: { timeout?: number }) => {
      if (ev !== 'popup') return Promise.reject(new Error('unsupported event'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPopupResolve = undefined
          reject(new Error('popup timeout'))
        }, Math.min(opts?.timeout ?? 500, 500))
        pendingPopupResolve = (popup: unknown) => {
          clearTimeout(timer)
          resolve(popup)
        }
      })
    },
    goto: async (targetUrl: string) => {
      loadRoute(targetUrl)
    },
    waitForLoadState: async () => {},
    waitForNavigation: async () => null,
    route: async () => {},
    unroute: async () => {},
    keyboard: {
      press: async (key: string) => {
        actions.push({ kind: 'keyboard.press', value: key })
        runActionEffect('keyboard.press', '', key, null)
      },
    },
    evaluate: async (scriptOrFn: unknown, arg?: unknown) => evalInDom(dom, scriptOrFn, arg),
    locator: (selector: string) => makeLocator(selector),
  }

  return { page, actions, getDocument: () => dom.window.document }
}

describe('v2.3.3 Fix 1: Wix login detection ignores spam comment external links & prioritizes logged-in surfaces', () => {
  it('filters external third-party <a> hrefs while allowing same-origin and official Wix/Google auth hrefs', () => {
    const pageUrl = 'https://aistrategies.gmu.edu/post/ai-roadmap'
    expect(isAllowedWixLoginHref('https://dmplay.xyz/login', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('https://jaiclub-vip.in/login', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('https://daman-games.org/daman-login', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('https://esicportal.info/login', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('https://okwin.cc/login', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('https://spammer.wixsite.com/dmplay', pageUrl)).toBe(false)
    expect(isAllowedWixLoginHref('mailto:spam@example.com', pageUrl)).toBe(false)

    expect(isAllowedWixLoginHref('', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('#', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('javascript:void(0)', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('/members/login', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('https://www.aistrategies.gmu.edu/login', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('https://users.wix.com/wix-users/login', pageUrl)).toBe(true)
    expect(isAllowedWixLoginHref('https://accounts.google.com/o/oauth2/v2/auth', pageUrl)).toBe(true)
  })

  it('publishes directly on already-logged-in Wix blogs containing spam login anchor links ("DM play login", "Jai Club Login", "Daman Login", "OK Win Login", "esic portal login") without misclassifying needs_login or clicking external links', async () => {
    const wixUrl = 'https://aistrategies.gmu.edu/post/ai-policy'
    const spamCommentsHtml = `
      <div data-hook="top-level-comment-list">
        <div data-hook="comment-item">
          <div data-hook="comment-content">
            <div data-hook="ricos-viewer">
              <p>Try <a id="spam-dmplay" href="https://dmplay.xyz/login">DM play login</a> and <a id="spam-jaiclub" href="https://jaiclub.in/login">Jai Club Login</a> today!</p>
            </div>
          </div>
        </div>
        <div data-hook="comment-item">
          <div data-hook="comment-content">
            <p><a id="spam-daman" href="https://daman.games/login">Daman Login</a> | <a id="spam-esic" href="https://esicportal.info">esic portal login</a> | <a id="spam-okwin" href="https://okwin.cc/login">OK Win Login</a></p>
            <p>Log in to comment at our casino site!</p>
          </div>
        </div>
      </div>
    `
    let clickedSpam = false
    const routes: Record<string, V233Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>GMU AI Strategies</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <button data-hook="comment-box-placeholder">Write a comment...</button>
              </div>
              ${spamCommentsHtml}
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value, el, doc) => {
          if (kind === 'click' && (el?.id?.startsWith('spam-') || selector.includes('spam-'))) {
            clickedSpam = true
          }
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>GMU AI Strategies</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comments-section">
                    <div data-hook="comment-box">
                      <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                      <button type="button" data-hook="submit-comment-button">Publish</button>
                    </div>
                    ${spamCommentsHtml}
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Insightful policy notes <a href="https://goshortsai.example.com">https://goshortsai.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixUrl]!.html = `
              <html><head><title>GMU AI Strategies</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div data-hook="top-level-comment-list">
                    <div data-hook="comment-item">Insightful policy notes <a href="https://goshortsai.example.com">Goshortsai</a></div>
                  </div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-spam-1',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Insightful policy notes',
        websiteUrl: 'https://goshortsai.example.com',
        autoGoogleSso: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(clickedSpam).toBe(false)
    expect(actions.some(a => a.selector?.includes('spam-'))).toBe(false)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('skips login detection when Wix comment-box-rce-wrapper + active submit button are already visible (even with stray external links outside comment list)', async () => {
    const wixUrl = 'https://vermontmuseum.org/post/exhibit-2026'
    let clickedSpam = false
    const routes: Record<string, V233Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>Vermont Museum</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <main>
              <article data-hook="post">
                <a id="spam-ext-article" href="https://jaiclub.in/login">Jai Club Login</a>
              </article>
              <div data-hook="comments-section">
                <div data-hook="comment-box">
                  <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                  <button type="button" data-hook="submit-comment-button">Publish</button>
                </div>
                <div class="custom-comments-wrapper">
                  <a id="spam-ext-comment" href="https://dmplay.net/login">DmPlay Login</a>
                </div>
              </div>
            </main>
          </body></html>
        `,
        onAction: (kind, selector, value, el, doc) => {
          if (kind === 'click' && (el?.id?.startsWith('spam-') || selector.includes('spam-'))) {
            clickedSpam = true
          }
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Great exhibit <a href="https://goshortsai.example.com">https://goshortsai.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixUrl]!.html = `
              <html><head><title>Vermont Museum</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div data-hook="comment-item">Great exhibit <a href="https://goshortsai.example.com">Goshortsai</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-loggedin-rce',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Great exhibit',
        websiteUrl: 'https://goshortsai.example.com',
        autoGoogleSso: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(clickedSpam).toBe(false)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('ignores spam external login links during Wix autoGoogleSso and clicks only the real Wix login button (while preserving logged-out redline)', async () => {
    const wixUrl = 'https://acrcglobal.com/post/industry-update'
    const loggedInHtml = `
      <html><head><title>ACRC Global</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div data-hook="comments-section">
          <div data-hook="comment-box">
            <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
            <button type="button" data-hook="submit-comment-button">Publish</button>
          </div>
        </div>
      </body></html>
    `
    let clickedSpam = false
    const routes: Record<string, V233Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>ACRC Global</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="top-level-comment-list">
                <div data-hook="comment-item">
                  <div data-hook="comment-content"><a id="spam-first-link" href="https://okwin-vip.com/login">OK Win Login</a></div>
                </div>
              </div>
              <button data-hook="login-as-member-text-button" type="button">Log in to comment</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value, el, doc) => {
          if (kind === 'click' && (el?.id === 'spam-first-link' || selector.includes('spam-first-link'))) {
            clickedSpam = true
          }
          if (kind === 'click' && selector.includes('login-as-member-text-button')) {
            return {
              mutateHtml: `
                <html><head><title>ACRC Global</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <h2>Log in</h2>
                    <button id="google-sso-btn" type="button">Log in with Google</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('google-sso-btn')) {
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount',
                    html: '<html><body><div data-identifier="user@gmail.com">user@gmail.com</div></body></html>',
                    onClick: () => ({ mutateParentHtml: loggedInHtml, close: true }),
                  },
                ],
              },
            }
          }
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Helpful report <a href="https://goshortsai.example.com">https://goshortsai.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixUrl]!.html = `
              <html><head><title>ACRC Global</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div data-hook="comment-item">Helpful report <a href="https://goshortsai.example.com">Goshortsai</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-sso-clean',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Helpful report',
        websiteUrl: 'https://goshortsai.example.com',
        autoGoogleSso: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(clickedSpam).toBe(false)
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('login-as-member-text-button'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // Regression: logged-out page with ONLY spam comments and NO real login button must NOT return needs_login or click spam links.
    const spamOnlyUrl = 'https://ulrichlifestyle.com/post/spam-only'
    let clickedSpamOnly = false
    const { page: spamOnlyPage } = createV233MockPage({
      [spamOnlyUrl]: {
        html: `
          <html><head><title>Ulrich Lifestyle</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="top-level-comment-list">
                <div data-hook="comment-item">
                  <div data-hook="comment-content">
                    <a id="spam-daman-only" href="https://daman.games/login">Daman Login</a>
                    <span>Log in to comment at daman.games</span>
                  </div>
                </div>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, _sel, _val, el) => {
          if (kind === 'click' && el?.id === 'spam-daman-only') clickedSpamOnly = true
        },
      },
    })
    const spamOnlyRes = await executeCommentPublish(
      spamOnlyPage as never,
      'p-wix-spam-only',
      {
        kind: 'comment_publish',
        url: spamOnlyUrl,
        siteHint: 'wix_blog',
        commentText: 'Hello',
        autoGoogleSso: true,
      },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 200, sleepImpl: async () => {} },
    )
    expect(clickedSpamOnly).toBe(false)
    expect(spamOnlyRes.outcome).toBe('needs_llm_fallback')
    expect(spamOnlyRes.submitTriggered).toBe(false)
  })
})

describe('v2.3.3 Fix 2: OpenCart Journal2 / Journal3 .comment-submit & multilingual submit button matching', () => {
  it('matches Lithuanian, Greek, English, and multilingual OpenCart comment submit button labels', () => {
    for (const label of ['SIŲSTI', 'siusti', 'PATEIKTI', 'Submit', 'Post Comment', 'Submit Comment', 'Υποβολή', 'Αποστολή', 'Send']) {
      expect(matchesMultilingualSubmitLabel(label), label).toBe(true)
    }
    expect(matchesMultilingualSubmitLabel('Read More')).toBe(false)
  })

  it('fills and submits OpenCart Journal3 .comment-submit form (omninatural.co.uk style) with Journal JSON success response', async () => {
    const ocUrl = 'https://www.omninatural.co.uk/blog/natural-skincare-tips'
    const routes: Record<string, V233Route> = {
      [ocUrl]: {
        html: `
          <html><head><title>OmniNatural Blog</title><link rel="stylesheet" href="/catalog/view/theme/journal3/stylesheet/style.css"></head><body>
            <div class="post-comments">
              <div class="comment-form">
                <form class="form-horizontal">
                  <input type="text" name="name" placeholder="Name" />
                  <input type="email" name="email" placeholder="Email" />
                  <input type="text" name="website" placeholder="Website" />
                  <textarea name="comment" placeholder="Comment"></textarea>
                  <button type="button" class="btn btn-primary comment-submit"><span>Submit</span></button>
                </form>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-submit')) {
            return {
              emitResponses: [
                {
                  url: 'https://www.omninatural.co.uk/index.php?route=journal3/blog/comment&post_id=42',
                  status: 200,
                  method: 'POST',
                  resourceType: 'xhr',
                  body: JSON.stringify({
                    status: 'success',
                    response: { message: 'Thank you for your comment. It is awaiting moderation.' },
                  }),
                },
              ],
            }
          }
        },
      },
    }

    const { page, actions } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-oc-journal3',
      {
        kind: 'comment_publish',
        url: ocUrl,
        commentText: 'Great skincare breakdown!',
        authorName: 'Alex',
        authorEmail: 'alex@example.org',
        websiteUrl: 'https://goshortsai.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('comment-submit'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'opencart',
      submitTriggered: true,
    })
  })

  it('fills and submits OpenCart Journal2 div.comment-form + a.comment-submit (3guys.gr style) and verifies live link on reload', async () => {
    const ocUrl = 'https://3guys.gr/blog/espresso-extraction'
    const routes: Record<string, V233Route> = {
      [ocUrl]: {
        html: `
          <html><head><title>3Guys Coffee Blog</title><link rel="stylesheet" href="/catalog/view/theme/journal2/css/journal.css"></head><body>
            <div class="post-comments">
              <div class="comment-form">
                <input type="text" name="name" />
                <input type="email" name="email" />
                <input type="text" name="website" />
                <textarea name="comment"></textarea>
                <a class="button comment-submit">Υποβολή</a>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, _val, _el, doc) => {
          if (kind === 'click' && selector.includes('comment-submit')) {
            const alert = doc?.createElement('div')
            if (alert && doc) {
              alert.className = 'alert alert-success'
              alert.textContent = 'Your comment has been posted!'
              doc.querySelector('.comment-form')?.prepend(alert)
            }
            routes[ocUrl]!.html = `
              <html><head><title>3Guys Coffee Blog</title></head><body>
                <div class="post-comments">
                  <div class="comment-item">
                    <a href="https://goshortsai.example.com">Alex</a>
                    <p>Awesome extraction notes!</p>
                  </div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-oc-journal2',
      {
        kind: 'comment_publish',
        url: ocUrl,
        commentText: 'Awesome extraction notes!',
        authorName: 'Alex',
        authorEmail: 'alex@example.org',
        websiteUrl: 'https://goshortsai.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('comment-submit'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'opencart',
      submitTriggered: true,
    })
  })

  it('matches Lithuanian SIŲSTI / PATEIKTI submit buttons inside OpenCart comment container without clicking Reply, and still blocks OpenCart CAPTCHA', async () => {
    const ocLtUrl = 'https://kashyapholidays.in/index.php?route=journal3/blog/post&journal_blog_post_id=19'
    const routes: Record<string, V233Route> = {
      [ocLtUrl]: {
        html: `
          <html><head><title>Journal Blog LT</title><link rel="stylesheet" href="/catalog/view/theme/journal3/stylesheet/style.css"></head><body>
            <div class="post-comments">
              <div class="comment-list">
                <div class="comment-item">
                  <p>Existing comment</p>
                  <button type="button" class="reply-btn">Reply</button>
                </div>
              </div>
              <div class="comment-form">
                <form>
                  <input type="text" name="name" />
                  <input type="email" name="email" />
                  <textarea name="comment"></textarea>
                  <button type="button" id="lt-send-btn" class="btn btn-primary">SIŲSTI</button>
                </form>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('lt-send-btn')) {
            return {
              emitResponses: [
                {
                  url: 'https://kashyapholidays.in/index.php?route=journal3/blog/comment',
                  status: 200,
                  method: 'POST',
                  resourceType: 'xhr',
                  body: JSON.stringify({ success: 'Comment submitted for approval.' }),
                },
              ],
            }
          }
        },
      },
    }

    const { page, actions } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-oc-lt',
      {
        kind: 'comment_publish',
        url: ocLtUrl,
        commentText: 'Puikus straipsnis!',
        authorName: 'Tomas',
        authorEmail: 'tomas@example.lt',
        websiteUrl: 'https://goshortsai.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('lt-send-btn'))).toBe(true)
    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'opencart',
      submitTriggered: true,
    })

    // Journal3 .comment-submit WITH CAPTCHA must still return blocked_captcha without clicking.
    const ocCapUrl = 'https://cap-journal.example.org/blog/post-1'
    const { page: capPage, actions: capActions } = createV233MockPage({
      [ocCapUrl]: {
        html: `
          <html><head><title>Cap Journal</title><link rel="stylesheet" href="/catalog/view/theme/journal3/stylesheet/style.css"></head><body>
            <div class="post-comments">
              <div class="comment-form">
                <form>
                  <input type="text" name="name" />
                  <textarea name="comment"></textarea>
                  <div class="g-recaptcha" data-sitekey="abc"></div>
                  <button type="button" class="comment-submit">PATEIKTI</button>
                </form>
              </div>
            </div>
          </body></html>
        `,
      },
    })
    const capRes = await executeCommentPublish(
      capPage as never,
      'p-oc-cap',
      {
        kind: 'comment_publish',
        url: ocCapUrl,
        commentText: 'Nice post',
        authorName: 'Alex',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(capRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'opencart',
      submitTriggered: false,
    })
    expect(capActions.some(a => a.kind === 'click')).toBe(false)
  })
})

describe('v2.3.3 Fix 3: Wix pages with third-party comment plugin iframes prioritize native Wix comments', () => {
  it('distinguishes third-party non-Wix comment iframes from Wix-native, same-origin, Blogger, and CAPTCHA iframes', () => {
    const pageUrl = 'https://www.ukiyoto.com/post/book-launch'
    expect(isThirdPartyNonWixCommentFrameUrl('https://www.commentsplugin.com/widget?id=99', pageUrl)).toBe(true)
    expect(isThirdPartyNonWixCommentFrameUrl('https://disqus.com/embed/comments/?f=demo', pageUrl)).toBe(true)
    expect(isThirdPartyNonWixCommentFrameUrl('https://talk.hyvor.com/embed/iframe', pageUrl)).toBe(true)

    expect(isThirdPartyNonWixCommentFrameUrl('https://apps.wixapps.net/comments-ooi/frame', pageUrl)).toBe(false)
    expect(isThirdPartyNonWixCommentFrameUrl('https://www.ukiyoto.com/embedded-section', pageUrl)).toBe(false)
    expect(isThirdPartyNonWixCommentFrameUrl('https://www.blogger.com/comment/frame/123', pageUrl)).toBe(false)
    expect(isThirdPartyNonWixCommentFrameUrl('https://www.google.com/recaptcha/api2/anchor', pageUrl)).toBe(false)
  })

  it('waits for native Wix comments to hydrate and publishes through native Wix even when a third-party commentsplugin.com iframe is mounted (ukiyoto.com scenario)', async () => {
    const ukiyotoUrl = 'https://www.ukiyoto.com/post/poetry-anthology'
    const thirdPartyFrames: V233ChildFrameSpec[] = [
      {
        url: 'https://www.commentsplugin.com/embed?site=ukiyoto',
        html: '<body><textarea placeholder="Write a comment"></textarea><div class="g-recaptcha"></div><p>Comments are closed</p></body>',
      },
      {
        url: 'https://www.google.com/recaptcha/api2/anchor?k=thirdparty',
        parentUrl: 'https://www.commentsplugin.com/embed?site=ukiyoto',
        html: '<body>reCAPTCHA inside third-party widget</body>',
      },
    ]

    let hydrated = false
    const routes: Record<string, V233Route> = {
      [ukiyotoUrl]: {
        html: `
          <html><head><title>Ukiyoto Publishing</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <h1 data-hook="post-title">Poetry Anthology</h1>
                <iframe src="https://www.commentsplugin.com/embed?site=ukiyoto"></iframe>
              </article>
              <div data-hook="comments-section-placeholder"></div>
            </div>
          </body></html>
        `,
        frames: thirdPartyFrames,
        onScroll: (count) => {
          if (!hydrated && count >= 1) {
            hydrated = true
            return {
              mutateHtml: `
                <html><head><title>Ukiyoto Publishing</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SITE_CONTAINER">
                    <article data-hook="post">
                      <h1 data-hook="post-title">Poetry Anthology</h1>
                      <iframe src="https://www.commentsplugin.com/embed?site=ukiyoto"></iframe>
                    </article>
                    <div data-hook="comments-section">
                      <div data-hook="comment-box">
                        <button data-hook="comment-box-placeholder">Write a comment...</button>
                      </div>
                    </div>
                  </div>
                </body></html>
              `,
              frames: thirdPartyFrames,
            }
          }
        },
        onAction: (kind, selector, value, _el, doc) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>Ukiyoto Publishing</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SITE_CONTAINER">
                    <iframe src="https://www.commentsplugin.com/embed?site=ukiyoto"></iframe>
                    <div data-hook="comments-section">
                      <div data-hook="comment-box">
                        <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                        <button type="button" data-hook="submit-comment-button">Publish</button>
                      </div>
                    </div>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Wonderful anthology! <a href="https://goshortsai.example.com">https://goshortsai.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[ukiyotoUrl]!.html = `
              <html><head><title>Ukiyoto Publishing</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div data-hook="comment-item">Wonderful anthology! <a href="https://goshortsai.example.com">Goshortsai</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-ukiyoto',
      {
        kind: 'comment_publish',
        url: ukiyotoUrl,
        siteHint: 'wix_blog',
        commentText: 'Wonderful anthology!',
        websiteUrl: 'https://goshortsai.example.com',
      },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 2_000, sleepImpl: async () => {} },
    )

    expect(hydrated).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('prioritizes native <wix-comments> container alongside commentsplugin.com iframe, while still blocking top-level reCAPTCHA iframes', async () => {
    const wixCustomElUrl = 'https://www.ukiyoto.com/post/native-wix-comments'
    const routes: Record<string, V233Route> = {
      [wixCustomElUrl]: {
        html: `
          <html><head><title>Ukiyoto Custom El</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <iframe src="https://www.commentsplugin.com/embed?site=ukiyoto"></iframe>
            <wix-comments>
              <div contenteditable="true" role="textbox"></div>
              <button type="button" data-hook="submit-comment-button">Publish</button>
            </wix-comments>
          </body></html>
        `,
        frames: [
          {
            url: 'https://www.commentsplugin.com/embed?site=ukiyoto',
            html: '<body><textarea placeholder="Third party"></textarea></body>',
          },
        ],
        onAction: (kind, selector, value, _el, doc) => {
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Great read <a href="https://goshortsai.example.com">https://goshortsai.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixCustomElUrl]!.html = `
              <html><head><title>Ukiyoto Custom El</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <wix-comments><div class="comment">Great read <a href="https://goshortsai.example.com">Goshortsai</a></div></wix-comments>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV233MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-comments-el',
      {
        kind: 'comment_publish',
        url: wixCustomElUrl,
        siteHint: 'wix_blog',
        commentText: 'Great read',
        websiteUrl: 'https://goshortsai.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // Top-level page reCAPTCHA iframe alongside native Wix comments MUST still be blocked (zero CAPTCHA bypass).
    const capUrl = 'https://www.ukiyoto.com/post/real-captcha'
    const { page: capPage, actions: capActions } = createV233MockPage({
      [capUrl]: {
        html: `
          <html><head><title>Ukiyoto Captcha</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <wix-comments>
              <div contenteditable="true" role="textbox"></div>
              <button type="button" data-hook="submit-comment-button">Publish</button>
            </wix-comments>
          </body></html>
        `,
        frames: [
          {
            url: 'https://www.google.com/recaptcha/api2/anchor?k=real',
            html: '<body>reCAPTCHA</body>',
          },
        ],
      },
    })
    const capRes = await executeCommentPublish(
      capPage as never,
      'p-wix-real-cap',
      {
        kind: 'comment_publish',
        url: capUrl,
        siteHint: 'wix_blog',
        commentText: 'Should be blocked',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(capRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      submitTriggered: false,
    })
    expect(capActions).toHaveLength(0)
  })
})
