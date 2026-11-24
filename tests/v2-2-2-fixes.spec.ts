import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import {
  DEFAULT_WIX_NAV_TIMEOUT_MS,
  DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS,
  executeCommentPublish,
  navigateWixWithCommit,
} from '../src/host/browser-playwright/comment-publish.ts'
import { executeDirectoryAutofill } from '../src/host/browser-playwright/directory-autofill.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'

interface V222Route {
  html: string
  scrollHeight?: number
  waitForLoadStateError?: Error
  gotoError?: Error
  redirectTo?: string
  onScroll?: (fraction: number, count: number, ctx: { setScrollHeight: (h: number) => void; setHtml: (h: string) => void; scrollY: number; scrollToCalls: number[] }) => void
  onKeyPress?: (key: string, ctx: { setScrollHeight: (h: number) => void; setHtml: (h: string) => void; endCount: number }) => void
  onInspect?: (count: number, ctx: { setHtml: (h: string) => void }) => void
  onAction?: (kind: string, selector: string, value?: string, element?: Element | null) => {
    navigateTo?: string
    mutateHtml?: string
  } | void
}

function createV222StrictMockPage(routes: Record<string, V222Route>) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2000
  let currentScrollY = 0
  const scrollToYs: number[] = []
  const scrolledIntoViewTags: string[] = []
  const keysPressed: string[] = []
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const gotoCalls: Array<{ url: string; timeout?: number; waitUntil?: string }> = []
  let scrollCount = 0
  let endCount = 0
  let inspectCount = 0

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
      scrollToYs.push(y)
    }
    targetDom.window.HTMLElement.prototype.scrollIntoView = function () {
      scrolledIntoViewTags.push(this.getAttribute('data-hook') || this.id || this.localName)
    }
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
    const effectiveUrl = route.redirectTo ?? targetUrl
    const effectiveRoute = routes[effectiveUrl] ?? route
    currentUrl = effectiveUrl
    currentScrollHeight = effectiveRoute.scrollHeight ?? 2000
    currentScrollY = 0
    dom = buildDom(effectiveRoute.html, effectiveUrl)
  }

  const setDomOnly = (html: string) => {
    dom = buildDom(html, currentUrl)
  }

  const setHtml = (html: string) => {
    const r = activeRoute()
    if (r) r.html = html
    dom = buildDom(html, currentUrl)
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

  const makeSingleLocatorApi = (selector: string, resolveNode: () => Element | null, strict: boolean) => {
    const checkStrict = () => {
      if (!strict) return
      const all = dom.window.document.querySelectorAll(selector)
      if (all.length > 1) {
        throw new Error(`locator.click: Error: strict mode violation: locator('${selector}') resolved to ${all.length} elements`)
      }
    }
    return {
      isVisible: async () => isNodeVisible(resolveNode()),
      isDisabled: async () => {
        const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
        return Boolean(el && (el.disabled === true || el.hasAttribute('disabled')))
      },
      getAttribute: async (attr: string) => resolveNode()?.getAttribute(attr) ?? null,
      evaluate: async <R>(fn: (node: unknown) => R) => fn(resolveNode()),
      scrollIntoViewIfNeeded: async () => { checkStrict() },
      fill: async (val: string) => {
        checkStrict()
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
        checkStrict()
        actions.push({ kind: 'click', selector })
        const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
        if (!el) throw new Error(`Missing element for click: ${selector}`)
        if (!isNodeVisible(el)) throw new Error(`locator.click: Timeout 10000ms exceeded (element is not visible: ${selector})`)
        if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
          throw new Error(`locator.click: Timeout 10000ms exceeded (element is disabled: ${selector})`)
        }
        const eff = activeRoute()?.onAction?.('click', selector, undefined, el)
        if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
        if (eff?.navigateTo) loadRoute(eff.navigateTo)
      },
      press: async (key: string) => {
        checkStrict()
        keysPressed.push(key)
        actions.push({ kind: 'press', selector, value: key })
        const eff = activeRoute()?.onAction?.('press', selector, key, resolveNode())
        if (eff?.mutateHtml) setDomOnly(eff.mutateHtml)
      },
    }
  }

  const page = {
    isClosed: () => false,
    on: () => {},
    off: () => {},
    url: () => currentUrl,
    title: async () => dom.window.document.title || '',
    innerText: async (sel = 'body') => dom.window.document.querySelector(sel)?.textContent?.trim() ?? '',
    mainFrame: () => mainFrameStub,
    frames: () => [mainFrameStub],
    keyboard: {
      press: async (key: string) => {
        keysPressed.push(key)
        actions.push({ kind: 'keyboard:press', value: key })
        if (key === 'End') {
          endCount++
          currentScrollY = currentScrollHeight
        }
        activeRoute()?.onKeyPress?.(key, {
          setScrollHeight: (h) => { currentScrollHeight = h },
          setHtml,
          endCount,
        })
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
      if (route?.gotoError) {
        throw route.gotoError
      }
      loadRoute(url)
    },
    waitForNavigation: async () => null,
    waitForLoadState: async () => {
      const route = activeRoute()
      if (route?.waitForLoadStateError) {
        throw route.waitForLoadStateError
      }
    },
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      const route = activeRoute()
      if (typeof fnOrScript === 'function' && typeof arg === 'number') {
        const res = runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
        route?.onScroll?.(arg, scrollCount++, {
          setScrollHeight: (h) => { currentScrollHeight = h },
          setHtml,
          scrollY: currentScrollY,
          scrollToCalls: scrollToYs,
        })
        return res
      }
      if (typeof fnOrScript === 'string') {
        if (fnOrScript.includes('wixHasCommentSection')) {
          route?.onInspect?.(++inspectCount, { setHtml })
        }
        return dom.window.eval(fnOrScript)
      }
      return runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
    },
    locator: (selector: string) => {
      const resolveAll = () => Array.from(dom.window.document.querySelectorAll(selector))
      const count = async () => resolveAll().length
      const strictApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null, true)
      const firstApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null, false)
      const nth = (index: number) => makeSingleLocatorApi(selector, () => resolveAll()[index] ?? null, false)
      return { ...strictApi, first: () => firstApi, nth, count }
    },
  }

  return {
    page,
    actions,
    gotoCalls,
    scrollToYs,
    scrolledIntoViewTags,
    keysPressed,
    getScrollCount: () => scrollCount,
    getEndCount: () => endCount,
  }
}

describe('v2.2.2 Fix 1: Wix scroll-to-bottom (End + dynamic scrollHeight), reload comment-list hydration & dual Write a comment strict-mode safety', () => {
  it('scrolls to document bottom + presses End across dynamic scrollHeight growth and early-exits once Wix comments mount', async () => {
    const longWixUrl = 'https://long-article.wixsite.com/blog/post/deep-dive'
    let pollsSlept = 0
    let triggerMounted = false

    const routes: Record<string, V222Route> = {
      [longWixUrl]: {
        scrollHeight: 3200,
        html: `
          <html><head><title>Long Wix Article</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <p>Very long Wix blog post with lazy images...</p>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
        onScroll: (_fraction, idx, ctx) => {
          // Simulates article images loading and growing scrollHeight: 3200 -> 6400 -> 9600.
          if (idx === 0) {
            ctx.setScrollHeight(6400)
          } else if (idx === 1) {
            ctx.setScrollHeight(9600)
          } else if (idx === 2 && ctx.scrollY >= 9600) {
            triggerMounted = true
            ctx.setHtml(`
              <html><head><title>Long Wix Article</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
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
                <html><head><title>Long Wix Article</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
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

    const { page, scrollToYs, scrolledIntoViewTags, keysPressed, getEndCount } = createV222StrictMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-bottom',
      { kind: 'comment_publish', url: longWixUrl, siteHint: 'wix_blog', commentText: 'Great read', probeOnly: true },
      {
        defaultTimeoutMs: 10_000,
        sleepImpl: async () => {
          if (!triggerMounted) pollsSlept++
        },
      },
    )

    // Explicitly scrolled to every growing bottom (3200 -> 6400 -> 9600), pressed End on growth, and kept placeholder scrollIntoView.
    expect(scrollToYs).toContain(3200)
    expect(scrollToYs).toContain(6400)
    expect(scrollToYs).toContain(9600)
    expect(keysPressed).toContain('End')
    expect(getEndCount()).toBeGreaterThanOrEqual(3)
    expect(scrolledIntoViewTags).toContain('comments-section-placeholder')
    // Early-exited on poll #3 instead of waiting through the entire 15s (~38 polls) window!
    expect(pollsSlept).toBeLessThanOrEqual(3)
    expect(res).toMatchObject({ outcome: 'form_ready', siteType: 'wix', submitTriggered: false })
  })

  it('scrolls to bottom on Wix post-submit reload and waits for delayed 2-3s comment list hydration before declaring live (no false optimistic_dom_not_persisted)', async () => {
    expect(DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS).toBeGreaterThanOrEqual(8_000)
    expect(DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS).toBeLessThanOrEqual(10_000)

    const postUrl = 'https://hydrated-blog.wixsite.com/blog/post/real-live'
    let submitted = false
    let reloadScrolls = 0
    let reloadSimulatedMs = 0

    const routes: Record<string, V222Route> = {
      [postUrl]: {
        scrollHeight: 7200,
        html: `
          <html><head><title>Hydrated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true" role="textbox"></div>
                <button type="button" data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: routes[postUrl]!.html.replace(
                '<div data-hook="create-comment-input" contenteditable="true" role="textbox"></div>',
                '<div data-hook="create-comment-input" contenteditable="true" role="textbox">Great resource <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            submitted = true
            // Clean reload initially only has the lazy placeholder, then Write a comment at ~1.2s,
            // and finally hydrates the actual comment list with our link at ~2.8s (poll #7 * 400ms)!
            routes[postUrl]!.html = `
              <html><head><title>Hydrated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <article data-hook="post"><p>Long article body</p><div data-hook="comments-section-placeholder"></div></article>
              </body></html>
            `
            return {
              mutateHtml: `
                <html><head><title>Hydrated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comments-section"><div class="optimistic">Great resource <a href="https://demo.example.com">https://demo.example.com</a></div></div>
                </body></html>
              `,
            }
          }
        },
        onScroll: (_fraction, _idx, ctx) => {
          if (!submitted) return
          reloadScrolls++
          if (reloadScrolls === 3) {
            // `Write a comment...` appears 2-3s BEFORE the comment list hydrates (must NOT abort early as missing!).
            ctx.setScrollHeight(8400)
            ctx.setHtml(`
              <html><head><title>Hydrated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <article data-hook="post">
                  <div data-hook="comment-box"><button data-hook="comment-box-placeholder">Write a comment...</button></div>
                </article>
              </body></html>
            `)
          } else if (reloadScrolls === 7 && ctx.scrollY >= 8400) {
            // Comment list finally hydrates at ~2.8s with persisted backlink!
            ctx.setHtml(`
              <html><head><title>Hydrated Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <article data-hook="post">
                  <div data-hook="comment-box"><button data-hook="comment-box-placeholder">Write a comment...</button></div>
                  <div data-hook="top-level-comment-list">
                    <div data-hook="comment-item">Great resource <a href="https://demo.example.com">https://demo.example.com</a></div>
                  </div>
                </article>
              </body></html>
            `)
          }
        },
      },
    }

    const { page, scrollToYs, keysPressed, gotoCalls } = createV222StrictMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-reload-live',
      {
        kind: 'comment_publish',
        url: postUrl,
        siteHint: 'wix_blog',
        commentText: 'Great resource',
        websiteUrl: 'https://demo.example.com',
      },
      {
        defaultTimeoutMs: 10_000,
        wixPostSubmitWaitMs: 10,
        sleepImpl: async (ms) => {
          if (submitted && gotoCalls.length >= 2) {
            reloadSimulatedMs += ms
          }
        },
      },
    )

    expect(gotoCalls).toHaveLength(2)
    expect(gotoCalls[1]).toMatchObject({ url: postUrl, waitUntil: 'commit', timeout: 20_000 })
    expect(scrollToYs).toContain(7200)
    expect(scrollToYs).toContain(8400)
    expect(keysPressed).toContain('End')
    // Waited ~2.4s-3.2s for comment list hydration and exited immediately once found (well under 10s cap).
    expect(reloadSimulatedMs).toBeGreaterThanOrEqual(2_000)
    expect(reloadSimulatedMs).toBeLessThan(6_000)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // Guardrail: genuinely unpersisted optimistic DOM still returns uncertain_after_submit after full reload wait.
    const ghostUrl = 'https://ghost-opt.wixsite.com/blog/post/vanished'
    const ghostRoutes: Record<string, V222Route> = {
      [ghostUrl]: {
        scrollHeight: 4000,
        html: `
          <html><head><title>Ghost Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true" role="textbox"></div>
                <button type="button" data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: ghostRoutes[ghostUrl]!.html.replace(
                '<div data-hook="create-comment-input" contenteditable="true" role="textbox"></div>',
                '<div data-hook="create-comment-input" contenteditable="true" role="textbox">Check <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            ghostRoutes[ghostUrl]!.html = `
              <html><head><title>Ghost Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <article data-hook="post">
                  <button data-hook="comment-box-placeholder">Write a comment...</button>
                  <div data-hook="top-level-comment-list"><p>No comments yet.</p></div>
                </article>
              </body></html>
            `
            return {
              mutateHtml: `
                <html><head><title>Ghost Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comments-section"><a href="https://demo.example.com">Optimistic</a></div>
                </body></html>
              `,
            }
          }
        },
      },
    }
    const { page: ghostPage } = createV222StrictMockPage(ghostRoutes)
    const ghostRes = await executeCommentPublish(
      ghostPage as never,
      'p-wix-ghost',
      { kind: 'comment_publish', url: ghostUrl, siteHint: 'wix_blog', commentText: 'Check', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, wixReloadVerifyWaitMs: 800, sleepImpl: async () => {} },
    )
    expect(ghostRes).toMatchObject({
      outcome: 'uncertain_after_submit',
      siteType: 'wix',
      reason: 'optimistic_dom_not_persisted',
      submitTriggered: true,
    })
  })

  it('handles dual "Write a comment..." buttons (top & bottom, non-unique deep DOM, and hidden+visible) without Playwright strict-mode violation', async () => {
    // 1. Two visible identical `Write a comment...` buttons (fifthandcor.com exact pattern).
    const dualUrl = 'https://fifthandcor.example.com/post/seasonal-decor'
    const deepOpen = '<div>'.repeat(38)
    const deepClose = '</div>'.repeat(38)
    let triggerClicks = 0

    const routes: Record<string, V222Route> = {
      [dualUrl]: {
        html: `
          <html><head><title>Fifth and Cor</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <div>${deepOpen}<button data-hook="comment-box-placeholder">Write a comment...</button>${deepClose}</div>
              <div data-hook="top-level-comment-list"><p>Existing comment</p></div>
              <div>${deepOpen}<button data-hook="comment-box-placeholder">Write a comment...</button>${deepClose}</div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value, el) => {
          if (kind === 'click' && (selector.includes('comment-box-placeholder') || el?.getAttribute('data-hook') === 'comment-box-placeholder')) {
            triggerClicks++
            return {
              mutateHtml: `
                <html><head><title>Fifth and Cor</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
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
                <html><head><title>Fifth and Cor</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box">
                    <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox">Lovely ideas <a href="https://demo.example.com">https://demo.example.com</a> </div></div>
                    <button data-hook="primary-btn">Publish</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && (selector.includes('primary-btn') || el?.getAttribute('data-hook') === 'primary-btn')) {
            routes[dualUrl]!.html = `
              <html><head><title>Fifth and Cor</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item">Lovely ideas <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createV222StrictMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-dual',
      {
        kind: 'comment_publish',
        url: dualUrl,
        siteHint: 'wix_blog',
        commentText: 'Lovely ideas',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, sleepImpl: async () => {} },
    )

    // Selector fell back to non-unique `button[data-hook="comment-box-placeholder"]` (2 matches) yet clicked safely with 0 strict-mode error!
    expect(actions.some(a => a.kind === 'click' && a.selector === 'button[data-hook="comment-box-placeholder"]')).toBe(true)
    expect(triggerClicks).toBe(1)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // 2. First matching trigger hidden + second matching trigger visible (deep identical trees -> non-unique selector matching both!) -> clicks visible nth(1) cleanly!
    const hiddenFirstUrl = 'https://hidden-dup.wixsite.com/blog/post/1'
    let visibleTriggerClicked = false
    const hiddenRoutes: Record<string, V222Route> = {
      [hiddenFirstUrl]: {
        html: `
          <html><head><title>Hidden Dup Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div>${deepOpen}<button data-hook="comment-box-placeholder" style="display:none">Write a comment...</button>${deepClose}</div>
            <div>${deepOpen}<button data-hook="comment-box-placeholder">Write a comment...</button>${deepClose}</div>
          </body></html>
        `,
        onAction: (kind, selector, _val, el) => {
          if (kind === 'click' && (selector.includes('comment-box-placeholder') || el?.getAttribute('data-hook') === 'comment-box-placeholder')) {
            visibleTriggerClicked = true
            return {
              mutateHtml: `
                <html><head><title>Hidden Dup Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                  <button data-hook="primary-btn">Publish</button>
                </body></html>
              `,
            }
          }
        },
      },
    }
    const { page: hiddenPage } = createV222StrictMockPage(hiddenRoutes)
    const hiddenRes = await executeCommentPublish(
      hiddenPage as never,
      'p-wix-hidden-dup',
      { kind: 'comment_publish', url: hiddenFirstUrl, siteHint: 'wix_blog', commentText: 'Nice', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(visibleTriggerClicked).toBe(true)
    expect(hiddenRes).toMatchObject({ outcome: 'form_ready', siteType: 'wix', submitTriggered: false })
  })
})

describe('v2.2.2 Fix 2: wix_blog waitUntil=commit (20000ms) + best-effort DOM-ready wait & real-offline guardrails', () => {
  it('completes publishing when wix_blog commit succeeds and domcontentloaded times out while SSR body is already usable', async () => {
    expect(DEFAULT_WIX_NAV_TIMEOUT_MS).toBe(20_000)

    const slowNetUrl = 'https://weak-net-wix.example.com/post/guide'
    const routes: Record<string, V222Route> = {
      [slowNetUrl]: {
        waitForLoadStateError: new Error('page.waitForLoadState: Timeout 6000ms exceeded.'),
        html: `
          <html><head><title>Weak Net Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <div data-hook="comment-box">
                <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
                <button data-hook="primary-btn">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: routes[slowNetUrl]!.html.replace(
                '<div contenteditable="true" role="textbox"></div>',
                '<div contenteditable="true" role="textbox">Helpful guide <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            routes[slowNetUrl]!.html = `
              <html><head><title>Weak Net Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="top-level-comment-list">
                  <div data-hook="comment-item">Helpful guide <a href="https://demo.example.com">https://demo.example.com</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, gotoCalls } = createV222StrictMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-commit',
      {
        kind: 'comment_publish',
        url: slowNetUrl,
        siteHint: 'wix_blog',
        commentText: 'Helpful guide',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, wixPostSubmitWaitMs: 10, wixDomReadyWaitMs: 100, sleepImpl: async () => {} },
    )

    expect(gotoCalls[0]).toMatchObject({ url: slowNetUrl, waitUntil: 'commit', timeout: 20_000 })
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })

    // PlaywrightSession.navigate also upgrades siteHint=wix_blog to waitUntil=commit and tolerates domcontentloaded timeout when DOM has content.
    const recordedOpts: Array<Record<string, unknown>> = []
    const navPage = {
      isClosed: () => false,
      on: () => {},
      url: () => slowNetUrl,
      title: async () => 'Weak Net Wix',
      innerText: async () => 'Rendered SSR article content',
      waitForLoadState: vi.fn(async () => {
        throw new Error('page.waitForLoadState: Timeout 6000ms exceeded.')
      }),
      evaluate: async () => ({ textLength: 28, childCount: 1, htmlLen: 240, titleLen: 12 }),
      goto: vi.fn(async (_u: string, opts?: Record<string, unknown>) => {
        recordedOpts.push(opts ?? {})
      }),
    }
    const session = new PlaywrightSession({
      pages: () => [navPage],
      on: () => {},
      close: async () => {},
    } as never, 10_000, 4_500)

    const navRes = await session.act({ kind: 'navigate', url: slowNetUrl, siteHint: 'wix_blog' })
    expect(recordedOpts[0]).toMatchObject({ waitUntil: 'commit', timeout: 20_000 })
    expect(navRes).toMatchObject({ kind: 'page', title: 'Weak Net Wix', text: 'Rendered SSR article content' })
  })

  it('still throws on commit timeout, chrome-error:// network pages, or empty document after domcontentloaded timeout', async () => {
    // 1. Commit timeout itself must propagate (truly offline site).
    const offlineUrl = 'https://offline.wixsite.com/blog/post/dead'
    const { page: offlinePage } = createV222StrictMockPage({
      [offlineUrl]: {
        html: '<html><body></body></html>',
        gotoError: new Error('page.goto: Timeout 20000ms exceeded.'),
      },
    })
    await expect(
      navigateWixWithCommit(offlinePage as never, offlineUrl, { timeoutMs: 20_000, domReadyWaitMs: 50, sleep: async () => {} }),
    ).rejects.toThrow(/Timeout 20000ms exceeded/i)

    // 2. chrome-error:// error page must throw rather than being swallowed.
    const errUrl = 'https://broken.wixsite.com/blog/post/err'
    const { page: errPage } = createV222StrictMockPage({
      [errUrl]: {
        redirectTo: 'chrome-error://chromewebdata/',
        html: '<html><body>ERR_CONNECTION_TIMED_OUT</body></html>',
      },
      'chrome-error://chromewebdata/': {
        html: '<html><body>ERR_CONNECTION_TIMED_OUT</body></html>',
      },
    })
    await expect(
      navigateWixWithCommit(errPage as never, errUrl, { timeoutMs: 20_000, domReadyWaitMs: 50, sleep: async () => {} }),
    ).rejects.toThrow(/chrome-error/i)

    // 3. Empty document after domcontentloaded timeout must throw.
    const emptyUrl = 'https://empty.wixsite.com/blog/post/blank'
    const { page: emptyPage } = createV222StrictMockPage({
      [emptyUrl]: {
        waitForLoadStateError: new Error('page.waitForLoadState: Timeout 6000ms exceeded.'),
        html: '<html><head></head><body></body></html>',
      },
    })
    await expect(
      navigateWixWithCommit(emptyPage as never, emptyUrl, { timeoutMs: 20_000, domReadyWaitMs: 50, sleep: async () => {} }),
    ).rejects.toThrow(/navigation timed out/i)
  })
})

describe('v2.2.2 Fix 3: directory_autofill (login detection, MkDirs Analyze modal, StartupTrusted Fetch) & preflight HTTP 507 dead_site', () => {
  it('classifies /auth/login, /login, /signin, /sign-in, /auth/signin redirects and OAuth login walls as needs_login (never no_form)', async () => {
    const loginUrls = [
      'https://600.tools/auth/login',
      'https://dir-a.example.com/login',
      'https://dir-b.example.com/signin',
      'https://dir-c.example.com/sign-in',
      'https://dir-d.example.com/auth/signin',
    ]

    for (const loginUrl of loginUrls) {
      const submitUrl = new URL('/submit', loginUrl).toString()
      const { page } = createV222StrictMockPage({
        [submitUrl]: {
          redirectTo: loginUrl,
          html: '',
        },
        [loginUrl]: {
          // OAuth-only NextAuth/MkDirs login page (zero inputs, no "sign in to submit" phrase).
          html: `
            <html><head><title>Sign in</title></head><body>
              <main>
                <h1>Welcome back</h1>
                <button type="button">Continue with Google</button>
              </main>
            </body></html>
          `,
        },
      })

      const res = await executeDirectoryAutofill(
        page as never,
        'p-dir-login',
        { kind: 'directory_autofill', url: submitUrl, websiteUrl: 'https://demo.example.com' },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )
      expect(res.outcome, loginUrl).toBe('needs_login')
      expect(res.url, loginUrl).toBe(loginUrl)
    }

    // Even without a /login URL path, an explicit Google SSO / email-password wall on /submit returns needs_login!
    const wallUrl = 'https://gated-dir.example.com/submit'
    const { page: wallPage } = createV222StrictMockPage({
      [wallUrl]: {
        html: `
          <html><head><title>Submit Tool</title></head><body>
            <main>
              <h2>Sign in to your account</h2>
              <button type="button">Sign in with Google</button>
              <form>
                <input type="email" name="email" placeholder="Email" />
                <input type="password" name="password" placeholder="Password" />
                <button type="submit">Log in</button>
              </form>
            </main>
          </body></html>
        `,
      },
    })
    const wallRes = await executeDirectoryAutofill(
      wallPage as never,
      'p-dir-wall',
      { kind: 'directory_autofill', url: wallUrl, websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(wallRes.outcome).toBe('needs_login')
  })

  it('clicks secondary MkDirs Analyze confirmation dialog after AI Autofill and waits for fields to populate before backfilling', async () => {
    const submitUrl = 'https://600.tools/submit'
    let analyzeClicked = false

    const baseFormHtml = (opts?: { urlVal?: string; nameVal?: string; taglineVal?: string; showDialog?: boolean }) => `
      <html><head><title>Submit to 600.tools</title></head><body>
        <main>
          <form>
            <input id="link" name="link" type="url" placeholder="https://your-tool.com" value="${opts?.urlVal ?? ''}" required />
            <button type="button" id="ai-autofill-btn">AI Autofill</button>
            <input id="name" name="name" type="text" placeholder="Tool Name" value="${opts?.nameVal ?? ''}" required />
            <input id="tagline" name="tagline" type="text" placeholder="Tagline" value="${opts?.taglineVal ?? ''}" required />
            <textarea id="description" name="description" placeholder="Description" required></textarea>
            <input id="email" name="email" type="email" placeholder="Email" required />
            <button type="submit" id="submit-tool">Submit</button>
          </form>
          ${opts?.showDialog ? `
            <div role="dialog" aria-modal="true" data-state="open">
              <h3>AI Autofill Confirmation</h3>
              <p>We will analyze your website to pre-fill form fields.</p>
              <button type="button" id="cancel-analyze">Cancel</button>
              <button type="button" id="confirm-analyze">Analyze</button>
            </div>
          ` : ''}
        </main>
      </body></html>
    `

    const routes: Record<string, V222Route> = {
      [submitUrl]: {
        html: baseFormHtml(),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('ai-autofill-btn')) {
            // Clicking AI Autofill opens MkDirs confirmation dialog with Cancel + Analyze (does NOT populate yet).
            return {
              mutateHtml: baseFormHtml({ urlVal: 'https://demo.example.com', showDialog: true }),
            }
          }
          if (kind === 'click' && selector.includes('confirm-analyze')) {
            analyzeClicked = true
            // Clicking Analyze closes dialog and populates Name + Tagline, leaving Description + Email to backfill.
            return {
              mutateHtml: baseFormHtml({
                urlVal: 'https://demo.example.com',
                nameVal: 'DemoSite AI',
                taglineVal: 'AI workflow studio',
                showDialog: false,
              }),
            }
          }
        },
      },
    }

    const { page, actions } = createV222StrictMockPage(routes)
    const res = await executeDirectoryAutofill(
      page as never,
      'p-mkdirs-analyze',
      {
        kind: 'directory_autofill',
        url: submitUrl,
        websiteUrl: 'https://demo.example.com',
        name: 'Fallback Name',
        tagline: 'Fallback Tagline',
        description: 'Full product overview for DemoSite AI.',
        email: 'submit@screwdom.org',
      },
      { defaultTimeoutMs: 10_000, waitAfterFetchMs: 1_200, sleepImpl: async () => {} },
    )

    expect(analyzeClicked).toBe(true)
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('confirm-analyze'))).toBe(true)
    expect(res).toMatchObject({
      kind: 'directory_autofill',
      outcome: 'ready_to_submit',
      autofillTriggered: true,
      autofillConfirmClicked: true,
      autofilledFields: ['name', 'tagline'],
      filledFields: ['url', 'description', 'email'],
      remainingRequired: [],
      submitSelector: '#submit-tool',
    })

    // Also verify async-appearing secondary confirmation dialog (e.g. `Confirm` / `Continue` button mounting after 1 poll tick).
    const asyncUrl = 'https://featuredtool.example.com/submit'
    let asyncConfirmClicked = false
    let asyncAutoClicked = false
    let asyncSleepTicks = 0
    const asyncRoutes: Record<string, V222Route> = {
      [asyncUrl]: {
        html: baseFormHtml(),
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('ai-autofill-btn')) {
            asyncAutoClicked = true
            return { mutateHtml: baseFormHtml({ urlVal: 'https://demo.example.com', showDialog: false }) }
          }
          if (kind === 'click' && selector.includes('confirm-continue')) {
            asyncConfirmClicked = true
            return {
              mutateHtml: baseFormHtml({
                urlVal: 'https://demo.example.com',
                nameVal: 'Featured Demo',
                taglineVal: 'Async confirmed tagline',
                showDialog: false,
              }),
            }
          }
        },
      },
    }
    const { page: asyncPage } = createV222StrictMockPage(asyncRoutes)
    const origEval = asyncPage.evaluate
    asyncPage.evaluate = async (fnOrScript: unknown, arg?: unknown) => {
      if (asyncAutoClicked && !asyncConfirmClicked && asyncSleepTicks >= 1 && typeof fnOrScript === 'string' && fnOrScript.includes('confirmBtnRegex')) {
        // Inject async-rendered confirmation dialog right before dialog inspection on poll 1!
        await origEval(() => {
          const dlg = globalThis.document.createElement('div')
          dlg.setAttribute('role', 'dialog')
          dlg.innerHTML = '<p>Continue with AI Autofill?</p><button type="button" id="confirm-continue">Continue</button>'
          globalThis.document.body.appendChild(dlg)
        })
      }
      return await origEval(fnOrScript, arg)
    }
    const asyncRes = await executeDirectoryAutofill(
      asyncPage as never,
      'p-mkdirs-async',
      {
        kind: 'directory_autofill',
        url: asyncUrl,
        websiteUrl: 'https://demo.example.com',
        description: 'Async full description.',
        email: 'submit@screwdom.org',
      },
      {
        defaultTimeoutMs: 10_000,
        waitAfterFetchMs: 1_200,
        sleepImpl: async () => {
          if (asyncAutoClicked) asyncSleepTicks++
        },
      },
    )
    expect(asyncConfirmClicked).toBe(true)
    expect(asyncRes).toMatchObject({
      outcome: 'ready_to_submit',
      autofillTriggered: true,
      autofillConfirmClicked: true,
      autofilledFields: ['name', 'tagline'],
    })
  })

  it('re-discovers newly enabled StartupTrusted Fetch button after filling URL, triggers Fetch, waits for回填, and backfills remaining fields', async () => {
    const submitUrl = 'https://startuptrusted.com/submit'
    let fetchClicked = false
    let urlEntered = ''

    const renderPage = (opts?: { urlVal?: string; fetchEnabled?: boolean; fetched?: boolean }) => `
      <html><head><title>Submit Startup - StartupTrusted</title></head><body>
        <main>
          <form>
            <div>
              <label>Startup Website</label>
              <input id="startup_url" name="startup_url" type="text" placeholder="https://yourstartup.com" value="${opts?.urlVal ?? ''}" required />
            </div>
            <button type="button" id="fetch-btn" ${opts?.fetchEnabled ? '' : 'disabled'}>Fetch</button>
            <input id="startup_name" name="startup_name" type="text" placeholder="Startup Name" value="${opts?.fetched ? 'DemoSite' : ''}" required />
            <input id="tagline" name="tagline" type="text" placeholder="One-liner tagline" value="${opts?.fetched ? 'Trusted AI workspace' : ''}" required />
            <textarea id="description" name="description" placeholder="Tell us about your startup" required></textarea>
            <input id="founder_email" name="founder_email" type="email" placeholder="Founder Email" required />
            <button type="submit" id="submit-startup">Submit Startup</button>
          </form>
        </main>
      </body></html>
    `

    const routes: Record<string, V222Route> = {
      [submitUrl]: {
        html: renderPage({ fetchEnabled: false }),
        onAction: (kind, selector, value) => {
          if (kind === 'fill' && selector.includes('startup_url')) {
            urlEntered = value ?? ''
            // Filling URL unlocks the previously disabled Fetch button!
            return { mutateHtml: renderPage({ urlVal: urlEntered, fetchEnabled: true }) }
          }
          if (kind === 'click' && selector.includes('fetch-btn')) {
            fetchClicked = true
            return { mutateHtml: renderPage({ urlVal: urlEntered, fetchEnabled: true, fetched: true }) }
          }
        },
      },
    }

    const { page } = createV222StrictMockPage(routes)
    const res = await executeDirectoryAutofill(
      page as never,
      'p-startuptrusted',
      {
        kind: 'directory_autofill',
        url: submitUrl,
        websiteUrl: 'https://demo.example.com',
        name: 'Fallback Name',
        tagline: 'Fallback Tagline',
        description: 'Comprehensive description for DemoSite.',
        email: 'founder@screwdom.org',
      },
      { defaultTimeoutMs: 10_000, waitAfterFetchMs: 800, sleepImpl: async () => {} },
    )

    expect(urlEntered).toBe('https://demo.example.com')
    expect(fetchClicked).toBe(true)
    expect(res).toMatchObject({
      kind: 'directory_autofill',
      outcome: 'ready_to_submit',
      autofillTriggered: true,
      autofilledFields: ['name', 'tagline'],
      filledFields: ['url', 'description', 'email'],
      remainingRequired: [],
      submitSelector: '#submit-startup',
    })
  })

  it('classifies HTTP 507 Insufficient Storage (and soft-507 pages) as dead_site in batch_preflight and auto-skips with dead_site tag', async () => {
    const detail: BacklinkBatchDetail = {
      batch: {
        id: 1180,
        name: 'Batch #1180',
        websiteId: 7,
        websiteName: 'Demo',
        websiteHost: 'demo.example.com',
        plannedAt: '2026-11-24T00:00:00Z',
        counts: { pending: 3, executed: 0, skipped: 0, failed: 0, total: 3 },
        executing: false,
      },
      website: { id: 7, name: 'Demo', siteUrl: 'https://demo.example.com', siteHost: 'demo.example.com' },
      anchors: [{ id: 1, anchorText: 'Demo', targetUrl: 'https://demo.example.com' }],
      items: [
        { id: 1, sourceId: 5071, sourceName: 'Darasa UTI', sourceUrl: 'https://darasa.uti.ac.tz/submit', sourceHost: 'darasa.uti.ac.tz', submitUrl: null, sourceNotes: null, category: '目录', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
        { id: 2, sourceId: 5072, sourceName: 'Soft507', sourceUrl: 'https://soft507.example.org/submit', sourceHost: 'soft507.example.org', submitUrl: null, sourceNotes: null, category: '目录', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
        { id: 3, sourceId: 5073, sourceName: 'HealthyDir', sourceUrl: 'https://healthy.example.org/submit', sourceHost: 'healthy.example.org', submitUrl: null, sourceNotes: null, category: '目录', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-24T00:00:00Z' },
      ],
    }

    let darasaFetchCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('darasa.uti.ac.tz')) {
        darasaFetchCount++
        return new Response('<html><head><title>507 Insufficient Storage</title></head><body><h1>507 Insufficient Storage</h1></body></html>', {
          status: 507,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.includes('soft507.example.org')) {
        return new Response('<html><head><title>507 Insufficient Storage</title></head><body><p>Disk full</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('<html><body><form action="/submit"><input name="url" /></form></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as unknown as typeof fetch

    const preflightSkipCalls: Array<{ batchId: number; items: readonly { itemId: number; skipReason: string; tags?: readonly string[] }[] }> = []
    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock-507',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'skipped', publishRecordId: null }),
      preflightSkip: async (batchId, items) => {
        preflightSkipCalls.push({ batchId, items })
        return {
          batchId,
          skippedCount: items.length,
          unchangedCount: 0,
          results: items.map(it => ({
            itemId: it.itemId,
            sourceId: detail.items.find(x => x.id === it.itemId)!.sourceId,
            itemStatus: 'skipped',
            changed: true,
            attachedTags: it.tags ?? [],
          })),
        }
      },
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId) => ({ sourceId, attached: [] }),
    }

    const handle = createBacklinksToolHandler({
      config: resolveMcpConfig({ SUPERMANAGER_BASE_URL: 'https://sm.example.com', SUPERMANAGER_TOKEN: 'smag_ok' }),
      batchSource,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })

    const res = await handle({
      action: 'batch_preflight',
      batchId: 1180,
      autoSkip: true,
      timeoutMs: 1_000,
    })

    expect(res.isError).toBeUndefined()
    // Definitive HTTP 507 must NOT waste a retry attempt.
    expect(darasaFetchCount).toBe(1)

    const text = (res.content[0] as { text: string }).text
    const data = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      counts: Record<string, number>
      runnableItemIds: number[]
      deadItems: Array<{ id: number; reason: string; httpStatus?: number }>
      autoSkipResult: { skippedItemIds: number[]; taggedSourceIds: number[] }
    }

    expect(data.counts).toMatchObject({ runnable: 1, dead: 2, autoSkipped: 2 })
    expect(data.runnableItemIds).toEqual([3])
    expect(data.deadItems).toEqual([
      expect.objectContaining({ id: 1, reason: 'http_507', httpStatus: 507 }),
      expect.objectContaining({ id: 2, reason: 'http_507', httpStatus: 200 }),
    ])
    expect(data.autoSkipResult.skippedItemIds).toEqual([1, 2])
    expect(data.autoSkipResult.taggedSourceIds).toEqual([5071, 5072])
    expect(preflightSkipCalls[0]?.items).toEqual([
      expect.objectContaining({ itemId: 1, tags: ['dead_site'], skipReason: expect.stringContaining('http_507') }),
      expect.objectContaining({ itemId: 2, tags: ['dead_site'], skipReason: expect.stringContaining('http_507') }),
    ])
  })
})
