import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { BacklinksError } from '../src/host/backlinks/types.ts'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import {
  DEFAULT_COMMENT_NAV_TIMEOUT_MS,
  DEFAULT_CONTEXT_DESTROYED_RETRY_MS,
  appendCacheBustParam,
  detectPostSubmitWafBlock,
  executeCommentPublish,
  extractCommentNumericId,
  isWpDieFormValidationError,
  shouldAbortCommentPublishRequest,
} from '../src/host/browser-playwright/comment-publish.ts'
import { executeDirectoryAutofill } from '../src/host/browser-playwright/directory-autofill.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { createBrowserToolHandler, BrowserSessionManager } from '../src/mcp/browser-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'
import { detectToxicSite, runBatchPreflight } from '../src/mcp/preflight.ts'

interface V23MockResponse {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface V23Route {
  html: string
  scrollHeight?: number
  onAction?: (
    kind: string,
    selector: string,
    value?: string,
    element?: Element | null,
  ) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponses?: readonly V23MockResponse[]
    openPopup?: V23PopupSpec
    throwError?: Error
  } | void
}

interface V23PopupStep {
  url: string
  html: string
  onClick?: (selector: string) => { nextStep?: boolean; close?: boolean; mutateParentHtml?: string } | void
}

interface V23PopupSpec {
  steps: V23PopupStep[]
}

function createV23MockPage(
  routes: Record<string, V23Route>,
  options?: {
    readonly failInitialInspectErrors?: Error[]
    readonly strictMultiMatch?: boolean
  },
) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2400
  let currentScrollY = 0
  let inspectCallCount = 0
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const gotoCalls: Array<{ url: string; timeout?: number; waitUntil?: string }> = []
  const responseListeners = new Set<(resp: unknown) => void>()
  const activeRouteHandlers: Array<{ pattern: string; handler: (...args: unknown[]) => unknown }> = []
  let routeInstallCount = 0
  let unrouteCount = 0
  let pendingPopupResolve: ((popup: unknown) => void) | undefined

  const buildDom = (html: string, url: string) => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : 'http://localhost/'
    const next = new JSDOM(html, { url: safeUrl, runScripts: 'outside-only' })
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

  let dom = buildDom(routes[currentUrl]?.html ?? '<html><body></body></html>', currentUrl)
  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false }
  const resolveRoute = (targetUrl: string): V23Route | undefined => {
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
    dom = buildDom(route.html, targetUrl)
  }

  const setDomOnly = (html: string) => {
    const r = activeRoute()
    if (r) r.html = html
    dom = buildDom(html, currentUrl)
  }

  const emitResponse = (spec: V23MockResponse) => {
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

  const createMockPopup = (spec: V23PopupSpec) => {
    let stepIndex = 0
    let closed = false
    const getStep = () => spec.steps[Math.min(stepIndex, spec.steps.length - 1)]!
    let popupDom = buildDom(getStep().html, getStep().url)
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
            popupDom = buildDom(getStep().html, getStep().url)
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

  const makeSingleLocatorApi = (selector: string, resolveNode: () => Element | null, strictGuard?: () => void) => ({
    isVisible: async () => isNodeVisible(resolveNode()),
    isDisabled: async () => {
      const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
      return Boolean(el && (el.disabled === true || el.hasAttribute('disabled')))
    },
    getAttribute: async (attr: string) => resolveNode()?.getAttribute(attr) ?? null,
    evaluate: async <R>(fn: (node: unknown) => R) => fn(resolveNode()),
    scrollIntoViewIfNeeded: async () => {},
    fill: async (val: string) => {
      strictGuard?.()
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
      strictGuard?.()
      actions.push({ kind: 'click', selector })
      const el = resolveNode() as (HTMLElement & { disabled?: boolean }) | null
      if (!el) throw new Error(`Missing element for click: ${selector}`)
      const eff = activeRoute()?.onAction?.('click', selector, undefined, el)
      if (eff?.emitResponses) {
        for (const r of eff.emitResponses) emitResponse(r)
      }
      if (eff?.openPopup) {
        const popup = createMockPopup(eff.openPopup)
        if (pendingPopupResolve) {
          const resolver = pendingPopupResolve
          pendingPopupResolve = undefined
          resolver(popup)
        }
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
    route: async (pattern: string, handler: (...args: unknown[]) => unknown) => {
      routeInstallCount++
      activeRouteHandlers.push({ pattern, handler })
    },
    unroute: async (pattern: string, handler?: (...args: unknown[]) => unknown) => {
      unrouteCount++
      const idx = activeRouteHandlers.findIndex(r => r.pattern === pattern && (!handler || r.handler === handler))
      if (idx >= 0) activeRouteHandlers.splice(idx, 1)
    },
    waitForEvent: (event: string, opts?: { timeout?: number }) => {
      if (event !== 'popup') return Promise.resolve(null)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPopupResolve = undefined
          reject(new Error('popup timeout'))
        }, Math.min(opts?.timeout ?? 200, 150))
        pendingPopupResolve = (popup) => {
          clearTimeout(timer)
          resolve(popup)
        }
      })
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
      loadRoute(url)
    },
    waitForNavigation: async () => null,
    waitForLoadState: async () => {},
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      if (typeof fnOrScript === 'string' && fnOrScript.includes('isWordPress')) {
        const err = options?.failInitialInspectErrors?.[inspectCallCount]
        inspectCallCount++
        if (err) throw err
      }
      if (typeof fnOrScript === 'string') {
        return dom.window.eval(fnOrScript)
      }
      return runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
    },
    locator: (selector: string) => {
      const resolveAll = () => Array.from(dom.window.document.querySelectorAll(selector))
      const count = async () => resolveAll().length
      const strictGuard = options?.strictMultiMatch
        ? () => {
            const all = resolveAll()
            if (all.length > 1) {
              throw new Error(`strict mode violation: locator('${selector}') resolved to ${all.length} elements`)
            }
          }
        : undefined
      const baseApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null, strictGuard)
      const firstApi = makeSingleLocatorApi(selector, () => resolveAll()[0] ?? null)
      const nth = (index: number) => makeSingleLocatorApi(selector, () => resolveAll()[index] ?? null)
      return { ...baseApi, first: () => firstApi, nth, count }
    },
  }

  return {
    page,
    actions,
    gotoCalls,
    getRouteStats: () => ({
      installed: routeInstallCount,
      unrouted: unrouteCount,
      activeCount: activeRouteHandlers.length,
      activeHandlers: [...activeRouteHandlers],
    }),
  }
}

describe('v2.3 Module 1: WordPress new #comment-ID submitted vs uncertain_after_submit & multilingual moderation', () => {
  it('parses comment numeric IDs and preserves #comment-ID when appending cache-busting param', () => {
    expect(extractCommentNumericId('https://blogs.ubc.ca/post/comment-page-2/#comment-904860')).toBe(904860)
    expect(extractCommentNumericId('comment-42')).toBe(42)
    expect(extractCommentNumericId('https://blogs.ubc.ca/post/')).toBeUndefined()
    const busted = appendCacheBustParam('https://blogs.ubc.ca/post/#comment-205', 123456)
    expect(busted).toBe('https://blogs.ubc.ca/post/?_cb=123456#comment-205')
  })

  it('returns submitted (wp_new_comment_id_assigned) when WP redirects to brand-new #comment-<ID> behind full-page cache, preserving #comment-<ID>', async () => {
    const postUrl = 'https://blogs.ubc.ca/edtech/great-article/'
    const redirectedUrl = 'https://blogs.ubc.ca/edtech/great-article/comment-page-2/#comment-205'
    let submitClicks = 0

    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: `
          <html><head><title>UBC Blog</title></head><body>
            <ol class="comment-list">
              <li id="comment-98"><a href="#comment-98">Old 1</a></li>
              <li id="comment-100"><a href="#comment-100">Old 2</a></li>
            </ol>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" />
              <input id="url" name="url" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            submitClicks++
            return { navigateTo: redirectedUrl }
          }
        },
      },
      [redirectedUrl]: {
        // Simulates full-page cache where newly posted comment #205 is NOT yet rendered and no English moderation notice appears.
        html: `
          <html><head><title>UBC Blog</title></head><body>
            <ol class="comment-list">
              <li id="comment-98"><p>Old cached comment 1</p></li>
              <li id="comment-100"><p>Old cached comment 2</p></li>
            </ol>
          </body></html>
        `,
      },
    }

    const { page } = createV23MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wp-new-id',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Thoughtful breakdown of classroom media.',
        authorName: 'Alex',
        authorEmail: 'alex@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(submitClicks).toBe(1)
    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      reason: 'wp_new_comment_id_assigned',
      publicUrl: redirectedUrl,
      finalUrl: redirectedUrl,
      submitTriggered: true,
    })
    expect(res.evidence).toContain('#comment-205')
    expect(res.evidence).toContain('100')
  })

  it('upgrades to live when cache-busting reload reveals the newly published comment without polluting publicUrl', async () => {
    const postUrl = 'https://sites.lafayette.edu/post/'
    const redirectedUrl = 'https://sites.lafayette.edu/post/#comment-310'

    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Lafayette</title></head><body>
            <li id="comment-300">Old</li>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" />
              <input id="url" name="url" />
              <button id="submit" type="submit">Post</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return { navigateTo: redirectedUrl }
          }
        },
      },
      [redirectedUrl]: {
        html: '<html><head><title>Lafayette</title></head><body><div id="comments"><p>Cached old page</p></div></body></html>',
      },
    }

    const { page } = createV23MockPage(routes)
    const origGoto = page.goto
    page.goto = async (url: string, opts?: { timeout?: number; waitUntil?: string }) => {
      if (url.includes('_cb=')) {
        routes[url] = {
          html: `
            <html><head><title>Lafayette</title></head><body>
              <div id="comments">
                <li id="comment-310"><a href="https://demo.example.com">Alex</a><p>Fresh uncached comment!</p></li>
              </div>
            </body></html>
          `,
        }
      }
      return await origGoto(url, opts)
    }

    const res = await executeCommentPublish(
      page as never,
      'p-wp-cb',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Fresh uncached comment!',
        authorName: 'Alex',
        authorEmail: 'alex@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: redirectedUrl,
      submitTriggered: true,
    })
    expect(res.publicUrl).not.toContain('_cb=')
  })

  it('strictly keeps uncertain_after_submit when NO new #comment-ID, NO ?unapproved=, and NO moderation/link appear (security redline)', async () => {
    const postUrl = 'https://einherjar.org/article/#comment-100'
    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Einherjar</title></head><body>
            <li id="comment-100"><p>Existing comment</p></li>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <button id="submit" type="submit">Post</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            // Redirects back to the SAME existing #comment-100 (NOT a brand-new ID) with no link or moderation text.
            return { navigateTo: postUrl }
          }
        },
      },
    }

    const { page } = createV23MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wp-no-new-id',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Nice post',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'uncertain_after_submit',
      siteType: 'wordpress',
      submitTriggered: true,
    })
  })

  it('matches expanded multilingual moderation phrases (IT/TR/RU/JA/DE/FR/ES/PT/ZH/EN)', async () => {
    const notices = [
      'Il tuo commento è in attesa di moderazione.',
      'Yorumunuz onay bekliyor.',
      'Ваш комментарий ожидает проверки.',
      'あなたのコメントは承認待ちです。',
      'Dein Kommentar muss noch freigeschaltet werden.',
      'Votre commentaire est en attente de modération.',
      'Tu comentario está pendiente de moderación.',
      'Seu comentário está aguardando moderação.',
      '您的评论正在等待审核。',
      'Your comment is pending approval.',
    ]

    for (const notice of notices) {
      const postUrl = 'https://i18n.example.org/post/'
      const redirectedUrl = 'https://i18n.example.org/post/#comment-501'
      const routes: Record<string, V23Route> = {
        [postUrl]: {
          html: `
            <html><head><title>I18N WP</title></head><body>
              <form id="commentform" action="/wp-comments-post.php">
                <textarea id="comment" name="comment"></textarea>
                <button id="submit" type="submit">Post</button>
              </form>
            </body></html>
          `,
          onAction: (kind, selector) => {
            if (kind === 'click' && selector.includes('submit')) {
              return { navigateTo: redirectedUrl }
            }
          },
        },
        [redirectedUrl]: {
          html: `<html><head><title>I18N WP</title></head><body><div id="comments"><p>${notice}</p></div></body></html>`,
        },
      }
      const { page } = createV23MockPage(routes)
      const res = await executeCommentPublish(
        page as never,
        'p-i18n',
        { kind: 'comment_publish', url: postUrl, commentText: 'Great read', websiteUrl: 'https://demo.example.com' },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )
      expect(res.outcome, notice).toBe('submitted')
      expect(res.publicUrl, notice).toBe(redirectedUrl)
    }
  })
})

describe('v2.3 Module 2: Non-Wix commit navigation (15s default) & lightweight resource interception with finally cleanup', () => {
  it('aborts images/media/fonts and ad/tracker domains while strictly preserving document, stylesheet, xhr/fetch, and Wix/OAuth/CAPTCHA domains', () => {
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/hero.jpg', 'image')).toBe(true)
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/clip.mp4', 'media')).toBe(true)
    expect(shouldAbortCommentPublishRequest('https://cdn.example.com/inter.woff2', 'font')).toBe(true)
    expect(shouldAbortCommentPublishRequest('https://www.googletagmanager.com/gtm.js', 'script')).toBe(true)
    expect(shouldAbortCommentPublishRequest('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script')).toBe(true)

    // Strictly preserved resource types:
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/post/', 'document')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/style.css', 'stylesheet')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/wp-json/comments', 'fetch')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://blog.example.com/wp-admin/admin-ajax.php', 'xhr')).toBe(false)

    // Strictly preserved domains (even for image/font/script):
    expect(shouldAbortCommentPublishRequest('https://static.wixstatic.com/media/a.png', 'image')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://accounts.google.com/gsi/client', 'script')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://www.google.com/recaptcha/api.js', 'script')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://js.hcaptcha.com/1/api.js', 'script')).toBe(false)
    expect(shouldAbortCommentPublishRequest('https://challenges.cloudflare.com/turnstile/v0/api.js', 'script')).toBe(false)
  })

  it('uses waitUntil=commit (15000ms default, respecting higher caller timeoutMs) for non-Wix sites and always unroutes in finally', async () => {
    const postUrl = 'https://slow-wp.example.org/huge-13mb-post/'
    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Huge WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php">
              <textarea id="comment" name="comment"></textarea>
              <button id="submit" type="submit">Post</button>
            </form>
          </body></html>
        `,
      },
    }

    const { page, gotoCalls, getRouteStats } = createV23MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-nonwix-commit',
      { kind: 'comment_publish', url: postUrl, commentText: 'Hello', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res.outcome).toBe('form_ready')
    expect(gotoCalls[0]).toMatchObject({
      url: postUrl,
      waitUntil: 'commit',
      timeout: DEFAULT_COMMENT_NAV_TIMEOUT_MS,
    })
    expect(getRouteStats().installed).toBe(1)
    expect(getRouteStats().unrouted).toBe(1)
    expect(getRouteStats().activeCount).toBe(0)

    // Respects higher caller timeoutMs (e.g. 25000ms).
    const { page: page2, gotoCalls: gotoCalls2 } = createV23MockPage(routes)
    await executeCommentPublish(
      page2 as never,
      'p-nonwix-higher',
      { kind: 'comment_publish', url: postUrl, commentText: 'Hello', timeoutMs: 25_000, probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(gotoCalls2[0]).toMatchObject({
      url: postUrl,
      waitUntil: 'commit',
      timeout: 25_000,
    })
  })
})

describe('v2.3 Module 3: Wix Google SSO one-click compound login, technical issue circuit breaker & safety redlines', () => {
  it('completes full Wix Google SSO loop (login -> multilingual Google SSO -> Account Chooser -> Consent -> comment -> Publish -> reload live)', async () => {
    const postUrl = 'https://sso-blog.wixsite.com/blog/post/ai-guide'
    let loggedIn = false
    let published = false

    const loggedOutHtml = `
      <html><head><title>Wix SSO Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div id="SITE_CONTAINER">
          <div data-hook="comments-section">
            <button data-hook="login-as-member-text-button">Log in to publish as a member</button>
          </div>
        </div>
      </body></html>
    `
    const loginModalHtml = `
      <html><head><title>Wix SSO Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div id="SITE_CONTAINER">
          <div id="SM_ROOT_COMP1" role="dialog">
            <h2 data-testid="login.headline">Log In</h2>
            <button id="google-sso-btn">Google でログイン</button>
          </div>
        </div>
      </body></html>
    `
    const loggedInEditorHtml = `
      <html><head><title>Wix SSO Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div id="SITE_CONTAINER">
          <div data-hook="comments-section">
            <div data-hook="comment-box">
              <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
              <button data-hook="primary-btn">Publish</button>
            </div>
          </div>
        </div>
      </body></html>
    `
    const persistedHtml = `
      <html><head><title>Wix SSO Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div id="SITE_CONTAINER">
          <div data-hook="comments-section">
            <div data-hook="comment-item">
              <p>Great guide! <a href="https://demo.example.com">https://demo.example.com</a></p>
            </div>
          </div>
        </div>
      </body></html>
    `

    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: loggedOutHtml,
        onAction: (kind, selector, value) => {
          if (kind === 'click' && selector.includes('login-as-member-text-button')) {
            return { mutateHtml: loginModalHtml }
          }
          if (kind === 'click' && selector.includes('google-sso-btn')) {
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/o/oauth2/v2/auth/accountchooser',
                    html: `
                      <html><body>
                        <div data-identifier="tester@gmail.com">Tester (tester@gmail.com)</div>
                        <div>Use another account</div>
                      </body></html>
                    `,
                    onClick: (sel) => {
                      if (sel.includes('tester@gmail.com')) return { nextStep: true }
                    },
                  },
                  {
                    url: 'https://accounts.google.com/signin/oauth/consent',
                    html: '<html><body><button id="consent-continue">继续</button></body></html>',
                    onClick: (sel) => {
                      if (sel.includes('consent-continue')) {
                        loggedIn = true
                        return { close: true, mutateParentHtml: loggedInEditorHtml }
                      }
                    },
                  },
                ],
              },
            }
          }
          if (kind === 'press' && value === 'Space') {
            return {
              mutateHtml: loggedInEditorHtml.replace(
                '<div contenteditable="true" role="textbox"></div>',
                '<div contenteditable="true" role="textbox">Great guide! <a href="https://demo.example.com">https://demo.example.com</a> </div>',
              ),
            }
          }
          if (kind === 'click' && selector.includes('primary-btn')) {
            published = true
            routes[postUrl]!.html = persistedHtml
            return { mutateHtml: persistedHtml }
          }
        },
      },
    }

    const { page } = createV23MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-sso-ok',
      {
        kind: 'comment_publish',
        url: postUrl,
        siteHint: 'wix_blog',
        commentText: 'Great guide!',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(loggedIn).toBe(true)
    expect(published).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      publicUrl: postUrl,
      submitTriggered: true,
    })
  })

  it('fast-circuits Wix OAuth "Looks like there was a technical issue" as manual_required + wix:google_sso_technical_issue without retry', async () => {
    const postUrl = 'https://tech-issue.wixsite.com/blog/post/1'
    let googleClicks = 0

    const routes: Record<string, V23Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Tech Issue Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SM_ROOT_COMP1" role="dialog">
              <h2 data-testid="login.headline">Log In</h2>
              <button id="google-btn">Continue with Google</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('google-btn')) {
            googleClicks++
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/o/oauth2/v2/auth/accountchooser',
                    html: '<html><body><div data-identifier="user@gmail.com">user@gmail.com</div></body></html>',
                    onClick: () => ({
                      close: true,
                      mutateParentHtml: `
                        <html><head><title>Tech Issue Wix</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                          <div id="SM_ROOT_COMP1" role="dialog">
                            <p>Looks like there was a technical issue. Please try again later.</p>
                          </div>
                        </body></html>
                      `,
                    }),
                  },
                ],
              },
            }
          }
        },
      },
    }

    const { page } = createV23MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p-wix-tech-issue',
      { kind: 'comment_publish', url: postUrl, siteHint: 'wix_blog', commentText: 'Nice' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(googleClicks).toBe(1)
    expect(res).toMatchObject({
      outcome: 'manual_required',
      siteType: 'wix',
      templateSignature: 'wix:google_sso_technical_issue',
      submitTriggered: false,
    })
  })

  it('aborts Wix Google SSO immediately on modal CAPTCHA, password/MFA popup, or explicit autoGoogleSso=false', async () => {
    // 1. Login modal reveals reCAPTCHA -> blocked_captcha
    const capUrl = 'https://cap-modal.wixsite.com/blog/post/1'
    const { page: capPage } = createV23MockPage({
      [capUrl]: {
        html: `
          <html><head><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section"><button data-hook="login-as-member-text-button">Log in</button></div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('login-as-member-text-button')) {
            return {
              mutateHtml: `
                <html><head><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
                    <button id="google-btn">Continue with Google</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    })
    const capRes = await executeCommentPublish(
      capPage as never,
      'p-wix-cap',
      { kind: 'comment_publish', url: capUrl, siteHint: 'wix_blog', commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(capRes).toMatchObject({ outcome: 'blocked_captcha', suggestedTags: ['has_captcha'], submitTriggered: false })

    // 2. OAuth popup requests password / 2FA -> stops immediately and falls back to needs_login
    const mfaUrl = 'https://mfa.wixsite.com/blog/post/1'
    const { page: mfaPage } = createV23MockPage({
      [mfaUrl]: {
        html: `
          <html><head><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SM_ROOT_COMP1" role="dialog"><button id="g-btn">Sign in with Google</button></div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('g-btn')) {
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/v3/signin/challenge/pwd',
                    html: '<html><body><input type="password" name="Passwd" /><p>Enter your password</p></body></html>',
                  },
                ],
              },
            }
          }
        },
      },
    })
    const mfaRes = await executeCommentPublish(
      mfaPage as never,
      'p-wix-mfa',
      { kind: 'comment_publish', url: mfaUrl, siteHint: 'wix_blog', commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(mfaRes).toMatchObject({ outcome: 'needs_login', siteType: 'wix', submitTriggered: false })

    // 3. Explicit autoGoogleSso=false does not click Google SSO button
    const { page: disabledPage, actions: disabledActions } = createV23MockPage({
      [mfaUrl]: {
        html: `
          <html><head><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SM_ROOT_COMP1" role="dialog"><button id="g-btn">Sign in with Google</button></div>
          </body></html>
        `,
      },
    })
    const disabledRes = await executeCommentPublish(
      disabledPage as never,
      'p-wix-sso-off',
      { kind: 'comment_publish', url: mfaUrl, siteHint: 'wix_blog', commentText: 'Hello', autoGoogleSso: false },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(disabledRes).toMatchObject({ outcome: 'needs_login', submitTriggered: false })
    expect(disabledActions.some(a => a.kind === 'click')).toBe(false)
  })
})

describe('v2.3 Module 4: :visible element filtering across directory_autofill, batch_fill & comment_publish', () => {
  it('directory_autofill skips hidden ebook modal inputs and hidden captcha fields, filling only visible form inputs', async () => {
    const dirUrl = 'https://discovercloud.com/submit'
    const { page, actions } = createV23MockPage({
      [dirUrl]: {
        html: `
          <html><head><title>DiscoverCloud Submit</title></head><body>
            <div id="ebook-modal" style="display: none">
              <form id="ebook-form">
                <input placeholder="First Name *" name="ebook_first_name" />
                <input type="email" placeholder="Work Email *" name="ebook_email" />
              </form>
            </div>
            <main>
              <form id="submit-tool-form">
                <input id="tool-url" type="url" name="website" placeholder="Website URL" required />
                <input id="tool-name" type="text" name="name" placeholder="First Name *" required />
                <textarea id="tool-desc" name="description" placeholder="Description" required></textarea>
                <div style="visibility: hidden"><textarea id="hidden-notes" name="notes"></textarea></div>
                <button type="submit">Submit Tool</button>
              </form>
            </main>
          </body></html>
        `,
      },
    })

    const res = await executeDirectoryAutofill(
      page as never,
      'p-dir-vis',
      {
        kind: 'directory_autofill',
        url: dirUrl,
        websiteUrl: 'https://demo.example.com',
        name: 'DemoApp',
        description: 'Fast developer utility.',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res.outcome).toBe('ready_to_submit')
    expect(res.filledFields).toEqual(['url', 'name', 'description'])
    expect(actions.some(a => a.selector?.includes('ebook'))).toBe(false)
    expect(actions.some(a => a.selector?.includes('g-recaptcha-response'))).toBe(false)
  })

  it('batch_fill resolves visible textarea while ignoring hidden textarea[name="g-recaptcha-response"] and hidden modal duplicates', async () => {
    const blogUrl = 'https://blogger-vis.example.com/post'
    const { page, actions } = createV23MockPage(
      {
        [blogUrl]: {
          html: `
            <html><head><title>Blogger Vis</title></head><body>
              <div style="display: none"><input placeholder="First Name *" id="hidden-name" /></div>
              <form>
                <input placeholder="First Name *" id="visible-name" />
                <textarea id="comment-body" name="commentBody"></textarea>
                <textarea name="g-recaptcha-response" style="display: none"></textarea>
                <button id="pub-btn" type="submit">Publish</button>
              </form>
            </body></html>
          `,
        },
      },
      { strictMultiMatch: true },
    )

    const fakeContext = {
      on: () => {},
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
    }
    const session = new PlaywrightSession(fakeContext as never, 10_000, 60_000)
    const manager = new BrowserSessionManager({
      id: 'mock-pw',
      available: () => true,
      open: async () => session,
    })
    const handler = createBrowserToolHandler({
      sessionManager: manager,
      config: resolveMcpConfig({}),
      sleepImpl: async () => {},
    })

    const res = await handler({
      action: 'batch_fill',
      fields: [
        { target: 'input[placeholder="First Name *"]', op: 'fill', value: 'Alice' },
        { target: 'textarea', op: 'fill', value: 'Insightful post!' },
      ],
      submitTarget: '#pub-btn',
      feedbackWaitMs: 0,
    })

    expect(res.isError).toBeUndefined()
    const payload = JSON.parse((res.content[0] as { text: string }).text.split('\n').slice(1).join('\n'))
    expect(payload).toMatchObject({ total: 2, succeeded: 2, failed: 0, submit: { ok: true } })
    expect(actions.filter(a => a.kind === 'fill').map(a => a.value)).toEqual(['Alice', 'Insightful post!'])
  })
})

describe('v2.3 Module 5: batch_preflight Toxic Backlink pre-filter (adult & gambling) with zero false positives', () => {
  it('blocks high-confidence toxic domains/paths/titles while never false-positiving vue slot, time slot, essex, class, or analytics', () => {
    // True positives
    expect(detectToxicSite({ host: 'xxxbold.live', url: 'https://xxxbold.live/post/1' })).toMatchObject({
      toxic: true,
      category: 'adult',
      matchedIn: 'domain',
    })
    expect(detectToxicSite({ host: 'betwad.com', url: 'https://betwad.com/blog/' })).toMatchObject({
      toxic: true,
      category: 'gambling',
      matchedIn: 'domain',
    })
    expect(detectToxicSite({ host: 'systeams.org', url: 'https://systeams.org/best-online-casino-review' })).toMatchObject({
      toxic: true,
      category: 'gambling',
      matchedIn: 'path',
    })
    expect(detectToxicSite({ host: 'mainstreetrogers.com', url: 'https://mainstreetrogers.com/slot-design-evolution/' })).toMatchObject({
      toxic: true,
      category: 'gambling',
      matchedIn: 'path',
    })
    expect(
      detectToxicSite({
        host: 'quitenicestuff2.com',
        url: 'https://quitenicestuff2.com/article-1',
        title: 'Best Online Gambling & Bookies Guide 2026',
      }),
    ).toMatchObject({
      toxic: true,
      category: 'gambling',
      matchedIn: 'title',
    })
    expect(
      detectToxicSite({
        host: 'blog.example.org',
        url: 'https://blog.example.org/p/1',
        title: 'Spin Free Slots to Win Big Jackpots',
      }),
    ).toMatchObject({
      toxic: true,
      category: 'gambling',
    })

    // Strict non-false-positives
    expect(detectToxicSite({ host: 'essex.ac.uk', url: 'https://essex.ac.uk/class/analytics', title: 'University of Essex Class Analytics' }).toxic).toBe(false)
    expect(detectToxicSite({ host: 'vuejs.org', url: 'https://vuejs.org/guide/components/slots.html', title: 'Vue Slot Composition Guide' }).toxic).toBe(false)
    expect(detectToxicSite({ host: 'scheduler.example.com', url: 'https://scheduler.example.com/time-slot', title: 'Pick a Time Slot for Your Meeting' }).toxic).toBe(false)
    expect(detectToxicSite({ host: 'better.com', url: 'https://better.com/beta-launch', title: 'Better Mortgage Beta Guide' }).toxic).toBe(false)
  })

  it('auto-skips toxic sites by default (autoSkipToxic=true), tags low_quality non-fatally even on tag 500, and respects autoSkipToxic=false', async () => {
    const detail: BacklinkBatchDetail = {
      batch: { id: 901, name: 'v2.3 toxic test', websiteId: 1, status: 'open', counts: { total: 4, pending: 4, live: 0, submitted: 0, failed: 0, skipped: 0 } } as never,
      website: { id: 1, name: 'Demo', url: 'https://demo.example.com' } as never,
      anchors: [],
      items: [
        { id: 1, sourceId: 101, sourceHost: 'xxxbold.live', sourceUrl: 'https://xxxbold.live/post/1', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 2, sourceId: 102, sourceHost: 'quitenicestuff2.com', sourceUrl: 'https://quitenicestuff2.com/post/2', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 3, sourceId: 103, sourceHost: 'vuejs.org', sourceUrl: 'https://vuejs.org/guide/slots', submitUrl: null, status: 'pending', tags: [] } as never,
        { id: 4, sourceId: 104, sourceHost: 'essex.ac.uk', sourceUrl: 'https://essex.ac.uk/class/analytics', submitUrl: null, status: 'pending', tags: [] } as never,
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
        // Simulate Supermanager 500 rejecting low_quality tag -> MUST NOT block toxic skip!
        throw new BacklinksError('HTTP 500 tag error', 'BACKLINKS_API_ERROR')
      },
    }

    const probedUrls: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input)
      probedUrls.push(url)
      if (url.includes('quitenicestuff2.com')) {
        return new Response('<html><head><title>Top Online Casino & Gambling Tips</title></head><body>Hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('<html><head><title>Vue Slot & Essex Analytics Guide</title></head><body><form id="commentform"></form></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }

    const preflight = await runBatchPreflight(mockSource, detail, {
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    })

    // xxxbold.live was blocked pre-HTTP (zero network call)!
    expect(probedUrls.some(u => u.includes('xxxbold.live'))).toBe(false)
    expect(preflight.data.counts).toMatchObject({ runnable: 2, toxicBlocked: 2, autoSkipped: 2 })
    expect(preflight.data.runnableItemIds).toEqual([3, 4])
    expect(preflight.data.toxicBlocked?.map(t => t.id)).toEqual([1, 2])
    expect(preflight.skippedToxicItemIds).toEqual([1, 2])
    expect(skippedCalls.every(c => c.skipReason.startsWith('toxic_site:'))).toBe(true)
    expect(tagCalls.some(t => t.tags.includes('low_quality'))).toBe(true)

    // Explicit autoSkipToxic=false via MCP backlinks tool handler does NOT skip toxic items.
    skippedCalls.length = 0
    const handler = createBacklinksToolHandler({
      config: resolveMcpConfig({}),
      batchSource: mockSource,
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    })
    const mcpRes = await handler({ action: 'batch_preflight', batchId: 901, autoSkipToxic: false })
    expect(mcpRes.isError).toBeUndefined()
    expect(skippedCalls).toHaveLength(0)
  })
})

describe('v2.3 Module 6: WP wp_die 403 vs WAF 403, GÖNDER & multilingual submit, Valine fast-path, context-destroyed retry & docs sync', () => {
  it('distinguishes WP wp_die HTTP 403 form validation (needs_llm_fallback) from real WAF 403 (blocked_waf)', async () => {
    expect(
      isWpDieFormValidationError('Please add a rating before submitting', '<body id="error-page"><div class="wp-die-message">Please add a rating</div></body>', true),
    ).toBe(true)
    expect(
      isWpDieFormValidationError('403 Forbidden Cloudflare Ray ID', '<html><title>Attention Required! | Cloudflare</title></html>', false),
    ).toBe(false)

    const wpDieRes = detectPostSubmitWafBlock({
      httpStatus: 403,
      rawResponseBody: '<body id="error-page"><div class="wp-die-message">ERROR: Please add a rating.</div></body>',
      postSubmitSnippet: 'ERROR: Please add a rating.',
    })
    expect(wpDieRes).toMatchObject({ blocked: false, isWpDieValidation: true, httpStatus: 403 })

    const wafRes = detectPostSubmitWafBlock({
      httpStatus: 403,
      responseHeaders: { server: 'LiteSpeed' },
      postSubmitSnippet: '403 Forbidden Access Denied',
    })
    expect(wafRes).toMatchObject({ blocked: true, provider: 'litespeed', httpStatus: 403 })

    // End-to-end WP wp_die 403 -> needs_llm_fallback with wp_die message in evidence!
    const postUrl = 'https://recipe-wp.example.org/best-pasta/'
    const wpPostEndpoint = 'https://recipe-wp.example.org/wp-comments-post.php'
    const { page } = createV23MockPage({
      [postUrl]: {
        html: `
          <html><head><title>Recipe WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              emitResponses: [
                {
                  url: wpPostEndpoint,
                  status: 403,
                  body: '<html><body id="error-page"><div class="wp-die-message">Please add a rating to leave a comment.</div></body></html>',
                },
              ],
              navigateTo: wpPostEndpoint,
            }
          }
        },
      },
      [wpPostEndpoint]: {
        html: '<html><head><title>Comment Submission Failure</title></head><body id="error-page"><div class="wp-die-message">Please add a rating to leave a comment.</div></body></html>',
      },
    })

    const publishRes = await executeCommentPublish(
      page as never,
      'p-wp-die-403',
      { kind: 'comment_publish', url: postUrl, commentText: 'Delicious!', websiteUrl: 'https://demo.example.com' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(publishRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wordpress',
      reason: 'wp_die_validation_error',
      httpStatus: 403,
      submitTriggered: false,
    })
    expect(publishRes.evidence).toContain('Please add a rating')
  })

  it('recognizes Turkish GÖNDER and other multilingual submit buttons cleanly', async () => {
    for (const label of ['GÖNDER', 'Yorum Gönder', 'Publicar comentario', 'Kommentar absenden', 'コメントを送信', 'Отправить']) {
      const postUrl = 'https://tr-blog.example.org/yazi/'
      const { page } = createV23MockPage({
        [postUrl]: {
          html: `
            <html><head><title>I18N Blog</title></head><body>
              <div id="comments">
                <form id="custom-comment-form" action="/yorum">
                  <input name="name" />
                  <input name="email" type="email" />
                  <input name="url" type="url" />
                  <textarea name="body"></textarea>
                  <button type="button" id="send-btn">${label}</button>
                </form>
              </div>
            </body></html>
          `,
        },
      })
      const res = await executeCommentPublish(
        page as never,
        'p-tr',
        { kind: 'comment_publish', url: postUrl, commentText: 'Nice post', probeOnly: true },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )
      expect(res.outcome, label).toBe('form_ready')
    }
  })

  it('supports Valine comment fast-path via LeanCloud POST /classes/Comment 201 and strict-mode-safe reload a.vnick .first()', async () => {
    const valineUrl = 'https://hexo-valine.example.org/posts/hello/'
    let submitted = false

    const routes: Record<string, V23Route> = {
      [valineUrl]: {
        html: `
          <html><head><title>Hexo Valine</title></head><body>
            <div id="vcomments" class="v">
              <div class="vwrap">
                <input class="vnick" placeholder="NickName" />
                <input class="vmail" placeholder="E-Mail" />
                <input class="vlink" placeholder="Website(http://)" />
                <textarea class="veditor"></textarea>
                <button class="vsubmit">Submit</button>
              </div>
              <div class="vcards">
                <div class="vcard"><a class="vnick" href="https://old.example.org">OldUser</a></div>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('vsubmit')) {
            submitted = true
            routes[valineUrl]!.html = `
              <html><head><title>Hexo Valine</title></head><body>
                <div id="vcomments" class="v">
                  <div class="vcards">
                    <div class="vcard"><a class="vnick" href="https://demo.example.com">Alice</a><p>Clean Hexo setup!</p></div>
                    <div class="vcard"><a class="vnick" href="https://old.example.org">OldUser</a></div>
                  </div>
                </div>
              </body></html>
            `
            return {
              emitResponses: [
                {
                  url: 'https://abc123.lc-cn-n1-shared.com/1.1/classes/Comment',
                  status: 201,
                  method: 'POST',
                  resourceType: 'fetch',
                  body: '{"objectId":"67890"}',
                },
              ],
            }
          }
        },
      },
    }

    const { page } = createV23MockPage(routes, { strictMultiMatch: true })
    const res = await executeCommentPublish(
      page as never,
      'p-valine',
      {
        kind: 'comment_publish',
        url: valineUrl,
        commentText: 'Clean Hexo setup!',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(submitted).toBe(true)
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'valine',
      publicUrl: valineUrl,
      submitTriggered: true,
    })
    expect(res.evidence).toContain('LeanCloud 201')
  })

  it('waits 2000ms and retries once on Execution context was destroyed / Cannot find context with specified id instead of failing', async () => {
    const postUrl = 'https://js-redirect.example.org/article/'
    const sleepCalls: number[] = []
    const { page } = createV23MockPage(
      {
        [postUrl]: {
          html: `
            <html><head><title>JS Redirect WP</title></head><body>
              <form id="commentform" action="/wp-comments-post.php">
                <textarea id="comment" name="comment"></textarea>
                <button id="submit" type="submit">Post</button>
              </form>
            </body></html>
          `,
        },
      },
      {
        failInitialInspectErrors: [new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')],
      },
    )

    const res = await executeCommentPublish(
      page as never,
      'p-ctx-retry',
      { kind: 'comment_publish', url: postUrl, commentText: 'Recovered!', probeOnly: true },
      {
        defaultTimeoutMs: 10_000,
        sleepImpl: async (ms) => {
          sleepCalls.push(ms)
        },
      },
    )

    expect(res).toMatchObject({ outcome: 'form_ready', siteType: 'wordpress' })
    expect(sleepCalls).toContain(DEFAULT_CONTEXT_DESTROYED_RETRY_MS)

    // Also handles "Cannot find context with specified id"
    const sleepCalls2: number[] = []
    const { page: page2 } = createV23MockPage(
      {
        [postUrl]: {
          html: `
            <html><head><title>JS Redirect WP</title></head><body>
              <form id="commentform" action="/wp-comments-post.php">
                <textarea id="comment" name="comment"></textarea>
                <button id="submit" type="submit">Post</button>
              </form>
            </body></html>
          `,
        },
      },
      {
        failInitialInspectErrors: [new Error('Protocol error (Runtime.callFunctionOn): Cannot find context with specified id')],
      },
    )
    const res2 = await executeCommentPublish(
      page2 as never,
      'p-ctx-retry-2',
      { kind: 'comment_publish', url: postUrl, commentText: 'Recovered!', probeOnly: true },
      {
        defaultTimeoutMs: 10_000,
        sleepImpl: async (ms) => {
          sleepCalls2.push(ms)
        },
      },
    )
    expect(res2).toMatchObject({ outcome: 'form_ready', siteType: 'wordpress' })
    expect(sleepCalls2).toContain(2_000)
  })

  it('syncs v2.3 capabilities, low runnable <= 5 relay rule, and zero-startup-bloat directive into rules/AGENTS.md and SKILL.md', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..')
    const rulesMd = readFileSync(path.join(repoRoot, 'antigravity-plugin/backlinks-publisher/rules/AGENTS.md'), 'utf8')
    const skillMd = readFileSync(path.join(repoRoot, 'antigravity-plugin/backlinks-publisher/skills/backlink-publish/SKILL.md'), 'utf8')

    for (const content of [rulesMd, skillMd]) {
      expect(content).toContain('v2.3')
      expect(content).toContain('autoSkipToxic')
      expect(content).toContain('autoGoogleSso')
      expect(content).toContain('wp_new_comment_id_assigned')
      expect(content).toContain('Valine')
      expect(content).toContain('runnable <= 5')
      expect(content).toContain('ls')
      expect(content).toContain('schema JSON')
    }
  })
})
