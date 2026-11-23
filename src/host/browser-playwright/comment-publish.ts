/**
 * Deterministic Playwright fast-path for standard WordPress and Wix blog comment
 * publishing (`browser action="comment_publish"`).
 *
 * Strictly enforces:
 * - Zero CAPTCHA bypass: detects reCAPTCHA/hCaptcha/Turnstile/SecureImg/math
 *   captchas and returns `blocked_captcha` (`submitTriggered: false`).
 * - Idempotency: once a submit action is triggered (`submitTriggered: true`),
 *   any post-submit uncertainty returns `uncertain_after_submit` and never retries.
 * - Rich-editor safety: never types raw `<a>` markup into `contenteditable` editors.
 */

import type { Page } from 'playwright-core'
import type {
  BrowserCommentPublishCommand,
  BrowserCommentPublishResult,
  CommentPublishFormSummary,
  CommentPublishSiteType,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import type { SleepLike } from '../../mcp/backlinks-tool.ts'

export const DEFAULT_LAZY_WAIT_MAX_MS = 2_500
const LAZY_POLL_INTERVAL_MS = 350

export interface WordPressInspection {
  readonly found: boolean
  readonly formSelector?: string
  readonly commentSelector?: string
  readonly authorSelector?: string
  readonly authorRequired?: boolean
  readonly emailSelector?: string
  readonly emailRequired?: boolean
  readonly urlSelector?: string
  readonly submitSelector?: string
  readonly captcha?: {
    readonly detected: boolean
    readonly kind?: string
    readonly templateSignature?: string
  }
}

export interface WixInspection {
  readonly hasCommentSection: boolean
  readonly loginRequired: boolean
  readonly captchaDetected: boolean
  readonly hasGuestEditor: boolean
  readonly editorSelector?: string
  readonly editorIsContentEditable?: boolean
  readonly triggerSelector?: string
  readonly nameSelector?: string
  readonly emailSelector?: string
  readonly websiteSelector?: string
  readonly submitSelector?: string
  readonly linkButtonSelector?: string
}

export interface CommentPageInspection {
  readonly title: string
  readonly finalUrl: string
  readonly isWix: boolean
  readonly isWordPress: boolean
  readonly commentsClosed: {
    readonly matched: boolean
    readonly phrase?: string
  }
  readonly wordpress: WordPressInspection
  readonly wix: WixInspection
  readonly formSummary: CommentPublishFormSummary
}

export interface CommentVerifyOutcome {
  readonly liveLinkFound: boolean
  readonly matchedHref?: string
  readonly matchedAnchor?: string
  readonly escapedHtmlDetected: boolean
  readonly moderationNotice?: string
  readonly wpErrorMessage?: string
}

/** Strip unapproved/moderation query parameters before public reload verification. */
export function stripWpModerationParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.searchParams.delete('unapproved')
    parsed.searchParams.delete('moderation-hash')
    return parsed.toString()
  } catch {
    return rawUrl
  }
}

/** Build WordPress comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
export function buildWpCommentContent(
  commentText: string,
  websiteUrl: string | undefined,
  anchorText: string | undefined,
  hasUrlField: boolean,
): string {
  const cleanComment = commentText.trim()
  const cleanUrl = websiteUrl?.trim()
  if (hasUrlField || !cleanUrl) {
    return cleanComment
  }
  if (/<a\b[^>]*href\s*=/iu.test(cleanComment)) {
    return cleanComment
  }
  const cleanAnchor = anchorText?.trim()
  if (cleanAnchor && cleanAnchor.length > 0) {
    const idx = cleanComment.toLowerCase().indexOf(cleanAnchor.toLowerCase())
    if (idx >= 0) {
      const matched = cleanComment.slice(idx, idx + cleanAnchor.length)
      return `${cleanComment.slice(0, idx)}<a href="${cleanUrl}">${matched}</a>${cleanComment.slice(idx + cleanAnchor.length)}`
    }
    return `${cleanComment} <a href="${cleanUrl}">${cleanAnchor}</a>`
  }
  return `${cleanComment} <a href="${cleanUrl}">${cleanUrl}</a>`
}

/** Strip raw `<a>` markup before typing into a `contenteditable` rich editor. */
export function stripHtmlLinkForRichEditor(
  commentText: string,
  anchorText?: string,
  websiteUrl?: string,
): { readonly plainText: string; readonly anchorText?: string; readonly websiteUrl?: string } {
  const linkMatch = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(commentText)
  const extractedHref = linkMatch?.[1]?.trim()
  const extractedAnchor = linkMatch?.[2]?.replace(/<[^>]+>/gu, '').trim()
  const plainText = commentText
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/giu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
  const finalAnchor = anchorText?.trim() || extractedAnchor || undefined
  const finalUrl = websiteUrl?.trim() || extractedHref || undefined
  return {
    plainText,
    ...(finalAnchor === undefined ? {} : { anchorText: finalAnchor }),
    ...(finalUrl === undefined ? {} : { websiteUrl: finalUrl }),
  }
}

/**
 * Self-contained browser evaluation script inspecting WordPress, Wix,
 * comments-closed banners, CAPTCHAs, and minimal fallback form metadata.
 */
export const INSPECT_COMMENT_PAGE_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    const hiddenAncestor = el.closest('[hidden], [aria-hidden="true"]');
    if (hiddenAncestor) return false;
    return true;
  };

  const uniqueInScope = (el, selector, root = document) => {
    if (!selector) return false;
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  };

  const selectorFor = (el, scopeEl) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (uniqueInScope(el, byId)) return byId;
    }
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      const byName = el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(el, byName)) return byName;
    }
    const hookAttr = el.getAttribute('data-hook');
    if (hookAttr) {
      const byHook = '[data-hook="' + hookAttr.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(el, byHook)) return byHook;
    }
    const testIdAttr = el.getAttribute('data-testid');
    if (testIdAttr) {
      const byTestId = '[data-testid="' + testIdAttr.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(el, byTestId)) return byTestId;
    }
    if (scopeEl) {
      const scopeSel = scopeEl.id ? '#' + escapeCss(scopeEl.id) : scopeEl.localName;
      if (scopeSel && nameAttr) {
        const scopedName = scopeSel + ' ' + el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedName)) return scopedName;
      }
      if (scopeSel && el.type) {
        const scopedType = scopeSel + ' ' + el.localName + '[type="' + String(el.type).replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedType)) return scopedType;
      }
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 5; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (uniqueInScope(el, path)) return path;
    }
    return '';
  };

  const docHtmlPrefix = (document.documentElement ? document.documentElement.innerHTML : '').slice(0, 65536);
  const isWix = !!(
    document.querySelector('[data-hook*="comment"], [id*="SITE_CONTAINER"], meta[name="generator"][content*="Wix" i], script[src*="wixstatic.com"], script[src*="parastorage.com"]')
    || /wixstatic\.com|static\.parastorage\.com|_wixCIDX|wix-warmup-data/i.test(docHtmlPrefix)
  );
  const isWordPress = !!(
    document.querySelector('form#commentform, form[action*="wp-comments-post.php"], meta[name="generator"][content*="WordPress" i], link[href*="wp-content"]')
    || /wp-comments-post\.php|wp-content/i.test(docHtmlPrefix)
  );

  // Detect explicit comments-closed banners outside script/style tags.
  const closedRegex = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+closed\b|\bcomments\s+(?:have\s+been\s+)?disabled\b|评论已关闭|评论功能已关闭|已关闭评论/i;
  let closedPhrase = '';
  const closedContainers = Array.from(document.querySelectorAll('#comments, .comments-area, #respond, .nocomments, [data-hook*="comment"], main, article'));
  const closedTargets = closedContainers.length > 0 ? closedContainers : (document.body ? [document.body] : []);
  for (const container of closedTargets) {
    if (!isVisible(container)) continue;
    const text = clean(container.innerText || container.textContent);
    const match = closedRegex.exec(text);
    if (match) {
      closedPhrase = match[0];
      break;
    }
  }
  if (!closedPhrase && document.body) {
    const clone = document.body.cloneNode(true);
    for (const s of clone.querySelectorAll('script,style,noscript')) s.remove();
    const match = closedRegex.exec(clean(clone.textContent));
    if (match) closedPhrase = match[0];
  }

  // WordPress comment form detection.
  const wpCommentTextarea = Array.from(document.querySelectorAll('textarea[name="comment"], textarea#comment')).find(isVisible);
  const wpFormCandidate = document.querySelector('form#commentform, form[action*="wp-comments-post.php"]')
    || (wpCommentTextarea ? wpCommentTextarea.closest('form') : null);

  let wordpress = { found: false };
  if (wpFormCandidate && isVisible(wpFormCandidate)) {
    const commentEl = wpFormCandidate.querySelector('textarea[name="comment"], textarea#comment, textarea:not([name*="ak_"])');
    const authorEl = wpFormCandidate.querySelector('input[name="author"], input#author');
    const emailEl = wpFormCandidate.querySelector('input[name="email"], input#email, input[type="email"]');
    const urlEl = wpFormCandidate.querySelector('input[name="url"], input#url, input[type="url"], input[name*="website" i]');
    const submitEl = wpFormCandidate.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])');

    const respondRoot = wpFormCandidate.closest('#respond, #comments') || wpFormCandidate;
    const formHtml = wpFormCandidate.outerHTML || '';
    const formText = clean(respondRoot.innerText || respondRoot.textContent);

    let captcha = { detected: false };
    if (respondRoot.querySelector('.g-recaptcha, iframe[src*="recaptcha"], [data-sitekey], textarea[name="g-recaptcha-response"], input[name*="recaptcha" i]')) {
      captcha = { detected: true, kind: 'recaptcha', templateSignature: 'wordpress:recaptcha_captcha' };
    } else if (respondRoot.querySelector('.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]')) {
      captcha = { detected: true, kind: 'hcaptcha', templateSignature: 'wordpress:hcaptcha_captcha' };
    } else if (respondRoot.querySelector('.cf-turnstile, iframe[src*="turnstile"], input[name="cf-turnstile-response"]')) {
      captcha = { detected: true, kind: 'turnstile', templateSignature: 'wordpress:turnstile_captcha' };
    } else if (respondRoot.querySelector('img[src*="secureimg" i], input[name*="si_code" i]') || /secureimg/i.test(formHtml)) {
      captcha = { detected: true, kind: 'secureimg', templateSignature: 'blog:secureimg_captcha' };
    } else if (respondRoot.querySelector('img[src*="captcha" i], input[name*="captcha" i], input[id*="captcha" i], input[class*="captcha" i]')) {
      captcha = { detected: true, kind: 'image_captcha', templateSignature: 'wordpress:image_captcha' };
    } else if (/\b\d+\s*[+\-×x*÷]\s*\d+\s*=\s*\??/u.test(formText) || (/math\s*captcha|算术|anti-?spam/i.test(formText) && wpFormCandidate.querySelector('input[name*="quiz" i], input[name*="math" i], input[name*="sum" i]'))) {
      captcha = { detected: true, kind: 'math_captcha', templateSignature: 'wordpress:math_captcha' };
    }

    if (commentEl && isVisible(commentEl)) {
      wordpress = {
        found: true,
        formSelector: selectorFor(wpFormCandidate) || 'form#commentform',
        commentSelector: selectorFor(commentEl, wpFormCandidate),
        ...(authorEl && isVisible(authorEl) ? {
          authorSelector: selectorFor(authorEl, wpFormCandidate),
          authorRequired: !!(authorEl.required || authorEl.getAttribute('aria-required') === 'true'),
        } : {}),
        ...(emailEl && isVisible(emailEl) ? {
          emailSelector: selectorFor(emailEl, wpFormCandidate),
          emailRequired: !!(emailEl.required || emailEl.getAttribute('aria-required') === 'true'),
        } : {}),
        ...(urlEl && isVisible(urlEl) ? {
          urlSelector: selectorFor(urlEl, wpFormCandidate),
        } : {}),
        ...(submitEl && isVisible(submitEl) ? {
          submitSelector: selectorFor(submitEl, wpFormCandidate),
        } : {}),
        ...(captcha.detected ? { captcha } : {}),
      };
    }
  }

  // Wix blog comment detection.
  const wixCommentRoots = Array.from(document.querySelectorAll('[data-hook*="comment"], [data-testid*="comment"], #comments')).filter(isVisible);
  const wixHasCommentSection = isWix && wixCommentRoots.length > 0;
  const wixLoginRegex = /\b(?:log\s*in|sign\s*in)\s+to\s+(?:comment|publish|reply|post)\b|\b(?:log\s*in|sign\s*in)\s+to\s+publish\s+as\s+a\s+member\b|\bsign\s*up\s+to\s+comment\b|登录.*(?:评论|发表)/i;
  const wixContainerText = wixCommentRoots.map(r => clean(r.innerText || r.textContent)).join(' ');
  const pageVisibleCaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile');
  const wixLoginButton = Array.from(document.querySelectorAll('[data-hook*="login"], [data-testid*="signUp"], [data-testid*="login"], button, a'))
    .find(el => isVisible(el) && wixLoginRegex.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));
  const wixLoginRequired = isWix && (wixLoginRegex.test(wixContainerText) || !!wixLoginButton);

  let wix = {
    hasCommentSection: wixHasCommentSection,
    loginRequired: wixLoginRequired,
    captchaDetected: isWix && pageVisibleCaptcha,
    hasGuestEditor: false,
  };

  if (isWix && !wixLoginRequired) {
    const editorEl = Array.from(document.querySelectorAll(
      '[data-hook="comment-box"] [contenteditable="true"], [data-hook="create-comment-input"], [data-hook*="comment"] [contenteditable="true"], [data-hook*="comment"] textarea, [placeholder*="Write a comment" i], [aria-label*="Write a comment" i]',
    )).find(el => isVisible(el) && (el.getAttribute('contenteditable') === 'true' || el.localName === 'textarea'));

    const triggerEl = Array.from(document.querySelectorAll(
      '[data-hook="comment-box-placeholder"], [data-hook="open-comment-box"], [data-hook*="comment"] button, [data-hook*="comment"] [role="button"], [placeholder*="Write a comment" i]',
    )).find(el => isVisible(el) && el !== editorEl && /write a comment|leave a comment|add a comment|写评论/i.test(clean(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label'))));

    if (editorEl) {
      const boxScope = (editorEl.parentElement ? editorEl.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], form') : null) || document;
      const outerScope = (boxScope.parentElement ? boxScope.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], section') : null) || document;
      const nameEl = Array.from(boxScope.querySelectorAll('input[type="text"], input:not([type])')).find(el => isVisible(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''))));
      const emailEl = Array.from(boxScope.querySelectorAll('input[type="email"], input[name*="email" i]')).find(isVisible);
      const websiteEl = Array.from(boxScope.querySelectorAll('input[type="url"], input[name*="website" i], input[name*="url" i], input[placeholder*="website" i]')).find(isVisible);
      const findLinkBtn = (scope) => Array.from(scope.querySelectorAll('button, [role="button"]')).find(el => isVisible(el) && /\blink\b|插入链接|链接/i.test(clean((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-hook') || '') + ' ' + (el.getAttribute('data-testid') || ''))));
      const findSubmitBtn = (scope) => Array.from(scope.querySelectorAll('[data-hook="submit-comment-button"], [data-hook="publish-comment-button"], button[type="submit"], button')).find(el => {
        if (!isVisible(el)) return false;
        const hook = clean(el.getAttribute('data-hook'));
        if (hook === 'submit-comment-button' || hook === 'publish-comment-button') return true;
        return /^(?:publish|post|submit|comment|reply|发布|提交)$/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
      });
      const linkBtn = findLinkBtn(boxScope) || findLinkBtn(outerScope);
      const submitEl = findSubmitBtn(boxScope) || findSubmitBtn(outerScope);

      wix = {
        hasCommentSection: true,
        loginRequired: false,
        captchaDetected: pageVisibleCaptcha,
        hasGuestEditor: true,
        editorSelector: selectorFor(editorEl),
        editorIsContentEditable: editorEl.getAttribute('contenteditable') === 'true',
        ...(nameEl ? { nameSelector: selectorFor(nameEl) } : {}),
        ...(emailEl ? { emailSelector: selectorFor(emailEl) } : {}),
        ...(websiteEl ? { websiteSelector: selectorFor(websiteEl) } : {}),
        ...(linkBtn ? { linkButtonSelector: selectorFor(linkBtn) } : {}),
        ...(submitEl ? { submitSelector: selectorFor(submitEl) } : {}),
      };
    } else if (triggerEl) {
      wix = {
        hasCommentSection: true,
        loginRequired: false,
        captchaDetected: pageVisibleCaptcha,
        hasGuestEditor: false,
        triggerSelector: selectorFor(triggerEl),
      };
    }
  }

  // Minimal fallback form summary for LLM handoff when needs_llm_fallback triggers.
  const allForms = Array.from(document.querySelectorAll('form')).filter(isVisible);
  const allTextareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(isVisible);
  const allIframes = Array.from(document.querySelectorAll('iframe')).filter(isVisible);
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
    .filter(isVisible)
    .slice(0, 12)
    .map(el => {
      const lbl = clean(el.getAttribute('name') || el.id || el.getAttribute('placeholder') || el.getAttribute('aria-label'));
      const typ = el.localName === 'input' ? ':' + (el.type || 'text') : '';
      return lbl ? el.localName + typ + '(' + lbl.slice(0, 32) + ')' : el.localName + typ;
    });
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
    .filter(isVisible)
    .map(el => clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label')))
    .filter(Boolean)
    .slice(0, 8);
  const bodySnippet = clean(document.body ? (document.body.innerText || document.body.textContent) : '').slice(0, 260);

  return {
    title: clean(document.title),
    finalUrl: location.href,
    isWix,
    isWordPress,
    commentsClosed: {
      matched: closedPhrase.length > 0,
      ...(closedPhrase ? { phrase: closedPhrase } : {}),
    },
    wordpress,
    wix,
    formSummary: {
      forms: allForms.length,
      textareas: allTextareas.length,
      inputs,
      buttons,
      iframes: allIframes.length,
      hasLoginWall: wixLoginRequired || !!document.querySelector('input[type="password"]'),
      ...(bodySnippet ? { snippet: bodySnippet } : {}),
    },
  };
})()`

interface BrowserDomNodeLike {
  readonly textContent: string | null
}

interface BrowserDomElementLike extends BrowserDomNodeLike {
  readonly innerText?: string
  getAttribute(name: string): string | null
  closest(selector: string): BrowserDomElementLike | null
  querySelectorAll(selector: string): Iterable<BrowserDomElementLike>
  scrollIntoView?(options?: { behavior?: string; block?: string }): void
}

interface BrowserDomRangeLike {
  setStart(node: BrowserDomNodeLike, offset: number): void
  setEnd(node: BrowserDomNodeLike, offset: number): void
}

interface BrowserDomGlobalLike {
  readonly document: {
    readonly body: BrowserDomElementLike | null
    querySelector(selector: string): BrowserDomElementLike | null
    querySelectorAll(selector: string): Iterable<BrowserDomElementLike>
    createTreeWalker(root: BrowserDomNodeLike, whatToShow: number): { nextNode(): BrowserDomNodeLike | null }
    createRange(): BrowserDomRangeLike
  }
  readonly location: { readonly href: string }
  readonly window: {
    scrollTo?(x: number, y: number): void
    getSelection?(): { removeAllRanges(): void; addRange(range: BrowserDomRangeLike): void } | null
  }
  readonly NodeFilter?: { readonly SHOW_TEXT: number }
}

/**
 * Self-contained browser evaluation function checking post-submit / post-reload
 * live clickable links, escaped HTML `<a>` text, moderation notices, and WP errors.
 */
export function verifyCommentResultInDom(params: {
  readonly websiteUrl?: string
  readonly anchorText?: string
  readonly commentText?: string
  readonly authorName?: string
}): CommentVerifyOutcome {
  const dom = globalThis as unknown as BrowserDomGlobalLike
  const clean = (v: unknown): string => String(v ?? '').replace(/\s+/gu, ' ').trim()
  const normalizeUrl = (raw: string): string => {
    try {
      const parsed = new URL(raw, dom.location.href)
      const host = parsed.hostname.toLowerCase().replace(/^www\./u, '')
      const path = parsed.pathname.replace(/\/+$/u, '')
      return `${host}${path}`
    } catch {
      return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/u, '').replace(/\/+$/u, '')
    }
  }

  let targetHost = ''
  const normalizedTarget = params.websiteUrl ? normalizeUrl(params.websiteUrl) : ''
  if (params.websiteUrl) {
    try {
      targetHost = new URL(params.websiteUrl).hostname.toLowerCase().replace(/^www\./u, '')
    } catch {
      targetHost = ''
    }
  }
  const cleanAnchor = clean(params.anchorText).toLowerCase()

  const errEl = dom.document.querySelector('.wp-die-message, #error-page')
  const errText = clean(errEl ? (errEl.innerText || errEl.textContent) : '')
  const bodyText = clean(dom.document.body ? (dom.document.body.innerText || dom.document.body.textContent) : '')
  const wpErrorMatch = /duplicate\s+comment\s+detected|comment\s+submission\s+failure|sorry,\s+you\s+must\s+be\s+logged\s+in/iu.exec(errText || bodyText)
  const wpErrorMessage = errText || (wpErrorMatch ? wpErrorMatch[0] : undefined)

  const modEl = dom.document.querySelector('.comment-awaiting-moderation')
  const modText = clean(modEl ? (modEl.innerText || modEl.textContent) : '')
  const modMatch = /your\s+comment\s+is\s+awaiting\s+moderation|awaiting\s+moderation|pending\s+approval|held\s+for\s+moderation|submitted\s+for\s+review|等待审核|待审核|审核通过后显示/iu.exec(modText || bodyText)
  const moderationNotice = modText || (modMatch ? modMatch[0] : undefined)

  // Check if visible text contains literal escaped `<a href=...>` pointing to our URL.
  const escapedPattern = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)/giu
  let escapedHtmlDetected = false
  let escMatch: RegExpExecArray | null
  while ((escMatch = escapedPattern.exec(bodyText)) !== null) {
    const rawEscHref = escMatch[1] ?? ''
    if (!normalizedTarget || normalizeUrl(rawEscHref).includes(normalizedTarget) || (targetHost && rawEscHref.toLowerCase().includes(targetHost))) {
      escapedHtmlDetected = true
      break
    }
  }

  // Strictly require a clickable `<a href>` link outside nav/header/footer (preferring comment containers).
  const scopeContainers = Array.from(dom.document.querySelectorAll('#comments, .comment-list, .comments-area, [data-hook*="comment"], main, article'))
  const candidateLinks: BrowserDomElementLike[] = []
  const seenLinks = new Set<BrowserDomElementLike>()
  const pushLinks = (root: { querySelectorAll(selector: string): Iterable<BrowserDomElementLike> }) => {
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (anchor.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')) continue
      if (!seenLinks.has(anchor)) {
        seenLinks.add(anchor)
        candidateLinks.push(anchor)
      }
    }
  }
  for (const container of scopeContainers) pushLinks(container)
  if (candidateLinks.length === 0) pushLinks(dom.document)

  let matchedHref: string | undefined
  let matchedAnchor: string | undefined
  for (const link of candidateLinks) {
    const hrefAttr = clean(link.getAttribute('href'))
    if (!hrefAttr || hrefAttr.startsWith('#') || hrefAttr.startsWith('javascript:')) continue
    const normHref = normalizeUrl(hrefAttr)
    const linkText = clean(link.innerText || link.textContent)
    const hrefMatches = normalizedTarget.length > 0 && (
      normHref === normalizedTarget
      || normHref.startsWith(`${normalizedTarget}/`)
      || (targetHost.length > 0 && normHref.split('/')[0] === targetHost)
    )
    const anchorMatches = cleanAnchor.length > 0 && linkText.toLowerCase().includes(cleanAnchor)
    if (hrefMatches || (normalizedTarget.length === 0 && anchorMatches)) {
      matchedHref = hrefAttr
      matchedAnchor = linkText
      break
    }
  }

  return {
    liveLinkFound: matchedHref !== undefined,
    ...(matchedHref === undefined ? {} : { matchedHref }),
    ...(matchedAnchor === undefined ? {} : { matchedAnchor }),
    escapedHtmlDetected,
    ...(moderationNotice === undefined ? {} : { moderationNotice }),
    ...(wpErrorMessage === undefined ? {} : { wpErrorMessage }),
  }
}

export interface ExecuteCommentPublishOptions {
  readonly defaultTimeoutMs: number
  readonly lazyWaitMaxMs?: number
  readonly sleepImpl?: SleepLike
  readonly signal?: AbortSignal
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) {
    return Promise.reject(new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED')
  }
}

async function scrollToCommentsArea(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dom = globalThis as unknown as BrowserDomGlobalLike & {
      readonly document: BrowserDomGlobalLike['document'] & { readonly body: (BrowserDomElementLike & { readonly scrollHeight?: number }) | null }
    }
    const anchor = dom.document.querySelector('#comments, #respond, form#commentform, [data-hook*="comment"], [id*="comment"]')
    if (anchor && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ behavior: 'instant', block: 'center' })
      return
    }
    if (typeof dom.window.scrollTo === 'function' && dom.document.body) {
      dom.window.scrollTo(0, dom.document.body.scrollHeight ?? 0)
    }
  }).catch(() => undefined)
}

function hasDetectedCommentSurface(inspection: CommentPageInspection): boolean {
  return (
    inspection.wordpress.found
    || inspection.commentsClosed.matched
    || inspection.wix.hasCommentSection
    || inspection.wix.hasGuestEditor
    || inspection.wix.loginRequired
    || inspection.wix.captchaDetected
  )
}

async function inspectCommentPage(page: Page): Promise<CommentPageInspection> {
  return await page.evaluate<CommentPageInspection>(INSPECT_COMMENT_PAGE_SCRIPT)
}

async function verifyResult(
  page: Page,
  command: BrowserCommentPublishCommand,
): Promise<CommentVerifyOutcome> {
  return await page.evaluate(verifyCommentResultInDom, {
    ...(command.websiteUrl === undefined ? {} : { websiteUrl: command.websiteUrl }),
    ...(command.anchorText === undefined ? {} : { anchorText: command.anchorText }),
    commentText: command.commentText,
    ...(command.authorName === undefined ? {} : { authorName: command.authorName }),
  })
}

function inferSiteType(inspection: CommentPageInspection): CommentPublishSiteType {
  if (inspection.wordpress.found || inspection.isWordPress) return 'wordpress'
  if (inspection.isWix) return 'wix'
  return 'other'
}

export async function executeCommentPublish(
  page: Page,
  ref: string,
  command: BrowserCommentPublishCommand,
  options: ExecuteCommentPublishOptions,
): Promise<BrowserCommentPublishResult> {
  const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs
  const verifyReload = command.verifyReload !== false
  const probeOnly = command.probeOnly === true
  const lazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? DEFAULT_LAZY_WAIT_MAX_MS, timeoutMs)
  const sleep = options.sleepImpl ?? defaultSleep

  throwIfAborted(options.signal)
  await page.goto(command.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
  throwIfAborted(options.signal)

  let inspection = await inspectCommentPage(page)

  // Scroll to bottom / comment area and wait briefly for lazy-mounted comments (max 2.5s).
  if (!hasDetectedCommentSurface(inspection)) {
    await scrollToCommentsArea(page)
    const deadline = Date.now() + lazyWaitMaxMs
    while (Date.now() < deadline) {
      throwIfAborted(options.signal)
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal)
      inspection = await inspectCommentPage(page)
      if (hasDetectedCommentSurface(inspection)) break
    }
  }

  // 1. WordPress standard comment form branch.
  if (inspection.wordpress.found) {
    const wp = inspection.wordpress
    if (wp.captcha?.detected) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'blocked_captcha',
        siteType: 'wordpress',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        ...(wp.captcha.templateSignature === undefined ? {} : { templateSignature: wp.captcha.templateSignature }),
        evidence: `WordPress 评论区存在 ${wp.captcha.kind ?? 'captcha'} 人机验证，未尝试绕过`,
        suggestedTags: ['has_captcha'],
        submitTriggered: false,
      }
    }

    if (probeOnly) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'form_ready',
        siteType: 'wordpress',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        probeOnly: true,
        submitTriggered: false,
        formSummary: inspection.formSummary,
      }
    }

    if ((wp.authorRequired && !command.authorName?.trim()) || (wp.emailRequired && !command.authorEmail?.trim())) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'needs_llm_fallback',
        siteType: 'wordpress',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        evidence: 'WordPress 评论表单缺少必填的 authorName 或 authorEmail 参数，转交常规流程处理',
        submitTriggered: false,
        formSummary: inspection.formSummary,
      }
    }

    const hasUrlField = wp.urlSelector !== undefined
    const wpBody = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasUrlField)

    await page.locator(wp.commentSelector!).first().fill(wpBody, { timeout: timeoutMs })
    if (wp.authorSelector !== undefined && command.authorName?.trim()) {
      await page.locator(wp.authorSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs })
    }
    if (wp.emailSelector !== undefined && command.authorEmail?.trim()) {
      await page.locator(wp.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs })
    }
    if (wp.urlSelector !== undefined && command.websiteUrl?.trim()) {
      await page.locator(wp.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs })
    }

    if (wp.submitSelector === undefined) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'needs_llm_fallback',
        siteType: 'wordpress',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        evidence: 'WordPress 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）',
        submitTriggered: false,
        formSummary: inspection.formSummary,
      }
    }

    // Point of no return: clicking submit marks submitTriggered=true (idempotent: never retry on uncertainty).
    const submitLocator = page.locator(wp.submitSelector).first()
    await Promise.allSettled([
      typeof page.waitForLoadState === 'function'
        ? page.waitForLoadState('domcontentloaded', { timeout: Math.min(10_000, timeoutMs) })
        : Promise.resolve(),
      submitLocator.click({ timeout: timeoutMs }),
    ])

    const postSubmitUrl = page.url()
    const postVerify = await verifyResult(page, command)
    if (postVerify.wpErrorMessage) {
      const mentionsCaptcha = /captcha|spam|security/iu.test(postVerify.wpErrorMessage)
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'uncertain_after_submit',
        siteType: 'wordpress',
        title: await page.title().catch(() => inspection.title),
        finalUrl: postSubmitUrl,
        evidence: `提交后页面返回错误提示: ${postVerify.wpErrorMessage.slice(0, 160)}`,
        ...(mentionsCaptcha ? { suggestedTags: ['has_captcha'] } : {}),
        submitTriggered: true,
      }
    }

    const sawModeration = Boolean(
      postVerify.moderationNotice || /[?&](?:unapproved|moderation-hash)=/iu.test(postSubmitUrl),
    )
    const isWpEndpoint = /wp-comments-post\.php/iu.test(postSubmitUrl)
    const cleanPublicUrl = isWpEndpoint ? command.url : stripWpModerationParams(postSubmitUrl)

    let finalVerify = postVerify
    let finalUrl = cleanPublicUrl
    if (verifyReload) {
      await page.goto(cleanPublicUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
      await scrollToCommentsArea(page)
      finalUrl = page.url()
      finalVerify = await verifyResult(page, command)
    }
    const finalTitle = await page.title().catch(() => inspection.title)

    if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'uncertain_after_submit',
        siteType: 'wordpress',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: '提交后检测到正文 HTML 被转义，链接未生效（遵守幂等铁律严禁重发）',
        submitTriggered: true,
      }
    }

    if (finalVerify.liveLinkFound) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'live',
        siteType: 'wordpress',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: `WordPress 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
        submitTriggered: true,
      }
    }

    if (sawModeration || finalVerify.moderationNotice) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'submitted',
        siteType: 'wordpress',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: `WordPress 评论已提交等待审核 (${finalVerify.moderationNotice ?? postVerify.moderationNotice ?? 'unapproved'})`,
        submitTriggered: true,
      }
    }

    return {
      kind: 'comment_publish',
      page: ref,
      outcome: 'uncertain_after_submit',
      siteType: 'wordpress',
      title: finalTitle,
      finalUrl,
      publicUrl: finalUrl,
      evidence: '已点击 WordPress 提交但重载公开页未确认目标链接或待审核提示（严禁自动重试）',
      submitTriggered: true,
    }
  }

  // 2. Explicit comments-closed banner (when no active WP form is available).
  if (inspection.commentsClosed.matched && !inspection.wix.hasGuestEditor) {
    return {
      kind: 'comment_publish',
      page: ref,
      outcome: 'comments_closed',
      siteType: inferSiteType(inspection),
      title: inspection.title,
      finalUrl: inspection.finalUrl,
      skipReason: `页面明确提示评论已关闭(${inspection.commentsClosed.phrase ?? 'comments closed'})`,
      suggestedTags: ['评论关闭'],
      submitTriggered: false,
    }
  }

  // 3. Wix blog comment branch.
  if (inspection.isWix) {
    if (inspection.wix.loginRequired || inspection.wix.captchaDetected) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'blocked_captcha',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        templateSignature: 'wix:signup_recaptcha',
        evidence: 'Wix 博客评论区要求会员登录或存在 reCAPTCHA 人机验证，未尝试绕过',
        suggestedTags: ['has_captcha'],
        submitTriggered: false,
      }
    }

    if (!inspection.wix.hasCommentSection) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'no_form',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        skipReason: 'Wix 博客评论区滚动探测后仍不存在',
        suggestedTags: ['no_form'],
        submitTriggered: false,
      }
    }

    if (!inspection.wix.hasGuestEditor && inspection.wix.triggerSelector) {
      await page.locator(inspection.wix.triggerSelector).first().click({ timeout: timeoutMs })
      await sleep(400, options.signal)
      inspection = await inspectCommentPage(page)
      if (inspection.wix.loginRequired || inspection.wix.captchaDetected) {
        return {
          kind: 'comment_publish',
          page: ref,
          outcome: 'blocked_captcha',
          siteType: 'wix',
          title: inspection.title,
          finalUrl: inspection.finalUrl,
          templateSignature: 'wix:signup_recaptcha',
          evidence: '展开 Wix 评论区后触发会员登录/reCAPTCHA 验证，未尝试绕过',
          suggestedTags: ['has_captcha'],
          submitTriggered: false,
        }
      }
    }

    if (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'no_form',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        skipReason: 'Wix 博客未发现免登录访客评论框',
        suggestedTags: ['no_form'],
        submitTriggered: false,
      }
    }

    if (probeOnly) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'form_ready',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        probeOnly: true,
        submitTriggered: false,
        formSummary: inspection.formSummary,
      }
    }

    const wix = inspection.wix
    const editorSelector = wix.editorSelector!
    const hasWebsiteField = wix.websiteSelector !== undefined
    if (wix.editorIsContentEditable) {
      const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl)
      if (stripped.websiteUrl && !hasWebsiteField && !wix.linkButtonSelector) {
        return {
          kind: 'comment_publish',
          page: ref,
          outcome: 'needs_llm_fallback',
          siteType: 'wix',
          title: inspection.title,
          finalUrl: inspection.finalUrl,
          evidence: 'Wix 富文本评论框未定位到链接工具按钮且无 Website 字段（避免把 <a> 原样转义，未触发提交）',
          submitTriggered: false,
          formSummary: inspection.formSummary,
        }
      }

      const editorLocator = page.locator(editorSelector).first()
      await editorLocator.click({ timeout: timeoutMs })
      await editorLocator.fill(stripped.plainText, { timeout: timeoutMs })

      if (stripped.websiteUrl && !hasWebsiteField && wix.linkButtonSelector) {
        const anchorToSelect = stripped.anchorText ?? stripped.websiteUrl
        const selectedOk = await page.evaluate(({ selector, anchor }) => {
          const dom = globalThis as unknown as BrowserDomGlobalLike
          const el = dom.document.querySelector(selector)
          if (!el) return false
          const walker = dom.document.createTreeWalker(el, dom.NodeFilter?.SHOW_TEXT ?? 4)
          let node = walker.nextNode()
          while (node) {
            const text = node.textContent ?? ''
            const idx = text.toLowerCase().indexOf(anchor.toLowerCase())
            if (idx >= 0) {
              const range = dom.document.createRange()
              range.setStart(node, idx)
              range.setEnd(node, idx + anchor.length)
              const sel = dom.window.getSelection?.()
              if (sel) {
                sel.removeAllRanges()
                sel.addRange(range)
              }
              return true
            }
            node = walker.nextNode()
          }
          return false
        }, { selector: editorSelector, anchor: anchorToSelect })

        if (!selectedOk) {
          return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'needs_llm_fallback',
            siteType: 'wix',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            evidence: 'Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）',
            submitTriggered: false,
            formSummary: inspection.formSummary,
          }
        }

        await page.locator(wix.linkButtonSelector).first().click({ timeout: timeoutMs })
        const urlInputSelector = 'input[type="url"], input[placeholder*="http" i], input[placeholder*="url" i], input[placeholder*="link" i], input[aria-label*="url" i], input[aria-label*="link" i]'
        const urlInputCount = await page.locator(urlInputSelector).count().catch(() => 0)
        if (urlInputCount <= 0) {
          return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'needs_llm_fallback',
            siteType: 'wix',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            evidence: '点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）',
            submitTriggered: false,
            formSummary: inspection.formSummary,
          }
        }
        const urlInput = page.locator(urlInputSelector).first()
        await urlInput.fill(stripped.websiteUrl, { timeout: timeoutMs })
        const applyBtnSelector = '[data-hook*="save" i], [data-hook*="apply" i], button[aria-label*="save" i], button[aria-label*="apply" i]'
        const applyCount = await page.locator(applyBtnSelector).count().catch(() => 0)
        if (applyCount > 0) {
          await page.locator(applyBtnSelector).first().click({ timeout: timeoutMs })
        } else {
          await urlInput.press('Enter', { timeout: timeoutMs })
        }
      }
    } else {
      const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasWebsiteField)
      await page.locator(editorSelector).first().fill(body, { timeout: timeoutMs })
    }

    if (wix.nameSelector && command.authorName?.trim()) {
      await page.locator(wix.nameSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs })
    }
    if (wix.emailSelector && command.authorEmail?.trim()) {
      await page.locator(wix.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs })
    }
    if (wix.websiteSelector && command.websiteUrl?.trim()) {
      await page.locator(wix.websiteSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs })
    }

    if (!wix.submitSelector) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'needs_llm_fallback',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        evidence: 'Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）',
        submitTriggered: false,
        formSummary: inspection.formSummary,
      }
    }

    // Point of no return: click Publish.
    await page.locator(wix.submitSelector).first().click({ timeout: timeoutMs })
    await sleep(Math.min(1_200, timeoutMs), options.signal)

    const postVerify = await verifyResult(page, command)
    const sawModeration = Boolean(postVerify.moderationNotice)
    let finalVerify = postVerify
    let finalUrl = page.url()

    if (verifyReload) {
      await page.goto(command.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
      await scrollToCommentsArea(page)
      await sleep(Math.min(800, timeoutMs), options.signal)
      finalUrl = page.url()
      finalVerify = await verifyResult(page, command)
    }

    const finalTitle = await page.title().catch(() => inspection.title)
    if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'uncertain_after_submit',
        siteType: 'wix',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: 'Wix 评论提交后检测到正文 HTML 被转义，链接未生效（严禁重发）',
        submitTriggered: true,
      }
    }
    if (finalVerify.liveLinkFound) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'live',
        siteType: 'wix',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: `Wix 访客评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
        submitTriggered: true,
      }
    }
    if (sawModeration || finalVerify.moderationNotice) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'submitted',
        siteType: 'wix',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        evidence: `Wix 访客评论已提交待审核 (${finalVerify.moderationNotice ?? postVerify.moderationNotice})`,
        submitTriggered: true,
      }
    }
    return {
      kind: 'comment_publish',
      page: ref,
      outcome: 'uncertain_after_submit',
      siteType: 'wix',
      title: finalTitle,
      finalUrl,
      publicUrl: finalUrl,
      evidence: '已触发 Wix Publish 但重载公开页未确认目标链接或待审核提示（严禁自动重试）',
      submitTriggered: true,
    }
  }

  // 4. Non-standard / unknown site: hand back to LLM on already-navigated tab.
  return {
    kind: 'comment_publish',
    page: ref,
    outcome: 'needs_llm_fallback',
    siteType: 'other',
    title: inspection.title,
    finalUrl: inspection.finalUrl,
    submitTriggered: false,
    formSummary: inspection.formSummary,
  }
}
