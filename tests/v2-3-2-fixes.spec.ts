import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMMENT_STEP_TIMEOUT_MS,
  ensureWordPressStarRating,
  executeCommentPublish,
  hasWpModerationUrlParams,
  matchModerationNotice,
  matchesGoogleSsoButtonLabel,
  matchesWixLoginTriggerLabel,
  matchesWixRceLinkButton,
  resolveStepTimeoutMs,
} from '../src/host/browser-playwright/comment-publish.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import type { BrowserAutomationProvider, BrowserCommand, BrowserResult, BrowserSession } from '../src/host/browser/types.ts'
import {
  BrowserSessionManager,
  DEFAULT_BATCH_FILL_DEADLINE_MS,
  DEFAULT_COMMENT_PUBLISH_DEADLINE_MS,
  DEFAULT_DIRECTORY_AUTOFILL_DEADLINE_MS,
  DEFAULT_NAVIGATE_DEADLINE_MS,
  DEFAULT_SNAPSHOT_DEADLINE_MS,
  MAX_TOOL_DEADLINE_MS,
  createBrowserToolHandler,
  resolveToolDeadlineMs,
} from '../src/mcp/browser-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'

interface V232MockResponse {
  readonly url: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly method?: string
  readonly resourceType?: string
}

interface V232PopupStep {
  url: string
  html: string
  onClick?: (selector: string) => { nextStep?: boolean; close?: boolean; mutateParentHtml?: string } | void
}

interface V232Route {
  html: string
  readyState?: 'loading' | 'interactive' | 'complete'
  scrollHeight?: number
  onAction?: (
    kind: string,
    selector: string,
    value?: string,
    element?: Element | null,
    doc?: Document,
  ) => {
    navigateTo?: string
    mutateHtml?: string
    emitResponses?: readonly V232MockResponse[]
    openPopup?: { steps: V232PopupStep[] }
    throwError?: Error
  } | void
}

function createV232MockPage(routes: Record<string, V232Route>) {
  let currentUrl = Object.keys(routes)[0] ?? 'https://example.org/'
  let currentScrollHeight = routes[currentUrl]?.scrollHeight ?? 2000
  let currentScrollY = 0
  let currentReadyState: 'loading' | 'interactive' | 'complete' = routes[currentUrl]?.readyState ?? 'complete'
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
    next.window.scrollTo = (_x: number, y: number) => { currentScrollY = y }
    next.window.HTMLElement.prototype.scrollIntoView = function () {}
    return next
  }

  let dom = buildDom(routes[currentUrl]?.html ?? '<html><body></body></html>', currentUrl, currentReadyState)
  const mainFrameStub = { url: () => currentUrl, name: () => '', isDetached: () => false }
  const resolveRoute = (targetUrl: string): V232Route | undefined => {
    const noHash = targetUrl.split('#')[0]!
    const noQuery = noHash.split('?')[0]!
    return routes[targetUrl] ?? routes[noHash] ?? routes[noQuery]
  }
  const activeRoute = () => resolveRoute(currentUrl)

  const loadRoute = (targetUrl: string) => {
    const route = resolveRoute(targetUrl)
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    currentScrollHeight = route.scrollHeight ?? 2000
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

  const emitResponse = (spec: V232MockResponse) => {
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

  const createMockPopup = (spec: { steps: V232PopupStep[] }) => {
    let stepIndex = 0
    let closed = false
    const getStep = () => spec.steps[Math.min(stepIndex, spec.steps.length - 1)]!
    let popupDom = buildDom(getStep().html, getStep().url, 'complete')
    return {
      url: () => getStep().url,
      isClosed: () => closed,
      waitForLoadState: async () => {},
      evaluate: async (scriptOrFn: unknown, arg?: unknown) => {
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
        g.window = popupDom.window
        g.document = popupDom.window.document
        g.location = popupDom.window.location
        g.getComputedStyle = popupDom.window.getComputedStyle.bind(popupDom.window)
        g.CSS = { escape: (s: string) => s.replace(/([^\w-])/gu, '\\$1') }
        g.NodeFilter = popupDom.window.NodeFilter
        g.Event = popupDom.window.Event
        try {
          if (typeof scriptOrFn === 'string') return popupDom.window.eval(scriptOrFn)
          if (typeof scriptOrFn === 'function') return (scriptOrFn as (a: unknown) => unknown)(arg)
          return undefined
        } finally {
          Object.assign(g, prev)
        }
      },
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
      selectOption: async (val: string, opts?: { timeout?: number }) => {
        actions.push({ kind: 'selectOption', selector, value: val, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
        const el = targetEl() as HTMLSelectElement | null
        if (el && el.localName === 'select') el.value = val
        runActionEffect('selectOption', selector, val, el)
      },
      check: async (opts?: { timeout?: number }) => {
        actions.push({ kind: 'check', selector, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
        const el = targetEl() as HTMLInputElement | null
        if (el && el.localName === 'input') el.checked = true
        runActionEffect('check', selector, undefined, el)
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
    frames: () => [mainFrameStub],
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
    evaluate: async (scriptOrFn: unknown, arg?: unknown) => {
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
      g.window = dom.window
      g.document = dom.window.document
      g.location = dom.window.location
      g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
      g.CSS = { escape: (s: string) => s.replace(/([^\w-])/gu, '\\$1') }
      g.NodeFilter = dom.window.NodeFilter
      g.Event = dom.window.Event
      try {
        if (typeof scriptOrFn === 'string') return dom.window.eval(scriptOrFn)
        if (typeof scriptOrFn === 'function') return (scriptOrFn as (a: unknown) => unknown)(arg)
        return undefined
      } finally {
        Object.assign(g, prev)
      }
    },
    locator: (selector: string) => makeLocator(selector),
  }

  return { page, actions, getDocument: () => dom.window.document }
}

function parseBrowserToolJson(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text ?? ''
  const idx = text.indexOf('\n')
  return JSON.parse(idx >= 0 ? text.slice(idx + 1) : text) as Record<string, unknown>
}

describe('v2.3.2 Fix 1: Tool-level hard deadline circuit breaker, hung-tab recycling & short step timeouts', () => {
  it('resolves default and capped deadlines across browser actions and clamps per-step timeouts to <=7s', () => {
    expect(resolveToolDeadlineMs('comment_publish')).toBe(DEFAULT_COMMENT_PUBLISH_DEADLINE_MS)
    expect(resolveToolDeadlineMs('comment_publish', 40_000)).toBe(40_000)
    expect(resolveToolDeadlineMs('comment_publish', 180_000)).toBe(MAX_TOOL_DEADLINE_MS)
    expect(resolveToolDeadlineMs('navigate')).toBe(DEFAULT_NAVIGATE_DEADLINE_MS)
    expect(resolveToolDeadlineMs('snapshot')).toBe(DEFAULT_SNAPSHOT_DEADLINE_MS)
    expect(resolveToolDeadlineMs('batch_fill')).toBe(DEFAULT_BATCH_FILL_DEADLINE_MS)
    expect(resolveToolDeadlineMs('directory_autofill')).toBe(DEFAULT_DIRECTORY_AUTOFILL_DEADLINE_MS)
    expect(resolveToolDeadlineMs('wait_for_login')).toBeUndefined()
    expect(resolveToolDeadlineMs('closeBrowser')).toBeUndefined()

    expect(resolveStepTimeoutMs(30_000)).toBe(DEFAULT_COMMENT_STEP_TIMEOUT_MS)
    expect(resolveStepTimeoutMs(5_000)).toBe(5_000)
    expect(resolveStepTimeoutMs(30_000, Date.now() + 2_500)).toBeLessThanOrEqual(2_500)
    expect(resolveStepTimeoutMs(30_000, Date.now() - 100)).toBe(1)
  })

  it('recycles a hung tab in PlaywrightSession without closing the browser session and gives the next task a clean tab', async () => {
    let pageSeq = 0
    let contextClosed = false
    const livePages: Array<{
      id: number
      closed: boolean
      closeCalls: number
      closeHandlers: Array<() => void>
    }> = []

    const createFakePwPage = (hangOnGoto: boolean) => {
      const id = ++pageSeq
      const state = { id, closed: false, closeCalls: 0, closeHandlers: [] as Array<() => void> }
      livePages.push(state)
      let url = 'about:blank'
      return {
        __id: id,
        url: () => url,
        title: async () => `Page ${id}`,
        innerText: async () => `Body of page ${id}`,
        isClosed: () => state.closed,
        on: (ev: string, fn: () => void) => {
          if (ev === 'close') state.closeHandlers.push(fn)
        },
        goto: async (targetUrl: string) => {
          if (hangOnGoto) {
            await new Promise<void>(() => {})
          }
          url = targetUrl
        },
        waitForLoadState: async () => {},
        evaluate: async () => ({ textLength: 10, childCount: 1, htmlLen: 256, titleLen: 5 }),
        close: async () => {
          state.closeCalls++
          state.closed = true
          for (const fn of state.closeHandlers) fn()
        },
        route: async () => {},
        unroute: async () => {},
      }
    }

    const hungPage = createFakePwPage(true)
    const contextPages: unknown[] = [hungPage]
    const fakeContext = {
      on: (_ev: string, _fn: () => void) => {},
      pages: () => contextPages,
      newPage: async () => {
        const next = createFakePwPage(false)
        contextPages.push(next)
        return next
      },
      close: async () => {
        contextClosed = true
      },
    }

    const session = new PlaywrightSession(fakeContext as never, 10_000, 16_000)
    const provider: BrowserAutomationProvider = {
      id: 'fake-pw',
      available: () => true,
      open: async () => session,
    }
    const manager = new BrowserSessionManager(provider)
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    // 1. Hung comment_publish trips deadlineMs=60, recycles hung tab (creating keeperPage first so context stays open), returns structured timeout.
    const timeoutRes = await handle({
      action: 'comment_publish',
      page: 'p1',
      url: 'https://hung.example.org/post',
      commentText: 'Nice post',
      deadlineMs: 60,
    })
    expect(timeoutRes.isError).toBeUndefined()
    const timeoutPayload = parseBrowserToolJson(timeoutRes as never)
    expect(timeoutPayload).toMatchObject({
      outcome: 'timeout',
      retryable: true,
      reason: 'tool_deadline_exceeded',
      pageRecycled: true,
    })
    expect(session.isClosed()).toBe(false)
    expect(contextClosed).toBe(false)
    expect(livePages[0]?.closed).toBe(true)
    expect(livePages[0]?.closeCalls).toBe(1)

    // 2. Next task on the exact same page ref ('p1') receives a fresh clean page with zero "browser session is closed" error!
    const nextRes = await handle({
      action: 'navigate',
      page: 'p1',
      url: 'https://healthy.example.org/post',
      deadlineMs: 5_000,
    })
    expect(nextRes.isError).toBeUndefined()
    expect(nextRes.content[0]?.text).toContain('https://healthy.example.org/post')
    expect(session.isClosed()).toBe(false)
  })

  it('enforces hard deadlines and tab recycling on navigate, snapshot, batch_fill, and directory_autofill', async () => {
    const recycledRefs: Array<string | undefined> = []
    const hangingSession: BrowserSession = {
      act: async (_cmd: BrowserCommand): Promise<BrowserResult> => {
        await new Promise<void>(() => {})
        throw new Error('unreachable')
      },
      close: async () => {},
      isClosed: () => false,
      recyclePage: async (ref?: string) => {
        recycledRefs.push(ref)
        return true
      },
    }
    const manager = new BrowserSessionManager({
      id: 'hanging-mock',
      available: () => true,
      open: async () => hangingSession,
    })
    const handle = createBrowserToolHandler({ sessionManager: manager, config: resolveMcpConfig({}) })

    const calls: Array<Record<string, unknown>> = [
      { action: 'navigate', page: 't1', url: 'https://slow-nav.example.org', deadlineMs: 40 },
      { action: 'snapshot', page: 't2', deadlineMs: 40 },
      { action: 'batch_fill', page: 't3', fields: [{ target: '#name', value: 'A' }], deadlineMs: 40 },
      { action: 'directory_autofill', page: 't4', websiteUrl: 'https://demo.example.com', deadlineMs: 40 },
    ]

    for (const args of calls) {
      const res = await handle(args)
      expect(res.isError).toBeUndefined()
      const data = parseBrowserToolJson(res as never)
      expect(data).toMatchObject({
        outcome: 'timeout',
        retryable: true,
        reason: 'tool_deadline_exceeded',
        pageRecycled: true,
        action: args.action,
      })
    }
    expect(recycledRefs).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('tightens per-step fill/click timeouts inside executeCommentPublish to <=7000ms even when timeoutMs=30000', async () => {
    const postUrl = 'https://wp-step-timeout.example.org/post-1'
    const { page, actions } = createV232MockPage({
      [postUrl]: {
        html: `
          <html><head><title>WP Step Timeout</title><link rel="stylesheet" href="/wp-content/style.css"></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" type="email" />
              <input id="url" name="url" type="url" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              mutateHtml: `<html><head><title>WP Step Timeout</title></head><body><div id="comments"><a href="https://demo.example.com">Alice</a></div></body></html>`,
            }
          }
        },
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Great article!',
        authorName: 'Alice',
        authorEmail: 'alice@example.org',
        websiteUrl: 'https://demo.example.com',
        timeoutMs: 30_000,
      },
      { defaultTimeoutMs: 30_000, sleepImpl: async () => {} },
    )

    expect(res.outcome).toBe('live')
    const stepTimeouts = actions
      .filter(a => a.kind === 'fill' || a.kind === 'click')
      .map(a => a.timeout)
    expect(stepTimeouts.length).toBeGreaterThanOrEqual(4)
    for (const t of stepTimeouts) {
      expect(t).toBeDefined()
      expect(t!).toBeLessThanOrEqual(DEFAULT_COMMENT_STEP_TIMEOUT_MS)
    }
  })
})

describe('v2.3.2 Fix 2: Wix RCE toolbar link insertion fallback & multilingual autoGoogleSso login triggers', () => {
  it('matches multilingual Wix RCE link buttons (rejecting unlink) and multilingual login/Google SSO labels', () => {
    expect(matchesWixRceLinkButton('textInlineStyleButton_LINK')).toBe(true)
    expect(matchesWixRceLinkButton('LinkButton')).toBe(true)
    expect(matchesWixRceLinkButton('Insertar enlace')).toBe(true)
    expect(matchesWixRceLinkButton('Inserir link')).toBe(true)
    expect(matchesWixRceLinkButton('Insérer un lien')).toBe(true)
    expect(matchesWixRceLinkButton('링크 삽입')).toBe(true)
    expect(matchesWixRceLinkButton('Вставить ссылку')).toBe(true)
    expect(matchesWixRceLinkButton('插入链接')).toBe(true)
    expect(matchesWixRceLinkButton('unlink')).toBe(false)
    expect(matchesWixRceLinkButton('remove-link')).toBe(false)
    expect(matchesWixRceLinkButton('Eliminar enlace')).toBe(false)

    for (const label of [
      'Iniciar sesión',
      'Inicia sesión para comentar',
      'Entrar',
      'Fazer login',
      'Se connecter',
      'Anmelden',
      'ログイン',
      'Войти',
      '로그인',
    ]) {
      expect(matchesWixLoginTriggerLabel(label), `login trigger: ${label}`).toBe(true)
    }

    for (const sso of [
      'Continuar con Google',
      'Inicia sesión con Google',
      'Faça login com o Google',
      'Connectez-vous avec Google',
      'Weiter mit Google',
      'Google でログイン',
      'Вход через Google',
    ]) {
      expect(matchesGoogleSsoButtonLabel(sso), `google sso: ${sso}`).toBe(true)
    }
  })

  it('falls back to Wix RCE toolbar Link button when URL + Space does not autolink (cofeci.gov.br / universidadmaya.edu.mx)', async () => {
    const wixUrl = 'https://www.universidadmaya.edu.mx/post/campus-life'
    let insertedHref = ''
    const routes: Record<string, V232Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>Universidad Maya</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="comment-box-rce-wrapper">
                  <div contenteditable="true" role="textbox"></div>
                </div>
                <div id="floating-toolbar" data-hook="ricos-inline-toolbar" style="display:none">
                  <button type="button" data-hook="textInlineStyleButton_LINK" aria-label="Insertar enlace">Enlace</button>
                </div>
                <div id="link-modal" data-hook="linkPanel" style="display:none">
                  <input type="text" placeholder="Pegar enlace" aria-label="Insertar enlace" />
                  <button type="button" data-hook="linkPanelConfirmButton" aria-label="Guardar">Guardar</button>
                </div>
                <button type="button" data-hook="submit-comment-button">Publicar</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value, _el, doc) => {
          // Pressing Space intentionally does NOT autolink!
          // Filling text makes the floating toolbar mount (simulating Ricos inline toolbar appearing after focus/selection).
          if (kind === 'fill' && selector.includes('comment-box-rce-wrapper')) {
            const tb = doc?.getElementById('floating-toolbar')
            if (tb) tb.removeAttribute('style')
          }
          if (kind === 'click' && selector.includes('textInlineStyleButton_LINK')) {
            const modal = doc?.getElementById('link-modal')
            if (modal) modal.removeAttribute('style')
          }
          if (kind === 'fill' && selector.includes('enlace')) {
            insertedHref = value ?? ''
          }
          if (kind === 'click' && (_el?.getAttribute('data-hook') === 'linkPanelConfirmButton' || selector.includes('linkPanelConfirm'))) {
            const editor = doc?.querySelector('[contenteditable="true"]')
            if (editor) {
              editor.innerHTML = `Excelente artículo en <a href="${insertedHref}">FreeCreate</a>.`
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixUrl]!.html = `
              <html><head><title>Universidad Maya</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="published">Excelente artículo en <a href="${insertedHref}">FreeCreate</a>.</div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Excelente artículo en FreeCreate.',
        websiteUrl: 'https://freecreate.example.com',
        anchorText: 'FreeCreate',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(insertedHref).toBe('https://freecreate.example.com')
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('falls back to Control+k shortcut when Wix RCE has no visible toolbar Link button and Space does not autolink', async () => {
    const wixUrl = 'https://www.cofeci.gov.br/post/shortcut-link'
    let insertedHref = ''
    const routes: Record<string, V232Route> = {
      [wixUrl]: {
        html: `
          <html><head><title>COFECI</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="comment-box-rce-wrapper">
                  <div contenteditable="true" role="textbox"></div>
                </div>
                <div id="shortcut-link-modal" style="display:none">
                  <input type="url" placeholder="https://..." />
                </div>
                <button type="button" data-hook="submit-comment-button">Publicar</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value, _el, doc) => {
          if (kind === 'press' && value === 'Control+k') {
            const modal = doc?.getElementById('shortcut-link-modal')
            if (modal) modal.removeAttribute('style')
          }
          if (kind === 'fill' && selector.includes('input[type="url"]')) {
            insertedHref = value ?? ''
          }
          if (kind === 'press' && value === 'Enter') {
            const editor = doc?.querySelector('[contenteditable="true"]')
            if (editor) {
              editor.innerHTML = `Ótimo guia <a href="${insertedHref}">FreeCreate</a>!`
            }
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixUrl]!.html = `
              <html><head><title>COFECI</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="published">Ótimo guia <a href="${insertedHref}">FreeCreate</a>!</div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Ótimo guia FreeCreate!',
        websiteUrl: 'https://freecreate.example.com',
        anchorText: 'FreeCreate',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(insertedHref).toBe('https://freecreate.example.com')
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('returns wix:rce_no_autolink without submitting when neither Space autolink nor RCE toolbar/shortcut creates a link', async () => {
    const wixUrl = 'https://www.cofeci.gov.br/post/noticias'
    const { page, actions } = createV232MockPage({
      [wixUrl]: {
        html: `
          <html><head><title>COFECI</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="comment-box-rce-wrapper">
                  <div contenteditable="true" role="textbox"></div>
                </div>
                <button type="button" data-hook="submit-comment-button">Publicar</button>
              </div>
            </div>
          </body></html>
        `,
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: wixUrl,
        siteHint: 'wix_blog',
        commentText: 'Muito útil para o setor.',
        websiteUrl: 'https://freecreate.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wix',
      reason: 'wix_rce_no_autolink',
      templateSignature: 'wix:rce_no_autolink',
      submitTriggered: false,
    })
    expect(actions.some(a => a.kind === 'click' && a.selector?.includes('submit-comment-button'))).toBe(false)
  })

  it('completes Wix autoGoogleSso on Spanish login entry button ("Iniciar sesión") like ulsachihuahua.edu.mx', async () => {
    const wixEsUrl = 'https://www.ulsachihuahua.edu.mx/post/becas-2026'
    const loggedInHtml = `
      <html><head><title>ULSA Chihuahua</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
        <div data-hook="comments-section">
          <div data-hook="comment-box">
            <div data-hook="comment-box-rce-wrapper"><div contenteditable="true" role="textbox"></div></div>
            <button type="button" data-hook="submit-comment-button">Publicar</button>
          </div>
        </div>
      </body></html>
    `
    const routes: Record<string, V232Route> = {
      [wixEsUrl]: {
        html: `
          <html><head><title>ULSA Chihuahua</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <main>
              <section id="comments">
                <p>Inicia sesión para comentar</p>
                <button id="es-login-btn" type="button">Iniciar sesión</button>
              </section>
            </main>
          </body></html>
        `,
        onAction: (kind, selector, value, _el, doc) => {
          if (kind === 'click' && selector.includes('es-login-btn')) {
            return {
              mutateHtml: `
                <html><head><title>ULSA Chihuahua</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SM_ROOT_COMP1" role="dialog">
                    <h2>Iniciar sesión</h2>
                    <button id="google-es-btn" type="button">Continuar con Google</button>
                  </div>
                </body></html>
              `,
            }
          }
          if (kind === 'click' && selector.includes('google-es-btn')) {
            return {
              openPopup: {
                steps: [
                  {
                    url: 'https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount',
                    html: `<html><body><div data-identifier="user@gmail.com">user@gmail.com</div></body></html>`,
                    onClick: () => ({ mutateParentHtml: loggedInHtml, close: true }),
                  },
                ],
              },
            }
          }
          if (kind === 'press' && value === 'Space') {
            const ed = doc?.querySelector('[contenteditable="true"]')
            if (ed) ed.innerHTML = 'Gran información <a href="https://freecreate.example.com">https://freecreate.example.com</a>'
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixEsUrl]!.html = `
              <html><head><title>ULSA Chihuahua</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="comment-item">Gran información <a href="https://freecreate.example.com">FreeCreate</a></div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: wixEsUrl,
        siteHint: 'wix_blog',
        commentText: 'Gran información',
        websiteUrl: 'https://freecreate.example.com',
        autoGoogleSso: true,
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      submitTriggered: true,
    })
  })
})

describe('v2.3.2 Fix 3: WooCommerce Reviews Tab auto-expansion & WordPress star rating auto-selection', () => {
  it('expands hidden WooCommerce #tab-title-reviews tab and auto-selects 5 stars before submitting', async () => {
    const productUrl = 'https://shop.example.org/product/espresso-grinder/'
    let submittedRating = ''
    let tabClicked = false

    const routes: Record<string, V232Route> = {
      [productUrl]: {
        html: `
          <html><head><title>Espresso Grinder</title><link rel="stylesheet" href="/wp-content/themes/shop/style.css"></head><body>
            <div class="woocommerce-tabs">
              <ul class="tabs wc-tabs" role="tablist">
                <li id="tab-title-description"><a href="#tab-description">Description</a></li>
                <li id="tab-title-reviews" class="reviews_tab"><a href="#tab-reviews">Reviews (2)</a></li>
              </ul>
              <div id="tab-reviews" style="display:none">
                <form id="commentform" action="/wp-comments-post.php" method="post">
                  <div class="comment-form-rating">
                    <p class="stars"><span><a class="star-1" href="#">1</a><a class="star-5" href="#">5</a></span></p>
                    <select name="rating" id="rating" style="display:none" required>
                      <option value="">Rate…</option>
                      <option value="5">Perfect</option>
                      <option value="4">Good</option>
                    </select>
                  </div>
                  <textarea id="comment" name="comment"></textarea>
                  <input id="author" name="author" required />
                  <input id="email" name="email" type="email" required />
                  <input id="url" name="url" type="url" />
                  <button id="submit" type="submit">Submit</button>
                </form>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, _val, _el, doc) => {
          if (kind === 'click' && (selector.includes('tab-title-reviews') || selector.includes('tab-reviews') || selector.includes('reviews_tab'))) {
            tabClicked = true
            const panel = doc?.getElementById('tab-reviews')
            if (panel) panel.removeAttribute('style')
          }
          if (kind === 'click' && selector.includes('star-5')) {
            const sel = doc?.getElementById('rating') as HTMLSelectElement | null
            if (sel) sel.value = '5'
          }
          if (kind === 'click' && selector.includes('submit')) {
            const sel = doc?.getElementById('rating') as HTMLSelectElement | null
            submittedRating = sel?.value ?? ''
            if (!submittedRating) {
              return {
                emitResponses: [{ url: 'https://shop.example.org/wp-comments-post.php', status: 403, body: '<body id="error-page"><div class="wp-die-message">Please select a rating</div></body>' }],
                mutateHtml: '<html><body id="error-page"><div class="wp-die-message">Please select a rating</div></body></html>',
              }
            }
            routes[productUrl]!.html = `
              <html><head><title>Espresso Grinder</title></head><body>
                <div id="comments"><li id="comment-501"><a href="https://freecreate.example.com">Bob</a><p>Solid burr alignment!</p></li></div>
              </body></html>
            `
            return { navigateTo: `${productUrl}#comment-501` }
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: productUrl,
        commentText: 'Solid burr alignment!',
        authorName: 'Bob',
        authorEmail: 'bob@example.org',
        websiteUrl: 'https://freecreate.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(tabClicked).toBe(true)
    expect(submittedRating).toBe('5')
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      submitTriggered: true,
    })
  })

  it('auto-selects radio star rating (talukadapoli.com pattern) and preserves already-selected ratings', async () => {
    const postUrl = 'https://talukadapoli.com/beaches/ladghar/'
    let submittedChecked = false
    const routes: Record<string, V232Route> = {
      [postUrl]: {
        html: `
          <html><head><title>Ladghar Beach</title><link rel="stylesheet" href="/wp-content/style.css"></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <div class="rating-radios">
                <input type="radio" id="rate-1" name="rating" value="1" />
                <input type="radio" id="rate-5" name="rating" value="5" />
              </div>
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" type="email" />
              <input id="url" name="url" type="url" />
              <input id="submit" type="submit" value="Post Comment" />
            </form>
          </body></html>
        `,
        onAction: (kind, selector, _v, _el, doc) => {
          if (kind === 'click' && selector.includes('submit')) {
            const r5 = doc?.getElementById('rate-5') as HTMLInputElement | null
            submittedChecked = Boolean(r5?.checked)
            routes[postUrl]!.html = `
              <html><head><title>Ladghar Beach</title></head><body>
                <div id="comments"><li id="comment-77"><a href="https://freecreate.example.com">Traveler</a></li></div>
              </body></html>
            `
            return { navigateTo: `${postUrl}#comment-77` }
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Lovely coastal guide.',
        authorName: 'Traveler',
        authorEmail: 't@example.org',
        websiteUrl: 'https://freecreate.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(submittedChecked).toBe(true)
    expect(res.outcome).toBe('live')

    // Verify already-selected rating is NOT overwritten.
    const { page: preselectedPage, getDocument } = createV232MockPage({
      'https://preselected.example.org/p': {
        html: `
          <html><body>
            <form id="commentform">
              <select name="rating" id="rating">
                <option value="">Rate</option>
                <option value="4" selected>4</option>
                <option value="5">5</option>
              </select>
            </form>
          </body></html>
        `,
      },
    })
    const ensureRes = await ensureWordPressStarRating(preselectedPage as never, '#commentform', 5_000)
    expect(ensureRes).toEqual({ detected: true, alreadySelected: true, selected: false })
    expect((getDocument().getElementById('rating') as HTMLSelectElement).value).toBe('4')
  })
})

describe('v2.3.2 Fix 4: OpenCart comment compatibility, multilingual WP moderation & unapproved= redirect recognition', () => {
  it('matches all required multilingual moderation phrases and detects unapproved=/moderation-hash= URL params', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['FR', 'Votre commentaire est en attente de modération.'],
      ['DE-1', 'Dein Kommentar wartet auf Freischaltung.'],
      ['DE-2', 'Ihr Kommentar wartet auf Moderation.'],
      ['CS', 'Váš komentář čeká na schválení.'],
      ['ES-1', 'Tu comentario está esperando moderación.'],
      ['ES-2', 'Su comentario está pendiente de moderación.'],
      ['RU-1', 'Ваш комментарий ожидает проверки.'],
      ['RU-2', 'Комментарий ожидает модерации.'],
      ['PL', 'Twój komentarz oczekuje na moderację.'],
      ['ID', 'Komentar Anda sedang menunggu moderasi.'],
      ['PT', 'Seu comentário está aguardando moderação.'],
    ]
    for (const [lang, text] of samples) {
      expect(matchModerationNotice(text), `${lang}: ${text}`).toBeTruthy()
    }

    expect(hasWpModerationUrlParams('https://blog.example.org/post/?unapproved=42&moderation-hash=abc#comment-42')).toBe(true)
    expect(hasWpModerationUrlParams('https://blog.example.org/post/?moderation-hash=xyz')).toBe(true)
    expect(hasWpModerationUrlParams('https://blog.example.org/post/#comment-42')).toBe(false)
  })

  it('fills, submits, and verifies OpenCart blog comment (#button-comment + name/text) while blocking OpenCart CAPTCHA forms', async () => {
    const ocUrl = 'https://www.grandwaygifts.com/index.php?route=blog/article&article_id=12'
    const routes: Record<string, V232Route> = {
      [ocUrl]: {
        html: `
          <html><head><title>Grandway Blog</title></head><body>
            <div id="blog-comment">
              <form id="form-comment">
                <input type="text" name="name" id="input-name" />
                <input type="email" name="email" id="input-email" />
                <textarea name="text" id="input-comment"></textarea>
                <button type="button" id="button-comment">Submit Comment</button>
              </form>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, _val, _el, doc) => {
          if (kind === 'click' && selector.includes('button-comment')) {
            const alertDiv = doc?.createElement('div')
            if (alertDiv && doc) {
              alertDiv.className = 'alert alert-success'
              alertDiv.textContent = 'Thank you for your comment. It has been submitted to the webmaster for approval.'
              doc.getElementById('form-comment')?.prepend(alertDiv)
            }
            return {
              emitResponses: [
                {
                  url: 'https://www.grandwaygifts.com/index.php?route=blog/article/write&article_id=12',
                  status: 200,
                  method: 'POST',
                  resourceType: 'xhr',
                  body: JSON.stringify({ success: 'Thank you for your comment. It has been submitted to the webmaster for approval.' }),
                },
              ],
            }
          }
        },
      },
    }

    const { page } = createV232MockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: ocUrl,
        commentText: 'Informative gift guide!',
        authorName: 'Chris',
        authorEmail: 'chris@example.org',
        websiteUrl: 'https://freecreate.example.com',
        anchorText: 'FreeCreate',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      outcome: 'submitted',
      siteType: 'opencart',
      submitTriggered: true,
    })

    // OpenCart review form with CAPTCHA MUST be blocked cleanly without submitting.
    const ocCaptchaUrl = 'https://www.lscstove.com/index.php?route=product/product&product_id=55'
    const { page: captchaPage, actions: captchaActions } = createV232MockPage({
      [ocCaptchaUrl]: {
        html: `
          <html><head><title>LSC Stove</title></head><body>
            <form id="form-review">
              <input type="text" name="name" id="input-name" />
              <textarea name="text" id="input-review"></textarea>
              <img src="index.php?route=extension/captcha/basic/captcha" />
              <input type="text" name="captcha" id="input-captcha" />
              <button type="button" id="button-review">Continue</button>
            </form>
          </body></html>
        `,
      },
    })

    const captchaRes = await executeCommentPublish(
      captchaPage as never,
      'p2',
      {
        kind: 'comment_publish',
        url: ocCaptchaUrl,
        commentText: 'Great stove!',
        authorName: 'Chris',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(captchaRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'opencart',
      submitTriggered: false,
    })
    expect(captchaActions.some(a => a.kind === 'click' && a.selector?.includes('button-review'))).toBe(false)
  })

  it('stably returns submitted (not uncertain_after_submit) on Czech/Polish/Indonesian WP moderation and on unapproved=/moderation-hash= redirects', async () => {
    // Case A: Czech moderation text without unapproved query param
    const csUrl = 'https://blog.example.cz/clanek/'
    const csRoutes: Record<string, V232Route> = {
      [csUrl]: {
        html: `
          <html><head><title>Článek</title><link rel="stylesheet" href="/wp-content/style.css"></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" type="email" />
              <button id="submit" type="submit">Odeslat</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              mutateHtml: '<html><head><title>Článek</title></head><body><p>Váš komentář čeká na schválení.</p></body></html>',
            }
          }
        },
      },
    }
    const { page: csPage } = createV232MockPage(csRoutes)
    const csRes = await executeCommentPublish(
      csPage as never,
      'p1',
      { kind: 'comment_publish', url: csUrl, commentText: 'Skvělý článek!', authorName: 'Jan', authorEmail: 'jan@example.cz' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(csRes).toMatchObject({ outcome: 'submitted', siteType: 'wordpress', submitTriggered: true })

    // Case B: 302 Location carried `?unapproved=888&moderation-hash=deadbeef#comment-888` even if final DOM has no moderation text and strips query params
    const unapprovedUrl = 'https://wp-strip.example.org/post-88/'
    const stripRoutes: Record<string, V232Route> = {
      [unapprovedUrl]: {
        html: `
          <html><head><title>WP Strip</title><link rel="stylesheet" href="/wp-content/style.css"></head><body>
            <form id="commentform" action="/wp-comments-post.php" method="post">
              <textarea id="comment" name="comment"></textarea>
              <input id="author" name="author" />
              <input id="email" name="email" type="email" />
              <button id="submit" type="submit">Post Comment</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return {
              emitResponses: [
                {
                  url: 'https://wp-strip.example.org/wp-comments-post.php',
                  status: 302,
                  headers: {
                    location: `${unapprovedUrl}?unapproved=888&moderation-hash=deadbeef#comment-888`,
                  },
                },
              ],
              navigateTo: `${unapprovedUrl}#comment-888`,
            }
          }
        },
      },
    }
    const { page: stripPage } = createV232MockPage(stripRoutes)
    const stripRes = await executeCommentPublish(
      stripPage as never,
      'p2',
      { kind: 'comment_publish', url: unapprovedUrl, commentText: 'Helpful insights!', authorName: 'Sam', authorEmail: 'sam@example.org' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(stripRes).toMatchObject({
      outcome: 'submitted',
      siteType: 'wordpress',
      reason: 'wp_unapproved_redirect',
      publicUrl: `${unapprovedUrl}#comment-888`,
      submitTriggered: true,
    })
  })
})
