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

import type { Frame, Page } from 'playwright-core'
import type {
  BrowserCommentPublishCommand,
  BrowserCommentPublishResult,
  CommentPublishFormSummary,
  CommentPublishSiteType,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import type { SleepLike } from '../../mcp/backlinks-tool.ts'

export const DEFAULT_LAZY_WAIT_MAX_MS = 2_500
export const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 5_000
export const DEFAULT_WIX_EXPAND_WAIT_MAX_MS = 4_000
const LAZY_POLL_INTERVAL_MS = 400
const FRAME_INSPECT_TIMEOUT_MS = 1_000
const BOTTOM_SNAPSHOT_MAX_CHARS = 1_200

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
  readonly hasLazyPlaceholder: boolean
  readonly hasCommentCountOnly: boolean
  readonly hasBlogPostStructure: boolean
  readonly isBlogListPage: boolean
  readonly isComplexWixLayout: boolean
  readonly commentHooks?: readonly string[]
  readonly editorSelector?: string
  readonly editorIsContentEditable?: boolean
  readonly triggerSelector?: string
  readonly nameSelector?: string
  readonly emailSelector?: string
  readonly websiteSelector?: string
  readonly submitSelector?: string
  readonly linkButtonSelector?: string
}

export interface ChildFramesInspection {
  readonly frames: readonly string[]
  readonly hasActionableCommentFrame: boolean
  readonly hasUnknownInteractiveFrame: boolean
  readonly captchaDetected: boolean
  readonly commentsClosedPhrase?: string
}

export interface CommentPageInspection {
  readonly title: string
  readonly finalUrl: string
  readonly isWix: boolean
  readonly isWordPress: boolean
  readonly readyState?: string
  readonly scrollHeight?: number
  readonly commentsClosed: {
    readonly matched: boolean
    readonly phrase?: string
  }
  readonly wordpress: WordPressInspection
  readonly wix: WixInspection
  readonly childFrames?: ChildFramesInspection
  readonly formSummary: CommentPublishFormSummary
  readonly bottomSnapshot?: string
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

  const scopeSelectorFor = (scopeEl) => {
    if (!scopeEl) return '';
    if (scopeEl.id) {
      const byId = '#' + escapeCss(scopeEl.id);
      if (uniqueInScope(scopeEl, byId)) return byId;
    }
    const hook = scopeEl.getAttribute && scopeEl.getAttribute('data-hook');
    if (hook) {
      const byHook = '[data-hook="' + hook.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(scopeEl, byHook)) return byHook;
    }
    return scopeEl.localName || '';
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
      const scopeSel = scopeSelectorFor(scopeEl);
      if (scopeSel && nameAttr) {
        const scopedName = scopeSel + ' ' + el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedName)) return scopedName;
      }
      if (scopeSel && hookAttr) {
        const scopedHook = scopeSel + ' [data-hook="' + hookAttr.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedHook)) return scopedHook;
      }
      if (scopeSel && el.type) {
        const scopedType = scopeSel + ' ' + el.localName + '[type="' + String(el.type).replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedType)) return scopedType;
      }
      if (scopeSel && el.getAttribute('contenteditable') === 'true') {
        const scopedCe = scopeSel + ' [contenteditable="true"]';
        if (uniqueInScope(el, scopedCe)) return scopedCe;
      }
      if (scopeSel && el.getAttribute('role') === 'textbox') {
        const scopedTb = scopeSel + ' [role="textbox"]';
        if (uniqueInScope(el, scopedTb)) return scopedTb;
      }
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 8; node = node.parentElement, depth++) {
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
    || /wixstatic\.com|static\.parastorage\.com|_wixCIDX|wix-warmup-data|communities-blog-ooi/i.test(docHtmlPrefix)
  );
  const isWordPress = !!(
    document.querySelector('form#commentform, form[action*="wp-comments-post.php"], meta[name="generator"][content*="WordPress" i], link[href*="wp-content"]')
    || /wp-comments-post\.php|wp-content/i.test(docHtmlPrefix)
  );

  // Extract visible text safely without pulling inline <script>/<style> JSON into jsdom textContent.
  const extractVisibleText = (el) => {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.length > 0) {
      return clean(el.innerText);
    }
    const clone = el.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const s of clone.querySelectorAll('script,style,noscript')) s.remove();
    }
    return clean(clone ? clone.textContent : '');
  };

  // Detect explicit comments-closed banners outside script/style tags.
  const closedRegex = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+closed\b|\bcomments\s+(?:have\s+been\s+)?disabled\b|评论已关闭|评论功能已关闭|已关闭评论/i;
  let closedPhrase = '';
  const closedContainers = Array.from(document.querySelectorAll('#comments, .comments-area, #respond, .nocomments, [data-hook*="comment"], main, article'));
  const closedTargets = closedContainers.length > 0 ? closedContainers : (document.body ? [document.body] : []);
  for (const container of closedTargets) {
    if (!isVisible(container)) continue;
    const text = extractVisibleText(container);
    const match = closedRegex.exec(text);
    if (match) {
      closedPhrase = match[0];
      break;
    }
  }
  if (!closedPhrase && document.body) {
    const match = closedRegex.exec(extractVisibleText(document.body));
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
    const formText = extractVisibleText(respondRoot);

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

  // Wix blog comment & layout structure detection (separates lazy placeholders & counters from interactive controls).
  const isSectionPlaceholderHook = hook => /^comments-section-placeholder$/i.test(hook);
  const isCounterHook = hook => /^comments?-count(?:er)?(?:-wrapper)?$|^post-footer__comment-count$/i.test(hook);
  const allCommentHookEls = Array.from(document.querySelectorAll('[data-hook*="comment" i], [data-testid*="comment" i], #comments'));
  const commentHooks = [];
  for (const el of allCommentHookEls) {
    const h = clean(el.getAttribute('data-hook') || el.getAttribute('data-testid') || (el.id === 'comments' ? '#comments' : ''));
    if (h && !commentHooks.includes(h)) commentHooks.push(h);
    if (commentHooks.length >= 12) break;
  }
  const hasCommentCountOnly = allCommentHookEls.some(el => isCounterHook(clean(el.getAttribute('data-hook'))));
  const wixCommentRoots = allCommentHookEls.filter(el => {
    if (!isVisible(el)) return false;
    const h = clean(el.getAttribute('data-hook'));
    if (isSectionPlaceholderHook(h) || /^skeleton-loader$/i.test(h) || isCounterHook(h) || /comment-count/i.test(h)) return false;
    const text = extractVisibleText(el);
    const hasInteractiveChild = !!el.querySelector('button, input, textarea, select, iframe, [contenteditable="true"], [role="textbox"]');
    const isInteractiveItself = el.localName === 'button'
      || el.localName === 'textarea'
      || el.getAttribute('contenteditable') === 'true'
      || el.getAttribute('role') === 'textbox';
    return !!(text || hasInteractiveChild || isInteractiveItself);
  });

  const pathLower = (location.pathname || '/').toLowerCase();
  const hasPostSlugUrl = /\/post\/[^/?#]+|\/single-post\/[^/?#]+/i.test(pathLower);
  const postHrefLinks = Array.from(document.querySelectorAll('a[href*="/post/"], a[href*="/single-post/"]'))
    .map(a => clean(a.getAttribute('href')))
    .filter(Boolean);
  const uniquePostLinks = Array.from(new Set(postHrefLinks));
  const multiCardCount = document.querySelectorAll('[data-hook="feed-post"], [data-hook="post-list-item"], [data-hook="post-footer"], [data-hook="more-button"]').length;
  const hasSingleArticleNode = !!document.querySelector('article[data-hook="post"], [data-hook="post-hero-image"], [data-hook="comments-section-placeholder"], [data-hook*="comment-box"]');
  const hasListDom = !!document.querySelector('[data-hook*="post-list" i], [data-hook="blog-post-list"], [data-hook="feed-post"], [data-hook="blog-feed"], [data-hook="recent-posts"] [data-hook="recent-post-list-item"]')
    || (!hasSingleArticleNode && multiCardCount >= 2);
  const listPathLooksLikeIndex = /\/(?:blog|news|news-and-events|news-and-updates|articles|posts|insights|stories|updates)(?:\/(?:page\/\d+\/?)?)?$/i.test(pathLower)
    || (pathLower === '/' && uniquePostLinks.length >= 2);
  const isBlogListPage = isWix && !hasPostSlugUrl && !hasSingleArticleNode && (
    hasListDom
    || uniquePostLinks.length >= 2
    || listPathLooksLikeIndex
  );
  const hasPostArticleDom = hasSingleArticleNode || (!isBlogListPage && !!document.querySelector('[data-hook="post-title"], [data-hook="post-footer"]'));
  const hasWixBlogScript = !!document.querySelector('script[src*="communities-blog-ooi" i], link[href*="communities-blog-ooi" i]');
  const hasBlogPostStructure = isWix && !isBlogListPage && (hasPostSlugUrl || hasPostArticleDom || hasWixBlogScript);
  const hasLazyPlaceholder = isWix && (
    !!document.querySelector('[data-hook="comments-section-placeholder"]')
    || allCommentHookEls.some(el => isSectionPlaceholderHook(clean(el.getAttribute('data-hook'))))
    || (!isBlogListPage && !!document.querySelector('[data-hook="skeleton-loader"]'))
  );

  const scrollHeight = Math.max(
    document.documentElement ? (document.documentElement.scrollHeight || 0) : 0,
    document.body ? (document.body.scrollHeight || 0) : 0,
  );
  const scrollY = Math.round(window.scrollY || (document.documentElement ? document.documentElement.scrollTop : 0) || 0);
  const readyState = typeof document.readyState === 'string' ? document.readyState : 'complete';
  const bodyTextClean = extractVisibleText(document.body);
  const tailWindowText = bodyTextClean.slice(-1500);
  const hasCommentHintText = /\b(?:write a comment|comments?|leave a comment|add a comment|escreva um coment|coment[aá]rios?|escribe un coment|commentaires?|kommentare?|评论|留言)\b/i.test(tailWindowText);
  const isComplexWixLayout = isWix && (
    !!document.querySelector('[id*="SITE_CONTAINER"], [data-hook="recent-posts"]')
    || /wix-warmup-data|communities-blog-ooi/i.test(docHtmlPrefix)
    || scrollHeight > 1800
    || readyState !== 'complete'
    || hasCommentHintText
  );

  const wixHasCommentSection = isWix && wixCommentRoots.length > 0;
  const wixLoginRegex = /\b(?:log\s*in|sign\s*in)\s+to\s+(?:comment|publish|reply|post)\b|\b(?:log\s*in|sign\s*in)\s+to\s+publish\s+as\s+a\s+member\b|\bsign\s*up\s+to\s+comment\b|faça\s+login\s+para\s+(?:comentar|publicar)|inicia\s+sesi[oó]n\s+para\s+(?:comentar|publicar)|connectez-vous\s+pour\s+(?:commenter|publier)|登录.*(?:评论|发表)/i;
  const wixContainerText = wixCommentRoots.map(r => extractVisibleText(r)).join(' ');
  const pageVisibleCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile, textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]'
  );
  const wixExplicitMemberLogin = Array.from(document.querySelectorAll(
    '[data-hook="login-as-member-text-button"], [data-testid="signUp.headline"], [data-testid="login.headline"]'
  )).find(el => isVisible(el));
  const wixMemberDialog = Array.from(document.querySelectorAll('[id^="SM_ROOT_COMP"], [role="dialog"]')).find(el => {
    if (!isVisible(el)) return false;
    const t = extractVisibleText(el);
    return !!(
      el.querySelector('input[type="password"], input[type="email"], [data-testid*="signUp" i], [data-testid*="login" i], iframe[src*="recaptcha" i]')
      || /\b(?:log\s*in|sign\s*up|sign\s*in|continue\s+with\s+google)\b/i.test(t)
    );
  });
  const wixLoginButton = Array.from(document.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i], button, a'))
    .find(el => isVisible(el) && wixLoginRegex.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));
  const wixLoginRequired = isWix && (
    wixLoginRegex.test(wixContainerText)
    || !!wixLoginButton
    || !!wixExplicitMemberLogin
    || !!wixMemberDialog
  );

  let wix = {
    hasCommentSection: wixHasCommentSection,
    loginRequired: wixLoginRequired,
    captchaDetected: isWix && pageVisibleCaptcha,
    hasGuestEditor: false,
    hasLazyPlaceholder: isWix && hasLazyPlaceholder,
    hasCommentCountOnly: isWix && hasCommentCountOnly,
    hasBlogPostStructure,
    isBlogListPage,
    isComplexWixLayout,
    ...(commentHooks.length > 0 ? { commentHooks } : {}),
  };

  if (isWix && !wixLoginRequired) {
    const editorEl = Array.from(document.querySelectorAll(
      '[data-hook*="comment-box"] [contenteditable="true"], [data-hook="ricos-tiptap-editor"] [contenteditable="true"], [data-hook="fullRicosEditor"] [contenteditable="true"], [data-hook="create-comment-input"], [data-hook*="comment"] [contenteditable="true"], [data-hook*="comment"] [role="textbox"], [data-hook*="comment"] textarea, [data-hook*="comment"] .tiptap.ProseMirror, [data-hook*="comment"] .public-DraftEditor-content, [placeholder*="Write a comment" i], [aria-label*="Write a comment" i]'
    )).find(el => isVisible(el) && (el.getAttribute('contenteditable') === 'true' || el.localName === 'textarea' || el.getAttribute('role') === 'textbox'));

    const triggerTextRegex = /write\s+a\s+comment|leave\s+a\s+comment|add\s+a\s+comment|post\s+a\s+comment|escreva\s+um\s+coment|escribe\s+un\s+coment|écrire\s+un\s+coment|kommentar\s+schreiben|写评论|发表评论|留下评论/i;
    const triggerEl = editorEl ? null : (
      Array.from(document.querySelectorAll('[data-hook="comment-box-placeholder"], [data-hook="open-comment-box"], [data-hook*="comment-box-placeholder"]'))
        .find(el => isVisible(el) && el !== editorEl)
      || Array.from(document.querySelectorAll('[data-hook*="comment" i] button, [data-hook*="comment" i] [role="button"], [data-testid*="comment" i] button, [data-testid*="comment" i] [role="button"], #comments button, [placeholder*="Write a comment" i], [placeholder*="comment" i]'))
        .find(el => {
          if (!isVisible(el) || el === editorEl) return false;
          const h = clean(el.getAttribute('data-hook'));
          if (isCounterHook(h)) return false;
          return triggerTextRegex.test(clean(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label')));
        })
      || Array.from(document.querySelectorAll('main button, article button, main [role="button"], article [role="button"], button'))
        .find(el => {
          if (!isVisible(el) || el === editorEl || el.closest('header, nav, [role="navigation"]')) return false;
          return /^\s*(?:write|leave|add|post)\s+a\s+comment\b|^\s*(?:escreva\s+um\s+coment|escribe\s+un\s+coment|写评论)/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
        })
    );

    if (editorEl) {
      const boxScope = editorEl.closest('[data-hook*="comment-box"]:not([data-hook*="rce-wrapper"])')
        || (editorEl.parentElement ? editorEl.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], form') : null)
        || document;
      const outerScope = editorEl.closest('[data-hook*="comments-section"], [data-testid*="comment"], #comments, section')
        || (boxScope.parentElement ? boxScope.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], section') : null)
        || document;
      const nameEl = Array.from(boxScope.querySelectorAll('input[type="text"], input:not([type])')).find(el => isVisible(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''))));
      const emailEl = Array.from(boxScope.querySelectorAll('input[type="email"], input[name*="email" i]')).find(isVisible);
      const websiteEl = Array.from(boxScope.querySelectorAll('input[type="url"], input[name*="website" i], input[name*="url" i], input[placeholder*="website" i]')).find(isVisible);
      const findLinkBtn = (scope) => Array.from(scope.querySelectorAll('button, [role="button"]')).find(el => isVisible(el) && /\blink\b|插入链接|链接/i.test(clean((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-hook') || '') + ' ' + (el.getAttribute('data-testid') || ''))));
      const findSubmitBtn = (scope) => Array.from(scope.querySelectorAll('[data-hook="submit-comment-button"], [data-hook="publish-comment-button"], [data-hook="primary-btn"], button[type="submit"], button')).find(el => {
        if (!isVisible(el)) return false;
        const hook = clean(el.getAttribute('data-hook'));
        if (hook === 'submit-comment-button' || hook === 'publish-comment-button') return true;
        if (hook === 'primary-btn' && el.closest('[data-hook*="comment-box"], [data-hook*="comments-section"]')) return true;
        return /^(?:publish|post|submit|comment|reply|publicar|enviar|publier|veröffentlichen|发布|提交|评论)$/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
      });
      const linkBtn = findLinkBtn(boxScope) || findLinkBtn(outerScope);
      const submitEl = findSubmitBtn(boxScope) || findSubmitBtn(outerScope);

      wix = {
        ...wix,
        hasCommentSection: true,
        loginRequired: false,
        hasGuestEditor: true,
        editorSelector: selectorFor(editorEl, boxScope),
        editorIsContentEditable: editorEl.getAttribute('contenteditable') === 'true' || editorEl.getAttribute('role') === 'textbox',
        ...(nameEl ? { nameSelector: selectorFor(nameEl, boxScope) } : {}),
        ...(emailEl ? { emailSelector: selectorFor(emailEl, boxScope) } : {}),
        ...(websiteEl ? { websiteSelector: selectorFor(websiteEl, boxScope) } : {}),
        ...(linkBtn ? { linkButtonSelector: selectorFor(linkBtn, boxScope) } : {}),
        ...(submitEl ? { submitSelector: selectorFor(submitEl, boxScope) } : {}),
      };
    } else if (triggerEl) {
      wix = {
        ...wix,
        hasCommentSection: true,
        loginRequired: false,
        hasGuestEditor: false,
        triggerSelector: selectorFor(triggerEl),
      };
    }
  }

  // Minimal fallback form summary + compact bottom-of-page snapshot for LLM handoff.
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
  const bodySnippet = bodyTextClean.slice(0, 260);

  const bottomControlNodes = Array.from(document.querySelectorAll(
    '[data-hook*="comment" i] button, [data-hook*="comment" i] input, [data-hook*="comment" i] textarea, [data-hook*="comment" i] [contenteditable="true"], [role="dialog"] button, [role="dialog"] input, main button, main input:not([type="hidden"]), main textarea, article button, a[href*="/post/"]'
  )).filter(isVisible);
  const bottomControls = [];
  for (const el of bottomControlNodes.slice(-12)) {
    const tag = el.localName;
    const hook = clean(el.getAttribute('data-hook'));
    const txt = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('href'));
    const entry = tag + (hook ? '[' + hook.slice(0, 28) + ']' : '') + (txt ? ':' + txt.slice(0, 48) : '');
    if (entry && !bottomControls.includes(entry)) bottomControls.push(entry);
    if (bottomControls.length >= 10) break;
  }

  const commentTextTail = wixContainerText
    ? wixContainerText.slice(0, 260)
    : bodyTextClean.slice(-500);
  const bottomParts = [
    'state: ready=' + readyState + ' scroll=' + scrollY + '/' + scrollHeight + ' wix=' + isWix + ' list=' + isBlogListPage + ' post=' + hasBlogPostStructure + ' placeholder=' + hasLazyPlaceholder,
    ...(commentHooks.length > 0 ? ['hooks: ' + commentHooks.slice(0, 8).join(', ')] : []),
    ...(isBlogListPage && uniquePostLinks.length > 0 ? ['posts: ' + uniquePostLinks.slice(0, 4).join(' | ')] : []),
    ...(bottomControls.length > 0 ? ['controls: ' + bottomControls.join('; ')] : []),
    ...(commentTextTail ? ['tail: ' + commentTextTail] : []),
  ];
  const bottomSnapshot = bottomParts.join('\n').slice(0, 1200);

  return {
    title: clean(document.title),
    finalUrl: location.href,
    isWix,
    isWordPress,
    readyState,
    scrollHeight,
    commentsClosed: {
      matched: closedPhrase.length > 0,
      ...(closedPhrase ? { phrase: closedPhrase } : {}),
    },
    wordpress,
    wix,
    ...(bottomSnapshot ? { bottomSnapshot } : {}),
    formSummary: {
      forms: allForms.length,
      textareas: allTextareas.length,
      inputs,
      buttons,
      iframes: allIframes.length,
      hasLoginWall: wixLoginRequired || !!document.querySelector('input[type="password"]'),
      ...(commentHooks.length > 0 ? { commentHooks: commentHooks.slice(0, 8) } : {}),
      ...(bodySnippet ? { snippet: bodySnippet } : {}),
    },
  };
})()`

/** Lightweight self-contained script run inside non-ad child frames. */
export const INSPECT_CHILD_FRAME_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const closedRegex = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+closed\b|\bcomments\s+(?:have\s+been\s+)?disabled\b|评论已关闭|评论功能已关闭|已关闭评论/i;
  const loginRegex = /\b(?:log\s*in|sign\s*in)\s+to\s+(?:comment|publish|reply|post)\b|\bsign\s*up\s+to\s+comment\b|faça\s+login|登录/i;
  const body = document.body;
  const text = (() => {
    if (!body) return '';
    if (typeof body.innerText === 'string' && body.innerText.length > 0) return clean(body.innerText);
    const clone = body.cloneNode(true);
    for (const s of clone.querySelectorAll('script,style,noscript')) s.remove();
    return clean(clone.textContent);
  })();
  const closedMatch = closedRegex.exec(text);
  const captchaDetected = !!document.querySelector(
    '.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]'
  );
  const hasEditor = !!document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  const hasTrigger = !!document.querySelector('[data-hook*="comment" i] button, button[data-hook*="comment" i]')
    || Array.from(document.querySelectorAll('button, a')).some(el => /write\s+a\s+comment|leave\s+a\s+comment|post\s+comment|escreva\s+um\s+coment|评论/i.test(clean(el.innerText || el.textContent)));
  const loginRequired = loginRegex.test(text) || !!document.querySelector('input[type="password"], [data-hook*="login" i]');
  return {
    captchaDetected,
    commentsClosedPhrase: closedMatch ? closedMatch[0] : '',
    hasEditor,
    hasTrigger,
    loginRequired,
    snippet: text.slice(0, 140),
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
  readonly wixLazyWaitMaxMs?: number
  readonly wixExpandWaitMaxMs?: number
  readonly sleepImpl?: SleepLike
  readonly signal?: AbortSignal
}

const WIX_PROGRESSIVE_SCROLL_STEPS = [0.3, 0.6, 0.85, 1.0] as const
const DEFAULT_PROGRESSIVE_SCROLL_STEPS = [0.5, 0.85, 1.0] as const
const AD_OR_MEDIA_FRAME_PATTERN =
  /^$|^about:blank$|doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net\/.*fbevents|video\.wixstatic\.com|youtube\.com\/embed|vimeo\.com/iu
const CAPTCHA_FRAME_URL_PATTERN = /recaptcha|hcaptcha|turnstile/iu
const KNOWN_COMMENT_FRAME_URL_PATTERN =
  /disqus\.com|blogger\.com\/comment|giscus\.app|utteranc\.es|hyvor\.com|commentbox\.io|intensedebate|facebook\.com\/plugins\/comments|comments-ooi|wixapps\.net.*comment|comment.*iframe/iu

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

async function scrollPageStep(page: Page, fraction: number): Promise<void> {
  await page.evaluate((stepFraction: number) => {
    const dom = globalThis as unknown as BrowserDomGlobalLike & {
      readonly document: BrowserDomGlobalLike['document'] & {
        readonly documentElement?: { readonly scrollHeight?: number } | null
        readonly body: (BrowserDomElementLike & { readonly scrollHeight?: number }) | null
      }
      readonly window: BrowserDomGlobalLike['window'] & {
        dispatchEvent?(ev: unknown): void
      }
      readonly Event?: new (type: string) => unknown
    }
    const docHeight = Math.max(
      dom.document.documentElement?.scrollHeight ?? 0,
      dom.document.body?.scrollHeight ?? 0,
    )
    if (stepFraction >= 0.65) {
      const anchor = dom.document.querySelector(
        '#comments, #respond, form#commentform, [data-hook="comments-section-placeholder"], [data-hook*="comment-box"], [data-hook="comments-section"], [data-hook="top-level-comment-list"]',
      )
      if (anchor && typeof anchor.scrollIntoView === 'function') {
        anchor.scrollIntoView({ behavior: 'instant', block: 'center' })
      } else if (typeof dom.window.scrollTo === 'function') {
        dom.window.scrollTo(0, Math.round(docHeight * stepFraction))
      }
    } else if (typeof dom.window.scrollTo === 'function') {
      dom.window.scrollTo(0, Math.round(docHeight * stepFraction))
    }
    if (typeof dom.Event === 'function' && typeof dom.window.dispatchEvent === 'function') {
      try {
        dom.window.dispatchEvent(new dom.Event('scroll'))
      } catch {
        // ignore synthetic event errors
      }
    }
  }, fraction).catch(() => undefined)
}

interface ChildFrameEvalOutcome {
  readonly captchaDetected?: boolean
  readonly commentsClosedPhrase?: string
  readonly hasEditor?: boolean
  readonly hasTrigger?: boolean
  readonly loginRequired?: boolean
  readonly snippet?: string
}

async function evaluateFrameWithTimeout(frame: Frame, timeoutMs: number): Promise<ChildFrameEvalOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      frame.evaluate<ChildFrameEvalOutcome>(INSPECT_CHILD_FRAME_SCRIPT).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function inspectChildFrames(page: Page): Promise<ChildFramesInspection> {
  if (typeof page.frames !== 'function') {
    return {
      frames: [],
      hasActionableCommentFrame: false,
      hasUnknownInteractiveFrame: false,
      captchaDetected: false,
    }
  }

  const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined
  const frameSummaries: string[] = []
  let hasActionableCommentFrame = false
  let hasUnknownInteractiveFrame = false
  let captchaDetected = false
  let commentsClosedPhrase: string | undefined
  let inspectedCount = 0

  for (const frame of page.frames()) {
    if (frame === mainFrame) continue
    if (typeof frame.isDetached === 'function' && frame.isDetached()) continue
    const frameUrl = typeof frame.url === 'function' ? frame.url() : ''
    if (AD_OR_MEDIA_FRAME_PATTERN.test(frameUrl)) continue

    if (CAPTCHA_FRAME_URL_PATTERN.test(frameUrl)) {
      captchaDetected = true
      frameSummaries.push(`${frameUrl.slice(0, 90)} [captcha]`)
      continue
    }

    const knownComment = KNOWN_COMMENT_FRAME_URL_PATTERN.test(frameUrl)
    if (knownComment) {
      hasActionableCommentFrame = true
    }

    let detail: ChildFrameEvalOutcome | null = null
    if (inspectedCount < 6 && typeof frame.evaluate === 'function') {
      inspectedCount++
      detail = await evaluateFrameWithTimeout(frame, FRAME_INSPECT_TIMEOUT_MS)
    }

    const tags: string[] = []
    if (detail?.captchaDetected) {
      captchaDetected = true
      tags.push('captcha')
    }
    if (detail?.commentsClosedPhrase) {
      commentsClosedPhrase ??= detail.commentsClosedPhrase
      tags.push('closed')
    }
    if (detail?.hasEditor) {
      hasActionableCommentFrame = true
      tags.push('editor')
    }
    if (detail?.hasTrigger) {
      hasActionableCommentFrame = true
      tags.push('trigger')
    }
    if (detail?.loginRequired) {
      hasActionableCommentFrame = true
      tags.push('login')
    }
    if (!knownComment && tags.length === 0) {
      hasUnknownInteractiveFrame = true
      if (detail?.snippet) tags.push(`text:${detail.snippet.slice(0, 50)}`)
      else tags.push('cross-origin')
    }
    frameSummaries.push(`${frameUrl.slice(0, 90)}${tags.length > 0 ? ` [${tags.join(',')}]` : ''}`)
  }

  return {
    frames: frameSummaries,
    hasActionableCommentFrame,
    hasUnknownInteractiveFrame,
    captchaDetected,
    ...(commentsClosedPhrase === undefined ? {} : { commentsClosedPhrase }),
  }
}

function hasActionableCommentSurface(inspection: CommentPageInspection): boolean {
  return (
    inspection.wordpress.found
    || inspection.commentsClosed.matched
    || inspection.wix.captchaDetected
    || inspection.wix.loginRequired
    || inspection.wix.hasGuestEditor
    || inspection.wix.triggerSelector !== undefined
    || Boolean(inspection.childFrames?.captchaDetected)
    || Boolean(inspection.childFrames?.hasActionableCommentFrame)
  )
}

async function inspectCommentPageWithFrames(page: Page): Promise<CommentPageInspection> {
  const base = await page.evaluate<CommentPageInspection>(INSPECT_COMMENT_PAGE_SCRIPT)
  const childFrames = await inspectChildFrames(page)
  const hasChildSignals =
    childFrames.frames.length > 0
    || childFrames.captchaDetected
    || childFrames.hasActionableCommentFrame
    || childFrames.hasUnknownInteractiveFrame
    || childFrames.commentsClosedPhrase !== undefined
  if (!hasChildSignals) {
    return base
  }

  const extraFramesLine = childFrames.frames.length > 0
    ? `[child-frames] ${childFrames.frames.slice(0, 4).join(' ; ')}`
    : ''
  const combinedBottom = [base.bottomSnapshot, extraFramesLine]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join('\n')
    .slice(0, BOTTOM_SNAPSHOT_MAX_CHARS)

  return {
    ...base,
    commentsClosed: base.commentsClosed.matched || !childFrames.commentsClosedPhrase
      ? base.commentsClosed
      : { matched: true, phrase: childFrames.commentsClosedPhrase },
    wix: {
      ...base.wix,
      captchaDetected: base.wix.captchaDetected || (base.isWix && childFrames.captchaDetected),
    },
    childFrames,
    ...(combinedBottom.length > 0 ? { bottomSnapshot: combinedBottom } : {}),
    formSummary: {
      ...base.formSummary,
      iframes: Math.max(base.formSummary.iframes, childFrames.frames.length),
      ...(childFrames.frames.length > 0 ? { childFrames: childFrames.frames.slice(0, 6) } : {}),
    },
  }
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

function buildFallbackResult(
  ref: string,
  siteType: CommentPublishSiteType,
  inspection: CommentPageInspection,
  evidence?: string,
): BrowserCommentPublishResult {
  return {
    kind: 'comment_publish',
    page: ref,
    outcome: 'needs_llm_fallback',
    siteType,
    title: inspection.title,
    finalUrl: inspection.finalUrl,
    ...(evidence === undefined ? {} : { evidence }),
    submitTriggered: false,
    formSummary: inspection.formSummary,
    ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
  }
}

function buildWixNoFormDiagnosis(inspection: CommentPageInspection): string {
  if (inspection.wix.isBlogListPage) {
    return '当前页面为 Wix 博客列表/索引页（非单篇文章 /post/），需要挑选近期文章进入后再探测评论框（安全护栏拒判 no_form，未触发提交）'
  }
  if (inspection.wix.hasLazyPlaceholder || inspection.wix.hasCommentCountOnly) {
    return 'Wix 博客仍处于 comments-section-placeholder/comment-count 懒加载阶段且未完成挂载，需 LLM 滚动复核（安全护栏拒判 no_form，未触发提交）'
  }
  if (inspection.childFrames?.hasActionableCommentFrame || inspection.childFrames?.hasUnknownInteractiveFrame) {
    return 'Wix 页面存在可疑子 iframe，可能承载延迟/第三方评论组件，转交 LLM 核查（安全护栏拒判 no_form，未触发提交）'
  }
  if (inspection.wix.hasCommentSection || inspection.wix.triggerSelector) {
    return '检测到 Wix 评论容器/触发器但未确认访客输入框或登录模态框，转交 LLM 接管（安全护栏拒判 no_form，未触发提交）'
  }
  if (inspection.wix.hasBlogPostStructure || inspection.wix.isComplexWixLayout) {
    return '复杂 Wix 博客文章/Thunderbolt 布局在等待窗口内未暴露确定性评论表单，附带底部快照转交 LLM 二次确认（安全护栏拒判 no_form，未触发提交）'
  }
  return 'Wix 页面未定位到确定性评论入口，附带底部快照转交 LLM 二次确认（未触发提交）'
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
  const baseLazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? DEFAULT_LAZY_WAIT_MAX_MS, timeoutMs)
  const wixLazyWaitMaxMs = Math.min(
    options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? DEFAULT_WIX_LAZY_WAIT_MAX_MS,
    timeoutMs,
  )
  const wixExpandWaitMaxMs = Math.min(options.wixExpandWaitMaxMs ?? DEFAULT_WIX_EXPAND_WAIT_MAX_MS, timeoutMs)
  const sleep = options.sleepImpl ?? defaultSleep

  throwIfAborted(options.signal)
  await page.goto(command.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
  throwIfAborted(options.signal)

  let inspection = await inspectCommentPageWithFrames(page)

  // Progressive multi-step scroll + lazy-load polling until an actionable surface mounts.
  if (!hasActionableCommentSurface(inspection)) {
    let activeWaitMaxMs = inspection.isWix ? wixLazyWaitMaxMs : baseLazyWaitMaxMs
    const startAt = Date.now()
    let deadline = startAt + activeWaitMaxMs
    let maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0

    for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
      throwIfAborted(options.signal)
      const steps = inspection.isWix ? WIX_PROGRESSIVE_SCROLL_STEPS : DEFAULT_PROGRESSIVE_SCROLL_STEPS
      const fraction = steps[Math.min(poll, steps.length - 1)]!
      await scrollPageStep(page, fraction)

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal)

      const prevIsWix = inspection.isWix
      inspection = await inspectCommentPageWithFrames(page)
      if (!prevIsWix && inspection.isWix && options.lazyWaitMaxMs === undefined) {
        activeWaitMaxMs = wixLazyWaitMaxMs
        deadline = startAt + activeWaitMaxMs
        maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0
      }
      if (hasActionableCommentSurface(inspection)) break
    }
  }

  // 1. WordPress standard comment form branch.
  if (inspection.wordpress.found) {
    const wp = inspection.wordpress
    if (wp.captcha?.detected || inspection.childFrames?.captchaDetected) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'blocked_captcha',
        siteType: 'wordpress',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        ...(wp.captcha?.templateSignature === undefined ? {} : { templateSignature: wp.captcha.templateSignature }),
        evidence: `WordPress 评论区存在 ${wp.captcha?.kind ?? 'captcha'} 人机验证，未尝试绕过`,
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
        ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
      }
    }

    if ((wp.authorRequired && !command.authorName?.trim()) || (wp.emailRequired && !command.authorEmail?.trim())) {
      return buildFallbackResult(
        ref,
        'wordpress',
        inspection,
        'WordPress 评论表单缺少必填的 authorName 或 authorEmail 参数，转交常规流程处理',
      )
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
      return buildFallbackResult(
        ref,
        'wordpress',
        inspection,
        'WordPress 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）',
      )
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
      await scrollPageStep(page, 1.0)
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

  // 3. Wix blog comment branch (with child-frame awareness & anti-false-no_form guardrail).
  if (inspection.isWix) {
    if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) {
      return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'blocked_captcha',
        siteType: 'wix',
        title: inspection.title,
        finalUrl: inspection.finalUrl,
        templateSignature: 'wix:signup_recaptcha',
        evidence: 'Wix 博客评论区检测到 reCAPTCHA 人机验证，未尝试绕过',
        suggestedTags: ['has_captcha'],
        submitTriggered: false,
      }
    }

    if (inspection.wix.loginRequired) {
      return buildFallbackResult(
        ref,
        'wix',
        inspection,
        'Wix 评论区提示需要登录发表（如 Log in to publish as a member），当前未检测到 CAPTCHA；转交 LLM 走登录决策树（interactive snapshot 核查 Google SSO 或邮箱注册，未触发提交）',
      )
    }

    if (!inspection.wix.hasGuestEditor && inspection.wix.triggerSelector) {
      const triggerLocator = page.locator(inspection.wix.triggerSelector).first()
      let clickError: unknown
      try {
        const scrollableTrigger = triggerLocator as unknown as {
          scrollIntoViewIfNeeded?: (opts?: { timeout?: number }) => Promise<void>
        }
        if (typeof scrollableTrigger.scrollIntoViewIfNeeded === 'function') {
          await scrollableTrigger.scrollIntoViewIfNeeded({ timeout: Math.min(3_000, timeoutMs) }).catch(() => undefined)
        }
        await triggerLocator.click({ timeout: timeoutMs })
      } catch (error) {
        clickError = error
      }

      if (clickError !== undefined) {
        return buildFallbackResult(
          ref,
          'wix',
          inspection,
          `点击 Wix 评论展开触发器失败 (${clickError instanceof Error ? clickError.message : String(clickError)})，转交 LLM 接管（未触发提交）`,
        )
      }

      const expandDeadline = Date.now() + wixExpandWaitMaxMs
      const expandMaxPolls = wixExpandWaitMaxMs > 0
        ? Math.max(1, Math.ceil(wixExpandWaitMaxMs / LAZY_POLL_INTERVAL_MS))
        : 1
      let sawLoginWithoutCaptcha = false

      for (let poll = 0; poll < expandMaxPolls && Date.now() < expandDeadline; poll++) {
        throwIfAborted(options.signal)
        const remaining = expandDeadline - Date.now()
        if (remaining <= 0) break
        await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal)

        inspection = await inspectCommentPageWithFrames(page)
        if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) {
          return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'blocked_captcha',
            siteType: 'wix',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            templateSignature: 'wix:signup_recaptcha',
            evidence: '展开 Wix 评论区后触发 reCAPTCHA 人机验证，未尝试绕过',
            suggestedTags: ['has_captcha'],
            submitTriggered: false,
          }
        }
        if (inspection.wix.loginRequired) {
          if (!sawLoginWithoutCaptcha && poll + 1 < expandMaxPolls) {
            sawLoginWithoutCaptcha = true
            continue
          }
          return buildFallbackResult(
            ref,
            'wix',
            inspection,
            '展开 Wix 评论区后显示需登录发表（Log in to publish as a member），未检测到 CAPTCHA，转交 LLM 核查 Google SSO/邮箱登录（未触发提交）',
          )
        }
        if (inspection.wix.hasGuestEditor && inspection.wix.editorSelector) {
          break
        }
      }

      if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) {
        return {
          kind: 'comment_publish',
          page: ref,
          outcome: 'blocked_captcha',
          siteType: 'wix',
          title: inspection.title,
          finalUrl: inspection.finalUrl,
          templateSignature: 'wix:signup_recaptcha',
          evidence: '展开 Wix 评论区后检测到 reCAPTCHA 人机验证，未尝试绕过',
          suggestedTags: ['has_captcha'],
          submitTriggered: false,
        }
      }
      if (inspection.wix.loginRequired) {
        return buildFallbackResult(
          ref,
          'wix',
          inspection,
          '展开 Wix 评论区后显示需登录发表（Log in to publish as a member），未检测到 CAPTCHA，转交 LLM 核查 Google SSO/邮箱登录（未触发提交）',
        )
      }
    }

    if (inspection.childFrames?.hasActionableCommentFrame && (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector)) {
      return buildFallbackResult(
        ref,
        'wix',
        inspection,
        '在子 iframe 中检测到疑似评论/登录组件，转交 LLM 使用 frame()>> 进一步确认（未触发提交）',
      )
    }

    if (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector) {
      const canSafelyDeclareWixNoForm =
        !inspection.wix.hasCommentSection
        && !inspection.wix.hasLazyPlaceholder
        && !inspection.wix.hasCommentCountOnly
        && !inspection.wix.triggerSelector
        && !inspection.wix.hasBlogPostStructure
        && !inspection.wix.isBlogListPage
        && !inspection.wix.isComplexWixLayout
        && !(inspection.childFrames?.hasActionableCommentFrame)
        && !(inspection.childFrames?.hasUnknownInteractiveFrame)
        && (inspection.readyState === undefined || inspection.readyState !== 'loading')

      if (canSafelyDeclareWixNoForm) {
        return {
          kind: 'comment_publish',
          page: ref,
          outcome: 'no_form',
          siteType: 'wix',
          title: inspection.title,
          finalUrl: inspection.finalUrl,
          skipReason: 'Wix 静态页面经渐进滚动、懒加载等待与 iframe 检查后确认无评论模块',
          suggestedTags: ['no_form'],
          submitTriggered: false,
        }
      }

      return buildFallbackResult(ref, 'wix', inspection, buildWixNoFormDiagnosis(inspection))
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
        ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
      }
    }

    const wix = inspection.wix
    const editorSelector = wix.editorSelector!
    const hasWebsiteField = wix.websiteSelector !== undefined
    if (wix.editorIsContentEditable) {
      const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl)
      if (stripped.websiteUrl && !hasWebsiteField && !wix.linkButtonSelector) {
        return buildFallbackResult(
          ref,
          'wix',
          inspection,
          'Wix 富文本评论框未定位到链接工具按钮且无 Website 字段（避免把 <a> 原样转义，未触发提交）',
        )
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
          return buildFallbackResult(
            ref,
            'wix',
            inspection,
            'Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）',
          )
        }

        await page.locator(wix.linkButtonSelector).first().click({ timeout: timeoutMs })
        const urlInputSelector = 'input[type="url"], input[placeholder*="http" i], input[placeholder*="url" i], input[placeholder*="link" i], input[aria-label*="url" i], input[aria-label*="link" i]'
        const urlInputCount = await page.locator(urlInputSelector).count().catch(() => 0)
        if (urlInputCount <= 0) {
          return buildFallbackResult(
            ref,
            'wix',
            inspection,
            '点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）',
          )
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
      return buildFallbackResult(
        ref,
        'wix',
        inspection,
        'Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）',
      )
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
      const reloadWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 3_500, timeoutMs)
      const reloadDeadline = Date.now() + reloadWaitMaxMs
      const reloadMaxPolls = reloadWaitMaxMs > 0 ? Math.max(1, Math.ceil(reloadWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 1
      await scrollPageStep(page, 1.0)
      finalVerify = await verifyResult(page, command)
      for (
        let poll = 0;
        poll < reloadMaxPolls && Date.now() < reloadDeadline
        && !finalVerify.liveLinkFound && !finalVerify.moderationNotice && !finalVerify.escapedHtmlDetected;
        poll++
      ) {
        const remaining = reloadDeadline - Date.now()
        if (remaining <= 0) break
        await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal)
        await scrollPageStep(page, 1.0)
        finalVerify = await verifyResult(page, command)
      }
      finalUrl = page.url()
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

  // 4. Non-standard / unknown site: block immediately on child-frame CAPTCHA, otherwise hand back to LLM.
  if (inspection.childFrames?.captchaDetected) {
    return {
      kind: 'comment_publish',
      page: ref,
      outcome: 'blocked_captcha',
      siteType: 'other',
      title: inspection.title,
      finalUrl: inspection.finalUrl,
      evidence: '在页面子 iframe 中检测到 CAPTCHA 人机验证，未尝试绕过',
      suggestedTags: ['has_captcha'],
      submitTriggered: false,
    }
  }

  return buildFallbackResult(ref, 'other', inspection)
}
