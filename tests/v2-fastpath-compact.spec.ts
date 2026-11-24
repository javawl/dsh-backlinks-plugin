import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  isSupermanager5xxError,
  mapTagsForSupermanagerWire,
  mapTagsToSafeChineseFallback,
  normalizeBlockingTag,
} from '../src/host/backlinks/standards.ts'
import type { BacklinkBatchDetail, BacklinkBatchSourceProvider } from '../src/host/backlinks/types.ts'
import { BacklinksError } from '../src/host/backlinks/types.ts'
import {
  buildWpCommentContent,
  executeCommentPublish,
  INSPECT_COMMENT_PAGE_SCRIPT,
  stripHtmlLinkForRichEditor,
  stripWpModerationParams,
  verifyCommentResultInDom,
  type CommentPageInspection,
} from '../src/host/browser-playwright/comment-publish.ts'
import {
  compactAriaSnapshot,
  compactPlainText,
  formatCompactTextEvaluation,
} from '../src/host/browser-playwright/compact-snapshot.ts'
import { parseControlReport, renderPageControls } from '../src/host/browser-playwright/interactive.ts'
import { PlaywrightSession } from '../src/host/browser-playwright/provider.ts'
import { SupermanagerBatchSource } from '../src/host/supermanager/provider.ts'
import { createBacklinksToolHandler } from '../src/mcp/backlinks-tool.ts'
import { BrowserSessionManager, createBrowserToolHandler, formatMcpBrowserOutput } from '../src/mcp/browser-tool.ts'
import { resolveMcpConfig } from '../src/mcp/config.ts'
import { detectSiteHint } from '../src/mcp/preflight.ts'

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

function evalInspectInJsdom(html: string, url = 'https://blog.example.org/post-1'): CommentPageInspection {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  return dom.window.eval(INSPECT_COMMENT_PAGE_SCRIPT) as CommentPageInspection
}

function evalVerifyInJsdom(
  html: string,
  params: Parameters<typeof verifyCommentResultInDom>[0],
  url = 'https://blog.example.org/post-1',
) {
  const dom = new JSDOM(html, { url })
  const prevDoc = globalThis.document
  const prevLoc = globalThis.location
  const prevNodeFilter = globalThis.NodeFilter
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'location', { value: dom.window.location, configurable: true })
  Object.defineProperty(globalThis, 'NodeFilter', { value: dom.window.NodeFilter, configurable: true })
  try {
    return verifyCommentResultInDom(params)
  } finally {
    if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document
    else Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true })
    if (prevLoc === undefined) delete (globalThis as Record<string, unknown>).location
    else Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true })
    if (prevNodeFilter === undefined) delete (globalThis as Record<string, unknown>).NodeFilter
    else Object.defineProperty(globalThis, 'NodeFilter', { value: prevNodeFilter, configurable: true })
  }
}

interface MockChildFrameSpec {
  readonly url: string
  readonly html: string
  readonly crossOriginError?: boolean
  readonly detached?: boolean
}

/** Lightweight jsdom-backed Playwright Page mock for driving `executeCommentPublish` end-to-end. */
function createDomDrivenMockPage(routes: Record<string, {
  title: string
  html: string
  frames?: readonly MockChildFrameSpec[]
  onScroll?: (fraction: number, scrollCount: number) => string | void
  onInspect?: (inspectCount: number) => string | void
  onAction?: (kind: string, selector: string, value?: string) => { navigateTo?: string; mutateHtml?: string } | void
}>) {
  const buildDom = (html: string, url: string) => {
    const next = new JSDOM(html, { url, runScripts: 'outside-only' })
    next.window.scrollTo = () => {}
    return next
  }

  let currentUrl = Object.keys(routes)[0] ?? 'https://blog.example.org/post-1'
  let dom = buildDom(routes[currentUrl]?.html ?? '<html></html>', currentUrl)
  const actions: Array<{ kind: string; selector?: string; value?: string }> = []
  const scrollFractions: number[] = []
  let scrollCount = 0
  let inspectCount = 0
  const mainFrameStub = { url: () => currentUrl, isDetached: () => false }

  const activeRoute = () => routes[currentUrl] ?? routes[currentUrl.split('#')[0]!]

  const loadRoute = (targetUrl: string) => {
    const cleanTarget = targetUrl.split('#')[0]!
    const route = routes[targetUrl] ?? routes[cleanTarget]
    if (!route) throw new Error(`No mock route for ${targetUrl}`)
    currentUrl = targetUrl
    dom = buildDom(route.html, targetUrl)
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

  const page = {
    isClosed: () => false,
    on: () => {},
    url: () => currentUrl,
    title: async () => dom.window.document.title || '',
    mainFrame: () => mainFrameStub,
    frames: () => {
      const specs = activeRoute()?.frames ?? []
      return [
        mainFrameStub,
        ...specs.map(spec => ({
          url: () => spec.url,
          isDetached: () => spec.detached === true,
          evaluate: async (scriptOrFn: unknown) => {
            if (spec.crossOriginError) {
              throw new Error('Blocked cross-origin frame')
            }
            const fDom = new JSDOM(spec.html, { url: spec.url, runScripts: 'outside-only' })
            if (typeof scriptOrFn === 'string') {
              return fDom.window.eval(scriptOrFn)
            }
            return undefined
          },
        })),
      ]
    },
    goto: async (url: string) => {
      actions.push({ kind: 'goto', value: url })
      loadRoute(url)
    },
    waitForLoadState: async () => {},
    evaluate: async (fnOrScript: unknown, arg?: unknown) => {
      const route = activeRoute()
      if (typeof fnOrScript === 'function' && typeof arg === 'number') {
        scrollFractions.push(arg)
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
      return runWithDomGlobals(() => (fnOrScript as (a?: unknown) => unknown)(arg))
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
          const route = activeRoute()
          const effect = route?.onAction?.('fill', selector, val)
          if (effect?.mutateHtml) {
            dom = buildDom(effect.mutateHtml, currentUrl)
          }
        },
        click: async () => {
          actions.push({ kind: 'click', selector })
          const route = activeRoute()
          const effect = route?.onAction?.('click', selector)
          if (effect?.mutateHtml) {
            dom = buildDom(effect.mutateHtml, currentUrl)
          }
          if (effect?.navigateTo) {
            loadRoute(effect.navigateTo)
          }
        },
        press: async (key: string) => {
          actions.push({ kind: 'press', selector, value: key })
          const route = activeRoute()
          const effect = route?.onAction?.('press', selector, key)
          if (effect?.mutateHtml) {
            dom = buildDom(effect.mutateHtml, currentUrl)
          }
        },
      }
      return {
        ...firstApi,
        first: () => firstApi,
        count,
      }
    },
  }

  return { page, actions, scrollFractions, getUrl: () => currentUrl }
}

describe('comment_publish fast-path helpers, inspection & end-to-end flows', () => {
  it('builds WordPress comment content cleanly and strips moderation params & rich-editor HTML', () => {
    expect(buildWpCommentContent('Great insights on this workflow.', 'https://demo.example.com', 'DemoSite', true))
      .toBe('Great insights on this workflow.')
    expect(buildWpCommentContent('I really liked DemoSite in this guide.', 'https://demo.example.com', 'DemoSite', false))
      .toBe('I really liked <a href="https://demo.example.com">DemoSite</a> in this guide.')
    expect(buildWpCommentContent('Helpful breakdown.', 'https://demo.example.com', 'DemoSite', false))
      .toBe('Helpful breakdown. <a href="https://demo.example.com">DemoSite</a>')

    expect(stripWpModerationParams('https://blog.example.org/post-1?unapproved=99&moderation-hash=abc123#comment-99'))
      .toBe('https://blog.example.org/post-1#comment-99')

    expect(stripHtmlLinkForRichEditor('Try <a href="https://demo.example.com">DemoSite</a> for faster checks.'))
      .toEqual({
        plainText: 'Try DemoSite for faster checks.',
        anchorText: 'DemoSite',
        websiteUrl: 'https://demo.example.com',
      })
  })

  it('publishes WordPress comment and confirms live clickable link on clean reload', async () => {
    const postUrl = 'https://wp.example.org/hello-world/'
    const publishedUrl = 'https://wp.example.org/hello-world/#comment-123'
    let submitted = false

    const routes: Record<string, { title: string; html: string; onAction?: (k: string, s: string) => { navigateTo?: string } | void }> = {
      [postUrl]: {
        title: 'Hello World - WP Blog',
        html: `
          <html><head><title>Hello World - WP Blog</title></head><body>
            <article><h1>Hello World</h1><p>Useful post.</p></article>
            <div id="respond">
              <form id="commentform" action="/wp-comments-post.php" method="post">
                <textarea id="comment" name="comment" required></textarea>
                <input id="author" name="author" type="text" required />
                <input id="email" name="email" type="email" required />
                <input id="url" name="url" type="url" />
                <button id="submit" type="submit">Post Comment</button>
              </form>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            submitted = true
            routes[postUrl]!.html = `
              <html><head><title>Hello World - WP Blog</title></head><body>
                <article><h1>Hello World</h1></article>
                <div id="comments">
                  <div id="comment-123">
                    <a href="https://demo.example.com">Alice</a>
                    <p>Great post about testing workflows.</p>
                  </div>
                </div>
              </body></html>
            `
            routes[publishedUrl] = routes[postUrl]!
            return { navigateTo: publishedUrl }
          }
        },
      },
    }

    const { page, actions } = createDomDrivenMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p1',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Great post about testing workflows.',
        authorName: 'Alice',
        authorEmail: 'alice@screwdom.org',
        websiteUrl: 'https://demo.example.com',
        anchorText: 'DemoSite',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(submitted).toBe(true)
    expect(res).toMatchObject({
      kind: 'comment_publish',
      page: 'p1',
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: publishedUrl,
      submitTriggered: true,
    })
    expect(actions.filter(a => a.kind === 'fill').map(a => a.value)).toEqual([
      'Great post about testing workflows.',
      'Alice',
      'alice@screwdom.org',
      'https://demo.example.com',
    ])
  })

  it('reports WordPress awaiting-moderation comments as submitted after clean public reload', async () => {
    const postUrl = 'https://wp-mod.example.org/article/'
    const modRedirectUrl = 'https://wp-mod.example.org/article/?unapproved=55&moderation-hash=deadbeef#comment-55'
    const cleanReloadUrl = 'https://wp-mod.example.org/article/#comment-55'

    const baseHtml = `
      <html><head><title>Mod Blog</title></head><body>
        <form id="commentform" action="/wp-comments-post.php" method="post">
          <textarea name="comment"></textarea>
          <input name="author" type="text" />
          <input name="email" type="email" />
          <input name="url" type="url" />
          <input type="submit" id="submit" value="Submit" />
        </form>
      </body></html>
    `
    const routes: Record<string, { title: string; html: string; onAction?: (k: string, s: string) => { navigateTo?: string } | void }> = {
      [postUrl]: {
        title: 'Mod Blog',
        html: baseHtml,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            return { navigateTo: modRedirectUrl }
          }
        },
      },
      [modRedirectUrl]: {
        title: 'Mod Blog',
        html: `<html><head><title>Mod Blog</title></head><body><div id="comments"><em class="comment-awaiting-moderation">Your comment is awaiting moderation.</em></div></body></html>`,
      },
      [cleanReloadUrl]: {
        title: 'Mod Blog',
        html: `<html><head><title>Mod Blog</title></head><body><div id="comments"><p>Previous comment only.</p></div></body></html>`,
      },
    }

    const { page } = createDomDrivenMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p2',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Thoughtful analysis.',
        authorName: 'Bob',
        authorEmail: 'bob@screwdom.org',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(res).toMatchObject({
      kind: 'comment_publish',
      outcome: 'submitted',
      siteType: 'wordpress',
      publicUrl: cleanReloadUrl,
      submitTriggered: true,
    })
  })

  it('strictly returns uncertain_after_submit without retrying when post-submit reload lacks link/moderation or escapes HTML', async () => {
    const postUrl = 'https://wp-uncertain.example.org/post/'
    let submitClicks = 0

    const routes: Record<string, { title: string; html: string; onAction?: (k: string, s: string) => { navigateTo?: string } | void }> = {
      [postUrl]: {
        title: 'Uncertain WP',
        html: `
          <html><head><title>Uncertain WP</title></head><body>
            <form id="commentform" action="/wp-comments-post.php">
              <textarea name="comment"></textarea>
              <button type="submit" id="submit">Send</button>
            </form>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit')) {
            submitClicks++
            routes[postUrl]!.html = `
              <html><head><title>Uncertain WP</title></head><body>
                <div id="comments">User wrote: &lt;a href="https://demo.example.com"&gt;DemoSite&lt;/a&gt;</div>
              </body></html>
            `
            return { navigateTo: postUrl }
          }
        },
      },
    }

    const { page } = createDomDrivenMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p3',
      {
        kind: 'comment_publish',
        url: postUrl,
        commentText: 'Check out DemoSite.',
        websiteUrl: 'https://demo.example.com',
        anchorText: 'DemoSite',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(submitClicks).toBe(1)
    expect(res).toMatchObject({
      outcome: 'uncertain_after_submit',
      siteType: 'wordpress',
      submitTriggered: true,
    })
    expect(res.evidence).toContain('转义')
  })

  it('detects WordPress CAPTCHAs (reCAPTCHA / Turnstile / SecureImg / math) without filling or submitting', async () => {
    const recaptchaUrl = 'https://wp-cap.example.org/post/'
    const { page, actions } = createDomDrivenMockPage({
      [recaptchaUrl]: {
        title: 'WP Captcha',
        html: `
          <html><head><title>WP Captcha</title></head><body>
            <form id="commentform" action="/wp-comments-post.php">
              <textarea name="comment"></textarea>
              <div class="g-recaptcha" data-sitekey="abc"></div>
              <button type="submit">Post</button>
            </form>
          </body></html>
        `,
      },
    })
    const res = await executeCommentPublish(
      page as never,
      'p4',
      { kind: 'comment_publish', url: recaptchaUrl, commentText: 'Hello' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(res).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wordpress',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
    expect(actions.filter(a => a.kind === 'fill' || a.kind === 'click')).toHaveLength(0)

    const secureImgInspection = evalInspectInJsdom(`
      <form id="commentform"><textarea name="comment"></textarea><img src="/si/secureimg.php" /><input name="si_code" /></form>
    `)
    expect(secureImgInspection.wordpress.captcha).toMatchObject({
      detected: true,
      kind: 'secureimg',
      templateSignature: 'blog:secureimg_captcha',
    })

    const mathInspection = evalInspectInJsdom(`
      <form id="commentform"><textarea name="comment"></textarea><label>3 + 4 = ?</label><input name="quiz" /></form>
    `)
    expect(mathInspection.wordpress.captcha).toMatchObject({
      detected: true,
      kind: 'math_captcha',
    })
  })

  it('detects explicit comments_closed banners with 评论关闭 tag', async () => {
    for (const phrase of ['Comments are closed.', '评论已关闭', 'Commenting is closed for this article.']) {
      const closedUrl = 'https://closed.example.org/post'
      const { page } = createDomDrivenMockPage({
        [closedUrl]: {
          title: 'Closed Blog',
          html: `<html><head><title>Closed Blog</title></head><body><main><p>${phrase}</p></main></body></html>`,
        },
      })
      const res = await executeCommentPublish(
        page as never,
        'p5',
        { kind: 'comment_publish', url: closedUrl, commentText: 'Hello' },
        { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
      )
      expect(res).toMatchObject({
        outcome: 'comments_closed',
        suggestedTags: ['评论关闭'],
        submitTriggered: false,
      })
    }
  })

  it('blocks immediately on Wix login/reCAPTCHA walls (both initial and revealed on click)', async () => {
    const wixLockedUrl = 'https://site.wixsite.com/blog/post/locked'
    const { page } = createDomDrivenMockPage({
      [wixLockedUrl]: {
        title: 'Wix Locked',
        html: `
          <html><head><title>Wix Locked</title><meta name="generator" content="Wix.com Website Builder"/></head><body>
            <div data-hook="comments-section">
              <button data-hook="login-button">Log in to publish as a member</button>
              <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
            </div>
          </body></html>
        `,
      },
    })
    const res1 = await executeCommentPublish(
      page as never,
      'p6',
      { kind: 'comment_publish', url: wixLockedUrl, commentText: 'Nice' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(res1).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      templateSignature: 'wix:signup_recaptcha',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })

    // Trigger click reveals login/recaptcha wall dynamically.
    const wixTriggerUrl = 'https://site.wixsite.com/blog/post/trigger'
    const routes: Record<string, { title: string; html: string; onAction?: (k: string, s: string) => { mutateHtml?: string } | void }> = {
      [wixTriggerUrl]: {
        title: 'Wix Trigger',
        html: `
          <html><head><title>Wix Trigger</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <button data-hook="comment-box-placeholder">Write a comment...</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>Wix Trigger</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comments-section">
                    <div data-testid="signUp">Log in to comment</div>
                    <div class="g-recaptcha"></div>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    }
    const { page: page2 } = createDomDrivenMockPage(routes)
    const res2 = await executeCommentPublish(
      page2 as never,
      'p7',
      { kind: 'comment_publish', url: wixTriggerUrl, commentText: 'Nice' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(res2).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      templateSignature: 'wix:signup_recaptcha',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
  })

  it('publishes Wix guest comment via rich toolbar link embedding (never raw <a> text) and detects no_form on Wix without comments', async () => {
    const wixGuestUrl = 'https://guest.wixsite.com/blog/post/open'
    let linkUrlFilled = ''
    let linkApplied = false

    const routes: Record<string, { title: string; html: string; onAction?: (k: string, s: string, v?: string) => { mutateHtml?: string; navigateTo?: string } | void }> = {
      [wixGuestUrl]: {
        title: 'Wix Guest Blog',
        html: `
          <html><head><title>Wix Guest Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true"></div>
                <button type="button" aria-label="Insert link" data-hook="link-button">Link</button>
                <input name="guestName" placeholder="Your name" />
                <button type="button" data-hook="submit-comment-button">Publish</button>
              </div>
              <div id="link-popover" style="display:none">
                <input type="url" placeholder="https://..." />
                <button type="button" data-hook="save-link-btn">Apply</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector, value) => {
          if (kind === 'click' && selector.includes('link-button')) {
            return {
              mutateHtml: routes[wixGuestUrl]!.html.replace('style="display:none"', ''),
            }
          }
          if (kind === 'fill' && selector.includes('input[type="url"]')) {
            linkUrlFilled = value ?? ''
          }
          if (kind === 'click' && selector.includes('save')) {
            linkApplied = true
          }
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            routes[wixGuestUrl]!.html = `
              <html><head><title>Wix Guest Blog</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section">
                  <div class="published-comment">Try <a href="${linkUrlFilled}">DemoSite</a> for fast audits.</div>
                </div>
              </body></html>
            `
          }
        },
      },
    }

    const { page, actions } = createDomDrivenMockPage(routes)
    const res = await executeCommentPublish(
      page as never,
      'p8',
      {
        kind: 'comment_publish',
        url: wixGuestUrl,
        commentText: 'Try <a href="https://demo.example.com">DemoSite</a> for fast audits.',
        authorName: 'GuestOne',
        websiteUrl: 'https://demo.example.com',
        anchorText: 'DemoSite',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(linkApplied).toBe(true)
    expect(linkUrlFilled).toBe('https://demo.example.com')
    // Rich contenteditable received plain text without raw HTML <a> tag!
    const editorFill = actions.find(a => a.kind === 'fill' && a.selector?.includes('create-comment-input'))
    expect(editorFill?.value).toBe('Try DemoSite for fast audits.')
    expect(res).toMatchObject({
      outcome: 'live',
      siteType: 'wix',
      publicUrl: wixGuestUrl,
      submitTriggered: true,
    })

    // Wix page with no comment section -> no_form.
    const wixNoFormUrl = 'https://noform.wixsite.com/blog/about'
    const { page: noFormPage } = createDomDrivenMockPage({
      [wixNoFormUrl]: {
        title: 'Wix About',
        html: `<html><head><title>Wix About</title><script src="https://static.wixstatic.com/app.js"></script></head><body><main><p>Static bio page</p></main></body></html>`,
      },
    })
    const noFormRes = await executeCommentPublish(
      noFormPage as never,
      'p9',
      { kind: 'comment_publish', url: wixNoFormUrl, commentText: 'Hi' },
      { defaultTimeoutMs: 10_000, lazyWaitMaxMs: 10, sleepImpl: async () => {} },
    )
    expect(noFormRes).toMatchObject({
      outcome: 'no_form',
      siteType: 'wix',
      suggestedTags: ['no_form'],
      submitTriggered: false,
    })

    // Wix contenteditable without link toolbar button & without website field must NOT submit linkless comment.
    const wixNoLinkBtnUrl = 'https://nolinkbtn.wixsite.com/blog/post'
    const { page: noLinkBtnPage, actions: noLinkBtnActions } = createDomDrivenMockPage({
      [wixNoLinkBtnUrl]: {
        title: 'Wix No Link Btn',
        html: `
          <html><head><title>Wix No Link Btn</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <div data-hook="create-comment-input" contenteditable="true"></div>
                <button type="button" data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
      },
    })
    const noLinkBtnRes = await executeCommentPublish(
      noLinkBtnPage as never,
      'p9b',
      {
        kind: 'comment_publish',
        url: wixNoLinkBtnUrl,
        commentText: 'Try DemoSite for audits.',
        websiteUrl: 'https://demo.example.com',
        anchorText: 'DemoSite',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(noLinkBtnRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'wix',
      submitTriggered: false,
    })
    expect(noLinkBtnActions.some(a => a.kind === 'click' && a.selector?.includes('submit'))).toBe(false)

    // Wix guest comment returning awaiting moderation -> submitted.
    const wixModUrl = 'https://mod.wixsite.com/blog/post'
    const wixModRoutes: Record<string, { title: string; html: string; onAction?: (k: string, s: string) => void }> = {
      [wixModUrl]: {
        title: 'Wix Mod',
        html: `
          <html><head><title>Wix Mod</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comments-section">
              <div data-hook="comment-box">
                <textarea placeholder="Write a comment..."></textarea>
                <input name="website" type="url" />
                <button type="button" data-hook="submit-comment-button">Publish</button>
              </div>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('submit-comment-button')) {
            wixModRoutes[wixModUrl]!.html = `
              <html><head><title>Wix Mod</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comments-section"><p>Your comment is pending approval.</p></div>
              </body></html>
            `
          }
        },
      },
    }
    const { page: wixModPage } = createDomDrivenMockPage(wixModRoutes)
    const wixModRes = await executeCommentPublish(
      wixModPage as never,
      'p9c',
      {
        kind: 'comment_publish',
        url: wixModUrl,
        commentText: 'Helpful notes.',
        websiteUrl: 'https://demo.example.com',
      },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(wixModRes).toMatchObject({
      outcome: 'submitted',
      siteType: 'wix',
      submitTriggered: true,
    })
  })

  it('returns needs_llm_fallback with formSummary on directories/custom sites and form_ready on probeOnly', async () => {
    const dirUrl = 'https://dir.example.org/submit'
    const { page: dirPage } = createDomDrivenMockPage({
      [dirUrl]: {
        title: 'Submit Directory',
        html: `
          <html><head><title>Submit Directory</title></head><body>
            <form action="/api/submit" method="post">
              <input name="site_title" placeholder="Tool name" />
              <input name="site_url" type="url" />
              <button type="submit">Submit Tool</button>
            </form>
          </body></html>
        `,
      },
    })
    const fallbackRes = await executeCommentPublish(
      dirPage as never,
      'p10',
      { kind: 'comment_publish', url: dirUrl, commentText: 'Great tool' },
      { defaultTimeoutMs: 10_000, lazyWaitMaxMs: 10, sleepImpl: async () => {} },
    )
    expect(fallbackRes).toMatchObject({
      outcome: 'needs_llm_fallback',
      siteType: 'other',
      finalUrl: dirUrl,
      submitTriggered: false,
      formSummary: {
        forms: 1,
        buttons: ['Submit Tool'],
      },
    })

    // probeOnly on WP returns form_ready without submitting.
    const wpUrl = 'https://wp.example.org/post'
    const { page: wpPage, actions: wpActions } = createDomDrivenMockPage({
      [wpUrl]: {
        title: 'WP Ready',
        html: `<html><head><title>WP Ready</title></head><body><form id="commentform"><textarea name="comment"></textarea><button type="submit">Post</button></form></body></html>`,
      },
    })
    const probeRes = await executeCommentPublish(
      wpPage as never,
      'p11',
      { kind: 'comment_publish', url: wpUrl, commentText: '', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(probeRes).toMatchObject({
      outcome: 'form_ready',
      siteType: 'wordpress',
      probeOnly: true,
      submitTriggered: false,
    })
    expect(wpActions.some(a => a.kind === 'click' || a.kind === 'fill')).toBe(false)

    // Verify bare URL text (not an <a href>) does not pass liveLinkFound in DOM verification.
    const bareVerify = evalVerifyInJsdom('<body><div id="comments">Visit https://demo.example.com for more.</div></body>', {
      websiteUrl: 'https://demo.example.com',
      anchorText: 'DemoSite',
    })
    expect(bareVerify.liveLinkFound).toBe(false)
  })

  it('wires comment_publish through MCP browser tool without emitting 8KB DOM snapshots', async () => {
    const sessionManager = new BrowserSessionManager({
      id: 'mock',
      available: () => true,
      open: async () => ({
        act: async (cmd) => {
          expect(cmd).toMatchObject({
            kind: 'comment_publish',
            url: 'https://blog.example.org/post',
            timeoutMs: 10_000,
          })
          return {
            kind: 'comment_publish',
            page: 'p1',
            outcome: 'live',
            siteType: 'wordpress',
            title: 'Blog Post',
            finalUrl: 'https://blog.example.org/post#comment-42',
            publicUrl: 'https://blog.example.org/post#comment-42',
            evidence: 'confirmed clickable link',
            submitTriggered: true,
          }
        },
        close: async () => {},
      }),
    })

    const handle = createBrowserToolHandler({ sessionManager, config: resolveMcpConfig({}) })
    const res = await handle({
      action: 'comment_publish',
      url: 'https://blog.example.org/post',
      commentText: 'Solid technical walkthrough.',
      authorName: 'Alice',
      authorEmail: 'alice@screwdom.org',
      websiteUrl: 'https://demo.example.com',
    })
    expect(res.isError).toBeUndefined()
    const payload = parseToolPayload(res as never)
    expect(payload.summary).toContain('comment_publish: live (wordpress)')
    expect(payload.data).toMatchObject({
      outcome: 'live',
      siteType: 'wordpress',
      publicUrl: 'https://blog.example.org/post#comment-42',
      submitTriggered: true,
    })
  })

  it('does not short-circuit on Wix comments-section-placeholder/comment-count, performs progressive scroll + delayed Ricos expand', async () => {
    const postUrl = 'https://br.wixsite.com/blog/post/cultura-2026'
    let clickedPlaceholder = false
    let pollsAfterClick = 0

    const { page, scrollFractions } = createDomDrivenMockPage({
      [postUrl]: {
        title: 'Cultura 2026',
        html: `
          <html><head><title>Cultura 2026</title><script src="https://static.parastorage.com/communities-blog-ooi/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <span data-hook="comment-count">2 comments</span>
                <p>Artigo de teste.</p>
                <div data-hook="comments-section-placeholder"></div>
              </article>
            </div>
          </body></html>
        `,
        onScroll: (_fraction, scrollIdx) => {
          if (scrollIdx === 2) {
            return `
              <html><head><title>Cultura 2026</title><script src="https://static.parastorage.com/communities-blog-ooi/app.js"></script></head><body>
                <div id="SITE_CONTAINER">
                  <article data-hook="post">
                    <span data-hook="comment-count">2 comments</span>
                    <div id="root-comment-box-start-1" data-hook="comment-box comment-box-top">
                      <button data-hook="comment-box-placeholder"><span>Escreva um comentário</span></button>
                    </div>
                    <div data-hook="top-level-comment-list"></div>
                  </article>
                </div>
              </body></html>
            `
          }
        },
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            clickedPlaceholder = true
          }
        },
        onInspect: () => {
          if (!clickedPlaceholder) return
          pollsAfterClick++
          if (pollsAfterClick === 3) {
            return `
              <html><head><title>Cultura 2026</title><script src="https://static.parastorage.com/communities-blog-ooi/app.js"></script></head><body>
                <div id="SITE_CONTAINER">
                  <article data-hook="post">
                    <div id="root-comment-box-start-1" data-hook="comment-box comment-box-top">
                      <div data-hook="fullRicosEditor">
                        <div data-hook="ricos-tiptap-editor">
                          <div contenteditable="true" class="tiptap ProseMirror" role="textbox"></div>
                        </div>
                      </div>
                      <button type="button" data-hook="primary-btn">Publicar</button>
                    </div>
                  </article>
                </div>
              </body></html>
            `
          }
        },
      },
    })

    const res = await executeCommentPublish(
      page as never,
      'p-wix-lazy',
      { kind: 'comment_publish', url: postUrl, commentText: '', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )

    expect(clickedPlaceholder).toBe(true)
    expect(scrollFractions.slice(0, 3)).toEqual([0.3, 0.6, 0.85])
    expect(res).toMatchObject({
      outcome: 'form_ready',
      siteType: 'wix',
      probeOnly: true,
      submitTriggered: false,
    })
  })

  it('routes Wix Log in to publish as a member without CAPTCHA to needs_llm_fallback (not no_form/blocked_captcha) while blocking when reCAPTCHA appears', async () => {
    const memberOnlyUrl = 'https://myremc.example.coop/post/board-2026'
    const { page: memberPage } = createDomDrivenMockPage({
      [memberOnlyUrl]: {
        title: 'Board 2026',
        html: `
          <html><head><title>Board 2026</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div id="SITE_CONTAINER">
              <article data-hook="post">
                <div data-hook="comment-box comment-box-top">
                  <button data-hook="comment-box-placeholder">Write a comment...</button>
                </div>
              </article>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            return {
              mutateHtml: `
                <html><head><title>Board 2026</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div id="SITE_CONTAINER">
                    <article data-hook="post">
                      <div data-hook="comment-box comment-box-top">
                        <span>Log in to publish as a member</span>
                        <button data-hook="login-as-member-text-button">Log in</button>
                        <button data-hook="primary-btn">Publish</button>
                      </div>
                    </article>
                  </div>
                </body></html>
              `,
            }
          }
        },
      },
    })

    const memberRes = await executeCommentPublish(
      memberPage as never,
      'p-wix-login',
      { kind: 'comment_publish', url: memberOnlyUrl, commentText: 'Great post', probeOnly: true },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(memberRes).toMatchObject({
      outcome: 'needs_login',
      siteType: 'wix',
      submitTriggered: false,
      formSummary: { hasLoginWall: true },
    })
    expect(memberRes.suggestedTags).toBeUndefined()
    expect(memberRes.bottomSnapshot).toBeTruthy()

    // Delayed reCAPTCHA after login wall appears still triggers blocked_captcha.
    let expanded = false
    let polls = 0
    const { page: capPage } = createDomDrivenMockPage({
      [memberOnlyUrl]: {
        title: 'Board 2026 Cap',
        html: `
          <html><head><title>Board 2026 Cap</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
            <div data-hook="comment-box comment-box-top">
              <button data-hook="comment-box-placeholder">Write a comment...</button>
            </div>
          </body></html>
        `,
        onAction: (kind, selector) => {
          if (kind === 'click' && selector.includes('comment-box-placeholder')) {
            expanded = true
            return {
              mutateHtml: `
                <html><head><title>Board 2026 Cap</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                  <div data-hook="comment-box comment-box-top">
                    <span>Log in to publish as a member</span>
                    <button data-hook="login-as-member-text-button">Log in</button>
                  </div>
                </body></html>
              `,
            }
          }
        },
        onInspect: () => {
          if (!expanded) return
          polls++
          if (polls >= 2) {
            return `
              <html><head><title>Board 2026 Cap</title><script src="https://static.wixstatic.com/app.js"></script></head><body>
                <div data-hook="comment-box comment-box-top">
                  <span>Log in to publish as a member</span>
                  <div class="g-recaptcha"></div>
                </div>
              </body></html>
            `
          }
        },
      },
    })
    const capRes = await executeCommentPublish(
      capPage as never,
      'p-wix-cap-late',
      { kind: 'comment_publish', url: memberOnlyUrl, commentText: 'Great post' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(capRes).toMatchObject({
      outcome: 'blocked_captcha',
      siteType: 'wix',
      templateSignature: 'wix:signup_recaptcha',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
  })

  it('enforces anti-false-no_form guardrails on Wix placeholders, unexpanded triggers, blog list pages, and complex post layouts', async () => {
    const cases = [
      {
        name: 'persistent lazy placeholder',
        url: 'https://a.wixsite.com/blog/post/slow-post',
        html: `<html><head><title>Slow Post</title><script src="https://static.wixstatic.com/a.js"></script></head><body><div id="SITE_CONTAINER"><article data-hook="post"><div data-hook="comments-section-placeholder"></div><div data-hook="skeleton-loader"></div></article></div></body></html>`,
      },
      {
        name: 'unrecognized trigger expansion',
        url: 'https://b.wixsite.com/blog/post/custom-box',
        html: `<html><head><title>Custom Box</title><script src="https://static.wixstatic.com/a.js"></script></head><body><div data-hook="comment-box comment-box-top"><button data-hook="comment-box-placeholder">Write a comment...</button></div></body></html>`,
      },
      {
        name: 'wix blog list index page',
        url: 'https://www.nhtcinc.example.org/news-and-events',
        html: `<html><head><title>News and Events</title><script src="https://static.wixstatic.com/a.js"></script></head><body><div id="SITE_CONTAINER"><main><div data-hook="skeleton-loader"></div><div data-hook="post-footer"><a href="/post/update-1">Update 1</a><button data-hook="more-button">More</button></div><div data-hook="post-footer"><a href="/post/update-2">Update 2</a><button data-hook="more-button">More</button></div></main></div></body></html>`,
        expectedBottom: 'list=true',
      },
      {
        name: 'complex wix post layout without comment hooks',
        url: 'https://c.wixsite.com/blog/post/complex-layout',
        html: `<html><head><title>Complex Post</title><script src="https://static.parastorage.com/communities-blog-ooi/viewer.js"></script></head><body><div id="SITE_CONTAINER"><article data-hook="post"><h1 data-hook="post-title">Complex Post</h1><p>Content</p></article></div></body></html>`,
      },
    ]

    for (const c of cases) {
      const { page } = createDomDrivenMockPage({
        [c.url]: { title: c.name, html: c.html },
      })
      const res = await executeCommentPublish(
        page as never,
        `p-${c.name}`,
        { kind: 'comment_publish', url: c.url, commentText: 'Nice insight', probeOnly: true },
        { defaultTimeoutMs: 10_000, wixLazyWaitMaxMs: 800, wixExpandWaitMaxMs: 800, sleepImpl: async () => {} },
      )
      expect(res.outcome, c.name).toBe('needs_llm_fallback')
      expect(res.siteType, c.name).toBe('wix')
      expect(res.submitTriggered, c.name).toBe(false)
      expect(res.suggestedTags, c.name).toBeUndefined()
      expect(res.bottomSnapshot, c.name).toBeTruthy()
      if (c.expectedBottom) {
        expect(res.bottomSnapshot, c.name).toContain(c.expectedBottom)
      }
    }
  })

  it('inspects non-ad child frames while ignoring ad/video iframes, and serializes bottomSnapshot via MCP formatter', async () => {
    const embedUrl = 'https://embed.wixsite.com/blog/post/disqus-post'
    const { page: framePage } = createDomDrivenMockPage({
      [embedUrl]: {
        title: 'Disqus Wix Post',
        html: `<html><head><title>Disqus Wix Post</title><script src="https://static.wixstatic.com/a.js"></script></head><body><div id="SITE_CONTAINER"><article data-hook="post"><iframe src="https://disqus.com/embed/comments/"></iframe></article></div></body></html>`,
        frames: [
          { url: 'https://googleads.g.doubleclick.net/pagead/ads?client=ca-pub-123', html: '<body>Ad</body>' },
          { url: 'https://video.wixstatic.com/video/demo/360p/mp4/file.mp4', html: '<body></body>' },
          { url: 'https://disqus.com/embed/comments/?f=demo', html: '<body><textarea placeholder="Join the discussion"></textarea></body>' },
        ],
      },
    })

    const frameRes = await executeCommentPublish(
      framePage as never,
      'p-frame',
      { kind: 'comment_publish', url: embedUrl, commentText: 'Great breakdown' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(frameRes.outcome).toBe('needs_llm_fallback')
    expect(frameRes.siteType).toBe('wix')
    expect(frameRes.submitTriggered).toBe(false)
    expect(frameRes.suggestedTags).toBeUndefined()
    expect(frameRes.formSummary?.childFrames?.some(f => f.includes('disqus.com'))).toBe(true)
    expect(frameRes.formSummary?.childFrames?.some(f => f.includes('doubleclick'))).toBe(false)
    expect(frameRes.bottomSnapshot).toContain('[child-frames]')

    const formatted = formatMcpBrowserOutput(frameRes, 4_500)
    expect(formatted).toContain('"bottomSnapshot"')

    // Child iframe containing reCAPTCHA blocks cleanly.
    const capFrameUrl = 'https://capframe.example.org/post'
    const { page: capFramePage } = createDomDrivenMockPage({
      [capFrameUrl]: {
        title: 'Captcha Frame',
        html: `<html><head><title>Captcha Frame</title></head><body><main><p>Post</p></main></body></html>`,
        frames: [
          { url: 'https://widget.example.org/comment-box', html: '<body><div class="g-recaptcha"></div></body>' },
        ],
      },
    })
    const capFrameRes = await executeCommentPublish(
      capFramePage as never,
      'p-cap-frame',
      { kind: 'comment_publish', url: capFrameUrl, commentText: 'Hi' },
      { defaultTimeoutMs: 10_000, sleepImpl: async () => {} },
    )
    expect(capFrameRes).toMatchObject({
      outcome: 'blocked_captcha',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    })
  })
})

describe('Compact DOM snapshot compression', () => {
  it('compresses bloated blog ARIA snapshot by >40% while preserving bottom comment form', () => {
    const navLinks = Array.from({ length: 45 }, (_, i) => `    - link "Category ${i + 1}":\n      - /url: /cat/${i + 1}`).join('\n')
    const footerLinks = Array.from({ length: 30 }, (_, i) => `    - link "Footer Item ${i + 1}":\n      - /url: /footer/${i + 1}`).join('\n')
    const paragraphs = Array.from({ length: 24 }, (_, i) =>
      `  - paragraph: ${'Detailed engineering notes on SEO link indexing and crawl budgets '.repeat(4)} section ${i + 1}.`,
    ).join('\n')

    const rawAria = [
      '- banner:',
      '  - navigation "Main Menu":',
      '    - img',
      navLinks,
      '    - link "Sign in":',
      '      - /url: /login',
      '- main:',
      '  - heading "How Technical Blogs Rank" [level=1]',
      paragraphs,
      '  - region "Leave a Reply":',
      '    - form "Comment Form":',
      '      - textbox "Comment"',
      '      - textbox "Name"',
      '      - textbox "Email"',
      '      - textbox "Website"',
      '      - button "Post Comment"',
      '- contentinfo:',
      '  - navigation "Footer":',
      footerLinks,
    ].join('\n')

    expect(rawAria.length).toBeGreaterThan(9_000)

    const compacted = compactAriaSnapshot(rawAria, 4_500)
    expect(compacted.text.length).toBeLessThanOrEqual(4_500)
    // >40% reduction vs raw input.
    expect(compacted.text.length).toBeLessThan(rawAria.length * 0.6)
    expect(compacted.compactSummary).toContain('forms=1')
    expect(compacted.compactSummary).toContain('inputs=4')
    expect(compacted.compactSummary).toContain('buttons=1')
    // Preserved bottom comment form & nav Sign in, pruned decorative nav/footer links.
    expect(compacted.text).toContain('textbox "Comment"')
    expect(compacted.text).toContain('button "Post Comment"')
    expect(compacted.text).toContain('link "Sign in"')
    expect(compacted.text).not.toContain('Footer Item 25')
    expect(compacted.text).not.toContain('Category 30')
  })

  it('supports compact plain-text, compact eval text, compact interactive snapshot, and full=true unpruned fallback', async () => {
    const rawText = [
      'Home',
      'Home',
      ...Array.from({ length: 30 }, (_, i) => `Article line ${i + 1}: ${'filler '.repeat(25)}`),
      'Leave a Reply: Comment form below',
      'Button: Submit Comment',
    ].join('\n')
    const compactText = compactPlainText(rawText, 1_500)
    expect(compactText.truncated).toBe(true)
    expect(compactText.text).toContain('Leave a Reply: Comment form below')
    expect(compactText.text).toContain('Button: Submit Comment')
    expect(compactText.compactSummary).toContain('priority=2')

    const evalOut = formatCompactTextEvaluation({
      forms: 1,
      inputs: 3,
      buttons: 1,
      iframes: 0,
      alerts: ['Moderation enabled'],
      formLines: ['form[0]#commentform action=/wp-comments-post.php: textarea(comment), input:text(author)'],
      mainLines: ['How to deploy MCP servers cleanly'],
      rawChars: 8_400,
    }, 4_500)
    expect(evalOut.truncated).toBe(false)
    expect(evalOut.text).toContain('[alerts]')
    expect(evalOut.text).toContain('[forms]')
    expect(evalOut.compactSummary).toContain('forms=1 inputs=3 buttons=1')

    const report = parseControlReport({
      forms: 1,
      passwordFields: 0,
      emailFields: 1,
      emailLinks: 0,
      controls: [
        { tag: 'a', text: 'Pricing', href: '/pricing', css: '', selector: 'nav a:nth-of-type(1)', x: 10, y: 10, inViewport: true, inBoilerplate: true },
        { tag: 'a', text: 'About', href: '/about', css: '', selector: 'footer a:nth-of-type(1)', x: 20, y: 10, inViewport: false, inBoilerplate: true },
        { tag: 'a', text: 'Sign in with Google', href: '/oauth/google', imageAlt: 'Sign in with Google', selector: 'a.google', x: 50, y: 20, inViewport: true, inBoilerplate: true },
        { tag: 'button', text: 'Post Comment', selector: 'button#submit', x: 100, y: 300, inViewport: true, inBoilerplate: false },
      ],
    })
    const compactInteractive = renderPageControls('Blog', report, { compact: true })
    expect(compactInteractive).toContain('sign-in candidates: google ×1')
    expect(compactInteractive).toContain('Sign in with Google')
    expect(compactInteractive).toContain('Post Comment')
    expect(compactInteractive).toContain('2 boilerplate nav/footer link(s) pruned')
    expect(compactInteractive).not.toContain('Pricing')

    // PlaywrightSession snapshot uses compact when compact: true and unpruned when compact: false.
    const rawAria = '- navigation:\n  - link "Pricing"\n- form:\n  - button "Post Comment"'
    const mockPage = {
      isClosed: () => false,
      on: () => {},
      url: () => 'https://example.org',
      title: async () => 'Example',
      locator: () => ({ ariaSnapshot: async () => rawAria }),
      innerText: async () => 'Raw text',
    }
    const session = new PlaywrightSession({ pages: () => [mockPage], close: async () => {}, on: () => {} } as never, 10_000, 4_500)
    const compactSnap = await session.act({ kind: 'snapshot', format: 'aria', compact: true, maxChars: 4_500 })
    const fullSnap = await session.act({ kind: 'snapshot', format: 'aria', compact: false, maxChars: 16_000 })
    expect(compactSnap.kind === 'page' && compactSnap.compactSummary).toContain('pruned=')
    expect(compactSnap.kind === 'page' && compactSnap.text).not.toContain('Pricing')
    expect(compactSnap.kind === 'page' ? formatMcpBrowserOutput(compactSnap, 4_500) : '').toContain('[compact]')
    expect(fullSnap.kind === 'page' && fullSnap.compactSummary).toBeUndefined()
    expect(fullSnap.kind === 'page' && fullSnap.text).toContain('Pricing')
  })
})

describe('batch_preflight v2: siteHint, anti-waf_403 loop & autoFailWaf', () => {
  const smConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_secret',
  })

  it('detects all 5 siteHints accurately on 64KB HTML payloads', () => {
    expect(detectSiteHint(
      'https://wp.example.org/p1',
      new Headers(),
      '<html><form id="commentform" action="/wp-comments-post.php"><textarea name="comment"></textarea></form></html>',
    )).toBe('wordpress_comment')

    expect(detectSiteHint(
      'https://wix.example.org/post',
      new Headers({ 'x-wix-request-id': 'req-1' }),
      '<html><body>Blog post</body></html>',
    )).toBe('wix_blog')

    expect(detectSiteHint(
      'https://closed.example.org/p2',
      new Headers(),
      '<html><body><p>Comments are closed.</p></body></html>',
    )).toBe('comments_closed_hint')

    expect(detectSiteHint(
      'https://dir.example.org/list',
      new Headers(),
      '<html><body><form action="/submit-site" method="post"><input name="url"/></form></body></html>',
    )).toBe('directory_or_form')

    expect(detectSiteHint(
      'https://plain.example.org/',
      new Headers(),
      '<html><body><form role="search"><input name="q"/></form><p>Welcome</p></body></html>',
    )).toBe('other')
  })

  it('returns runnableItems with siteHint, skips pre-tagged waf_403 zero-HTTP, and marks autoFailWaf items failed(manual_required)', async () => {
    const detail: BacklinkBatchDetail = {
      batch: {
        id: 201,
        name: 'Batch 201',
        websiteId: 7,
        websiteName: 'Demo',
        websiteHost: 'demo.example.com',
        plannedAt: '2026-11-23T00:00:00Z',
        counts: { pending: 5, executed: 0, skipped: 0, failed: 0, total: 5 },
        executing: false,
      },
      website: { id: 7, name: 'Demo', siteUrl: 'https://demo.example.com', siteHost: 'demo.example.com' },
      anchors: [{ id: 1, anchorText: 'Demo', targetUrl: 'https://demo.example.com' }],
      items: [
        { id: 1, sourceId: 901, sourceName: 'WP', sourceUrl: 'https://wp.example.org', sourceHost: 'wp.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-23T00:00:00Z' },
        { id: 2, sourceId: 902, sourceName: 'Wix', sourceUrl: 'https://wix.example.org', sourceHost: 'wix.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-23T00:00:00Z' },
        { id: 3, sourceId: 903, sourceName: 'NewWaf', sourceUrl: 'https://newwaf.example.org', sourceHost: 'newwaf.example.org', submitUrl: null, sourceNotes: null, category: '导航站', tags: [], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-23T00:00:00Z' },
        { id: 4, sourceId: 904, sourceName: 'OldWaf', sourceUrl: 'https://prosebox.example.net', sourceHost: 'prosebox.example.net', submitUrl: null, sourceNotes: null, category: '导航站', tags: ['waf_403'], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-23T00:00:00Z' },
        { id: 5, sourceId: 905, sourceName: 'Cap', sourceUrl: 'https://cap.example.org', sourceHost: 'cap.example.org', submitUrl: null, sourceNotes: null, category: '博客', tags: ['has_captcha'], paymentType: 'free', linkType: 'dofollow', status: 'pending', failureMode: null, failureReason: null, publishedUrl: null, publishStatus: null, plannedAt: '2026-11-23T00:00:00Z' },
      ],
    }

    const fetched: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('wp.example.org')) {
        return new Response('<form id="commentform"><textarea name="comment"></textarea></form>', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.includes('wix.example.org')) {
        return new Response('<script src="https://static.wixstatic.com/a.js"></script>', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.includes('newwaf.example.org')) {
        return new Response('CloudFront blocked', { status: 403, headers: { 'x-amz-cf-id': 'cf1' } })
      }
      return new Response('<p>Hello</p>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch

    const reportedResults: Array<{ itemId: number; status: string; failureMode?: string }> = []
    const taggedCalls: Array<{ sourceId: number; names: readonly string[] }> = []
    const claimedIds: number[][] = []
    const releasedLeases: number[] = []

    const batchSource: BacklinkBatchSourceProvider = {
      id: 'mock',
      available: () => true,
      listBatches: async () => [detail.batch],
      getBatch: async () => detail,
      claim: async (_b, itemIds) => {
        const ids = [...(itemIds ?? [])]
        claimedIds.push(ids)
        return { leaseId: 505, leaseExpiresAt: '2026-11-23T01:00:00Z', items: detail.items.filter(i => ids.includes(i.id)) }
      },
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-23T02:00:00Z' }),
      release: async (leaseId) => { releasedLeases.push(leaseId) },
      reportItemResult: async (itemId, result) => {
        if (claimedIds.length === 0) {
          throw new BacklinksError('item must be claimed under an active lease', 'BACKLINKS_CONFLICT')
        }
        reportedResults.push({
          itemId,
          status: result.status,
          ...(result.status === 'failed' ? { failureMode: result.failureMode } : {}),
        })
        return { itemStatus: 'failed', publishRecordId: null }
      },
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId, names) => {
        taggedCalls.push({ sourceId, names })
        return { sourceId, attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })) }
      },
    }

    const handle = createBacklinksToolHandler({
      config: smConfig,
      batchSource,
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    })

    const res = await handle({
      action: 'batch_preflight',
      batchId: 201,
      autoFailWaf: true,
    })
    expect(res.isError).toBeUndefined()
    // Pre-tagged waf_403 (id 4) was NOT fetched via HTTP.
    expect(fetched.some(u => u.includes('prosebox'))).toBe(false)
    // Both new waf_403 (id 3) and pre-tagged waf_403 (id 4) were failed via ephemeral lease.
    expect(claimedIds).toEqual([[3, 4]])
    expect(releasedLeases).toEqual([505])
    expect(reportedResults).toEqual([
      { itemId: 3, status: 'failed', failureMode: 'manual_required' },
      { itemId: 4, status: 'failed', failureMode: 'manual_required' },
    ])
    // Only newly discovered waf_403 source (903) receives tagSource.
    expect(taggedCalls).toEqual([{ sourceId: 903, names: ['waf_403'] }])

    const data = parseToolPayload(res as never).data as {
      runnableItemIds: number[]
      runnableItems: Array<{ itemId: number; domain: string; siteHint: string }>
      heldForManual: Array<{ id: number; reason: string }>
      autoFailWafResult: { failedItemIds: number[]; taggedSourceIds: number[] }
    }
    expect(data.runnableItemIds).toEqual([1, 2, 5])
    expect(data.runnableItems).toEqual([
      { itemId: 1, domain: 'wp.example.org', siteHint: 'wordpress_comment' },
      { itemId: 2, domain: 'wix.example.org', siteHint: 'wix_blog' },
      { itemId: 5, domain: 'cap.example.org', siteHint: 'other' },
    ])
    expect(data.heldForManual).toEqual([
      { id: 4, sourceId: 904, host: 'prosebox.example.net', matchedTags: ['waf_403'], reason: 'already_tagged_waf_403' },
    ])
    expect(data.autoFailWafResult).toEqual({ failedItemIds: [3, 4], taggedSourceIds: [903] })

    // skipSoftTagged: true also holds out has_captcha (item 5) zero-HTTP.
    fetched.length = 0
    const strictSoftRes = await handle({
      action: 'batch_preflight',
      batchId: 201,
      skipSoftTagged: true,
    })
    const strictSoftData = parseToolPayload(strictSoftRes as never).data as {
      runnableItemIds: number[]
      heldForManual: Array<{ id: number; reason: string }>
    }
    expect(strictSoftData.runnableItemIds).toEqual([1, 2])
    expect(strictSoftData.heldForManual.map(i => [i.id, i.reason])).toEqual([
      [4, 'already_tagged_waf_403'],
      [5, 'already_tagged_soft_block'],
    ])
    expect(fetched.some(u => u.includes('cap.example.org'))).toBe(false)
  })
})

describe('Supermanager source_tags compatibility: comments_closed -> 评论关闭 & 5xx degradation', () => {
  const smConfig = resolveMcpConfig({
    SUPERMANAGER_BASE_URL: 'https://sm.example.com',
    SUPERMANAGER_TOKEN: 'smag_secret',
  })

  it('maps comments_closed to 评论关闭 on outbound Supermanager wire while normalizing both in preflight', async () => {
    expect(normalizeBlockingTag('comments_closed')).toBe('comments_closed')
    expect(normalizeBlockingTag('评论关闭')).toBe('comments_closed')
    expect(mapTagsForSupermanagerWire(['comments_closed', '免徽章', 'comments_closed'])).toEqual(['评论关闭', '免徽章'])
    expect(mapTagsToSafeChineseFallback(['no_form', 'has_captcha', 'comments_closed'])).toEqual([
      '无表单',
      '验证码',
      '评论关闭',
    ])
    expect(isSupermanager5xxError(new BacklinksError('supermanager /api/agent/sources/1/tags failed (HTTP 500): Internal', 'BACKLINKS_API_ERROR'))).toBe(true)
    expect(isSupermanager5xxError(new BacklinksError('supermanager denied /api/agent/sources/1/tags (401): bad token', 'BACKLINKS_UNAUTHORIZED'))).toBe(false)

    const sentTagPayloads: string[][] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as { tags?: string[]; items?: Array<{ tags?: string[] }> }
      if (url.includes('/tags')) {
        sentTagPayloads.push(body.tags ?? [])
        return new Response(JSON.stringify({ sourceId: 10, attached: [{ id: 1, name: '评论关闭', created: false }] }), { status: 200 })
      }
      if (url.includes('/preflight-skip')) {
        sentTagPayloads.push(body.items?.[0]?.tags ?? [])
        return new Response(JSON.stringify({ ok: true, batchId: 1, skippedCount: 1, unchangedCount: 0, results: [] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    try {
      const sm = new SupermanagerBatchSource(() => ({
        baseUrl: 'https://sm.example.com',
        token: 'smag_secret',
        requestTimeoutMs: 5_000,
      }))
      await sm.tagSource(10, ['comments_closed', '免徽章'])
      await sm.preflightSkip(1, [{ itemId: 99, skipReason: 'closed', tags: ['comments_closed'] }])
      expect(sentTagPayloads).toEqual([
        ['评论关闭', '免徽章'],
        ['评论关闭'],
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries with safe Chinese tag aliases on HTTP 500 and degrades non-fatally when 5xx persists', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[][] = []
    let failAll = false

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { tags: string[] }
      calls.push(payload.tags)
      if (failAll || payload.tags.includes('no_form')) {
        return new Response('Internal Server Error', { status: 500 })
      }
      return new Response(JSON.stringify({
        sourceId: 22,
        attached: payload.tags.map((name, idx) => ({ id: idx + 1, name, created: true })),
      }), { status: 200 })
    }) as unknown as typeof fetch

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const sm = new SupermanagerBatchSource(() => ({
        baseUrl: 'https://sm.example.com',
        token: 'smag_secret',
        requestTimeoutMs: 5_000,
      }))

      // 1. Fails on ['no_form', 'has_captcha'] -> falls back to ['无表单', '验证码'] and succeeds.
      const recovered = await sm.tagSource(22, ['no_form', 'has_captcha'])
      expect(calls).toEqual([
        ['no_form', 'has_captcha'],
        ['无表单', '验证码'],
      ])
      expect(recovered.fallbackUsed).toBe(true)
      expect(recovered.attached.map(a => a.name)).toEqual(['无表单', '验证码'])

      // 2. Persistent 500 degrades non-fatally without throwing and logs warning to stderr.
      failAll = true
      const handle = createBacklinksToolHandler({ config: smConfig, batchSource: sm })
      const tagRes = await handle({ action: 'source_tags', sourceId: 22, tags: ['no_form'] })
      expect(tagRes.isError).toBeUndefined()
      const tagPayload = parseToolPayload(tagRes as never)
      expect(tagPayload.summary).toContain('warning: source_tags degraded non-fatally')
      expect(tagPayload.data).toMatchObject({
        sourceId: 22,
        attached: [],
        degraded: true,
      })
      expect(stderrSpy).toHaveBeenCalled()
    } finally {
      stderrSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })

  it('still throws/errors on non-5xx failures (401/403/400) while keeping custom mock 5xx non-fatal in MCP handler', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const handle = createBacklinksToolHandler({
        config: smConfig,
        batchSource: {
          id: 'mock',
          available: () => true,
          listBatches: async () => [],
          getBatch: async () => { throw new Error('unused') },
          claim: async () => { throw new Error('unused') },
          heartbeat: async () => { throw new Error('unused') },
          release: async () => {},
          reportItemResult: async () => ({ itemStatus: 'failed', publishRecordId: null }),
          addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
          tagSource: async (_sourceId, names) => {
            if (names.includes('unauthorized')) {
              throw new BacklinksError('supermanager denied /api/agent/sources/1/tags (401): bad token', 'BACKLINKS_UNAUTHORIZED')
            }
            throw new BacklinksError('supermanager /api/agent/sources/1/tags failed (HTTP 502): bad gateway', 'BACKLINKS_API_ERROR')
          },
        },
      })

      const res401 = await handle({ action: 'source_tags', sourceId: 1, tags: ['unauthorized'] })
      expect(res401.isError).toBe(true)

      const res502 = await handle({ action: 'source_tags', sourceId: 1, tags: ['paid_only'] })
      expect(res502.isError).toBeUndefined()
      expect(parseToolPayload(res502 as never).data).toMatchObject({ degraded: true })
    } finally {
      stderrSpy.mockRestore()
    }
  })
})
