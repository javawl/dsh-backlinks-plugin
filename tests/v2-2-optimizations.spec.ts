import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import {
  DEFAULT_WIX_LAZY_WAIT_MAX_MS,
  executeCommentPublish,
  INSPECT_COMMENT_PAGE_SCRIPT,
  verifyCommentResultInDom,
  type CommentPageInspection,
} from '../src/host/browser-playwright/comment-publish.ts'
import {
  COMPACT_TEXT_SCRIPT,
  compactAriaSnapshot,
  compactPlainText,
  formatCompactTextEvaluation,
} from '../src/host/browser-playwright/compact-snapshot.ts'
import { executeDirectoryAutofill } from '../src/host/browser-playwright/directory-autofill.ts'
import { parseControlReport, renderPageControls, VISIBLE_CONTROLS_SCRIPT } from '../src/host/browser-playwright/interactive.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import type { BrowserAutomationProvider, BrowserSession } from '../src/host/browser/types.ts'
import { BrowserError } from '../src/host/browser/types.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { BrowserSessionManager, createBrowserToolHandler, formatMcpBrowserOutput } from '../src/mcp/browser-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'
import { detectSiteHint, detectTimeoutClusters, readBoundedBodyText, runBatchPreflight } from '../src/mcp/preflight.ts'

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

interface MockFrameRoute {
  url: string
  html: string
  onAction?: (kind: string, selector: string, value?: string) => { mutateHtml?: string } | void
}

interface MockPageRoute {
  html: string
  frames?: MockFrameRoute[]
  onScroll?: (fraction: number, count: number) => string | void
  onInspect?: (count: number) => string | void
  onKeyPress?: (key: string) => { mutateHtml?: string } | void
  onAction?: (kind: string, selector: string, value?: string) => {
    navigateTo?: string
    mutateHtml?: string
    throwOnce?: Error
  } | void
}

function createRichDomMockPage(routes: Record<string, MockPageRoute>, opts?: { failFirstVerifyWithDestroyed?: boolean }) {
  const buildDom = (html: string, url: string) => {
    const next = new JSDOM(html, { url, runScripts: 'outside-only' })
    next.window.scrollTo = () => {}
    next.window.HTMLElement.prototype.scrollIntoView = function () {
      scrolledIntoViewTags.push(this.getAttribute('data-hook') || this.id || this.localName)
    }
    return next
  }

  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let dom = buildDom(routes[currentUrl]?.html ?? '<html></html>', currentUrl)
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const keysPressed: string[] = []
  const scrolledIntoViewTags: string[] = []
  let scrollCount = 0
  let inspectCount = 0
  let failedVerifyOnce = false

  const mainFrameStub = { url: () => currentUrl, isDetached: () => false }
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

  const makeFrameApi = (spec: MockFrameRoute) => {
    let frameDom = buildDom(spec.html, spec.url)
    return {
      url: () => spec.url,
      isDetached: () => false,
      evaluate: async (scriptOrFn: unknown, arg?: unknown) => {
        if (typeof scriptOrFn === 'string') return frameDom.window.eval(scriptOrFn)
        return runWithDomGlobals(frameDom, () => (scriptOrFn as (a?: unknown) => unknown)(arg))
      },
      locator: (selector: string) => {
        const api = {
          fill: async (val: string) => {
            actions.push({ kind: 'frame:fill', selector, value: val })
            const el = frameDom.window.document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
            if (!el) throw new Error(`Missing frame element for fill: ${selector}`)
            el.value = val
            const eff = spec.onAction?.('fill', selector, val)
            if (eff?.mutateHtml) {
              spec.html = eff.mutateHtml
              frameDom = buildDom(eff.mutateHtml, spec.url)
            }
          },
          selectOption: async (val: string) => {
            actions.push({ kind: 'frame:select', selector, value: val })
            const el = frameDom.window.document.querySelector(selector) as HTMLSelectElement | null
            if (el) el.value = val
            const eff = spec.onAction?.('select', selector, val)
            if (eff?.mutateHtml) {
              spec.html = eff.mutateHtml
              frameDom = buildDom(eff.mutateHtml, spec.url)
            }
          },
          click: async () => {
            actions.push({ kind: 'frame:click', selector })
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

  const page = {
    isClosed: () => false,
    on: () => {},
    off: () => {},
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
        keysPressed.push(key)
        actions.push({ kind: 'keyboard:press', value: key })
        const eff = activeRoute()?.onKeyPress?.(key)
        if (eff?.mutateHtml) {
          activeRoute()!.html = eff.mutateHtml
          dom = buildDom(eff.mutateHtml, currentUrl)
        }
      },
    },
    goto: async (url: string) => {
      actions.push({ kind: 'goto', value: url })
      loadRoute(url)
    },
    waitForNavigation: async () => null,
    waitForLoadState: async () => {},
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      const route = activeRoute()
      if (typeof fnOrScript === 'function' && fnOrScript === verifyCommentResultInDom && opts?.failFirstVerifyWithDestroyed && !failedVerifyOnce) {
        failedVerifyOnce = true
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
      }
      if (typeof fnOrScript === 'function' && typeof arg === 'number') {
        const mutated = route?.onScroll?.(arg, scrollCount++)
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
          const eff = activeRoute()?.onAction?.('click', selector)
          if (eff?.throwOnce) {
            throw eff.throwOnce
          }
          if (eff?.mutateHtml) {
            dom = buildDom(eff.mutateHtml, currentUrl)
          }
          if (eff?.navigateTo) {
            loadRoute(eff.navigateTo)
          }
        },
        press: async (key: string) => {
          keysPressed.push(key)
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

  return { page, actions, keysPressed, scrolledIntoViewTags }
}

describe('Pillar 1: Wix comment_publish full deterministic pipeline', () => {
  it('defaults Wix lazy wait to 8-10s, scrolls placeholder into view, supports multilingual triggers, and dismisses marketing overlays before clicking', async () => {
    expect(DEFAULT_WIX_LAZY_WAIT_MAX_MS).toBeGreaterThanOrEqual(8_000)
    expect(DEFAULT_WIX_LAZY_WAIT_MAX_MS).toBeLessThanOrEqual(10_000)

    const postUrl = 'https://fi.wixsite.com/blog/post/finnish-post'
    let popupDismissed = false
    let clickedTrigger = false

    const routes: Record<string, MockPageRoute> = {
      [postUrl]: {
        html: `
          <html><head><title>Finnish Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="POPUPS_ROOT"><div role="dialog">Subscribe to our newsletter! <button aria-label="Close">×</button></div></div>
            <article data-hook="post">
              <div data-hook="comments-section-placeholder">Comments Loading...</div>
            </article>
          </body></html>
        `,
        onScroll: (_fraction, idx) => {
          if (idx === 1) {
            return `
              <html><head><title>Finnish Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div id="POPUPS_ROOT"><div role="dialog">Subscribe to our newsletter! <button aria-label="Close">×</button></div></div>
                <article data-hook="post">
                  <div data-hook="comment-box">
                    <button data-hook="comment-box-placeholder">Kirjoita kommentti...</button>
                  </div>
                </article>
              </body></html>
            `
          }
        },
        onKeyPress: (key) => {
          if (key === 'Escape') {
            popupDismissed = true
            return {
              mutateHtml: routes[postUrl]!.html.replace(/<div id="POPUPS_ROOT">[\s\S]*?<\/div><\/div>/u, '<div id="POPUPS_ROOT" style="display:none"></div>'),
            }
          }
        },
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            clickedTrigger = true
            return {
              mutateHtml: `
                <html><head><title>Finnish Wix Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box">
                    <div data-hook="create-comment-input" contenteditable="true"></div>
                    <input name="guestName" placeholder="Name" />
                    <button data-hook="submit-comment-button">Julkaise</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }

    const { page, keysPressed, scrolledIntoViewTags } = createRichDomMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-fi',
      { kind: 'comment_publish', url: postUrl, commentText: 'Great read', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(scrolledIntoViewTags).toContain('comments-section-placeholder')
    expect(keysPressed).toContain('Escape')
    expect(popupDismissed).toBe(true)
    expect(clickedTrigger).toBe(true)
    expect(res).toMatchObject({ outcome: 'form_ready', siteType: 'wix', submitTriggered: false })
  })

  it('filters non-comment third-party iframes (trustpilot/engage.wixapps/usrfiles/maps/youtube) so commentless Wix pages return no_form', async () => {
    const aboutUrl = 'https://clean.wixsite.com/site/about'
    const { page } = createRichDomMockPage({
      [aboutUrl]: {
        html: `<html><head><title>About Us</title><script src="https://static.wixstatic.com/a.js"></script></head><body><main><p>Static company info.</p></main></body></html>`,
        frames: [
          { url: 'https://widget.trustpilot.com/trustboxes/5419b6a8b0d04a076446a9ad/index.html', html: '<body>4.9 stars</body>' },
          { url: 'https://engage.wixapps.net/chat-widget-server/renderFedops', html: '<body>Chat with us</body>' },
          { url: 'https://static.usrfiles.com/html/embed-badge.html', html: '<body>Badge</body>' },
          { url: 'https://www.google.com/maps/embed?pb=123', html: '<body>Map</body>' },
          { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', html: '<body>Video</body>' },
          { url: 'https://player.vimeo.com/video/12345', html: '<body>Vimeo</body>' },
          { url: 'https://googleads.g.doubleclick.net/pagead/ads', html: '<body>Ad</body>' },
        ],
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p-wix-clean',
      { kind: 'comment_publish', url: aboutUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 50, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'no_form',
      siteType: 'wix',
      suggestedTags: ['no_form'],
      submitTriggered: false,
    })
  })

  it('fast-detects Wix member comment wall (Log in / Faça login / Iniciar sesión + no guest inputs) without blind Publish', async () => {
    for (const label of ['Log in', 'Faça login', 'Iniciar sesión']) {
      const url = 'https://member.wixsite.com/blog/post/member-only'
      const { page, actions } = createRichDomMockPage({
        [url]: {
          html: `
            <html><head><title>Member Blog</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
              <div data-hook="comments-section">
                <div data-hook="comment-box">
                  <div data-hook="create-comment-input" contenteditable="true"></div>
                  <button data-hook="login-btn">${label}</button>
                  <button data-testid="google-sso">Continue with Google</button>
                  <button data-hook="submit-comment-button">Publish</button>
                </div>
              </div>
            </body></html>
          `,
        },
      })

      const res = await executeCommentPublish(
        page as never,
        'p-member',
        { kind: 'comment_publish', url, commentText: 'Nice article', websiteUrl: 'https://demo.example.com' },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )

      expect(res.outcome, label).toBe('needs_login')
      expect(res.submitTriggered, label).toBe(false)
      expect(res.loginInfo?.ssoProviders, label).toContain('google')
      expect(actions.some(a => a.kind === 'click' && a.selector?.includes('submit'))).toBe(false)
    }
  })

  it('sends Space in Wix contenteditable editor to verify autolink <a href>, and runs post-submit dialog + reload double verification', async () => {
    const url = 'https://space.wixsite.com/blog/post/autolink'
    const routes: Record<string, MockPageRoute> = {
      [url]: {
        html: `
          <html><head><title>Space Autolink</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true"></div>
                <input name="guestName" placeholder="Your name" />
                <button data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space' && selector.includes('create-comment-input')) {
            // Simulate Wix Tiptap autolink converting URL into clickable <a href> upon Space.
            return {
              mutateHtml: routes[url]!.html.replace(
                '<div data-hook="create-comment-input" contenteditable="true"></div>',
                '<div data-hook="create-comment-input" contenteditable="true">Great guide <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[url]!.html = `
              <html><head><title>Space Autolink</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="comment-item">Great guide <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, keysPressed } = createRichDomMockPage(routes)
    const liveRes = await executeCommentPublish(
      page as never,
      'p-space-live',
      {
        kind: 'comment_publish',
        url,
        commentText: 'Great guide',
        authorName: 'Alice',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
    )
    expect(keysPressed).toContain('Space')
    expect(liveRes).toMatchObject({ outcome: 'live', siteType: 'wix', submitTriggered: true })

    // Case 2: Optimistic DOM disappears after clean reload -> uncertain_after_submit (optimistic_dom_not_persisted), NEVER live!
    const optimisticUrl = 'https://opt.wixsite.com/blog/post/fake-live'
    let reloadCount = 0
    const optRoutes: Record<string, MockPageRoute> = {
      [optimisticUrl]: {
        html: `
          <html><head><title>Optimistic Wix</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true"></div>
                <input name="guestName" placeholder="Name" />
                <button data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: optRoutes[optimisticUrl]!.html.replace(
                '<div data-hook="create-comment-input" contenteditable="true"></div>',
                '<div data-hook="create-comment-input" contenteditable="true">Insightful <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            // Immediate optimistic DOM shows the link, but clean reload has empty comments!
            const optimisticDom = `
              <html><head><title>Optimistic Wix</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
                <div data-hook="comments-section"><div class="optimistic">Insightful <a href="https://demo.example.com">Demo</a></div></div>
              </body></html>
            `
            optRoutes[optimisticUrl]!.html = `
              <html><head><title>Optimistic Wix</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
                <div data-hook="comments-section"><p>No comments yet.</p></div>
              </body></html>
            `
            reloadCount++
            return { mutateHtml: optimisticDom }
          }
        },
      },
    }
    const { page: optPage } = createRichDomMockPage(optRoutes)
    const optRes = await executeCommentPublish(
      optPage as never,
      'p-opt',
      { kind: 'comment_publish', url: optimisticUrl, commentText: 'Insightful', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, wixLazyWaitMaxMs: 10, sleepImpl: async () => {} },
    )
    expect(reloadCount).toBe(1)
    expect(optRes).toMatchObject({
      outcome: 'uncertain_after_submit',
      siteType: 'wix',
      reason: 'optimistic_dom_not_persisted',
      submitTriggered: true,
    })
    expect(optRes.evidence).toContain('optimistic_dom_not_persisted')

    // Case 3: Post-submit role=dialog with reCAPTCHA -> blocked_captcha; with Sign Up -> needs_login; with pending review -> submitted.
    for (const variant of [
      { name: 'recaptcha', dialog: '<div role="dialog"><div class="g-recaptcha"></div>Verify human</div>', expected: 'blocked_captcha', triggered: false },
      { name: 'signup', dialog: '<div role="dialog"><h2>Sign Up</h2><button>Continue with Google</button></div>', expected: 'needs_login', triggered: false },
      { name: 'moderation', dialog: '<div role="dialog"><p>Your comment is pending approval.</p></div>', expected: 'submitted', triggered: true },
    ] as const) {
      const dUrl = `https://dlg.wixsite.com/blog/post/${variant.name}`
      const dlgRoutes: Record<string, MockPageRoute> = {
        [dUrl]: {
          html: `
            <html><head><title>Wix Dialog</title><script src="https://static.wixstatic.com/a.js"></script></head><body>
              <div data-hook="comments-section">
                <div data-hook="comment-box">
                  <textarea placeholder="Write a comment..."></textarea>
                  <input name="website" type="url" />
                  <button data-hook="submit-comment-button">Publish</button>
                </div>
              </div>
            </body></html>
          `,
          onAction: (kind, selector) => {
            if (kind === 'click' && selector.includes('submit-comment-button')) {
              return {
                mutateHtml: `<html><head><title>Wix Dialog</title></head><body>${variant.dialog}</body></html>`,
              }
            }
          },
        },
      }
      const { page: dlgPage } = createRichDomMockPage(dlgRoutes)
      const dlgRes = await executeCommentPublish(
        dlgPage as never,
        `p-dlg-${variant.name}`,
        { kind: 'comment_publish', url: dUrl, commentText: 'Good post', websiteUrl: 'https://demo.example.com' },
        { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
      )
      expect(dlgRes.outcome, variant.name).toBe(variant.expected)
      expect(dlgRes.submitTriggered, variant.name).toBe(variant.triggered)
    }
  })
})

describe('Pillar 2: Single-flight launch lock, keeper about:blank tab, and OAuth popup tracking/isolation', () => {
  it('enforces single-flight launch across concurrent callers and auto-recovers closed sessions cleanly', async () => {
    let openCalls = 0
    let session1Closed = false
    let resolveFirstOpen!: (session: BrowserSession) => void

    const provider: BrowserAutomationProvider = {
      id: 'mock-sf',
      available: () => true,
      open: () => {
        openCalls++
        if (openCalls === 1) {
          return new Promise<BrowserSession>((resolve) => {
            resolveFirstOpen = resolve
          })
        }
        return Promise.resolve({
          isClosed: () => false,
          act: async (cmd) => ({
            kind: 'page',
            page: cmd.page ?? 'p2',
            url: 'https://recovered.example.org',
            title: 'Recovered',
            text: 'ok',
            truncated: false,
          }),
          close: async () => {},
        })
      },
    }

    const manager = new BrowserSessionManager(provider)
    const p1 = manager.act({ kind: 'navigate', url: 'https://a.example.org', page: 'tabA' })
    const p2 = manager.act({ kind: 'navigate', url: 'https://b.example.org', page: 'tabB' })

    // Only ONE provider.open() call despite two concurrent navigates.
    expect(openCalls).toBe(1)

    resolveFirstOpen({
      isClosed: () => session1Closed,
      act: async (cmd) => {
        if (session1Closed) {
          throw new BrowserError('browser session is closed', 'BROWSER_ACTION_FAILED')
        }
        return {
          kind: 'page',
          page: cmd.page ?? 'p1',
          url: cmd.kind === 'navigate' ? cmd.url : 'https://example.org',
          title: 'OK',
          text: 'hello',
          truncated: false,
        }
      },
      close: async () => {
        session1Closed = true
      },
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.kind === 'page' && r1.page).toBe('tabA')
    expect(r2.kind === 'page' && r2.page).toBe('tabB')

    // Simulate context dying externally -> next act auto-relaunches cleanly via single-flight!
    session1Closed = true
    const r3 = await manager.act({ kind: 'navigate', url: 'https://recovered.example.org', page: 'tabC' })
    expect(openCalls).toBe(2)
    expect(r3.kind === 'page' && r3.url).toBe('https://recovered.example.org')
  })

  it('keeps an internal about:blank keeper on closePage of last tab, tracks OAuth popups via context.on(page), supports listPages, and isolates tab refs', async () => {
    const contextHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}
    const openPages: ReturnType<typeof makePage>[] = []

    function makePage(initialUrl: string, initialTitle: string, onClick?: () => void) {
      let closed = false
      let currentUrl = initialUrl
      const pageHandlers: Record<string, Array<() => void>> = {}
      const pageObj = {
        isClosed: () => closed,
        url: () => currentUrl,
        title: async () => initialTitle,
        goto: async (u: string) => { currentUrl = u },
        innerText: async () => initialTitle,
        waitForLoadState: async () => {},
        on: (ev: string, fn: () => void) => {
          ;(pageHandlers[ev] ??= []).push(fn)
        },
        close: async () => {
          closed = true
          const idx = openPages.indexOf(pageObj)
          if (idx >= 0) openPages.splice(idx, 1)
          for (const fn of pageHandlers.close ?? []) fn()
          if (openPages.length === 0) {
            for (const fn of contextHandlers.close ?? []) fn()
          }
        },
        locator: () => ({
          click: async () => {
            onClick?.()
          },
          first: () => ({ click: async () => { onClick?.() } }),
        }),
      }
      openPages.push(pageObj)
      return pageObj
    }

    const blogPage = makePage('https://blog.wixsite.com/post/1', 'Wix Blog', () => {
      // Simulate window.open OAuth popup fired during click.
      const popup = makePage('https://accounts.google.com/o/oauth2/auth', 'Sign in - Google Accounts')
      for (const fn of contextHandlers.page ?? []) fn(popup)
    })

    const mockContext = {
      pages: () => [...openPages],
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        ;(contextHandlers[ev] ??= []).push(fn)
      },
      newPage: async () => {
        const blank = makePage('about:blank', '')
        for (const fn of contextHandlers.page ?? []) fn(blank)
        return blank
      },
      close: async () => {},
    }

    const session = new PlaywrightSession(mockContext as never, 10_000, 4_500)

    // Navigate named tab `blog1` (creates new page since p1 was adopted in constructor).
    await session.act({ kind: 'navigate', page: 'blog1', url: 'https://blog.wixsite.com/post/1' })
    // Click Google button on p1 (which triggers window.open popup).
    const clickRes = await session.act({ kind: 'click', page: 'p1', selector: 'button.google' })
    expect(clickRes).toMatchObject({
      kind: 'acked',
      popupPageRef: 'popup1',
      openedPages: [{ ref: 'popup1', url: 'https://accounts.google.com/o/oauth2/auth', title: 'Sign in - Google Accounts', isPopup: true }],
    })
    expect(formatMcpBrowserOutput(clickRes, 4_500)).toContain('opened popup popup1')

    // listPages lists p1, blog1, and popup1 (not any internal keeper).
    const listed = await session.act({ kind: 'listPages' })
    expect(listed.kind).toBe('pages')
    if (listed.kind === 'pages') {
      expect(listed.pages.map(p => p.ref)).toEqual(['p1', 'blog1', 'popup1'])
      expect(listed.pages.find(p => p.ref === 'popup1')?.isPopup).toBe(true)
    }

    // Close popup1 -> blog1 and p1 MUST remain completely intact!
    await session.act({ kind: 'closePage', page: 'popup1' })
    const probeBlog = await session.act({ kind: 'probe', page: 'blog1' })
    expect(probeBlog).toMatchObject({ kind: 'probe', page: 'blog1', url: 'https://blog.wixsite.com/post/1' })

    // Close p1 and blog1 (the LAST business tab) -> context MUST NOT close thanks to internal about:blank keeper!
    await session.act({ kind: 'closePage', page: 'p1' })
    await session.act({ kind: 'closePage', page: 'blog1' })
    expect(session.isClosed()).toBe(false)
    expect(openPages).toHaveLength(1)
    expect(openPages[0]?.url()).toBe('about:blank')

    // listPages excludes the internal about:blank keeper.
    const listedEmpty = await session.act({ kind: 'listPages' })
    expect(listedEmpty.kind === 'pages' && listedEmpty.pages).toEqual([])

    // Re-navigating reuses the keeper cleanly without crashing.
    const nextNav = await session.act({ kind: 'navigate', page: 'fresh', url: 'https://next.example.org/' })
    expect(nextNav).toMatchObject({ kind: 'page', page: 'fresh', url: 'https://next.example.org/' })
    expect(blogPage.isClosed()).toBe(true)
  })
})

describe('Pillar 3: WP 302 context-destroyed recovery, multilingual moderation, #comment-ID cache downgrade & non-WP engines', () => {
  it('recovers from Execution context destroyed during WP 302 redirect and downgrades cached #comment-ID to submitted', async () => {
    const postUrl = 'https://wp-cache.example.org/post-1/'
    const redirectedUrl = 'https://wp-cache.example.org/post-1/#comment-777'

    const routes: Record<string, MockPageRoute> = {
      [postUrl]: {
        html: `
          <html><head><title>WP Cache Blog</title></head><body>
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
            // Post-submit page shows #comment-777 with author link, while clean reload serves stale cache without #comment-777.
            routes[redirectedUrl] = {
              html: `
                <html><head><title>WP Cache Blog</title></head><body>
                  <div id="comments">
                    <li id="comment-777"><a class="url" href="https://demo.example.com">Alice</a><p>Solid guide!</p></li>
                  </div>
                </body></html>
              `,
            }
            routes[postUrl]!.html = `
              <html><head><title>WP Cache Blog</title></head><body>
                <div id="comments"><p>Cached older comment only.</p></div>
              </body></html>
            `
            return { navigateTo: redirectedUrl }
          }
        },
      },
    }

    const { page } = createRichDomMockPage(routes, { failFirstVerifyWithDestroyed: true })
    // Override clean reload URL to simulate stale server cache on reload of redirectedUrl!
    const origGoto = page.goto
    let gotoCount = 0
    page.goto = async (target: string) => {
      gotoCount++
      if (gotoCount === 2) {
        routes[redirectedUrl]!.html = `<html><head><title>WP Cache Blog</title></head><body><div id="comments"><p>Cached page before purge.</p></div></body></html>`
      }
      return await origGoto(target)
    }

    const res = await executeCommentPublish(
      page as never,
      'p-wp-cache',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Solid guide!',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      reason: 'post_submit_comment_id_cached',
      publicUrl: redirectedUrl,
      postSubmitUrl: redirectedUrl,
      submitTriggered: true,
    })
  })

  it('detects multilingual moderation notices (ES/FR/DE/PT/FA/ZH) immediately pre-reload while keeping #comment-ID', async () => {
    const samples = [
      'Tu comentario está esperando moderación.',
      'Votre commentaire est en attente de modération.',
      'Dein Kommentar wartet auf Freischaltung.',
      'Seu comentário está aguardando moderação.',
      'دیدگاه شما در انتظار بررسی است.',
      '您的评论正在等待审核，审核通过后显示。',
    ]

    for (const notice of samples) {
      const postUrl = 'https://i18n-wp.example.org/article/'
      const modUrl = 'https://i18n-wp.example.org/article/?unapproved=88&moderation-hash=abc#comment-88'
      const routes: Record<string, MockPageRoute> = {
        [postUrl]: {
          html: `<html><head><title>i18n</title></head><body><form id="commentform"><textarea name="comment"></textarea><button id="submit" type="submit">Send</button></form></body></html>`,
          onAction: (kind) => {
            if (kind === 'click') return { navigateTo: modUrl }
          },
        },
        [modUrl]: {
          html: `<html><head><title>i18n</title></head><body><div id="comments"><p>${notice}</p></div></body></html>`,
        },
      }
      const { page, actions } = createRichDomMockPage(routes)
      const res = await executeCommentPublish(
        page as never,
        'p-i18n',
        { kind: 'comment_publish', url: postUrl, commentText: 'Great post', websiteUrl: 'https://demo.example.com' },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )
      expect(res.outcome, notice).toBe('submitted')
      expect(res.publicUrl, notice).toBe('https://i18n-wp.example.org/article/#comment-88')
      // Did not perform an unnecessary reload once moderation was definitively confirmed!
      expect(actions.filter(a => a.kind === 'goto')).toHaveLength(1)
    }
  })

  it('expands collapsed WP comments (SmartMag a.ts-button), supports Typecho & custom blog forms, and supports Blogger iframe', async () => {
    // 1. Collapsed WP SmartMag trigger
    const smartUrl = 'https://smartmag.example.org/news/'
    const smartRoutes: Record<string, MockPageRoute> = {
      [smartUrl]: {
        html: `
          <html><head><title>SmartMag</title></head><body>
            <a class="ts-button" href="#respond">ADD A COMMENT</a>
            <div id="respond" style="display:none">
              <form id="commentform" action="/wp-comments-post.php">
                <textarea id="comment" name="comment"></textarea>
                <button id="submit" type="submit">Post</button>
              </form>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('ts-button')) {
            return { mutateHtml: smartRoutes[smartUrl]!.html.replace('style="display:none"', '') }
          }
        },
      },
    }
    const { page: smartPage } = createRichDomMockPage(smartRoutes)
    const smartRes = await executeCommentPublish(
      smartPage as never,
      'p-smart',
      { kind: 'comment_publish', url: smartUrl, commentText: 'Nice', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(smartRes).toMatchObject({ outcome: 'form_ready', siteType: 'wordpress' })

    // 2. Typecho comment form (author/mail/url/text)
    const typechoUrl = 'https://typecho.example.org/archives/1/'
    const typechoRoutes: Record<string, MockPageRoute> = {
      [typechoUrl]: {
        html: `
          <html><head><title>Typecho Post</title><meta name="generator" content="Typecho 1.2" /></head><body>
            <form id="comment-form" action="/archives/1/comment" method="post">
              <input name="author" type="text" required />
              <input name="mail" type="email" required />
              <input name="url" type="url" />
              <textarea name="text" required></textarea>
              <button type="submit" id="tc-submit">提交评论</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('tc-submit')) {
            typechoRoutes[typechoUrl]!.html = `<html><head><title>Typecho Post</title></head><body><div id="comments"><a href="https://demo.example.com">Alice</a><p>很实用的教程</p></div></body></html>`
          }
        },
      },
    }
    const { page: tcPage } = createRichDomMockPage(typechoRoutes)
    const tcRes = await executeCommentPublish(
      tcPage as never,
      'p-tc',
      {
        kind: 'comment_publish',
        url: typechoUrl,
        commentText: '很实用的教程',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(tcRes).toMatchObject({ outcome: 'live', siteType: 'typecho', submitTriggered: true })

    // 3. Custom blog form (name/email/website/body)
    const customUrl = 'https://customblog.example.org/entry'
    const customRoutes: Record<string, MockPageRoute> = {
      [customUrl]: {
        html: `
          <html><head><title>Custom Blog</title></head><body>
            <section id="comments">
              <form action="/comments/create" method="post">
                <input name="name" type="text" />
                <input name="email" type="email" />
                <input name="website" type="url" />
                <textarea name="body"></textarea>
                <button type="submit" id="c-submit">Post Comment</button>
              </form>
            </section>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('c-submit')) {
            customRoutes[customUrl]!.html = `<html><head><title>Custom Blog</title></head><body><section id="comments"><p>Your comment is pending approval.</p></section></body></html>`
          }
        },
      },
    }
    const { page: customPage } = createRichDomMockPage(customRoutes)
    const customRes = await executeCommentPublish(
      customPage as never,
      'p-custom',
      {
        kind: 'comment_publish',
        url: customUrl,
        commentText: 'Great writeup',
        authorName: 'Bob',
        authorEmail: 'bob@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(customRes).toMatchObject({ outcome: 'submitted', siteType: 'other', submitTriggered: true })

    // 4. Blogger comment iframe (iframe[src*="blogger.com/comment"])
    const bloggerUrl = 'https://demo.blogspot.com/2026/11/post.html'
    const bloggerRoutes: Record<string, MockPageRoute> = {
      [bloggerUrl]: {
        html: `<html><head><title>Blogger Post</title></head><body><iframe src="https://www.blogger.com/comment/frame/12345"></iframe></body></html>`,
        frames: [
          {
            url: 'https://www.blogger.com/comment/frame/12345',
            html: `
              <html><body>
                <textarea id="commentBody" name="commentBody"></textarea>
                <input id="anonName" name="anonName" type="text" />
                <input id="anonURL" name="anonURL" type="url" />
                <input id="postCommentSubmit" type="submit" value="Publish" />
              </body></html>
            `,
            onAction: (kind, selector) => {
              if (kind === 'click' && selector.includes('postCommentSubmit')) {
                return { mutateHtml: '<html><body><p>Your comment will be visible after approval.</p></body></html>' }
              }
            },
          },
        ],
      },
    }
    const { page: bloggerPage } = createRichDomMockPage(bloggerRoutes)
    const bloggerRes = await executeCommentPublish(
      bloggerPage as never,
      'p-blogger',
      {
        kind: 'comment_publish',
        url: bloggerUrl,
        commentText: 'Helpful Blogger post',
        authorName: 'Carl',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(bloggerRes).toMatchObject({ outcome: 'submitted', siteType: 'blogger', submitTriggered: true })
  })
})

describe('Pillar 4: Compact snapshot upgrades, batch_fill submitFeedback, directory_autofill, preflight, navigate & batch_list websiteId', () => {
  it('collapses >15-option selects into first 3 + ... (共 N 项) + last 2 and preserves status keywords without role=alert', () => {
    const options = Array.from({ length: 40 }, (_, i) => `    - option "Country ${i + 1}"`).join('\n')
    const rawAria = [
      '- main:',
      '  - form "Submit Tool":',
      '    - textbox "Website URL"',
      '    - combobox "Country":',
      options,
      '    - textbox "Email"',
      '    - button "Submit"',
      ...Array.from({ length: 45 }, (_, i) => `  - paragraph: Filler paragraph ${i + 1} ${'word '.repeat(35)}`),
      '  - paragraph: Thank you! Your site has been submitted and is pending review.',
    ].join('\n')

    const compacted = compactAriaSnapshot(rawAria, 1_500)
    expect(compacted.text).toContain('option "Country 1"')
    expect(compacted.text).toContain('option "Country 3"')
    expect(compacted.text).toContain('... (共 40 项)')
    expect(compacted.text).toContain('option "Country 39"')
    expect(compacted.text).toContain('option "Country 40"')
    expect(compacted.text).not.toContain('option "Country 15"')
    // Form bottom and status feedback survive tight budget!
    expect(compacted.text).toContain('textbox "Email"')
    expect(compacted.text).toContain('button "Submit"')
    expect(compacted.text).toContain('Thank you! Your site has been submitted')

    // COMPACT_TEXT_SCRIPT accurately distinguishes #id vs [name=] and collects status keywords without role=alert.
    const selectOpts = Array.from({ length: 20 }, (_, i) => `<option value="c${i + 1}">Cat ${i + 1}</option>`).join('')
    const dom = new JSDOM(`
      <html><body>
        <form id="dir-form" action="/submit">
          <input id="site_id" type="url" />
          <input name="site_email" type="email" />
          <select id="cat_id" name="cat_name">${selectOpts}</select>
          <button type="submit">提交</button>
        </form>
        <p>提交成功，您的网站已提交等待审核！</p>
      </body></html>
    `, { runScripts: 'outside-only' })
    const evalRaw = dom.window.eval(COMPACT_TEXT_SCRIPT)
    const evalFmt = formatCompactTextEvaluation(evalRaw, 4_500)
    expect(evalFmt.text).toContain('input:url#site_id')
    expect(evalFmt.text).toContain('input:email[name="site_email"]')
    expect(evalFmt.text).toContain('select#cat_id[name="cat_name"] [Cat 1, Cat 2, Cat 3, ... (共 20 项), Cat 19, Cat 20]')
    expect(evalFmt.text).toContain('[alerts]')
    expect(evalFmt.text).toContain('提交成功')

    // compactPlainText exempts status keywords even under extreme truncation.
    const plain = [
      ...Array.from({ length: 40 }, (_, i) => `Unrelated prose ${i}: ${'lorem '.repeat(20)}`),
      'Error: this domain is already submitted.',
    ].join('\n')
    const compactPlain = compactPlainText(plain, 300)
    expect(compactPlain.text).toContain('Error: this domain is already submitted.')

    // interactive snapshot includes input[type=url].
    const iDom = new JSDOM(`
      <html><body>
        <form action="/submit">
          <input id="target-url" name="website" type="url" placeholder="https://your-site.com" />
          <button type="submit">Submit</button>
        </form>
      </body></html>
    `, { runScripts: 'outside-only' })
    iDom.window.CSS = { escape: (v: string) => v }
    for (const el of iDom.window.document.querySelectorAll('*')) {
      el.getBoundingClientRect = () => new iDom.window.DOMRect(10, 10, 120, 30)
    }
    const iReport = parseControlReport(iDom.window.eval(VISIBLE_CONTROLS_SCRIPT))
    const rendered = renderPageControls('Directory', iReport, { compact: true })
    expect(rendered).toContain('input[type=url]')
    expect(rendered).toContain('css=#target-url')
    expect(rendered).toContain('name=website')
  })

  it('captures native dialog alerts, XHR/fetch responses, and new DOM toast notices into batch_fill submitFeedback', async () => {
    const pageHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}
    let dialogAccepted = false
    let submittedDom = false

    const mockPage = {
      isClosed: () => false,
      url: () => 'https://onenav.example.cn/submit',
      title: async () => 'AI 导航提交',
      waitForLoadState: async () => {},
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        ;(pageHandlers[ev] ??= []).push(fn)
      },
      off: (ev: string, fn: (...args: unknown[]) => void) => {
        const list = pageHandlers[ev]
        if (list) {
          const idx = list.indexOf(fn)
          if (idx >= 0) list.splice(idx, 1)
        }
      },
      evaluate: async () => (submittedDom ? ['提交成功，审核通过后展示'] : []),
      locator: () => {
        const api = {
          fill: async () => {},
          click: async () => {
            submittedDom = true
            for (const fn of pageHandlers.dialog ?? []) {
              fn({
                type: () => 'alert',
                message: () => '提交成功！感谢推荐',
                accept: async () => { dialogAccepted = true },
              })
            }
            for (const fn of pageHandlers.response ?? []) {
              fn({
                url: () => 'https://onenav.example.cn/wp-admin/admin-ajax.php',
                status: () => 200,
                headers: () => ({ 'content-type': 'application/json' }),
                text: async () => '{"status":1,"msg":"提交成功，等待审核"}',
                request: () => ({ resourceType: () => 'xhr', method: () => 'POST' }),
              })
            }
          },
          first: () => api,
        }
        return api
      },
    }

    const session = new PlaywrightSession({
      pages: () => [mockPage],
      on: () => {},
      close: async () => {},
    } as never, 10_000, 4_500)

    const manager = new BrowserSessionManager({
      id: 'mock',
      available: () => true,
      open: async () => session,
    })
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    const res = await handle({
      action: 'batch_fill',
      fields: [{ target: 'input[name="url"]', value: 'https://demo.example.com' }],
      submitTarget: 'button[type="submit"]',
      feedbackWaitMs: 0,
    })

    expect(res.isError).toBeUndefined()
    expect(dialogAccepted).toBe(true)
    const { data } = parseToolPayload(res as never)
    expect(data).toMatchObject({
      succeeded: 1,
      failed: 0,
      submit: { attempted: true, ok: true },
      submitFeedback: {
        dialogs: [{ type: 'alert', message: '提交成功！感谢推荐' }],
        networkResponses: [{
          url: 'https://onenav.example.cn/wp-admin/admin-ajax.php',
          status: 200,
          bodySnippet: '{"status":1,"msg":"提交成功，等待审核"}',
        }],
        domNotices: ['提交成功，审核通过后展示'],
      },
    })
  })

  it('executes directory_autofill fast-path on MkDirs / AI-Autofill submit pages', async () => {
    const submitUrl = 'https://mkdirs-dir.example.org/submit'
    const routes: Record<string, MockPageRoute> = {
      [submitUrl]: {
        html: `
          <html><head><title>Submit to MkDirs</title></head><body>
            <form action="/api/submit">
              <input id="url" name="url" type="url" placeholder="https://..." required />
              <button type="button" id="ai-autofill">AI Autofill</button>
              <input id="name" name="name" type="text" placeholder="Tool name" required />
              <input id="tagline" name="tagline" type="text" placeholder="Short tagline" required />
              <textarea id="description" name="description" placeholder="Detailed description" required></textarea>
              <input id="email" name="email" type="email" placeholder="Your email" required />
              <button type="submit" id="submit-btn">Submit Tool</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('ai-autofill')) {
            // Simulate AI Autofill populating Name and Tagline, leaving Description and Email empty.
            return {
              mutateHtml: routes[submitUrl]!.html
                .replace('id="url" name="url" type="url"', 'id="url" name="url" type="url" value="https://demo.example.com"')
                .replace('id="name" name="name" type="text"', 'id="name" name="name" type="text" value="DemoSite AI"')
                .replace('id="tagline" name="tagline" type="text"', 'id="tagline" name="tagline" type="text" value="Auto fetched tagline"'),
            }
          }
        },
      },
    }

    const { page } = createRichDomMockPage(routes)
    const res = await executeDirectoryAutofill(
      page as never,
      'p-dir',
      {
        kind: 'directory_autofill',
        url: submitUrl,
        websiteUrl: 'https://demo.example.com',
        name: 'Fallback Name',
        tagline: 'Fallback Tagline',
        description: 'Full description of DemoSite AI.',
        email: 'submit@screwdom.org',
      },
      { defaultTimeoutMs: 10_000, waitAfterFetchMs: 50, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      kind: 'directory_autofill',
      outcome: 'ready_to_submit',
      autofillTriggered: true,
      autofilledFields: ['name', 'tagline'],
      filledFields: ['url', 'description', 'email'],
      remainingRequired: [],
      submitSelector: '#submit-btn',
    })

    // Also verify MCP browser handler routing for directory_autofill and listPages.
    const mcpSession = new PlaywrightSession({
      pages: () => [page],
      on: () => {},
      close: async () => {},
    } as never, 10_000, 4_500)
    const mcpManager = new BrowserSessionManager({
      id: 'mock-dir-mcp',
      available: () => true,
      open: async () => mcpSession,
    })
    const mcpHandle = createBrowserToolHandler({ sessionManager: mcpManager, config: resolveMcpConfig({}) })

    const mcpDirRes = await mcpHandle({
      action: 'directory_autofill',
      websiteUrl: 'https://demo.example.com',
      name: 'DemoSite AI',
      tagline: 'Fast AI tool',
      description: 'Detailed description',
      email: 'submit@screwdom.org',
      waitAfterFetchMs: 10,
    })
    expect(mcpDirRes.isError).toBeUndefined()
    expect(parseToolPayload(mcpDirRes as never).data).toMatchObject({
      outcome: 'ready_to_submit',
    })

    const mcpPagesRes = await mcpHandle({ action: 'listPages' })
    expect(mcpPagesRes.isError).toBeUndefined()
    expect(parseToolPayload(mcpPagesRes as never).data).toMatchObject({
      pages: [{ ref: 'p1', url: submitUrl }],
    })
  })

  it('preflight sniffs head 32KB + tail 64KB (or full <=128KB), detects /go/ rootSubmitHint and timeoutClusters', async () => {
    // 1. 180KB HTML with #commentform at the very end (>128KB) -> head 32KB + tail 64KB detects wordpress_comment!
    const hugePadding = '<!-- pad -->'.repeat(14_000) // ~168KB
    const wpLargeHtml = `<html><head><title>Long WP Article</title></head><body>${hugePadding}<form id="commentform" action="/wp-comments-post.php"><textarea name="comment"></textarea></form></body></html>`
    const largeRes = new Response(wpLargeHtml, { status: 200, headers: { 'content-type': 'text/html' } })
    const sniffed = await readBoundedBodyText(largeRes)
    expect(sniffed).toContain('<title>Long WP Article</title>')
    expect(sniffed).toContain('wp-comments-post.php')
    expect(detectSiteHint('https://longwp.example.org/post', new Headers(), sniffed)).toBe('wordpress_comment')

    // 2. Typecho hint detection
    const tcHtml = '<html><head><meta name="generator" content="Typecho 1.2" /></head><body><form id="comment-form"><input name="mail"/><textarea name="text"></textarea></form></body></html>'
    expect(detectSiteHint('https://tc.example.org/1', new Headers(), tcHtml)).toBe('typecho_comment')

    // 3. End-to-end runBatchPreflight: /go/ outbound redirect -> rootSubmitHint + >=3 /nano-banana-pro-* timeouts -> timeoutClusters
    const detail: BacklinkBatchDetail = {
      batch: {
        id: 301,
        name: 'Batch 301',
        websiteId: 7,
        websiteName: 'Demo',
        websiteHost: 'demo.example.com',
        plannedAt: '2026-11-24T00:00:00Z',
        counts: { pending: 4, executed: 0, skipped: 0, failed: 0, total: 4 },
        executing: false,
      },
      website: { id: 7, name: 'Demo', siteUrl: 'https://demo.example.com', siteHost: 'demo.example.com' },
      anchors: [{ id: 1, anchorText: 'Demo', targetUrl: 'https://demo.example.com' }],
      items: [
        { id: 1, sourceId: 11, sourceName: 'OneNavGo', sourceUrl: 'https://nav.example.cn/go/some-tool', sourceHost: 'nav.example.cn', submitUrl: null, sourceNotes: null, category: '导航站', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
        { id: 2, sourceId: 12, sourceName: 'Farm1', sourceUrl: 'https://farm1.example.org/nano-banana-pro-guide', sourceHost: 'farm1.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
        { id: 3, sourceId: 13, sourceName: 'Farm2', sourceUrl: 'https://farm2.example.org/nano-banana-pro-review', sourceHost: 'farm2.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
        { id: 4, sourceId: 14, sourceName: 'Farm3', sourceUrl: 'https://farm3.example.org/nano-banana-pro-free', sourceHost: 'farm3.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
      ],
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/go/')) {
        const res = new Response('Not Found on external target', { status: 404 })
        Object.defineProperty(res, 'url', { value: 'https://thirdparty-tool.example.net/' })
        return res
      }
      const err = new Error('The operation timed out')
      err.name = 'TimeoutError'
      throw err
    }) as unknown as typeof fetch

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'skipped', publishRecordId: null }),
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId) => ({ sourceId, attached: [] }),
    }

    const preflight = await runBatchPreflight(batchSource, detail, {
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      timeoutMs: 1_000,
      concurrency: 4,
    })

    // /go/ outbound redirect is NOT tagged dead_site; returns rootSubmitHint!
    expect(preflight.data.deadItems).toBeUndefined()
    expect(preflight.data.runnableItems).toEqual([
      {
        itemId: 1,
        domain: 'nav.example.cn',
        siteHint: 'directory_or_form',
        redirectedFromGo: true,
        rootSubmitHint: 'https://nav.example.cn/',
      },
    ])
    // 3 timed-out /nano-banana-pro-* items produce a timeoutCluster!
    expect(preflight.data.timeoutClusters).toHaveLength(1)
    expect(preflight.data.timeoutClusters?.[0]).toMatchObject({
      pattern: '/nano-banana-pro-*',
      count: 3,
      itemIds: [2, 3, 4],
    })
    expect(detectTimeoutClusters([])).toEqual([])
  })

  it('browser navigate defaults to domcontentloaded and returns ready DOM when explicit load times out', async () => {
    const recordedOpts: Array<Record<string, unknown>> = []
    const mockPage = {
      isClosed: () => false,
      on: () => {},
      url: () => 'https://slow-ads.example.org/submit',
      title: async () => 'Slow Ads Page',
      innerText: async () => 'Form ready',
      evaluate: async () => 'interactive',
      goto: vi.fn(async (_url: string, opts?: Record<string, unknown>) => {
        recordedOpts.push(opts ?? {})
        if (opts?.waitUntil === 'load') {
          throw new Error('page.goto: Timeout 10000ms exceeded.')
        }
      }),
    }

    const session = new PlaywrightSession({
      pages: () => [mockPage],
      on: () => {},
      close: async () => {},
    } as never, 10_000, 4_500)

    const defaultNav = await session.act({ kind: 'navigate', url: 'https://slow-ads.example.org/submit' })
    expect(defaultNav).toMatchObject({ kind: 'page', title: 'Slow Ads Page' })
    expect(recordedOpts[0]?.waitUntil).toBe('domcontentloaded')

    const loadTimeoutNav = await session.act({ kind: 'navigate', url: 'https://slow-ads.example.org/submit', waitUntil: 'load' })
    expect(loadTimeoutNav).toMatchObject({ kind: 'page', title: 'Slow Ads Page', text: 'Form ready' })
  })

  it('filters backlinks batch_list by websiteId (supporting both number and numeric string)', async () => {
    const rawBatches = [
      { id: 1, name: 'Site7 Pending', websiteId: 7, websiteName: 'Site7', websiteHost: 'site7.com', plannedAt: '2026-11-24', counts: { pending: 3, executed: 0, skipped: 0, failed: 0, total: 3 }, executing: false },
      { id: 2, name: 'Site7 Done', websiteId: 7, websiteName: 'Site7', websiteHost: 'site7.com', plannedAt: '2026-11-23', counts: { pending: 0, executed: 5, skipped: 0, failed: 0, total: 5 }, executing: false },
      { id: 3, name: 'Site9 Pending', websiteId: 9, websiteName: 'Site9', websiteHost: 'site9.com', plannedAt: '2026-11-24', counts: { pending: 2, executed: 0, skipped: 0, failed: 0, total: 2 }, executing: false },
    ]
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
    const handle = createBacklinksToolHandler({
      config: resolveMcpConfig({ SUPERMANAGER_BASE_URL: 'https://sm.example.com', SUPERMANAGER_TOKEN: 'smag_ok' }),
      batchSource,
    })

    const numRes = parseToolPayload(await handle({ action: 'batch_list', websiteId: 7 }) as never)
    expect(numRes.data).toMatchObject({ total: 3, matched: 1, websiteId: 7 })
    expect((numRes.data as { batches: Array<{ id: number }> }).batches.map(b => b.id)).toEqual([1])

    const strRes = parseToolPayload(await handle({ action: 'batch_list', websiteId: '7', onlyPending: false }) as never)
    expect(strRes.data).toMatchObject({ total: 3, matched: 2, websiteId: 7 })
    expect((strRes.data as { batches: Array<{ id: number }> }).batches.map(b => b.id)).toEqual([1, 2])

    const badRes = await handle({ action: 'batch_list', websiteId: 'not-a-number' })
    expect(badRes.isError).toBe(true)
  })
})
