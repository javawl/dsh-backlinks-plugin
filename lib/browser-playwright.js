import { t as assertNever } from "./backlinks-types-C6425y97.js";
import { t as BrowserError } from "./types-DhIxLWiv.js";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { chromium } from "playwright-core";
// lib/types/host/browser-playwright/overlay.js
/**
* Safe dismissal helper for visible marketing popups, Klaviyo modals, cookie
* consent banners, and blocking non-auth dialogs before clicking targets.
*
* Strictly preserves login/signup dialogs and CAPTCHA modals so downstream
* classifiers can report `needs_login` or `blocked_captcha` accurately.
*/
const INSPECT_BLOCKING_OVERLAY_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };

  const unique = (el, sel) => {
    if (!sel) return false;
    try {
      const list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };

  const selectorFor = (el) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (unique(el, byId)) return byId;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byTestId)) return byTestId;
    }
    const hook = el.getAttribute('data-hook');
    if (hook) {
      const byHook = '[data-hook="' + hook.replace(/"/g, '\\"') + '"]';
      if (unique(el, byHook)) return byHook;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const byAria = el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
      if (unique(el, byAria)) return byAria;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (unique(el, path)) return path;
    }
    return '';
  };

  const extractText = (el) => {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.length > 0) return clean(el.innerText);
    if (typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      const parts = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const t = clean(node.textContent);
        if (t) parts.push(t);
        node = walker.nextNode();
      }
      if (parts.length > 0) return clean(parts.join(' '));
    }
    return clean(el.textContent);
  };

  const isAuthOrCaptchaContainer = (el) => {
    if (!el) return false;
    if (el.matches('[id^="SM_ROOT_COMP"], [data-testid*="signUp" i], [data-testid*="login" i]')) return true;
    if (el.querySelector('[id^="SM_ROOT_COMP"], [data-testid*="signUp" i], [data-testid*="login" i], input[type="password"], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile')) {
      return true;
    }
    const text = extractText(el);
    if (/\b(?:log\s*in\s+to|sign\s*up\s+to|continue\s+with\s+google|sign\s+in\s+with\s+google|sign\s+up\s+with\s+google|recaptcha|hcaptcha|turnstile)\b/i.test(text)) {
      return true;
    }
    return false;
  };

  const findCloseButton = (container) => {
    const candidates = Array.from(container.querySelectorAll('button, [role="button"], a'));
    const closeEl = candidates.find(el => {
      if (!isVisible(el)) return false;
      const sig = clean(
        (el.getAttribute('aria-label') || '') + ' '
        + (el.getAttribute('title') || '') + ' '
        + (el.getAttribute('data-testid') || '') + ' '
        + (el.getAttribute('data-hook') || '') + ' '
        + (el.getAttribute('class') || '') + ' '
        + (el.innerText || el.textContent || '')
      );
      return /^(?:×|✕|✖|x|close|dismiss|no thanks|skip|decline|reject|accept|accept all|got it|ok|i agree|รับทราบ|关闭|接受|同意|知道了)$/i.test(clean(el.innerText || el.textContent))
        || /\b(?:close|dismiss|klaviyo-close|popup-close|modal-close|cookie-accept|accept-all|onetrust-accept|decline|reject)\b/i.test(sig);
    });
    return closeEl ? selectorFor(closeEl) : '';
  };

  const checks = [
    { kind: 'wix_popup', selector: '#POPUPS_ROOT' },
    { kind: 'klaviyo_modal', selector: '.klaviyo-form, [class*="klaviyo" i][role="dialog"], [aria-label*="POPUP Form" i], [data-testid*="klaviyo" i]' },
    { kind: 'consent_banner', selector: '[data-hook*="consent-banner" i], [id*="consent-banner" i], [class*="consent-banner" i], [id*="cookie-banner" i], [class*="cookie-consent" i], [id*="onetrust" i], .cc-window, [aria-label*="cookie" i][role="dialog"]' },
    { kind: 'dialog_overlay', selector: '[role="dialog"], [aria-modal="true"], .modal.show, .popup-overlay' },
  ];

  for (const check of checks) {
    const nodes = Array.from(document.querySelectorAll(check.selector));
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (check.kind === 'wix_popup') {
        const hasVisibleContent = Array.from(el.children || []).some(isVisible)
          || clean(el.innerText || el.textContent).length > 0;
        if (!hasVisibleContent) continue;
      }
      if (el.querySelector('[data-hook*="comment-box"], #commentform, textarea[name="comment"]')) continue;
      if (isAuthOrCaptchaContainer(el)) continue;
      const closeSelector = findCloseButton(el);
      if (check.kind === 'dialog_overlay' && !closeSelector) {
        const text = clean(el.innerText || el.textContent);
        const looksLikePromoOrCookie = /\b(?:cookie|consent|newsletter|subscribe|discount|offer|promo|off\s+your|join\s+our\s+list|privacy\s+preferences|accept\s+all)\b|订阅|优惠|隐私|cookie/i.test(text);
        if (!looksLikePromoOrCookie) continue;
      }
      return {
        detected: true,
        kind: check.kind,
        ...(closeSelector ? { closeSelector } : {}),
      };
    }
  }

  return { detected: false };
})()`;
/**
* Inspect for visible marketing/cookie overlays and dismiss via Escape and/or
* close button so subsequent clicks are never intercepted.
*/
async function dismissBlockingOverlays(page, timeoutMs) {
	if (typeof page.evaluate !== "function") return { dismissed: false };
	const before = await page.evaluate(INSPECT_BLOCKING_OVERLAY_SCRIPT).catch(() => ({ detected: false }));
	if (!before?.detected) return { dismissed: false };
	if (typeof page.keyboard?.press === "function") await page.keyboard.press("Escape").catch(() => void 0);
	const afterEsc = await page.evaluate(INSPECT_BLOCKING_OVERLAY_SCRIPT).catch(() => ({ detected: false }));
	if (!afterEsc?.detected) return {
		dismissed: true,
		...before.kind === void 0 ? {} : { kind: before.kind }
	};
	const closeSelector = afterEsc.closeSelector ?? before.closeSelector;
	if (closeSelector && typeof page.locator === "function") {
		const clickTimeout = Math.min(1500, Math.max(400, timeoutMs));
		await page.locator(closeSelector).first().click({ timeout: clickTimeout }).catch(() => void 0);
		return {
			dismissed: true,
			...before.kind === void 0 ? {} : { kind: before.kind }
		};
	}
	return {
		dismissed: true,
		...before.kind === void 0 ? {} : { kind: before.kind }
	};
}
const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 15e3;
const DEFAULT_WIX_NAV_TIMEOUT_MS = 15e3;
const LAZY_POLL_INTERVAL_MS = 400;
const POST_SUBMIT_POLL_INTERVAL_MS = 500;
const FRAME_INSPECT_TIMEOUT_MS = 1e3;
const BOTTOM_SNAPSHOT_MAX_CHARS = 1200;
/** Strip unapproved/moderation query parameters before public reload verification (preserving `#comment-ID`). */
function stripWpModerationParams(rawUrl) {
	try {
		const parsed = new URL(rawUrl);
		parsed.searchParams.delete("unapproved");
		parsed.searchParams.delete("moderation-hash");
		return parsed.toString();
	} catch {
		return rawUrl;
	}
}
/** Build plain/HTML comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
function buildWpCommentContent(commentText, websiteUrl, anchorText, hasUrlField) {
	const cleanComment = commentText.trim();
	const cleanUrl = websiteUrl?.trim();
	if (hasUrlField || !cleanUrl) return cleanComment;
	if (/<a\b[^>]*href\s*=/iu.test(cleanComment)) return cleanComment;
	const cleanAnchor = anchorText?.trim();
	if (cleanAnchor && cleanAnchor.length > 0) {
		const idx = cleanComment.toLowerCase().indexOf(cleanAnchor.toLowerCase());
		if (idx >= 0) {
			const matched = cleanComment.slice(idx, idx + cleanAnchor.length);
			return `${cleanComment.slice(0, idx)}<a href="${cleanUrl}">${matched}</a>${cleanComment.slice(idx + cleanAnchor.length)}`;
		}
		return `${cleanComment} <a href="${cleanUrl}">${cleanAnchor}</a>`;
	}
	return `${cleanComment} <a href="${cleanUrl}">${cleanUrl}</a>`;
}
/** Strip raw `<a>` markup before typing into a `contenteditable` rich editor. */
function stripHtmlLinkForRichEditor(commentText, anchorText, websiteUrl) {
	const linkMatch = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(commentText);
	const extractedHref = linkMatch?.[1]?.trim();
	const extractedAnchor = linkMatch?.[2]?.replace(/<[^>]+>/gu, "").trim();
	const plainText = commentText.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/giu, "$1").replace(/\s+/gu, " ").trim();
	const finalAnchor = anchorText?.trim() || extractedAnchor || void 0;
	const finalUrl = websiteUrl?.trim() || extractedHref || void 0;
	return {
		plainText,
		...finalAnchor === void 0 ? {} : { anchorText: finalAnchor },
		...finalUrl === void 0 ? {} : { websiteUrl: finalUrl }
	};
}
/**
* Self-contained browser evaluation script inspecting WordPress (including
* collapsed comment triggers), Typecho, custom blog forms, Wix (with member-wall
* fast detection & multilingual triggers), Blogger iframes, comments-closed
* banners, CAPTCHAs, and minimal fallback form metadata.
*/
const INSPECT_COMMENT_PAGE_SCRIPT = String.raw`(() => {
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

  const isContentEditableEl = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const ce = el.getAttribute('contenteditable');
    const editable = ce === 'true' || ce === '' || ce === 'plaintext-only' || el.isContentEditable === true;
    if (!editable) return false;
    if (el.parentElement && el.parentElement.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
      return false;
    }
    return true;
  };

  const scopeSelectorFor = (scopeEl) => {
    if (!scopeEl || scopeEl === document) return '';
    if (scopeEl.id) {
      const byId = '#' + escapeCss(scopeEl.id);
      if (uniqueInScope(scopeEl, byId)) return byId;
    }
    const hook = scopeEl.getAttribute && scopeEl.getAttribute('data-hook');
    if (hook) {
      const byHook = '[data-hook="' + hook.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(scopeEl, byHook)) return byHook;
    }
    const testId = scopeEl.getAttribute && scopeEl.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (uniqueInScope(scopeEl, byTestId)) return byTestId;
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
    const tryScoped = (anchorEl) => {
      if (!anchorEl || anchorEl === document || anchorEl === el) return '';
      const scopeSel = scopeSelectorFor(anchorEl);
      if (!scopeSel) return '';
      if (nameAttr) {
        const scopedName = scopeSel + ' ' + el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedName)) return scopedName;
      }
      if (hookAttr) {
        const scopedHook = scopeSel + ' [data-hook="' + hookAttr.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedHook)) return scopedHook;
      }
      if (el.type) {
        const scopedType = scopeSel + ' ' + el.localName + '[type="' + String(el.type).replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedType)) return scopedType;
      }
      if (el.getAttribute('contenteditable') === 'true') {
        const scopedCe = scopeSel + ' [contenteditable="true"]';
        if (uniqueInScope(el, scopedCe)) return scopedCe;
      }
      if (isContentEditableEl(el)) {
        const scopedCeAny = scopeSel + ' [contenteditable]';
        if (uniqueInScope(el, scopedCeAny)) return scopedCeAny;
      }
      if (el.getAttribute('role') === 'textbox') {
        const scopedTb = scopeSel + ' [role="textbox"]';
        if (uniqueInScope(el, scopedTb)) return scopedTb;
      }
      if (el.localName === 'textarea') {
        const scopedTa = scopeSel + ' textarea';
        if (uniqueInScope(el, scopedTa)) return scopedTa;
      }
      const aria = el.getAttribute('aria-label');
      if (aria) {
        const scopedAria = scopeSel + ' ' + el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
        if (uniqueInScope(el, scopedAria)) return scopedAria;
      }
      if (el.getAttribute('role') === 'button') {
        const scopedRoleBtn = scopeSel + ' [role="button"]';
        if (uniqueInScope(el, scopedRoleBtn)) return scopedRoleBtn;
      }
      if (el.localName === 'button') {
        const scopedBtn = scopeSel + ' button';
        if (uniqueInScope(el, scopedBtn)) return scopedBtn;
      }
      return '';
    };
    const fromScope = tryScoped(scopeEl);
    if (fromScope) return fromScope;
    const nearestAnchor = el.parentElement ? el.parentElement.closest('[data-hook], [data-testid], [id]') : null;
    if (nearestAnchor && nearestAnchor !== scopeEl) {
      const fromNearest = tryScoped(nearestAnchor);
      if (fromNearest) return fromNearest;
    }
    const anchorSel = nearestAnchor ? scopeSelectorFor(nearestAnchor) : '';
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 16; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (uniqueInScope(el, path)) return path;
      if (nearestAnchor && node.parentElement === nearestAnchor && anchorSel) {
        const anchored = anchorSel + ' > ' + path;
        if (uniqueInScope(el, anchored)) return anchored;
      }
    }
    return '';
  };

  const docHtmlPrefix = (document.documentElement ? document.documentElement.innerHTML : '').slice(0, 65536);
  const isWix = !!(
    document.querySelector('[data-hook*="comment"], [id*="SITE_CONTAINER"], meta[name="generator"][content*="Wix" i], script[src*="wixstatic.com"], script[src*="parastorage.com"]')
    || /wixstatic\.com|static\.parastorage\.com|_wixCIDX|wix-warmup-data|communities-blog-ooi/i.test(docHtmlPrefix)
  );
  const isWordPress = !!(
    document.querySelector('form#commentform, form[action*="wp-comments-post.php"], .verbum-comments, .jetpack-comments, meta[name="generator"][content*="WordPress" i], link[href*="wp-content"]')
    || /wp-comments-post\.php|wp-content|verbum-comments/i.test(docHtmlPrefix)
  );
  const isTypecho = !!(
    document.querySelector('meta[name="generator"][content*="Typecho" i]')
    || (document.querySelector('input[name="mail"]') && document.querySelector('textarea[name="text"]'))
  );
  const hasBloggerCommentIframe = !!document.querySelector(
    'iframe#comment-editor, iframe[name="comment-editor"], iframe[src*="blogger.com/comment" i], iframe[src*="blogspot.com/comment" i]'
  );

  const extractVisibleText = (el) => {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.length > 0) {
      return clean(el.innerText);
    }
    const clone = el.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const s of clone.querySelectorAll('script,style,noscript')) s.remove();
    }
    if (clone && typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      const parts = [];
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const t = clean(node.textContent);
        if (t) parts.push(t);
        node = walker.nextNode();
      }
      if (parts.length > 0) return clean(parts.join(' '));
    }
    return clean(clone ? clone.textContent : '');
  };

  const detectFormCaptcha = (formEl, prefix) => {
    const respondRoot = formEl.closest('#respond, #comments, .comments-area') || formEl;
    const formHtml = formEl.outerHTML || '';
    const formText = extractVisibleText(respondRoot);
    if (respondRoot.querySelector('.g-recaptcha, iframe[src*="recaptcha"], [data-sitekey], textarea[name="g-recaptcha-response"], input[name*="recaptcha" i]')) {
      return { detected: true, kind: 'recaptcha', templateSignature: prefix + ':recaptcha_captcha' };
    }
    if (respondRoot.querySelector('.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]')) {
      return { detected: true, kind: 'hcaptcha', templateSignature: prefix + ':hcaptcha_captcha' };
    }
    if (respondRoot.querySelector('.cf-turnstile, iframe[src*="turnstile"], input[name="cf-turnstile-response"]')) {
      return { detected: true, kind: 'turnstile', templateSignature: prefix + ':turnstile_captcha' };
    }
    if (respondRoot.querySelector('img[src*="secureimg" i], input[name*="si_code" i]') || /secureimg/i.test(formHtml)) {
      return { detected: true, kind: 'secureimg', templateSignature: 'blog:secureimg_captcha' };
    }
    if (respondRoot.querySelector('img[src*="captcha" i], input[name*="captcha" i], input[id*="captcha" i], input[class*="captcha" i]')) {
      return { detected: true, kind: 'image_captcha', templateSignature: prefix + ':image_captcha' };
    }
    if (/\b\d+\s*[+\-×x*÷]\s*\d+\s*=\s*\??/u.test(formText) || (/math\s*captcha|算术|anti-?spam/i.test(formText) && formEl.querySelector('input[name*="quiz" i], input[name*="math" i], input[name*="sum" i]'))) {
      return { detected: true, kind: 'math_captcha', templateSignature: prefix + ':math_captcha' };
    }
    return { detected: false };
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

  // WordPress comment form detection (including hidden #comment collapsed trigger & Jetpack Verbum Gutenberg contenteditable).
  const allWpTextareas = Array.from(document.querySelectorAll('textarea[name="comment"], textarea#comment'));
  const wpCommentTextarea = allWpTextareas.find(isVisible) || null;
  const wpAnyTextarea = wpCommentTextarea || allWpTextareas[0] || null;
  const wpFormCandidate = document.querySelector('form#commentform, form[action*="wp-comments-post.php"]')
    || (wpAnyTextarea ? wpAnyTextarea.closest('form') : null)
    || (isWordPress ? document.querySelector('.verbum-comments form, .jetpack-comments form, #respond form, #respond.comment-respond, .verbum-comments, .jetpack-comments') : null);

  let wordpress = { found: false };
  if (wpFormCandidate && isVisible(wpFormCandidate)) {
    const wpSearchScope = wpFormCandidate.closest('#respond, .verbum-comments, .jetpack-comments') || wpFormCandidate;
    const textareaEl = Array.from(wpFormCandidate.querySelectorAll('textarea[name="comment"], textarea#comment, textarea:not([name*="ak_"])'))
      .find(isVisible);
    const richCommentEl = textareaEl ? null : Array.from(
      wpSearchScope.querySelectorAll(
        '.verbum-editor [contenteditable="true"], .verbum-editor [contenteditable=""], .block-editor-rich-text__editable[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"], [role="textbox"]'
      )
    ).find(el => isVisible(el) && (isContentEditableEl(el) || el.getAttribute('role') === 'textbox'));
    const commentEl = textareaEl || richCommentEl;
    const authorEl = Array.from(wpSearchScope.querySelectorAll('input[name="author"], input#author, input[name="name"], input[placeholder*="name" i], input[aria-label*="name" i]')).find(isVisible);
    const emailEl = Array.from(wpSearchScope.querySelectorAll('input[name="email"], input#email, input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i]')).find(isVisible);
    const urlEl = Array.from(wpSearchScope.querySelectorAll('input[name="url"], input#url, input[type="url"], input[name*="website" i], input[placeholder*="website" i], input[placeholder*="url" i], input[aria-label*="website" i]')).find(isVisible);
    const submitEl = Array.from(
      wpSearchScope.querySelectorAll('#submit, button#submit, input#submit, button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"]), [role="button"]')
    ).find(el => {
      if (!isVisible(el)) return false;
      if (el.id === 'submit' || el.type === 'submit') return true;
      const t = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
      return /^(?:post\s+comment|comment|publish|submit|reply|send|发表评论|提交评论|发布|提交)$/i.test(t);
    });
    const guestToggleRegex = /^(?:add\s+your\s+name|continue\s+as\s+(?:a\s+)?guest|comment\s+as\s+(?:a\s+)?guest|post\s+as\s+(?:a\s+)?guest|leave\s+a\s+comment\s+as\s+(?:a\s+)?guest|fill\s+in\s+your\s+details|use\s+name\s+and\s+email)$/i;
    const guestToggleEl = Array.from(wpSearchScope.querySelectorAll('button, [role="button"], a')).find(el => {
      if (!isVisible(el) || el === submitEl) return false;
      const t = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
      return guestToggleRegex.test(t);
    });
    const captcha = detectFormCaptcha(wpFormCandidate, 'wordpress');

    if (commentEl && isVisible(commentEl)) {
      const commentIsContentEditable = commentEl.localName !== 'textarea';
      wordpress = {
        found: true,
        formSelector: selectorFor(wpFormCandidate) || 'form#commentform',
        commentSelector: selectorFor(commentEl, wpSearchScope),
        ...(commentIsContentEditable ? { commentIsContentEditable: true } : {}),
        ...(authorEl && isVisible(authorEl) ? {
          authorSelector: selectorFor(authorEl, wpSearchScope),
          authorRequired: !!(authorEl.required || authorEl.getAttribute('aria-required') === 'true'),
        } : {}),
        ...(emailEl && isVisible(emailEl) ? {
          emailSelector: selectorFor(emailEl, wpSearchScope),
          emailRequired: !!(emailEl.required || emailEl.getAttribute('aria-required') === 'true'),
        } : {}),
        ...(urlEl && isVisible(urlEl) ? {
          urlSelector: selectorFor(urlEl, wpSearchScope),
        } : {}),
        ...(submitEl && isVisible(submitEl) ? {
          submitSelector: selectorFor(submitEl, wpSearchScope),
        } : {}),
        ...(guestToggleEl && isVisible(guestToggleEl) ? {
          guestToggleSelector: selectorFor(guestToggleEl, wpSearchScope),
        } : {}),
        ...(captcha.detected ? { captcha } : {}),
      };
    }
  }

  // If #comment exists in DOM but is hidden (collapsed theme such as SmartMag), find expand trigger.
  if (!wordpress.found && (wpAnyTextarea || wpFormCandidate)) {
    const collapsedTriggerRegex = /\b(?:add\s+a\s+comment|leave\s+a\s+comment|leave\s+a\s+reply|show\s+comments|view\s+comments|load\s+comments|write\s+a\s+comment|post\s+a\s+comment)\b|发表评论|展开评论|写评论|查看评论/i;
    const collapsedTrigger =
      Array.from(document.querySelectorAll('a.ts-button, .comments-show-btn, .show-comments, [data-target*="comment" i], [aria-controls*="comment" i]'))
        .find(el => isVisible(el) && !el.closest('header, nav, [role="navigation"]'))
      || Array.from(document.querySelectorAll('#comments a, #comments button, .comments-area a, .comments-area button, main a, main button, article a, article button, a, button, [role="button"]'))
        .find(el => {
          if (!isVisible(el) || el.closest('header, nav, [role="navigation"]')) return false;
          const t = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
          return collapsedTriggerRegex.test(t);
        });
    if (collapsedTrigger) {
      const sel = selectorFor(collapsedTrigger);
      if (sel) {
        wordpress = { found: false, collapsedTriggerSelector: sel };
      }
    }
  }

  // Non-WP comment forms: Typecho (author/mail/url/text) & common custom blog forms (name/email/website/body).
  let genericComment = { found: false };
  if (!wordpress.found && !isWix) {
    const visibleForms = Array.from(document.querySelectorAll('form')).filter(isVisible);
    // 1) Typecho comment form
    for (const form of visibleForms) {
      const textEl = form.querySelector('textarea[name="text"], textarea#textarea');
      const mailEl = form.querySelector('input[name="mail"]');
      const authorEl = form.querySelector('input[name="author"]');
      const urlEl = form.querySelector('input[name="url"]');
      const formAction = clean(form.getAttribute('action'));
      const looksTypecho = !!(textEl && isVisible(textEl) && (mailEl || /\/comment(?:\/|$|\?)/i.test(formAction) || isTypecho));
      if (looksTypecho) {
        const submitEl = form.querySelector('button[type="submit"], input[type="submit"], button.submit, button:not([type="button"]):not([type="reset"])');
        const captcha = detectFormCaptcha(form, 'typecho');
        genericComment = {
          found: true,
          kind: 'typecho',
          formSelector: selectorFor(form),
          commentSelector: selectorFor(textEl, form),
          ...(authorEl && isVisible(authorEl) ? {
            authorSelector: selectorFor(authorEl, form),
            authorRequired: !!(authorEl.required || authorEl.getAttribute('aria-required') === 'true'),
          } : {}),
          ...(mailEl && isVisible(mailEl) ? {
            emailSelector: selectorFor(mailEl, form),
            emailRequired: !!(mailEl.required || mailEl.getAttribute('aria-required') === 'true'),
          } : {}),
          ...(urlEl && isVisible(urlEl) ? {
            urlSelector: selectorFor(urlEl, form),
          } : {}),
          ...(submitEl && isVisible(submitEl) ? {
            submitSelector: selectorFor(submitEl, form),
          } : {}),
          ...(captcha.detected ? { captcha } : {}),
        };
        break;
      }
    }

    // 2) Custom blog comment form (name / email / website / body or comment-scoped form)
    if (!genericComment.found) {
      for (const form of visibleForms) {
        const commentEl = form.querySelector(
          'textarea[name="body"], textarea[name="comment"], textarea[name="content"], textarea[name="message"], textarea[id*="comment" i], textarea[placeholder*="comment" i]'
        );
        if (!commentEl || !isVisible(commentEl)) continue;
        const formMeta = clean(
          (form.id || '') + ' '
          + (form.getAttribute('class') || '') + ' '
          + (form.getAttribute('action') || '') + ' '
          + (form.closest('#comments, #respond, .comments, .comments-area, .comment-section') ? 'comment-section' : '')
        );
        const submitEl = form.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])');
        const submitText = submitEl ? clean(submitEl.innerText || submitEl.textContent || submitEl.getAttribute('value')) : '';
        const authorEl = form.querySelector('input[name="name"], input[name="author"], input[id="name"], input[id="author"]');
        const emailEl = form.querySelector('input[name="email"], input[name="mail"], input[type="email"]');
        const urlEl = form.querySelector('input[name="website"], input[name="url"], input[name="homepage"], input[type="url"]');

        const hasClassicBlogBodyTuple = !!(
          commentEl.getAttribute('name') === 'body'
          && (authorEl || emailEl || urlEl)
        );
        const hasCommentContext = /comment|reply|respond|评论|留言/i.test(formMeta + ' ' + submitText);
        const looksLikeDirectory = /\b(?:submit\s+(?:tool|site|product|listing)|tool\s+name|site_title|site_url)\b/i.test(
          clean(form.outerHTML).slice(0, 1200)
        );

        if ((hasClassicBlogBodyTuple || hasCommentContext) && !looksLikeDirectory) {
          const captcha = detectFormCaptcha(form, 'blog');
          genericComment = {
            found: true,
            kind: 'custom_blog',
            formSelector: selectorFor(form),
            commentSelector: selectorFor(commentEl, form),
            ...(authorEl && isVisible(authorEl) ? {
              authorSelector: selectorFor(authorEl, form),
              authorRequired: !!(authorEl.required || authorEl.getAttribute('aria-required') === 'true'),
            } : {}),
            ...(emailEl && isVisible(emailEl) ? {
              emailSelector: selectorFor(emailEl, form),
              emailRequired: !!(emailEl.required || emailEl.getAttribute('aria-required') === 'true'),
            } : {}),
            ...(urlEl && isVisible(urlEl) ? {
              urlSelector: selectorFor(urlEl, form),
            } : {}),
            ...(submitEl && isVisible(submitEl) ? {
              submitSelector: selectorFor(submitEl, form),
            } : {}),
            ...(captcha.detected ? { captcha } : {}),
          };
          break;
        }
      }
    }
  }

  // Wix blog comment & layout structure detection (separates lazy placeholders & counters from interactive controls).
  const isSectionPlaceholderHook = hook => /^(?:comments-section-placeholder|comments-placeholder|blog-comments-placeholder)$/i.test(hook);
  const isCounterHook = hook => /^comments?-count(?:er)?(?:-wrapper)?$|^post-footer__comment-count$/i.test(hook);
  const allCommentHookEls = Array.from(document.querySelectorAll('[data-hook*="comment" i], [data-testid*="comment" i], #comments'));
  const commentHooks = [];
  for (const el of allCommentHookEls) {
    const h = clean(el.getAttribute('data-hook') || el.getAttribute('data-testid') || (el.id === 'comments' ? '#comments' : ''));
    if (h && !commentHooks.includes(h)) commentHooks.push(h);
    if (commentHooks.length >= 12) break;
  }
  const hasCounterHookEl = allCommentHookEls.some(el => isCounterHook(clean(el.getAttribute('data-hook'))));
  const wixCommentRoots = allCommentHookEls.filter(el => {
    if (!isVisible(el)) return false;
    const h = clean(el.getAttribute('data-hook'));
    if (isSectionPlaceholderHook(h) || /^skeleton-loader$/i.test(h) || isCounterHook(h) || /comment-count/i.test(h)) return false;
    const text = extractVisibleText(el);
    const hasInteractiveChild = !!el.querySelector('button, input, textarea, select, iframe, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
    const isInteractiveItself = el.localName === 'button'
      || el.localName === 'textarea'
      || isContentEditableEl(el)
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

  const bodyTextClean = extractVisibleText(document.body);
  const hasCommentsLoadingText = /\bcomments\s+loading\b|\bloading\s+comments\b/i.test(bodyTextClean);
  const placeholderEls = Array.from(document.querySelectorAll(
    '[data-hook="comments-section-placeholder"], [data-hook="comments-placeholder"], [data-hook="blog-comments-placeholder"]'
  ));
  const isPlaceholderEmpty = (el) => {
    const text = extractVisibleText(el);
    if (text.length > 0) return false;
    if (el.querySelector('button, input, textarea, select, iframe, a[href], [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="button"], [role="progressbar"], [aria-busy="true"]')) {
      return false;
    }
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (rect && rect.height > 8) return false;
    return true;
  };
  const hasVisibleSpinnerOrSkeleton = Array.from(document.querySelectorAll(
    '[data-hook="skeleton-loader"], [data-hook*="loader" i], [data-hook*="spinner" i], [role="progressbar"], [aria-busy="true"], [data-hook*="comment" i] [class*="spinner" i], [data-hook*="comment" i] [class*="loading" i], article [class*="spinner" i]'
  )).some(isVisible);
  const hasLoadingIndicator = hasCommentsLoadingText || hasVisibleSpinnerOrSkeleton;
  const hasNonZeroCommentCount = allCommentHookEls.some(el => {
    if (!isVisible(el)) return false;
    const h = clean(el.getAttribute('data-hook'));
    if (!isCounterHook(h)) return false;
    const t = extractVisibleText(el);
    const nums = t.match(/\d+/g);
    return !!(nums && nums.some(n => Number(n) > 0));
  });
  const hasCommentListNode = Array.from(document.querySelectorAll(
    '[data-hook="top-level-comment-list"], [data-hook*="comment-list" i], [data-hook="comment-item"], [data-hook="single-comment"]'
  )).some(el => isVisible(el) && (extractVisibleText(el).length > 0 || el.children.length > 0));
  const hasCommentListOrCount = hasNonZeroCommentCount || hasCommentListNode;
  const hasWriteCommentPrompt = /\b(?:write\s+a\s+comment|leave\s+a\s+comment|add\s+a\s+comment|post\s+a\s+comment)\b|escreva\s+um\s+coment|escribe\s+un\s+coment|escribir\s+un\s+coment|kirjoita\s+kommentti|écrire\s+un\s+commentaire|写评论|发表评论|เขียนความคิดเห็น/i.test(bodyTextClean);
  const hasEmptyCommentPlaceholder = isWix && placeholderEls.length > 0 && placeholderEls.every(isPlaceholderEmpty);

  const hasLazyPlaceholder = isWix && (
    placeholderEls.length > 0
    || allCommentHookEls.some(el => isSectionPlaceholderHook(clean(el.getAttribute('data-hook'))))
    || hasCommentsLoadingText
    || (!isBlogListPage && !!document.querySelector('[data-hook="skeleton-loader"]'))
  );

  const scrollHeight = Math.max(
    document.documentElement ? (document.documentElement.scrollHeight || 0) : 0,
    document.body ? (document.body.scrollHeight || 0) : 0,
  );
  const scrollY = Math.round(window.scrollY || (document.documentElement ? document.documentElement.scrollTop : 0) || 0);
  const readyState = typeof document.readyState === 'string' ? document.readyState : 'complete';
  const tailWindowText = bodyTextClean.slice(-1500);
  const hasCommentHintText = /\b(?:write a comment|comments?|leave a comment|add a comment|escreva|escribe|escribir|kirjoita|kommentar|écrire|coment[aá]rios?|commentaires?|kommentare?|评论|留言|ความคิดเห็น)\b/i.test(tailWindowText);
  const isComplexWixLayout = isWix && (
    !!document.querySelector('[id*="SITE_CONTAINER"], [data-hook="recent-posts"]')
    || /wix-warmup-data|communities-blog-ooi/i.test(docHtmlPrefix)
    || scrollHeight > 1800
    || readyState !== 'complete'
    || hasCommentHintText
  );

  // Detect visible Wix comment editor FIRST so already-logged-in Wix blogs (e.g. visible
  // comment-box-rce-wrapper + Publish) are never blocked by leftover comment-count or placeholders.
  const wixEditorEl = isWix ? Array.from(document.querySelectorAll([
    '[data-hook="comment-box-rce-wrapper"][contenteditable="true"]',
    '[data-hook="comment-box-rce-wrapper"][contenteditable=""]',
    '[data-hook="comment-box-rce-wrapper"][role="textbox"]',
    '[data-hook="comment-box-rce-wrapper"] [contenteditable="true"]',
    '[data-hook="comment-box-rce-wrapper"] [contenteditable=""]',
    '[data-hook="comment-box-rce-wrapper"] [contenteditable="plaintext-only"]',
    '[data-hook="comment-box-rce-wrapper"] [role="textbox"]',
    '[data-hook="comment-box-rce-wrapper"] textarea',
    '[data-hook="comment-box-rce-wrapper"] .ProseMirror',
    '[data-hook="comment-box-rce-wrapper"] .public-DraftEditor-content',
    '[data-hook*="comment-box"] [contenteditable="true"]',
    '[data-hook*="comment-box"] [contenteditable=""]',
    '[data-hook="ricos-tiptap-editor"] [contenteditable="true"]',
    '[data-hook="fullRicosEditor"] [contenteditable="true"]',
    '[data-hook="create-comment-input"]',
    '[data-hook*="comment"] [contenteditable="true"]',
    '[data-hook*="comment"] [contenteditable=""]',
    '[data-hook*="comment"] [role="textbox"]',
    '[data-hook*="comment"] textarea',
    '[data-hook*="comment"] .tiptap.ProseMirror',
    '[data-hook*="comment"] .public-DraftEditor-content',
    '[placeholder*="Write a comment" i]',
    '[aria-label*="Write a comment" i]',
    '[placeholder*="Add a comment" i]',
    '[placeholder*="Leave a comment" i]',
    'form textarea[placeholder*="comment" i]',
    'form textarea[aria-label*="comment" i]',
  ].join(', '))).find(el => isVisible(el) && (isContentEditableEl(el) || el.localName === 'textarea' || el.getAttribute('role') === 'textbox')) : null;

  const wixHasCommentSection = isWix && (wixCommentRoots.length > 0 || !!wixEditorEl);
  const wixLoginRegex = /\b(?:log\s*in|sign\s*in)\s+to\s+(?:comment|publish|reply|post)\b|\b(?:log\s*in|sign\s*in)\s+to\s+publish\s+as\s+a\s+member\b|\bsign\s*up\s+to\s+comment\b|faça\s+login\s+para\s+(?:comentar|publicar)|inicia(?:r)?\s+sesi[oó]n\s+para\s+(?:comentar|publicar)|connectez-vous\s+pour\s+(?:commenter|publier)|登录.*(?:评论|发表)/i;
  const wixShortLoginBtnRegex = /^\s*(?:log\s*in|sign\s*in|sign\s*up|faça\s+login|fazer\s+login|iniciar\s+sesi[oó]n|inicia\s+sesi[oó]n|se\s+connecter|connexion|anmelden|einloggen|kirjaudu(?:\s+sisään)?|登录|登入)\b/i;

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
      el.querySelector('input[type="password"], [data-testid*="signUp" i], [data-testid*="login" i], iframe[src*="recaptcha" i]')
      || /\b(?:log\s*in\s+to|sign\s*up\s+to|continue\s+with\s+google|sign\s+up\s+with\s+google|sign\s+in\s+with\s+google|already\s+a\s+member)\b/i.test(t)
    );
  });

  // Check visible guest Name/Email inputs inside Wix comment roots.
  const hasVisibleWixGuestInputs = wixCommentRoots.some(root => {
    const nameIn = Array.from(root.querySelectorAll('input[type="text"], input:not([type])')).find(el =>
      isVisible(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')))
    );
    const emailIn = Array.from(root.querySelectorAll('input[type="email"], input[name*="email" i]')).find(isVisible);
    return !!(nameIn || emailIn);
  });

  // Collect login controls inside Wix comment roots or open member dialog.
  const loginControlScopes = [
    ...wixCommentRoots,
    ...(wixMemberDialog ? [wixMemberDialog] : []),
  ];
  const loginButtons = [];
  const ssoProviders = [];
  const pushUnique = (arr, val, limit) => {
    if (val && !arr.includes(val) && arr.length < limit) arr.push(val);
  };
  for (const scope of loginControlScopes) {
    for (const el of scope.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i], button, a, [role="button"]')) {
      if (!isVisible(el)) continue;
      const hook = clean(el.getAttribute('data-hook'));
      const label = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
      const low = (label + ' ' + hook + ' ' + clean(el.getAttribute('data-testid')) + ' ' + clean(el.getAttribute('href'))).toLowerCase();
      if (/google|gsi\/button/.test(low)) pushUnique(ssoProviders, 'google', 6);
      if (/facebook|fb-login/.test(low)) pushUnique(ssoProviders, 'facebook', 6);
      if (/appleid|with apple/.test(low)) pushUnique(ssoProviders, 'apple', 6);
      const isLoginHook = /login|signup|sign-up|sign-in/i.test(hook + ' ' + clean(el.getAttribute('data-testid')));
      if (isLoginHook || wixLoginRegex.test(label) || wixShortLoginBtnRegex.test(label)) {
        const sel = selectorFor(el);
        pushUnique(loginButtons, (label || hook || 'login') + (sel ? ' (' + sel + ')' : ''), 6);
      }
    }
  }

  const wixGlobalLoginButton = Array.from(document.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i], button, a'))
    .find(el => isVisible(el) && !el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]') && wixLoginRegex.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));

  const wixCommentScopedLogin = loginButtons.length > 0 && !hasVisibleWixGuestInputs;
  const wixLoginRequired = isWix && (
    wixCommentScopedLogin
    || (wixLoginRegex.test(wixContainerText) && !hasVisibleWixGuestInputs)
    || (!wixEditorEl && !!wixGlobalLoginButton && !hasVisibleWixGuestInputs)
    || (!!wixExplicitMemberLogin && !hasVisibleWixGuestInputs)
    || !!wixMemberDialog
  );

  const wixLoginInfo = wixLoginRequired
    ? {
        loginButtons,
        ssoProviders,
        ...(wixMemberDialog && wixMemberDialog.querySelector('input[type="email"], input[type="password"]') ? { hasEmailForm: true } : {}),
        ...(wixMemberDialog ? { dialogText: extractVisibleText(wixMemberDialog).slice(0, 200) } : {}),
      }
    : undefined;

  let wix = {
    hasCommentSection: wixHasCommentSection,
    loginRequired: wixLoginRequired,
    captchaDetected: isWix && pageVisibleCaptcha,
    hasGuestEditor: false,
    hasLazyPlaceholder: isWix && hasLazyPlaceholder,
    hasEmptyCommentPlaceholder,
    hasLoadingIndicator: isWix && hasLoadingIndicator,
    hasCommentListOrCount: isWix && hasCommentListOrCount,
    hasWriteCommentPrompt: isWix && hasWriteCommentPrompt,
    hasCommentCountOnly: isWix && hasCounterHookEl && !wixEditorEl,
    hasBlogPostStructure,
    isBlogListPage,
    isComplexWixLayout,
    ...(commentHooks.length > 0 ? { commentHooks } : {}),
    ...(wixLoginInfo ? { loginInfo: wixLoginInfo } : {}),
  };

  if (isWix && !wixLoginRequired) {
    const editorEl = wixEditorEl;

    const triggerTextRegex = /write\s+a\s+comment|leave\s+a\s+comment|add\s+a\s+comment|post\s+a\s+comment|escribir|escribe\s+un\s+coment|escreva|kirjoita|kommentar|écrire|ecrire|写评论|发表评论|留下评论|เขียนความคิดเห็น/i;
    const triggerEl = editorEl ? null : (
      Array.from(document.querySelectorAll('button[data-hook="comment-box-placeholder"], [data-hook="comment-box-placeholder"], [data-hook="open-comment-box"], [data-hook*="comment-box-placeholder"]'))
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
          return /^\s*(?:write|leave|add|post)\s+a\s+comment\b|^\s*(?:escribir|escribe|escreva|kirjoita|kommentar|écrire|ecrire|写评论|เขียนความคิดเห็น)/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
        })
    );

    if (editorEl) {
      const boxScope = editorEl.closest('[data-hook*="comment-box"]:not([data-hook*="rce-wrapper"])')
        || (editorEl.parentElement ? editorEl.parentElement.closest('[data-hook*="comment"]:not([data-hook*="rce-wrapper"]), [data-testid*="comment"], form') : null)
        || editorEl.closest('[data-hook="comment-box-rce-wrapper"]')
        || document;
      const outerScope = editorEl.closest('[data-hook*="comments-section"], [data-testid*="comment"], #comments, section, article, form')
        || (boxScope.parentElement ? boxScope.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], section, article, main') : null)
        || (boxScope.parentElement && boxScope.parentElement !== document.body ? boxScope.parentElement : null)
        || document;
      const nameEl = Array.from(boxScope.querySelectorAll('input[type="text"], input:not([type])')).find(el => isVisible(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''))));
      const emailEl = Array.from(boxScope.querySelectorAll('input[type="email"], input[name*="email" i]')).find(isVisible);
      const websiteEl = Array.from(boxScope.querySelectorAll('input[type="url"], input[name*="website" i], input[name*="url" i], input[placeholder*="website" i]')).find(isVisible);
      const findLinkBtn = (scope) => Array.from(scope.querySelectorAll('button, [role="button"]')).find(el => isVisible(el) && /\blink\b|插入链接|链接/i.test(clean((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-hook') || '') + ' ' + (el.getAttribute('data-testid') || ''))));
      const findSubmitBtn = (scope) => Array.from(scope.querySelectorAll('[data-hook="submit-comment-button"], [data-hook="publish-comment-button"], [data-hook*="publish" i], [data-hook="primary-btn"], button[type="submit"], button, [role="button"]')).find(el => {
        if (!isVisible(el)) return false;
        const hook = clean(el.getAttribute('data-hook'));
        if (hook === 'submit-comment-button' || hook === 'publish-comment-button') return true;
        if (hook === 'primary-btn' && el.closest('[data-hook*="comment-box"], [data-hook*="comments-section"], [data-hook*="comment"]')) return true;
        return /^(?:publish(?:\s+comment)?|post(?:\s+comment)?|submit(?:\s+comment)?|comment|reply|publicar|enviar|publier|veröffentlichen|julkaise|เผยแพร่|โพสต์|ส่ง|公開|게시|发布|提交|评论)$/i.test(
          clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'))
        );
      });
      const linkBtnInBox = findLinkBtn(boxScope);
      const linkBtn = linkBtnInBox || findLinkBtn(outerScope);
      const linkBtnScope = linkBtnInBox ? boxScope : outerScope;
      const submitInBox = findSubmitBtn(boxScope);
      const submitEl = submitInBox || findSubmitBtn(outerScope);
      const submitScope = submitInBox ? boxScope : outerScope;

      wix = {
        ...wix,
        hasCommentSection: true,
        loginRequired: false,
        hasGuestEditor: true,
        hasCommentCountOnly: false,
        editorSelector: selectorFor(editorEl, boxScope),
        editorIsContentEditable: isContentEditableEl(editorEl) || editorEl.getAttribute('role') === 'textbox',
        ...(nameEl ? { nameSelector: selectorFor(nameEl, boxScope) } : {}),
        ...(emailEl ? { emailSelector: selectorFor(emailEl, boxScope) } : {}),
        ...(websiteEl ? { websiteSelector: selectorFor(websiteEl, boxScope) } : {}),
        ...(linkBtn ? { linkButtonSelector: selectorFor(linkBtn, linkBtnScope) } : {}),
        ...(submitEl ? { submitSelector: selectorFor(submitEl, submitScope) } : {}),
      };
    } else if (triggerEl) {
      wix = {
        ...wix,
        hasCommentSection: true,
        loginRequired: false,
        hasGuestEditor: false,
        hasCommentCountOnly: false,
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
    isTypecho,
    hasBloggerCommentIframe,
    readyState,
    scrollHeight,
    commentsClosed: {
      matched: closedPhrase.length > 0,
      ...(closedPhrase ? { phrase: closedPhrase } : {}),
    },
    wordpress,
    ...(genericComment.found ? { genericComment } : {}),
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
})()`;
/** Post-Publish Wix inspection checking visible `role=dialog` for reCAPTCHA, login/signup, or moderation (incl. Thai 'รับทราบ'). */
const INSPECT_WIX_POST_SUBMIT_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const unique = (el, sel) => {
    if (!sel) return false;
    try {
      const list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };
  const selectorFor = (el) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (unique(el, byId)) return byId;
    }
    const hook = el.getAttribute('data-hook');
    if (hook) {
      const byHook = '[data-hook="' + hook.replace(/"/g, '\\"') + '"]';
      if (unique(el, byHook)) return byHook;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byTestId)) return byTestId;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const byAria = el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
      if (unique(el, byAria)) return byAria;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (unique(el, path)) return path;
    }
    return '';
  };
  const extractText = (el) => {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.length > 0) return clean(el.innerText);
    const clone = el.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const s of clone.querySelectorAll('script,style,noscript')) s.remove();
    }
    if (clone && typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      const parts = [];
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const t = clean(node.textContent);
        if (t) parts.push(t);
        node = walker.nextNode();
      }
      if (parts.length > 0) return clean(parts.join(' '));
    }
    return clean(clone ? clone.textContent : '');
  };

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [id^="SM_ROOT_COMP"]'))
    .filter(isVisible);

  const moderationRegex = /awaiting\s+moderation|pending\s+approval|pending\s+review|held\s+for\s+moderation|submitted\s+for\s+review|under\s+review|moderation|waiting\s+for\s+approval|will\s+appear\s+(?:once|after)\s+(?:it\s+is\s+)?approved|aguardando\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)|pendiente\s+de\s+(?:moderaci[oó]n|aprobaci[oó]n)|en\s+attente\s+de\s+(?:mod[ée]ration|validation|approbation)|wartet\s+auf\s+(?:freischaltung|moderation)|in\s+attesa\s+di\s+(?:moderazione|approvazione)|wacht\s+op\s+goedkeuring|oczekuje\s+na\s+(?:moderacj[ęe]|zatwierdzenie)|onay\s+bekliyor|ожидает\s+модерации|на\s+модерации|รอการอนุมัติ|รอการตรวจสอบ|รอตรวจสอบ|กำลังรอการอนุมัติ|อยู่ระหว่างการตรวจสอบ|ได้รับการอนุมัติ|ความคิดเห็นของคุณ.*อนุมัติ|承認待ち|審査中|승인\s*대기|검토\s*중|đang\s+chờ\s+(?:duyệt|kiểm\s+duyệt)|menunggu\s+(?:persetujuan|moderasi)|等待审核|待审核|审核通过后显示/i;
  const loginRegex = /\b(?:sign\s*up|log\s*in|sign\s*in|continue\s+with\s+google|sign\s+up\s+with\s+google|sign\s+in\s+with\s+google|already\s+a\s+member|faça\s+login|iniciar\s+sesi[oó]n|se\s+connecter|anmelden|kirjaudu)\b|เข้าสู่ระบบ|ลงทะเบียน|登录|注册/i;
  const errorDialogRegex = /\b(?:error|failed|invalid|cannot\s+post|unable\s+to\s+post|try\s+again\s+later)\b|เกิดข้อผิดพลาด|ไม่สามารถ/i;
  const ackButtonRegex = /^(?:got\s*it|ok|okay|done|close|understood|entendido|compris|verstanden|รับทราบ|ตกลง|知道了|好的|确定|了解|확인)$/i;
  const thaiAckRegex = /^รับทราบ$/i;

  let hasCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile'
  );
  let hasLoginDialog = false;
  let moderationNotice = '';
  let ackButtonSelector = '';
  let dialogText = '';
  const loginButtons = [];
  const ssoProviders = [];
  let hasEmailForm = false;

  for (const dialog of dialogs) {
    const text = extractText(dialog);
    if (!dialogText && text) dialogText = text.slice(0, 240);
    const dialogHasCaptcha = !!(
      dialog.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile')
      || /\b(?:recaptcha|hcaptcha|turnstile|i'm\s+not\s+a\s+robot)\b/i.test(text)
    );
    if (dialogHasCaptcha) {
      hasCaptcha = true;
    }
    const dialogIsLogin = !!(
      dialog.querySelector('[data-testid*="signUp" i], [data-testid*="login" i], input[type="password"]')
      || loginRegex.test(text)
    );
    if (dialogIsLogin) {
      hasLoginDialog = true;
      if (dialog.querySelector('input[type="email"], input[type="password"]')) hasEmailForm = true;
      for (const btn of dialog.querySelectorAll('button, a, [role="button"]')) {
        if (!isVisible(btn)) continue;
        const lbl = clean(btn.innerText || btn.textContent || btn.getAttribute('aria-label'));
        const low = (lbl + ' ' + clean(btn.getAttribute('data-testid')) + ' ' + clean(btn.getAttribute('href'))).toLowerCase();
        if (/google/.test(low) && !ssoProviders.includes('google')) ssoProviders.push('google');
        if (/facebook/.test(low) && !ssoProviders.includes('facebook')) ssoProviders.push('facebook');
        if (lbl && loginButtons.length < 6 && !loginButtons.includes(lbl)) loginButtons.push(lbl);
      }
    }
    const ackBtn = Array.from(dialog.querySelectorAll('button, [role="button"], a')).find(btn => {
      if (!isVisible(btn)) return false;
      const lbl = clean(btn.innerText || btn.textContent || btn.getAttribute('aria-label'));
      return ackButtonRegex.test(lbl);
    });
    const ackLabel = ackBtn ? clean(ackBtn.innerText || ackBtn.textContent || ackBtn.getAttribute('aria-label')) : '';
    const modMatch = moderationRegex.exec(text);
    const isThaiAckModeration = !dialogIsLogin && !dialogHasCaptcha && !errorDialogRegex.test(text) && thaiAckRegex.test(ackLabel);
    if ((modMatch || isThaiAckModeration) && !moderationNotice) {
      moderationNotice = modMatch ? modMatch[0] : ackLabel;
      if (ackBtn) {
        ackButtonSelector = selectorFor(ackBtn);
      }
    }
  }

  return {
    hasCaptcha,
    hasLoginDialog,
    ...(moderationNotice ? { moderationNotice } : {}),
    ...(ackButtonSelector ? { ackButtonSelector } : {}),
    ...(dialogText ? { dialogText } : {}),
    ...(hasLoginDialog ? {
      loginInfo: {
        loginButtons,
        ssoProviders,
        ...(hasEmailForm ? { hasEmailForm: true } : {}),
        ...(dialogText ? { dialogText } : {}),
      },
    } : {}),
  };
})()`;
/** Lightweight self-contained script run inside non-ad child frames. */
const INSPECT_CHILD_FRAME_SCRIPT = String.raw`(() => {
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
})()`;
/** Script evaluated inside Blogger `#comment-editor` / `iframe[src*="blogger.com/comment"]`. */
const INSPECT_BLOGGER_FRAME_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const unique = (el, s) => {
    if (!s) return false;
    try {
      const list = document.querySelectorAll(s);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };
  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const hasCaptcha = !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha" i], .h-captcha, .cf-turnstile')
    || /\brecaptcha\b/i.test(bodyText);
  const closedMatch = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+(?:closed|disabled)\b|评论已关闭/i.exec(bodyText);
  const modMatch = /awaiting\s+moderation|visible\s+after\s+approval|pending\s+approval|comment\s+will\s+be\s+published\s+after|รอการอนุมัติ|รอการตรวจสอบ|等待审核|待审核/i.exec(bodyText);
  const errMatch = /your\s+comment\s+could\s+not\s+be\s+saved|error|invalid/i.exec(bodyText);

  const commentEl = Array.from(document.querySelectorAll(
    'textarea#commentBody, textarea[name="commentBody"], textarea, [contenteditable="true"], [role="textbox"]'
  )).find(isVisible);
  const identitySelect = document.querySelector('select#identityMenu, select[name="identityMenu"]');
  const supportsNameUrlIdentity = !!(identitySelect && Array.from(identitySelect.options || []).some(o => /nameurl/i.test(o.value)));
  const anonNameEl = Array.from(document.querySelectorAll('input#anonName, input[name="anonName"]')).find(isVisible);
  const anonUrlEl = Array.from(document.querySelectorAll('input#anonURL, input[name="anonURL"]')).find(isVisible);
  const submitWordRegex = /^(?:publish(?:\s+comment)?|post(?:\s+comment)?|submit(?:\s+comment)?|send|publicar|publier|veröffentlichen|pubblica|publiceren|opublikuj|yayınla|опубликовать|เผยแพร่|โพสต์|公開|投稿|게시|发布|发表|提交|發佈|發表)$/i;
  const submitCandidates = Array.from(document.querySelectorAll(
    'input#postCommentSubmit, button#postCommentSubmit, input[name="postCommentSubmit"], button[name="postCommentSubmit"], [role="button"], button, input[type="submit"], input[type="button"]'
  )).filter(isVisible);
  const submitEl = submitCandidates.find(el => {
    const idOrName = clean((el.id || '') + ' ' + (el.getAttribute('name') || ''));
    if (/postCommentSubmit/i.test(idOrName)) return true;
    const label = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title'));
    return submitWordRegex.test(label);
  });

  const signInBtn = Array.from(document.querySelectorAll('a, button, [role="button"]')).find(el =>
    isVisible(el) && /\b(?:sign\s*in(?:\s+with\s+google)?|log\s*in)\b/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')))
  );
  const loginRequired = !commentEl && (!!signInBtn || /\bsign\s*in\s+with\s+google\b|\bto\s+leave\s+a\s+comment.*sign\s*in\b/i.test(bodyText));

  const sel = (el, fallback) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (unique(el, byId)) return byId;
    }
    const name = el.getAttribute('name');
    if (name) {
      const byName = el.localName + '[name="' + name.replace(/"/g, '\\"') + '"]';
      if (unique(el, byName)) return byName;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const byAria = el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
      if (unique(el, byAria)) return byAria;
    }
    const jsname = el.getAttribute('jsname');
    if (jsname) {
      const byJsname = el.localName + '[jsname="' + jsname.replace(/"/g, '\\"') + '"]';
      if (unique(el, byJsname)) return byJsname;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byTestId)) return byTestId;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (unique(el, path)) return path;
    }
    return fallback;
  };

  return {
    hasCaptcha,
    ...(closedMatch ? { commentsClosedPhrase: closedMatch[0] } : {}),
    loginRequired,
    ...(loginRequired ? {
      loginInfo: {
        loginButtons: signInBtn ? [clean(signInBtn.innerText || signInBtn.textContent)] : ['Sign in with Google'],
        ssoProviders: /google/i.test(bodyText + ' ' + (signInBtn ? clean(signInBtn.innerText || signInBtn.textContent) : '')) ? ['google'] : [],
      },
    } : {}),
    hasEditor: !!commentEl,
    ...(commentEl ? {
      commentSelector: sel(commentEl, 'textarea'),
      ...(commentEl.localName !== 'textarea' ? { commentIsContentEditable: true } : {}),
    } : {}),
    ...(identitySelect ? { identitySelectSelector: sel(identitySelect, 'select#identityMenu'), supportsNameUrlIdentity } : {}),
    ...(anonNameEl ? { anonNameSelector: sel(anonNameEl, 'input[name="anonName"]') } : {}),
    ...(anonUrlEl ? { anonUrlSelector: sel(anonUrlEl, 'input[name="anonURL"]') } : {}),
    ...(submitEl ? { submitSelector: sel(submitEl, '[role="button"], button, input[type="submit"]') } : {}),
    ...(modMatch ? { moderationNotice: modMatch[0] } : {}),
    ...(errMatch && !modMatch ? { errorMessage: errMatch[0] } : {}),
    snippet: bodyText.slice(0, 240),
  };
})()`;
/**
* Self-contained browser evaluation function checking post-submit / post-reload
* live clickable links (including specific `#comment-<id>` nodes with author or
* body `<a href>`), escaped HTML `<a>` text, multilingual moderation notices
* (EN/ES/FR/DE/PT/FA/ZH), WP errors, and compact post-submit snippet.
*/
function verifyCommentResultInDom(params) {
	const dom = globalThis;
	const clean = (v) => String(v ?? "").replace(/\s+/gu, " ").trim();
	const normalizeUrl = (raw) => {
		try {
			const parsed = new URL(raw, dom.location.href);
			return `${parsed.hostname.toLowerCase().replace(/^www\./u, "")}${parsed.pathname.replace(/\/+$/u, "")}`;
		} catch {
			return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/u, "").replace(/\/+$/u, "");
		}
	};
	let targetHost = "";
	const normalizedTarget = params.websiteUrl ? normalizeUrl(params.websiteUrl) : "";
	if (params.websiteUrl) try {
		targetHost = new URL(params.websiteUrl).hostname.toLowerCase().replace(/^www\./u, "");
	} catch {
		targetHost = "";
	}
	const cleanAnchor = clean(params.anchorText).toLowerCase();
	const errEl = dom.document.querySelector(".wp-die-message, #error-page");
	const errText = clean(errEl ? errEl.innerText || errEl.textContent : "");
	const bodyText = clean(dom.document.body ? dom.document.body.innerText || dom.document.body.textContent : "");
	const wpErrorMatch = /duplicate\s+comment\s+detected|comment\s+submission\s+failure|sorry,\s+you\s+must\s+be\s+logged\s+in|you\s+are\s+posting\s+comments\s+too\s+quickly/iu.exec(errText || bodyText);
	const wpErrorMessage = errText || (wpErrorMatch ? wpErrorMatch[0] : void 0);
	const captchaDetected = Boolean(dom.document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*=\"recaptcha\" i], iframe[src*=\"hcaptcha\" i], iframe[src*=\"turnstile\" i]"));
	const modEl = dom.document.querySelector(".comment-awaiting-moderation, .moderation-notice, [class*=\"awaiting-moderation\" i]");
	const modText = clean(modEl ? modEl.innerText || modEl.textContent : "");
	const modMatch = new RegExp([
		"your\\s+comment\\s+is\\s+awaiting\\s+moderation",
		"awaiting\\s+moderation",
		"pending\\s+approval",
		"pending\\s+moderation",
		"pending\\s+review",
		"held\\s+for\\s+moderation",
		"submitted\\s+for\\s+review",
		"waiting\\s+for\\s+(?:moderation|approval)",
		"comment\\s+is\\s+under\\s+review",
		"esperando\\s+moderaci[oó]n",
		"pendiente\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)",
		"esperando\\s+ser\\s+moderado",
		"en\\s+attente\\s+de\\s+(?:mod[ée]ration|validation|approbation)",
		"wartet\\s+auf\\s+(?:freischaltung|moderation)",
		"muss\\s+noch\\s+freigeschaltet\\s+werden",
		"aguardando\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
		"aguarda\\s+modera[çc][ãa]o",
		"pendente\\s+de\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
		"دیدگاه\\s+شما\\s+در\\s+انتظار\\s+(?:بررسی|تایید|تأیید)",
		"در\\s+انتظار\\s+(?:بررسی|تایید|تأیید)",
		"در\\s+صف\\s+بررسی",
		"پس\\s+از\\s+(?:تایید|تأیید)\\s+نمایش",
		"รอการอนุมัติ",
		"รอการตรวจสอบ",
		"รอตรวจสอบ",
		"กำลังรอการอนุมัติ",
		"อยู่ระหว่างการตรวจสอบ",
		"ได้รับการอนุมัติ",
		"等待审核",
		"待审核",
		"审核通过后显示",
		"正在等待审核",
		"审核后显示"
	].join("|"), "iu").exec(modText || bodyText);
	const moderationNotice = modText || (modMatch ? modMatch[0] : void 0);
	const escapedPattern = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)/giu;
	let escapedHtmlDetected = false;
	let escMatch;
	while ((escMatch = escapedPattern.exec(bodyText)) !== null) {
		const rawEscHref = escMatch[1] ?? "";
		if (!normalizedTarget || normalizeUrl(rawEscHref).includes(normalizedTarget) || targetHost && rawEscHref.toLowerCase().includes(targetHost)) {
			escapedHtmlDetected = true;
			break;
		}
	}
	const matchesTargetLink = (link) => {
		const hrefAttr = clean(link.getAttribute("href"));
		if (!hrefAttr || hrefAttr.startsWith("#") || hrefAttr.startsWith("javascript:")) return void 0;
		const normHref = normalizeUrl(hrefAttr);
		const linkText = clean(link.innerText || link.textContent);
		const hrefMatches = normalizedTarget.length > 0 && (normHref === normalizedTarget || normHref.startsWith(`${normalizedTarget}/`) || targetHost.length > 0 && normHref.split("/")[0] === targetHost);
		const anchorMatches = cleanAnchor.length > 0 && linkText.toLowerCase().includes(cleanAnchor);
		if (hrefMatches || normalizedTarget.length === 0 && anchorMatches) return {
			href: hrefAttr,
			text: linkText
		};
	};
	let commentNodeLinkFound = false;
	let matchedHref;
	let matchedAnchor;
	if (params.commentId) {
		const cleanId = params.commentId.replace(/^#/u, "");
		const specificSelectors = [
			`#${cleanId}`,
			`#div-${cleanId}`,
			`[id$="${cleanId}"]`
		];
		for (const sel of specificSelectors) {
			let node = null;
			try {
				node = dom.document.querySelector(sel);
			} catch {
				node = null;
			}
			if (!node) continue;
			for (const link of node.querySelectorAll("a[href]")) {
				const hit = matchesTargetLink(link);
				if (hit) {
					commentNodeLinkFound = true;
					matchedHref = hit.href;
					matchedAnchor = hit.text;
					break;
				}
			}
			if (commentNodeLinkFound) break;
		}
	}
	if (matchedHref === void 0) {
		const scopeContainers = Array.from(dom.document.querySelectorAll("#comments, .comment-list, .comments-area, [data-hook*=\"comment\"], main, article"));
		const candidateLinks = [];
		const seenLinks = /* @__PURE__ */ new Set();
		const pushLinks = (root) => {
			for (const anchor of root.querySelectorAll("a[href]")) {
				if (anchor.closest("header, nav, footer, [role=\"banner\"], [role=\"navigation\"], [role=\"contentinfo\"]")) continue;
				if (!seenLinks.has(anchor)) {
					seenLinks.add(anchor);
					candidateLinks.push(anchor);
				}
			}
		};
		for (const container of scopeContainers) pushLinks(container);
		if (candidateLinks.length === 0) pushLinks(dom.document);
		for (const link of candidateLinks) {
			const hit = matchesTargetLink(link);
			if (hit) {
				matchedHref = hit.href;
				matchedAnchor = hit.text;
				break;
			}
		}
	}
	const snippetRoot = errEl ?? modEl ?? dom.document.querySelector("#comments, .comments-area, [data-hook*=\"comment\"]") ?? dom.document.body;
	const rawSnippet = clean(snippetRoot ? snippetRoot.innerText || snippetRoot.textContent : bodyText);
	const snippet = rawSnippet.length > 0 ? rawSnippet.slice(0, 260) : void 0;
	return {
		liveLinkFound: matchedHref !== void 0,
		...params.commentId ? { commentNodeLinkFound } : {},
		...matchedHref === void 0 ? {} : { matchedHref },
		...matchedAnchor === void 0 ? {} : { matchedAnchor },
		escapedHtmlDetected,
		...moderationNotice === void 0 ? {} : { moderationNotice },
		...wpErrorMessage === void 0 ? {} : { wpErrorMessage },
		...captchaDetected ? { captchaDetected: true } : {},
		...snippet === void 0 ? {} : { snippet }
	};
}
const WIX_PROGRESSIVE_SCROLL_STEPS = [
	.3,
	.6,
	.85,
	1
];
const DEFAULT_PROGRESSIVE_SCROLL_STEPS = [
	.5,
	.85,
	1
];
const CAPTCHA_FRAME_URL_PATTERN = /recaptcha|hcaptcha|turnstile/iu;
const KNOWN_COMMENT_FRAME_URL_PATTERN = /disqus\.com|blogger\.com\/comment|blogspot\.com\/comment|jetpack\.wordpress\.com\/jetpack-comment|giscus\.app|utteranc\.es|hyvor\.com|commentbox\.io|intensedebate|facebook\.com\/plugins\/comments|comments-ooi|wixapps\.net\/.*comment|comment.*iframe/iu;
const NON_COMMENT_FRAME_URL_PATTERN = /^$|^about:blank$|^javascript:|doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net\/.*fbevents|video\.wixstatic\.com|youtube\.com(?:\/|$)|youtu\.be|vimeo\.com|trustpilot\.com|engage\.wixapps\.net|usrfiles\.com|filesusr\.com|google\.com\/maps|maps\.google\.com|calendly\.com|intercom\.io|tawk\.to|crisp\.chat|klaviyo\.com|spotify\.com\/embed|soundcloud\.com\/player/iu;
const POST_SUBMIT_WAF_FINGERPRINT_PATTERN = /litespeed|cloudflare|attention\s+required!|just\s+a\s+moment|sucuri|wordfence|mod_?security|modsecurity|imperva|incapsula|akamai|barracuda|cloudfront|403\s+forbidden|access\s+denied|request\s+blocked|forbidden\s+you\s+don'?t\s+have\s+permission|not\s+acceptable|too\s+many\s+requests|blocked\s+by\s+(?:firewall|waf|security)/iu;
function inferPostSubmitWafProvider(combinedText) {
	if (/litespeed/iu.test(combinedText)) return "litespeed";
	if (/cloudflare|cf-ray|cf-mitigated|attention\s+required!|just\s+a\s+moment/iu.test(combinedText)) return "cloudflare";
	if (/sucuri/iu.test(combinedText)) return "sucuri";
	if (/wordfence/iu.test(combinedText)) return "wordfence";
	if (/mod_?security|modsecurity/iu.test(combinedText)) return "modsecurity";
	if (/cloudfront|x-amz-cf/iu.test(combinedText)) return "cloudfront";
	if (/imperva|incapsula/iu.test(combinedText)) return "imperva";
	if (/akamai/iu.test(combinedText)) return "akamai";
	return "waf";
}
/** Detect HTTP 403 or 406/429 WAF-fingerprinted blocks returned after comment submission. */
function detectPostSubmitWafBlock(input) {
	const combined = [
		Object.entries(input.responseHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join(" "),
		input.title ?? "",
		input.postSubmitSnippet ?? "",
		input.responseSnippet ?? ""
	].filter(Boolean).join(" ");
	const bestSnippet = (input.postSubmitSnippet?.trim() || input.responseSnippet?.trim() || input.title?.trim() || void 0)?.slice(0, 260);
	if (input.httpStatus === 403) return {
		blocked: true,
		httpStatus: 403,
		provider: inferPostSubmitWafProvider(combined),
		...bestSnippet === void 0 ? {} : { snippet: bestSnippet }
	};
	if ((input.httpStatus === 406 || input.httpStatus === 429) && POST_SUBMIT_WAF_FINGERPRINT_PATTERN.test(combined)) return {
		blocked: true,
		httpStatus: input.httpStatus,
		provider: inferPostSubmitWafProvider(combined),
		...bestSnippet === void 0 ? {} : { snippet: bestSnippet }
	};
	const onWpEndpoint = Boolean(input.postSubmitUrl && /wp-comments-post\.php/iu.test(input.postSubmitUrl));
	const hasExplicit403Text = /\b403\s+forbidden\b/iu.test(combined);
	const hasStrongWafVendorAndBlock = /(?:litespeed|cloudflare|sucuri|wordfence|mod_?security|modsecurity)/iu.test(combined) && /(?:403|406|429|forbidden|access\s+denied|request\s+blocked|not\s+acceptable|blocked\s+by)/iu.test(combined);
	if (onWpEndpoint && (hasExplicit403Text || hasStrongWafVendorAndBlock) || hasExplicit403Text && hasStrongWafVendorAndBlock) return {
		blocked: true,
		httpStatus: /\b406\b/u.test(combined) && !/\b403\b/u.test(combined) ? 406 : /\b429\b/u.test(combined) && !/\b403\b/u.test(combined) ? 429 : 403,
		provider: inferPostSubmitWafProvider(combined),
		...bestSnippet === void 0 ? {} : { snippet: bestSnippet }
	};
	return { blocked: false };
}
/** Check whether a Playwright locator is disabled via `isDisabled()`, `aria-disabled="true"`, or `disabled`. */
async function isLocatorDisabled(locator) {
	const probe = locator;
	try {
		if (typeof probe.isDisabled === "function") {
			if (await probe.isDisabled()) return true;
		}
	} catch {}
	try {
		if (typeof probe.getAttribute === "function") {
			const ariaDisabled = await probe.getAttribute("aria-disabled");
			if (ariaDisabled !== null && ariaDisabled.toLowerCase() === "true") return true;
			if (await probe.getAttribute("disabled") !== null) return true;
		}
	} catch {}
	try {
		if (typeof probe.evaluate === "function") {
			if (await probe.evaluate((node) => {
				const el = node;
				if (!el) return false;
				if (el.disabled === true) return true;
				const aria = el.getAttribute?.("aria-disabled");
				if (aria && aria.toLowerCase() === "true") return true;
				const raw = el.getAttribute?.("disabled");
				return raw !== null && raw !== void 0;
			}) === true) return true;
		}
	} catch {}
	return false;
}
const INSPECT_DISABLED_SUBMIT_LOGIN_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const loginPromptRegex = /\b(?:must\s+be\s+logged\s+in|log\s*in\s+to\s+(?:comment|post|publish|reply)|sign\s*in\s+to\s+(?:comment|post|publish|reply)|please\s+(?:log\s*in|sign\s*in)|login\s+required|sign\s*up\s+to\s+comment)\b|请先登录|登录后(?:评论|发表)/i;
  const scopes = Array.from(document.querySelectorAll('#respond, #comments, .comments-area, [data-hook*="comment" i], [role="dialog"], form, main, article'))
    .filter(isVisible);
  const targets = scopes.length > 0 ? scopes : (document.body ? [document.body] : []);
  let matchedText = '';
  const loginButtons = [];
  const ssoProviders = [];
  for (const scope of targets) {
    const t = clean(scope.innerText || scope.textContent);
    const m = loginPromptRegex.exec(t);
    if (m && !matchedText) matchedText = m[0];
    for (const btn of scope.querySelectorAll('button, a, [role="button"]')) {
      if (!isVisible(btn) || btn.closest('header, nav, footer, [role="navigation"]')) continue;
      const lbl = clean(btn.innerText || btn.textContent || btn.getAttribute('aria-label'));
      const low = (lbl + ' ' + clean(btn.getAttribute('href')) + ' ' + clean(btn.getAttribute('data-testid'))).toLowerCase();
      if (/google|gsi\/button/.test(low) && !ssoProviders.includes('google')) ssoProviders.push('google');
      if (/\b(?:log\s*in|sign\s*in|sign\s*up)\b|登录|注册/i.test(lbl) && !loginButtons.includes(lbl) && loginButtons.length < 6) {
        loginButtons.push(lbl);
      }
    }
  }
  const hasLoginPrompt = Boolean(matchedText || loginButtons.length > 0);
  return {
    hasLoginPrompt,
    ...(matchedText ? { matchedText } : {}),
    ...(hasLoginPrompt ? { loginInfo: { loginButtons, ssoProviders } } : {}),
  };
})()`;
const FIND_JETPACK_GUEST_TOGGLE_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const unique = (el, sel) => {
    if (!sel) return false;
    try {
      const list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };
  const selectorFor = (el) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (unique(el, byId)) return byId;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byTestId)) return byTestId;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const byAria = el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
      if (unique(el, byAria)) return byAria;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (unique(el, path)) return path;
    }
    return '';
  };
  const guestToggleRegex = /^(?:add\s+your\s+name|continue\s+as\s+(?:a\s+)?guest|comment\s+as\s+(?:a\s+)?guest|post\s+as\s+(?:a\s+)?guest|leave\s+a\s+comment\s+as\s+(?:a\s+)?guest|fill\s+in\s+your\s+details|use\s+name\s+and\s+email)$/i;
  const scope = document.querySelector('#respond, .verbum-comments, .jetpack-comments, form#commentform, form[action*="wp-comments-post.php"]') || document;
  const btn = Array.from(scope.querySelectorAll('button, [role="button"], a')).find(el => {
    if (!isVisible(el)) return false;
    const t = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
    return guestToggleRegex.test(t);
  });
  return btn ? selectorFor(btn) : '';
})()`;
async function inspectDisabledSubmitLoginPrompt(page) {
	if (typeof page.evaluate !== "function") return { hasLoginPrompt: false };
	return await page.evaluate(INSPECT_DISABLED_SUBMIT_LOGIN_SCRIPT).catch(() => ({ hasLoginPrompt: false }));
}
async function findDynamicJetpackGuestToggle(page) {
	if (typeof page.evaluate !== "function") return void 0;
	const sel = await page.evaluate(FIND_JETPACK_GUEST_TOGGLE_SCRIPT).catch(() => "");
	return sel && sel.length > 0 ? sel : void 0;
}
function defaultSleep$1(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(new BrowserError("browser comment_publish aborted", "BROWSER_ABORTED"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new BrowserError("browser comment_publish aborted", "BROWSER_ABORTED"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function throwIfAborted$2(signal) {
	if (signal?.aborted) throw new BrowserError("browser comment_publish aborted", "BROWSER_ABORTED");
}
function isNavigationContextError(error) {
	const msg = String(error instanceof Error ? error.message : error);
	if (/session is closed/iu.test(msg)) return false;
	return /execution context was destroyed|frame was detached|cannot find context with specified id|most likely because of a navigation/iu.test(msg);
}
async function scrollPageStep(page, fraction) {
	await page.evaluate((stepFraction) => {
		const dom = globalThis;
		const docHeight = Math.max(dom.document.documentElement?.scrollHeight ?? 0, dom.document.body?.scrollHeight ?? 0);
		const placeholder = dom.document.querySelector("[data-hook=\"comments-section-placeholder\"], [data-hook=\"comment-box-placeholder\"], [data-hook*=\"comment-box\"], [data-hook=\"comments-section\"]");
		if (placeholder && typeof placeholder.scrollIntoView === "function") placeholder.scrollIntoView({
			behavior: "instant",
			block: "center"
		});
		else if (stepFraction >= .65) {
			const anchor = dom.document.querySelector("#comments, #respond, form#commentform, [data-hook=\"top-level-comment-list\"], iframe[src*=\"blogger.com/comment\"]");
			if (anchor && typeof anchor.scrollIntoView === "function") anchor.scrollIntoView({
				behavior: "instant",
				block: "center"
			});
			else if (typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
		} else if (typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
		if (typeof dom.Event === "function" && typeof dom.window.dispatchEvent === "function") try {
			dom.window.dispatchEvent(new dom.Event("scroll"));
		} catch {}
	}, fraction).catch(() => void 0);
}
async function evaluateFrameWithTimeout(frame, timeoutMs) {
	let timer;
	try {
		return await Promise.race([frame.evaluate(INSPECT_CHILD_FRAME_SCRIPT).catch(() => null), new Promise((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
async function inspectChildFrames(page) {
	if (typeof page.frames !== "function") return {
		frames: [],
		hasActionableCommentFrame: false,
		hasUnknownInteractiveFrame: false,
		captchaDetected: false
	};
	const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : void 0;
	const frameSummaries = [];
	let hasActionableCommentFrame = false;
	let hasUnknownInteractiveFrame = false;
	let captchaDetected = false;
	let commentsClosedPhrase;
	let bloggerFrameUrl;
	let inspectedCount = 0;
	for (const frame of page.frames()) {
		if (frame === mainFrame) continue;
		if (typeof frame.isDetached === "function" && frame.isDetached()) continue;
		const frameUrl = typeof frame.url === "function" ? frame.url() : "";
		if (CAPTCHA_FRAME_URL_PATTERN.test(frameUrl)) {
			captchaDetected = true;
			frameSummaries.push(`${frameUrl.slice(0, 90)} [captcha]`);
			continue;
		}
		const frameName = typeof frame.name === "function" ? frame.name() : "";
		const isBloggerFrame = /blogger\.com\/comment|blogspot\.com\/comment/iu.test(frameUrl) || /^comment-editor$/iu.test(frameName);
		const knownComment = KNOWN_COMMENT_FRAME_URL_PATTERN.test(frameUrl) || isBloggerFrame;
		if (!knownComment && NON_COMMENT_FRAME_URL_PATTERN.test(frameUrl)) continue;
		if (isBloggerFrame) bloggerFrameUrl ??= frameUrl || "comment-editor";
		if (knownComment) hasActionableCommentFrame = true;
		let detail = null;
		if (inspectedCount < 6 && typeof frame.evaluate === "function") {
			inspectedCount++;
			detail = await evaluateFrameWithTimeout(frame, FRAME_INSPECT_TIMEOUT_MS);
		}
		const tags = [];
		if (detail?.captchaDetected) {
			captchaDetected = true;
			tags.push("captcha");
		}
		if (detail?.commentsClosedPhrase) {
			commentsClosedPhrase ??= detail.commentsClosedPhrase;
			tags.push("closed");
		}
		if (detail?.hasEditor) {
			hasActionableCommentFrame = true;
			tags.push("editor");
		}
		if (detail?.hasTrigger) {
			hasActionableCommentFrame = true;
			tags.push("trigger");
		}
		if (detail?.loginRequired) {
			hasActionableCommentFrame = true;
			tags.push("login");
		}
		if (!knownComment && tags.length === 0) {
			hasUnknownInteractiveFrame = true;
			if (detail?.snippet) tags.push(`text:${detail.snippet.slice(0, 50)}`);
			else tags.push("cross-origin");
		}
		frameSummaries.push(`${frameUrl.slice(0, 90)}${tags.length > 0 ? ` [${tags.join(",")}]` : ""}`);
	}
	return {
		frames: frameSummaries,
		hasActionableCommentFrame,
		hasUnknownInteractiveFrame,
		captchaDetected,
		...commentsClosedPhrase === void 0 ? {} : { commentsClosedPhrase },
		...bloggerFrameUrl === void 0 ? {} : { bloggerFrameUrl }
	};
}
function hasActionableCommentSurface(inspection) {
	return inspection.wordpress.found || Boolean(inspection.wordpress.collapsedTriggerSelector) || Boolean(inspection.genericComment?.found) || inspection.commentsClosed.matched || inspection.wix.captchaDetected || inspection.wix.loginRequired || inspection.wix.hasGuestEditor || inspection.wix.triggerSelector !== void 0 || Boolean(inspection.hasBloggerCommentIframe) || Boolean(inspection.childFrames?.bloggerFrameUrl) || Boolean(inspection.childFrames?.captchaDetected) || Boolean(inspection.childFrames?.hasActionableCommentFrame);
}
async function inspectCommentPageWithFrames(page) {
	const base = await page.evaluate(INSPECT_COMMENT_PAGE_SCRIPT);
	const childFrames = await inspectChildFrames(page);
	if (!(childFrames.frames.length > 0 || childFrames.captchaDetected || childFrames.hasActionableCommentFrame || childFrames.hasUnknownInteractiveFrame || childFrames.commentsClosedPhrase !== void 0 || childFrames.bloggerFrameUrl !== void 0)) return base;
	const extraFramesLine = childFrames.frames.length > 0 ? `[child-frames] ${childFrames.frames.slice(0, 4).join(" ; ")}` : "";
	const combinedBottom = [base.bottomSnapshot, extraFramesLine].filter((part) => Boolean(part && part.length > 0)).join("\n").slice(0, BOTTOM_SNAPSHOT_MAX_CHARS);
	return {
		...base,
		commentsClosed: base.commentsClosed.matched || !childFrames.commentsClosedPhrase ? base.commentsClosed : {
			matched: true,
			phrase: childFrames.commentsClosedPhrase
		},
		wix: {
			...base.wix,
			captchaDetected: base.wix.captchaDetected || base.isWix && childFrames.captchaDetected
		},
		childFrames,
		...combinedBottom.length > 0 ? { bottomSnapshot: combinedBottom } : {},
		formSummary: {
			...base.formSummary,
			iframes: Math.max(base.formSummary.iframes, childFrames.frames.length),
			...childFrames.frames.length > 0 ? { childFrames: childFrames.frames.slice(0, 6) } : {}
		}
	};
}
async function verifyResult(page, command, commentId) {
	return await page.evaluate(verifyCommentResultInDom, {
		...command.websiteUrl === void 0 ? {} : { websiteUrl: command.websiteUrl },
		...command.anchorText === void 0 ? {} : { anchorText: command.anchorText },
		commentText: command.commentText,
		...command.authorName === void 0 ? {} : { authorName: command.authorName },
		...commentId === void 0 ? {} : { commentId }
	});
}
/**
* Navigation-resilient verification wrapper: retries cleanly after
* `Execution context was destroyed` / `frame was detached` during 302 redirects.
*/
async function safeVerifyResult(page, command, timeoutMs, sleep, signal) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const currentUrl = page.url();
		const commentId = /#(comment-\d+)\b/iu.exec(currentUrl)?.[1];
		try {
			return {
				verify: await verifyResult(page, command, commentId),
				currentUrl,
				...commentId === void 0 ? {} : { commentId }
			};
		} catch (error) {
			if (!isNavigationContextError(error) || attempt === 2) throw error;
			if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: Math.min(5e3, timeoutMs) }).catch(() => void 0);
			await sleep(Math.min(300, timeoutMs), signal);
		}
	}
	return {
		verify: {
			liveLinkFound: false,
			escapedHtmlDetected: false
		},
		currentUrl: page.url()
	};
}
/** Verify whether the Wix contenteditable editor now contains a real `<a href>` matching targetUrl. */
async function checkRichEditorHasLink(page, editorSelector, websiteUrl) {
	return await page.evaluate(({ selector, targetUrl }) => {
		const editor = globalThis.document.querySelector(selector);
		if (!editor) return false;
		let targetHost = "";
		try {
			targetHost = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./u, "");
		} catch {
			targetHost = targetUrl.toLowerCase();
		}
		for (const anchor of editor.querySelectorAll("a[href]")) {
			const href = String(anchor.getAttribute("href") ?? "").trim().toLowerCase();
			if (!href || href.startsWith("javascript:")) continue;
			if (targetHost.length === 0 || href.includes(targetHost)) return true;
		}
		return false;
	}, {
		selector: editorSelector,
		targetUrl: websiteUrl
	}).catch(() => false);
}
function inferSiteType(inspection) {
	if (inspection.wordpress.found || inspection.isWordPress) return "wordpress";
	if (inspection.genericComment?.kind === "typecho" || inspection.isTypecho) return "typecho";
	if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl) return "blogger";
	if (inspection.isWix) return "wix";
	return "other";
}
function buildFallbackResult(ref, siteType, inspection, evidence, reason) {
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "needs_llm_fallback",
		siteType,
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		...evidence === void 0 ? {} : { evidence },
		...reason === void 0 ? {} : { reason },
		submitTriggered: false,
		formSummary: inspection.formSummary,
		...inspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: inspection.bottomSnapshot }
	};
}
function buildNeedsLoginResult(ref, siteType, inspection, evidence, loginInfo, finalUrlOverride) {
	const effectiveLoginInfo = loginInfo ?? inspection.wix.loginInfo;
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "needs_login",
		siteType,
		title: inspection.title,
		finalUrl: finalUrlOverride ?? inspection.finalUrl,
		evidence,
		submitTriggered: false,
		...effectiveLoginInfo === void 0 ? {} : { loginInfo: effectiveLoginInfo },
		formSummary: {
			...inspection.formSummary,
			hasLoginWall: true
		},
		...inspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: inspection.bottomSnapshot }
	};
}
function buildWixNoFormDiagnosis(inspection) {
	if (inspection.wix.isBlogListPage) return "当前页面为 Wix 博客列表/索引页（非单篇文章 /post/），需要挑选近期文章进入后再探测评论框（安全护栏拒判 no_form，未触发提交）";
	if (inspection.wix.hasLazyPlaceholder || inspection.wix.hasCommentCountOnly) return "Wix 博客仍处于 comments-section-placeholder/comment-count 懒加载阶段且未完成挂载，需 LLM 滚动复核（安全护栏拒判 no_form，未触发提交）";
	if (inspection.childFrames?.hasActionableCommentFrame || inspection.childFrames?.hasUnknownInteractiveFrame) return "Wix 页面存在可疑子 iframe，可能承载延迟/第三方评论组件，转交 LLM 核查（安全护栏拒判 no_form，未触发提交）";
	if (inspection.wix.hasCommentSection || inspection.wix.triggerSelector) return "检测到 Wix 评论容器/触发器但未确认访客输入框或登录模态框，转交 LLM 接管（安全护栏拒判 no_form，未触发提交）";
	if (inspection.wix.hasBlogPostStructure || inspection.wix.isComplexWixLayout) return "复杂 Wix 博客文章/Thunderbolt 布局在等待窗口内未暴露确定性评论表单，附带底部快照转交 LLM 二次确认（安全护栏拒判 no_form，未触发提交）";
	return "Wix 页面未定位到确定性评论入口，附带底部快照转交 LLM 二次确认（未触发提交）";
}
/** Shared submission + Jetpack Verbum guest-flow + 403/WAF detection + 302-resilient post-submit/reload verification for WP, Typecho, and custom blog forms. */
async function submitAndVerifyStandardForm(page, ref, siteType, siteLabel, inspection, form, command, options) {
	const { timeoutMs, verifyReload, probeOnly, sleep, signal } = options;
	if (form.captcha?.detected || inspection.childFrames?.captchaDetected) return {
		kind: "comment_publish",
		page: ref,
		outcome: "blocked_captcha",
		siteType,
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		...form.captcha?.templateSignature === void 0 ? {} : { templateSignature: form.captcha.templateSignature },
		evidence: `${siteLabel} 评论区存在 ${form.captcha?.kind ?? "captcha"} 人机验证，未尝试绕过`,
		suggestedTags: ["has_captcha"],
		submitTriggered: false
	};
	if (probeOnly) return {
		kind: "comment_publish",
		page: ref,
		outcome: "form_ready",
		siteType,
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		probeOnly: true,
		submitTriggered: false,
		formSummary: inspection.formSummary,
		...inspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: inspection.bottomSnapshot }
	};
	if (form.authorRequired && !command.authorName?.trim() || form.emailRequired && !command.authorEmail?.trim()) return buildFallbackResult(ref, siteType, inspection, `${siteLabel} 评论表单缺少必填的 authorName 或 authorEmail 参数，转交常规流程处理`);
	const hasUrlField = form.urlSelector !== void 0;
	await dismissBlockingOverlays(page, timeoutMs);
	const commentLocator = page.locator(form.commentSelector).first();
	if (form.commentIsContentEditable) {
		const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
		if (typeof commentLocator.click === "function") await commentLocator.click({ timeout: timeoutMs }).catch(() => void 0);
		await commentLocator.fill(stripped.plainText, { timeout: timeoutMs });
	} else {
		const commentBody = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasUrlField);
		await commentLocator.fill(commentBody, { timeout: timeoutMs });
	}
	let authorFilled = false;
	let emailFilled = false;
	let urlFilled = false;
	if (form.authorSelector !== void 0 && command.authorName?.trim()) {
		await page.locator(form.authorSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
		authorFilled = true;
	}
	if (form.emailSelector !== void 0 && command.authorEmail?.trim()) {
		await page.locator(form.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
		emailFilled = true;
	}
	if (form.urlSelector !== void 0 && command.websiteUrl?.trim()) {
		await page.locator(form.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
		urlFilled = true;
	}
	let activeSubmitSelector = form.submitSelector;
	let activeInspection = inspection;
	if (activeSubmitSelector === void 0) return buildFallbackResult(ref, siteType, activeInspection, `${siteLabel} 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）`);
	await dismissBlockingOverlays(page, timeoutMs);
	let submitLocator = page.locator(activeSubmitSelector).first();
	if (await isLocatorDisabled(submitLocator)) {
		const guestToggleSel = siteType === "wordpress" ? form.guestToggleSelector ?? await findDynamicJetpackGuestToggle(page) : void 0;
		if (guestToggleSel) {
			const toggleLocator = page.locator(guestToggleSel).first();
			if (!await isLocatorDisabled(toggleLocator)) {
				await toggleLocator.click({ timeout: timeoutMs }).catch(() => void 0);
				const expandDeadline = Date.now() + Math.min(2e3, timeoutMs);
				let refreshedWp = activeInspection.wordpress;
				for (let poll = 0; poll < 8; poll++) {
					throwIfAborted$2(signal);
					await sleep(Math.min(250, timeoutMs), signal);
					const nextInspection = await inspectCommentPageWithFrames(page).catch(() => activeInspection);
					activeInspection = nextInspection;
					refreshedWp = nextInspection.wordpress;
					if (Boolean(!authorFilled && refreshedWp.authorSelector || !emailFilled && refreshedWp.emailSelector || !urlFilled && refreshedWp.urlSelector) || Date.now() >= expandDeadline) break;
				}
				if (!authorFilled && refreshedWp.authorSelector && command.authorName?.trim()) {
					await page.locator(refreshedWp.authorSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
					authorFilled = true;
				}
				if (!emailFilled && refreshedWp.emailSelector && command.authorEmail?.trim()) {
					await page.locator(refreshedWp.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
					emailFilled = true;
				}
				if (!urlFilled && refreshedWp.urlSelector && command.websiteUrl?.trim()) {
					await page.locator(refreshedWp.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
					urlFilled = true;
				}
				if (refreshedWp.submitSelector) {
					activeSubmitSelector = refreshedWp.submitSelector;
					submitLocator = page.locator(activeSubmitSelector).first();
				}
				const enableDeadline = Date.now() + Math.min(2e3, timeoutMs);
				for (let poll = 0; poll < 8 && await isLocatorDisabled(submitLocator); poll++) {
					if (Date.now() >= enableDeadline) break;
					throwIfAborted$2(signal);
					await sleep(Math.min(200, timeoutMs), signal);
				}
			}
		}
		if (await isLocatorDisabled(submitLocator)) {
			const loginProbe = await inspectDisabledSubmitLoginPrompt(page);
			if (loginProbe.hasLoginPrompt) return buildNeedsLoginResult(ref, siteType, activeInspection, `${siteLabel} 评论提交按钮处于 disabled 状态且页面提示需要登录 (${loginProbe.matchedText ?? "login required"})，未点击提交`, loginProbe.loginInfo);
			return buildFallbackResult(ref, siteType, activeInspection, `${siteLabel} 评论提交按钮处于 disabled 状态 (submit_button_disabled)，未点击提交，转交 LLM 核查`, "submit_button_disabled");
		}
	}
	const capturedResponses = [];
	const pendingBodyReads = [];
	const onResponse = (resp) => {
		const r = resp;
		if (typeof r?.status !== "function") return;
		const status = r.status();
		const url = typeof r.url === "function" ? r.url() : "";
		const req = typeof r.request === "function" ? r.request() : void 0;
		const method = (typeof req?.method === "function" ? req.method() : "").toUpperCase();
		const resourceType = (typeof req?.resourceType === "function" ? req.resourceType() : "").toLowerCase();
		const isWpEndpoint = /wp-comments-post\.php/iu.test(url);
		const isPostOrDoc = method === "POST" || resourceType === "document" || resourceType === "xhr" || resourceType === "fetch";
		if (!isWpEndpoint && !isPostOrDoc) return;
		const entry = {
			url,
			status,
			headers: typeof r.headers === "function" ? r.headers() : {},
			isWpEndpoint,
			isPostOrDoc
		};
		capturedResponses.push(entry);
		if ((status === 403 || status === 406 || status === 429) && typeof r.text === "function") pendingBodyReads.push(r.text().then((raw) => {
			const cleaned = raw.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
			if (cleaned.length > 0) entry.bodySnippet = cleaned.slice(0, 260);
		}).catch(() => void 0));
	};
	const pageWithEvents = page;
	if (typeof pageWithEvents.on === "function") pageWithEvents.on("response", onResponse);
	const navWaitTimeout = Math.min(1e4, timeoutMs);
	let navResponse = null;
	try {
		const navPromise = typeof page.waitForNavigation === "function" ? page.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: navWaitTimeout
		}).catch(() => null) : typeof page.waitForLoadState === "function" ? page.waitForLoadState("domcontentloaded", { timeout: navWaitTimeout }).catch(() => null) : Promise.resolve(null);
		const [navRes] = await Promise.all([navPromise, submitLocator.click({ timeout: timeoutMs }).catch((error) => {
			if (isNavigationContextError(error)) return null;
			throw error;
		})]);
		navResponse = navRes;
		if (pendingBodyReads.length > 0) await Promise.all(pendingBodyReads);
	} finally {
		if (typeof pageWithEvents.off === "function") pageWithEvents.off("response", onResponse);
	}
	if (navResponse && typeof navResponse.status === "function") {
		const nr = navResponse;
		const navStatus = nr.status();
		const navUrl = typeof nr.url === "function" ? nr.url() : "";
		if (!capturedResponses.some((c) => c.url === navUrl && c.status === navStatus)) capturedResponses.push({
			url: navUrl,
			status: navStatus,
			headers: typeof nr.headers === "function" ? nr.headers() : {},
			isWpEndpoint: /wp-comments-post\.php/iu.test(navUrl),
			isPostOrDoc: true
		});
	}
	const postCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
	const postSubmitUrl = postCheck.currentUrl;
	const postVerify = postCheck.verify;
	const postCommentId = postCheck.commentId;
	const postTitle = await page.title().catch(() => activeInspection.title);
	const blockedResponse = capturedResponses.find((c) => (c.status === 403 || c.status === 406 || c.status === 429) && c.isWpEndpoint) ?? capturedResponses.find((c) => c.status === 403 || c.status === 406 || c.status === 429) ?? capturedResponses.find((c) => c.isWpEndpoint) ?? capturedResponses[capturedResponses.length - 1];
	const postSubmitSnippet = postVerify.snippet ?? blockedResponse?.bodySnippet;
	const wafBlock = detectPostSubmitWafBlock({
		...blockedResponse?.status === void 0 ? {} : { httpStatus: blockedResponse.status },
		...blockedResponse?.headers === void 0 ? {} : { responseHeaders: blockedResponse.headers },
		...blockedResponse?.bodySnippet === void 0 ? {} : { responseSnippet: blockedResponse.bodySnippet },
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		title: postTitle
	});
	if (wafBlock.blocked) {
		const statusCode = wafBlock.httpStatus ?? 403;
		const provider = wafBlock.provider ?? "waf";
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "blocked_waf",
			siteType,
			title: postTitle,
			finalUrl: postSubmitUrl,
			postSubmitUrl,
			httpStatus: statusCode,
			...wafBlock.snippet === void 0 ? {} : { postSubmitSnippet: wafBlock.snippet },
			reason: `waf_http_${statusCode}`,
			templateSignature: `${siteType}:waf_${provider}`,
			suggestedTags: ["waf_403"],
			evidence: `${siteLabel} 提交评论被 WAF/防火墙拦截 (HTTP ${statusCode}, ${provider})`,
			submitTriggered: true
		};
	}
	if (postVerify.wpErrorMessage) {
		const mentionsCaptcha = /captcha|spam|security/iu.test(postVerify.wpErrorMessage);
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType,
			title: postTitle,
			finalUrl: postSubmitUrl,
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: `提交后页面返回错误提示: ${postVerify.wpErrorMessage.slice(0, 160)}`,
			...mentionsCaptcha ? { suggestedTags: ["has_captcha"] } : {},
			submitTriggered: true
		};
	}
	const cleanPublicUrl = /wp-comments-post\.php/iu.test(postSubmitUrl) ? command.url : stripWpModerationParams(postSubmitUrl);
	if (Boolean(postVerify.moderationNotice || /[?&](?:unapproved|moderation-hash)=/iu.test(postSubmitUrl))) return {
		kind: "comment_publish",
		page: ref,
		outcome: "submitted",
		siteType,
		title: await page.title().catch(() => inspection.title),
		finalUrl: cleanPublicUrl,
		publicUrl: cleanPublicUrl,
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		evidence: `${siteLabel} 评论已提交等待审核 (${postVerify.moderationNotice ?? "unapproved"})`,
		submitTriggered: true
	};
	const postHasCommentIdLink = Boolean(postCommentId && (postVerify.commentNodeLinkFound || postVerify.liveLinkFound));
	let finalVerify = postVerify;
	let finalUrl = cleanPublicUrl;
	if (verifyReload) {
		await page.goto(cleanPublicUrl, {
			timeout: timeoutMs,
			waitUntil: "domcontentloaded"
		});
		await scrollPageStep(page, 1);
		const reloadCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
		finalUrl = reloadCheck.currentUrl;
		finalVerify = reloadCheck.verify;
	}
	const finalTitle = await page.title().catch(() => inspection.title);
	if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) return {
		kind: "comment_publish",
		page: ref,
		outcome: "uncertain_after_submit",
		siteType,
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		evidence: "提交后检测到正文 HTML 被转义，链接未生效（遵守幂等铁律严禁重发）",
		submitTriggered: true
	};
	if (finalVerify.liveLinkFound) return {
		kind: "comment_publish",
		page: ref,
		outcome: "live",
		siteType,
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		evidence: `${siteLabel} 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
		submitTriggered: true
	};
	if (finalVerify.moderationNotice) return {
		kind: "comment_publish",
		page: ref,
		outcome: "submitted",
		siteType,
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		postSubmitUrl,
		evidence: `${siteLabel} 评论已提交等待审核 (${finalVerify.moderationNotice})`,
		submitTriggered: true
	};
	if (postHasCommentIdLink && !finalVerify.wpErrorMessage && !finalVerify.captchaDetected) return {
		kind: "comment_publish",
		page: ref,
		outcome: "submitted",
		siteType,
		title: finalTitle,
		finalUrl,
		publicUrl: cleanPublicUrl,
		reason: "post_submit_comment_id_cached",
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		evidence: `${siteLabel} 提交后 #${postCommentId} 节点已确认含目标链接，公开页重载暂未渲染（疑似站方页面缓存），降级回写 submitted (post_submit_comment_id_cached)`,
		submitTriggered: true
	};
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "uncertain_after_submit",
		siteType,
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? finalVerify.snippet === void 0 ? {} : { postSubmitSnippet: finalVerify.snippet } : { postSubmitSnippet },
		evidence: `已点击 ${siteLabel} 提交但重载公开页未确认目标链接或待审核提示（严禁自动重试）`,
		submitTriggered: true
	};
}
/** Handle Blogger comment iframe (`#comment-editor` / `iframe[src*="blogger.com/comment"]`). */
async function executeBloggerCommentIframe(page, ref, inspection, command, options) {
	if (typeof page.frames !== "function") return void 0;
	const bloggerFrame = page.frames().find((frame) => {
		if (typeof frame.isDetached === "function" && frame.isDetached()) return false;
		const u = typeof frame.url === "function" ? frame.url() : "";
		const n = typeof frame.name === "function" ? frame.name() : "";
		return /blogger\.com\/comment|blogspot\.com\/comment/iu.test(u) || /^comment-editor$/iu.test(n);
	});
	if (!bloggerFrame || typeof bloggerFrame.evaluate !== "function") return void 0;
	let detail = null;
	try {
		detail = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT);
	} catch {
		return;
	}
	if (!detail) return void 0;
	if (detail.hasCaptcha) return {
		kind: "comment_publish",
		page: ref,
		outcome: "blocked_captcha",
		siteType: "blogger",
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		templateSignature: "blogger:recaptcha_captcha",
		evidence: "Blogger 评论 iframe 内检测到 CAPTCHA 人机验证，未尝试绕过",
		suggestedTags: ["has_captcha"],
		submitTriggered: false
	};
	if (detail.commentsClosedPhrase) return {
		kind: "comment_publish",
		page: ref,
		outcome: "comments_closed",
		siteType: "blogger",
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		skipReason: `Blogger 评论 iframe 提示评论已关闭(${detail.commentsClosedPhrase})`,
		suggestedTags: ["评论关闭"],
		submitTriggered: false
	};
	if (detail.loginRequired) return buildNeedsLoginResult(ref, "blogger", inspection, "Blogger 评论 iframe 需要登录 Google 账号后发表评论（未触发提交）", detail.loginInfo);
	if (!detail.hasEditor || !detail.commentSelector) return;
	if (options.probeOnly) return {
		kind: "comment_publish",
		page: ref,
		outcome: "form_ready",
		siteType: "blogger",
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		probeOnly: true,
		submitTriggered: false,
		formSummary: inspection.formSummary,
		...inspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: inspection.bottomSnapshot }
	};
	if (typeof bloggerFrame.locator !== "function") return buildFallbackResult(ref, "blogger", inspection, "检测到 Blogger 评论 iframe 但当前环境不支持 frame.locator，转交 LLM 使用 frame()>> 处理");
	let activeDetail = detail;
	if (detail.identitySelectSelector && detail.supportsNameUrlIdentity && (command.authorName || command.websiteUrl)) {
		const idLocator = bloggerFrame.locator(detail.identitySelectSelector).first();
		if (typeof idLocator.selectOption === "function") {
			await idLocator.selectOption("NAMEURL", { timeout: options.timeoutMs }).catch(() => void 0);
			const refreshed = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
			if (refreshed) activeDetail = refreshed;
		}
	}
	const hasAnonUrl = activeDetail.anonUrlSelector !== void 0;
	const commentLocator = bloggerFrame.locator(activeDetail.commentSelector ?? detail.commentSelector).first();
	if (activeDetail.commentIsContentEditable) {
		const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
		const bodyText = !hasAnonUrl && stripped.websiteUrl && !stripped.plainText.toLowerCase().includes(stripped.websiteUrl.toLowerCase()) ? `${stripped.plainText} ${stripped.websiteUrl}`.trim() : stripped.plainText;
		if (typeof commentLocator.click === "function") await commentLocator.click({ timeout: options.timeoutMs }).catch(() => void 0);
		await commentLocator.fill(bodyText, { timeout: options.timeoutMs });
	} else {
		const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasAnonUrl);
		await commentLocator.fill(body, { timeout: options.timeoutMs });
	}
	if (activeDetail.anonNameSelector && command.authorName?.trim()) await bloggerFrame.locator(activeDetail.anonNameSelector).first().fill(command.authorName.trim(), { timeout: options.timeoutMs });
	if (activeDetail.anonUrlSelector && command.websiteUrl?.trim()) await bloggerFrame.locator(activeDetail.anonUrlSelector).first().fill(command.websiteUrl.trim(), { timeout: options.timeoutMs });
	const refreshedAfterFill = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
	if (refreshedAfterFill?.submitSelector) activeDetail = {
		...activeDetail,
		submitSelector: refreshedAfterFill.submitSelector
	};
	if (!activeDetail.submitSelector) return buildFallbackResult(ref, "blogger", inspection, "Blogger 评论框已填充但未定位到 Publish 按钮，转交 LLM 接管（未触发提交）");
	const bloggerSubmitLocator = bloggerFrame.locator(activeDetail.submitSelector).first();
	if (await isLocatorDisabled(bloggerSubmitLocator)) return buildFallbackResult(ref, "blogger", inspection, "Blogger 评论 Publish 按钮处于 disabled 状态 (submit_button_disabled)，未点击提交，转交 LLM 核查", "submit_button_disabled");
	await bloggerSubmitLocator.click({ timeout: options.timeoutMs });
	await options.sleep(Math.min(1500, options.timeoutMs), options.signal);
	const postFrame = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
	const postSubmitUrl = page.url();
	const postSubmitSnippet = postFrame?.snippet;
	if (postFrame?.hasCaptcha) return {
		kind: "comment_publish",
		page: ref,
		outcome: "blocked_captcha",
		siteType: "blogger",
		title: inspection.title,
		finalUrl: postSubmitUrl,
		templateSignature: "blogger:recaptcha_captcha",
		evidence: "Blogger 评论提交后弹出 CAPTCHA 人机验证，未尝试绕过",
		suggestedTags: ["has_captcha"],
		submitTriggered: false
	};
	if (postFrame?.moderationNotice) return {
		kind: "comment_publish",
		page: ref,
		outcome: "submitted",
		siteType: "blogger",
		title: inspection.title,
		finalUrl: postSubmitUrl,
		publicUrl: postSubmitUrl,
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		evidence: `Blogger 评论已提交等待审核 (${postFrame.moderationNotice})`,
		submitTriggered: true
	};
	let finalUrl = postSubmitUrl;
	let finalVerify;
	if (options.verifyReload) {
		await page.goto(command.url, {
			timeout: options.timeoutMs,
			waitUntil: "domcontentloaded"
		});
		await scrollPageStep(page, 1);
		const check = await safeVerifyResult(page, command, options.timeoutMs, options.sleep, options.signal);
		finalUrl = check.currentUrl;
		finalVerify = check.verify;
	} else {
		const check = await safeVerifyResult(page, command, options.timeoutMs, options.sleep, options.signal);
		finalUrl = check.currentUrl;
		finalVerify = check.verify;
	}
	const finalTitle = await page.title().catch(() => inspection.title);
	if (finalVerify.liveLinkFound) return {
		kind: "comment_publish",
		page: ref,
		outcome: "live",
		siteType: "blogger",
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		evidence: `Blogger 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
		submitTriggered: true
	};
	if (finalVerify.moderationNotice) return {
		kind: "comment_publish",
		page: ref,
		outcome: "submitted",
		siteType: "blogger",
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		postSubmitUrl,
		evidence: `Blogger 评论已提交等待审核 (${finalVerify.moderationNotice})`,
		submitTriggered: true
	};
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "uncertain_after_submit",
		siteType: "blogger",
		title: finalTitle,
		finalUrl,
		publicUrl: finalUrl,
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? finalVerify.snippet === void 0 ? {} : { postSubmitSnippet: finalVerify.snippet } : { postSubmitSnippet },
		evidence: "已点击 Blogger Publish 但公开页未确认目标链接或待审核提示（严禁自动重试）",
		submitTriggered: true
	};
}
async function executeCommentPublish(page, ref, command, options) {
	const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs;
	const isWixHint = command.siteHint === "wix_blog" || /\.wixsite\.com\b/iu.test(command.url);
	const navTimeoutMs = isWixHint ? Math.max(timeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS) : timeoutMs;
	const verifyReload = command.verifyReload !== false;
	const probeOnly = command.probeOnly === true;
	const baseLazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? 2500, timeoutMs);
	const wixWaitCeiling = Math.max(timeoutMs, DEFAULT_WIX_LAZY_WAIT_MAX_MS);
	const wixLazyWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 15e3, wixWaitCeiling);
	const wixExpandWaitMaxMs = Math.min(options.wixExpandWaitMaxMs ?? 4e3, timeoutMs);
	const wixPostSubmitWaitMs = Math.min(options.wixPostSubmitWaitMs ?? 2500, timeoutMs);
	const sleep = options.sleepImpl ?? defaultSleep$1;
	throwIfAborted$2(options.signal);
	await page.goto(command.url, {
		timeout: navTimeoutMs,
		waitUntil: "domcontentloaded"
	});
	throwIfAborted$2(options.signal);
	let inspection = await inspectCommentPageWithFrames(page);
	let completedFullLazyWait = false;
	if (!hasActionableCommentSurface(inspection)) {
		let activeWaitMaxMs = inspection.isWix || isWixHint ? wixLazyWaitMaxMs : baseLazyWaitMaxMs;
		const startAt = Date.now();
		let deadline = startAt + activeWaitMaxMs;
		let maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0;
		let exitedEarly = false;
		for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
			throwIfAborted$2(options.signal);
			const steps = inspection.isWix || isWixHint ? WIX_PROGRESSIVE_SCROLL_STEPS : DEFAULT_PROGRESSIVE_SCROLL_STEPS;
			const fraction = steps[Math.min(poll, steps.length - 1)];
			await scrollPageStep(page, fraction);
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
			const prevIsWix = inspection.isWix;
			inspection = await inspectCommentPageWithFrames(page);
			if (!prevIsWix && inspection.isWix && options.lazyWaitMaxMs === void 0) {
				activeWaitMaxMs = wixLazyWaitMaxMs;
				deadline = startAt + activeWaitMaxMs;
				maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0;
			}
			if (hasActionableCommentSurface(inspection)) {
				exitedEarly = true;
				break;
			}
		}
		completedFullLazyWait = !exitedEarly && maxPolls > 0;
	}
	if (!inspection.wordpress.found && inspection.wordpress.collapsedTriggerSelector) {
		await dismissBlockingOverlays(page, timeoutMs);
		await page.locator(inspection.wordpress.collapsedTriggerSelector).first().click({ timeout: timeoutMs }).catch(() => void 0);
		await sleep(Math.min(400, timeoutMs), options.signal);
		inspection = await inspectCommentPageWithFrames(page);
	}
	if (inspection.wordpress.found) return await submitAndVerifyStandardForm(page, ref, "wordpress", "WordPress", inspection, inspection.wordpress, command, {
		timeoutMs,
		verifyReload,
		probeOnly,
		sleep,
		...options.signal === void 0 ? {} : { signal: options.signal }
	});
	if (inspection.genericComment?.found) {
		const gc = inspection.genericComment;
		return await submitAndVerifyStandardForm(page, ref, gc.kind === "typecho" ? "typecho" : "other", gc.kind === "typecho" ? "Typecho" : "博客评论", inspection, gc, command, {
			timeoutMs,
			verifyReload,
			probeOnly,
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
	}
	if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl) {
		const bloggerResult = await executeBloggerCommentIframe(page, ref, inspection, command, {
			timeoutMs,
			verifyReload,
			probeOnly,
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		if (bloggerResult !== void 0) return bloggerResult;
	}
	if (inspection.commentsClosed.matched && !inspection.wix.hasGuestEditor) return {
		kind: "comment_publish",
		page: ref,
		outcome: "comments_closed",
		siteType: inferSiteType(inspection),
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		skipReason: `页面明确提示评论已关闭(${inspection.commentsClosed.phrase ?? "comments closed"})`,
		suggestedTags: ["评论关闭"],
		submitTriggered: false
	};
	if (inspection.isWix) {
		if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) return {
			kind: "comment_publish",
			page: ref,
			outcome: "blocked_captcha",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			templateSignature: "wix:signup_recaptcha",
			evidence: "Wix 博客评论区检测到 reCAPTCHA 人机验证，未尝试绕过",
			suggestedTags: ["has_captcha"],
			submitTriggered: false
		};
		if (inspection.wix.loginRequired) return buildNeedsLoginResult(ref, "wix", inspection, "Wix 评论区为会员登录模板（检测到登录按钮且无访客 Name/Email 字段），未触发 Publish，请先登录或走 Google SSO");
		if (!inspection.wix.hasGuestEditor && inspection.wix.triggerSelector) {
			await dismissBlockingOverlays(page, timeoutMs);
			const triggerLocator = page.locator(inspection.wix.triggerSelector).first();
			let clickError;
			try {
				const scrollableTrigger = triggerLocator;
				if (typeof scrollableTrigger.scrollIntoViewIfNeeded === "function") await scrollableTrigger.scrollIntoViewIfNeeded({ timeout: Math.min(3e3, timeoutMs) }).catch(() => void 0);
				await triggerLocator.click({ timeout: timeoutMs });
			} catch (error) {
				clickError = error;
			}
			if (clickError !== void 0) return buildFallbackResult(ref, "wix", inspection, `点击 Wix 评论展开触发器失败 (${clickError instanceof Error ? clickError.message : String(clickError)})，转交 LLM 接管（未触发提交）`);
			const expandDeadline = Date.now() + wixExpandWaitMaxMs;
			const expandMaxPolls = wixExpandWaitMaxMs > 0 ? Math.max(1, Math.ceil(wixExpandWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 1;
			let sawLoginWithoutCaptcha = false;
			for (let poll = 0; poll < expandMaxPolls && (poll === 0 || Date.now() < expandDeadline); poll++) {
				throwIfAborted$2(options.signal);
				const remaining = expandDeadline - Date.now();
				if (remaining > 0) await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
				inspection = await inspectCommentPageWithFrames(page);
				if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) return {
					kind: "comment_publish",
					page: ref,
					outcome: "blocked_captcha",
					siteType: "wix",
					title: inspection.title,
					finalUrl: inspection.finalUrl,
					templateSignature: "wix:signup_recaptcha",
					evidence: "展开 Wix 评论区后触发 reCAPTCHA 人机验证，未尝试绕过",
					suggestedTags: ["has_captcha"],
					submitTriggered: false
				};
				if (inspection.wix.loginRequired) {
					if (!sawLoginWithoutCaptcha && poll + 1 < expandMaxPolls) {
						sawLoginWithoutCaptcha = true;
						continue;
					}
					return buildNeedsLoginResult(ref, "wix", inspection, "展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish");
				}
				if (inspection.wix.hasGuestEditor && inspection.wix.editorSelector) break;
			}
			if (inspection.wix.captchaDetected || inspection.childFrames?.captchaDetected) return {
				kind: "comment_publish",
				page: ref,
				outcome: "blocked_captcha",
				siteType: "wix",
				title: inspection.title,
				finalUrl: inspection.finalUrl,
				templateSignature: "wix:signup_recaptcha",
				evidence: "展开 Wix 评论区后检测到 reCAPTCHA 人机验证，未尝试绕过",
				suggestedTags: ["has_captcha"],
				submitTriggered: false
			};
			if (inspection.wix.loginRequired) return buildNeedsLoginResult(ref, "wix", inspection, "展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish");
		}
		if (inspection.childFrames?.hasActionableCommentFrame && (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector)) return buildFallbackResult(ref, "wix", inspection, "在子 iframe 中检测到疑似评论/登录组件，转交 LLM 使用 frame()>> 进一步确认（未触发提交）");
		if (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector) {
			const canSafelyDeclareWixNoForm = !inspection.wix.hasCommentSection && !inspection.wix.hasLazyPlaceholder && !inspection.wix.hasCommentCountOnly && !inspection.wix.triggerSelector && !inspection.wix.hasBlogPostStructure && !inspection.wix.isBlogListPage && !inspection.wix.isComplexWixLayout && !inspection.childFrames?.hasActionableCommentFrame && !inspection.childFrames?.hasUnknownInteractiveFrame && (inspection.readyState === void 0 || inspection.readyState !== "loading");
			const canDeclareEmptyWixPlaceholderNoForm = completedFullLazyWait && Boolean(inspection.wix.hasEmptyCommentPlaceholder) && !inspection.wix.hasCommentSection && !inspection.wix.hasGuestEditor && !inspection.wix.triggerSelector && !inspection.wix.loginRequired && !inspection.wix.captchaDetected && !inspection.wix.isBlogListPage && !inspection.wix.hasLoadingIndicator && !inspection.wix.hasCommentListOrCount && !inspection.wix.hasWriteCommentPrompt && !inspection.formSummary.hasLoginWall && !inspection.childFrames?.hasActionableCommentFrame && !inspection.childFrames?.hasUnknownInteractiveFrame && !inspection.childFrames?.captchaDetected && (inspection.readyState === void 0 || inspection.readyState !== "loading");
			if (canSafelyDeclareWixNoForm || canDeclareEmptyWixPlaceholderNoForm) return {
				kind: "comment_publish",
				page: ref,
				outcome: "no_form",
				siteType: "wix",
				title: inspection.title,
				finalUrl: inspection.finalUrl,
				skipReason: canDeclareEmptyWixPlaceholderNoForm ? "Wix 博客完成完整滚动与懒加载等待后 comments-section-placeholder 持续为空（无输入框/评论列表/登录墙/加载动画），确认已关闭评论 (no_form)" : "Wix 静态页面经渐进滚动、懒加载等待与 iframe 过滤检查后确认无评论模块",
				suggestedTags: ["no_form"],
				submitTriggered: false
			};
			return buildFallbackResult(ref, "wix", inspection, buildWixNoFormDiagnosis(inspection));
		}
		if (probeOnly) return {
			kind: "comment_publish",
			page: ref,
			outcome: "form_ready",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			probeOnly: true,
			submitTriggered: false,
			formSummary: inspection.formSummary,
			...inspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: inspection.bottomSnapshot }
		};
		const wix = inspection.wix;
		const editorSelector = wix.editorSelector;
		const hasWebsiteField = wix.websiteSelector !== void 0;
		if (wix.editorIsContentEditable) {
			const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
			await dismissBlockingOverlays(page, timeoutMs);
			const editorLocator = page.locator(editorSelector).first();
			if (stripped.websiteUrl && !hasWebsiteField && wix.linkButtonSelector) {
				await editorLocator.click({ timeout: timeoutMs });
				await editorLocator.fill(stripped.plainText, { timeout: timeoutMs });
				const anchorToSelect = stripped.anchorText ?? stripped.websiteUrl;
				if (!await page.evaluate(({ selector, anchor }) => {
					const dom = globalThis;
					const el = dom.document.querySelector(selector);
					if (!el) return false;
					const walker = dom.document.createTreeWalker(el, dom.NodeFilter?.SHOW_TEXT ?? 4);
					let node = walker.nextNode();
					while (node) {
						const idx = (node.textContent ?? "").toLowerCase().indexOf(anchor.toLowerCase());
						if (idx >= 0) {
							const range = dom.document.createRange();
							range.setStart(node, idx);
							range.setEnd(node, idx + anchor.length);
							const sel = dom.window.getSelection?.();
							if (sel) {
								sel.removeAllRanges();
								sel.addRange(range);
							}
							return true;
						}
						node = walker.nextNode();
					}
					return false;
				}, {
					selector: editorSelector,
					anchor: anchorToSelect
				})) return buildFallbackResult(ref, "wix", inspection, "Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）");
				await page.locator(wix.linkButtonSelector).first().click({ timeout: timeoutMs });
				const urlInputSelector = "input[type=\"url\"], input[placeholder*=\"http\" i], input[placeholder*=\"url\" i], input[placeholder*=\"link\" i], input[aria-label*=\"url\" i], input[aria-label*=\"link\" i]";
				if (await page.locator(urlInputSelector).count().catch(() => 0) <= 0) return buildFallbackResult(ref, "wix", inspection, "点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）");
				const urlInput = page.locator(urlInputSelector).first();
				await urlInput.fill(stripped.websiteUrl, { timeout: timeoutMs });
				const applyBtnSelector = "[data-hook*=\"save\" i], [data-hook*=\"apply\" i], button[aria-label*=\"save\" i], button[aria-label*=\"apply\" i]";
				if (await page.locator(applyBtnSelector).count().catch(() => 0) > 0) await page.locator(applyBtnSelector).first().click({ timeout: timeoutMs });
				else await urlInput.press("Enter", { timeout: timeoutMs });
			} else if (stripped.websiteUrl && !hasWebsiteField) {
				const textWithUrl = stripped.plainText.toLowerCase().includes(stripped.websiteUrl.toLowerCase()) ? stripped.plainText : `${stripped.plainText} ${stripped.websiteUrl}`.trim();
				await editorLocator.click({ timeout: timeoutMs });
				await editorLocator.fill(textWithUrl, { timeout: timeoutMs });
				if (typeof editorLocator.press === "function") await editorLocator.press("Space", { timeout: timeoutMs }).catch(() => void 0);
				else if (typeof page.keyboard?.press === "function") await page.keyboard.press("Space").catch(() => void 0);
				await sleep(Math.min(250, timeoutMs), options.signal);
				if (!await checkRichEditorHasLink(page, editorSelector, stripped.websiteUrl)) return buildFallbackResult(ref, "wix", inspection, "Wix 富文本评论框输入目标 URL 并补发 Space 后未确认 <a href> 自动转超链（避免发布无链评论，未触发提交）");
			} else {
				await editorLocator.click({ timeout: timeoutMs });
				await editorLocator.fill(stripped.plainText, { timeout: timeoutMs });
			}
		} else {
			const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasWebsiteField);
			await page.locator(editorSelector).first().fill(body, { timeout: timeoutMs });
		}
		if (wix.nameSelector && command.authorName?.trim()) await page.locator(wix.nameSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
		if (wix.emailSelector && command.authorEmail?.trim()) await page.locator(wix.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
		if (wix.websiteSelector && command.websiteUrl?.trim()) await page.locator(wix.websiteSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
		if (!wix.submitSelector) return buildFallbackResult(ref, "wix", inspection, "Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）");
		await dismissBlockingOverlays(page, timeoutMs);
		const wixSubmitLocator = page.locator(wix.submitSelector).first();
		if (await isLocatorDisabled(wixSubmitLocator)) {
			const loginProbe = await inspectDisabledSubmitLoginPrompt(page);
			if (loginProbe.hasLoginPrompt) return buildNeedsLoginResult(ref, "wix", inspection, `Wix 评论提交按钮处于 disabled 状态且页面提示需要登录 (${loginProbe.matchedText ?? "login required"})，未点击提交`, loginProbe.loginInfo);
			return buildFallbackResult(ref, "wix", inspection, "Wix 评论提交按钮处于 disabled 状态 (submit_button_disabled)，未点击提交，转交 LLM 核查", "submit_button_disabled");
		}
		await wixSubmitLocator.click({ timeout: timeoutMs });
		const postSubmitDeadline = Date.now() + wixPostSubmitWaitMs;
		const postSubmitMaxPolls = wixPostSubmitWaitMs > 0 ? Math.max(1, Math.ceil(wixPostSubmitWaitMs / POST_SUBMIT_POLL_INTERVAL_MS)) : 1;
		let postDialog = {
			hasCaptcha: false,
			hasLoginDialog: false
		};
		let postFrames;
		for (let poll = 0; poll < postSubmitMaxPolls && (poll === 0 || Date.now() < postSubmitDeadline); poll++) {
			throwIfAborted$2(options.signal);
			const remaining = postSubmitDeadline - Date.now();
			if (remaining > 0) await sleep(Math.min(POST_SUBMIT_POLL_INTERVAL_MS, remaining), options.signal);
			postDialog = await page.evaluate(INSPECT_WIX_POST_SUBMIT_SCRIPT).catch(() => ({
				hasCaptcha: false,
				hasLoginDialog: false
			}));
			postFrames = await inspectChildFrames(page);
			if (postDialog.hasCaptcha || postFrames.captchaDetected) return {
				kind: "comment_publish",
				page: ref,
				outcome: "blocked_captcha",
				siteType: "wix",
				title: await page.title().catch(() => inspection.title),
				finalUrl: page.url(),
				templateSignature: "wix:signup_recaptcha",
				evidence: "点击 Wix Publish 后弹出 reCAPTCHA 人机验证窗口，未尝试绕过",
				suggestedTags: ["has_captcha"],
				submitTriggered: false
			};
			if (postDialog.hasLoginDialog) return buildNeedsLoginResult(ref, "wix", inspection, "点击 Wix Publish 后弹出 Sign Up / Log in 登录窗口，非乐观成功，请先登录后再发表", postDialog.loginInfo, page.url());
			if (postDialog.moderationNotice) {
				if (postDialog.ackButtonSelector && typeof page.locator === "function") await page.locator(postDialog.ackButtonSelector).first().click({ timeout: Math.min(2e3, timeoutMs) }).catch(() => void 0);
				const currentUrl = page.url();
				return {
					kind: "comment_publish",
					page: ref,
					outcome: "submitted",
					siteType: "wix",
					title: await page.title().catch(() => inspection.title),
					finalUrl: currentUrl,
					publicUrl: currentUrl,
					postSubmitUrl: currentUrl,
					...postDialog.dialogText === void 0 ? {} : { postSubmitSnippet: postDialog.dialogText },
					evidence: `Wix 评论提交后弹窗提示等待审核 (${postDialog.moderationNotice})`,
					submitTriggered: true
				};
			}
		}
		const postCheck = await safeVerifyResult(page, command, timeoutMs, sleep, options.signal);
		const postSubmitUrl = postCheck.currentUrl;
		const postVerify = postCheck.verify;
		const postSubmitSnippet = postVerify.snippet;
		const sawModeration = Boolean(postVerify.moderationNotice);
		const hadOptimisticLinkBeforeReload = postVerify.liveLinkFound;
		if (sawModeration) return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType: "wix",
			title: await page.title().catch(() => inspection.title),
			finalUrl: postSubmitUrl,
			publicUrl: postSubmitUrl,
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: `Wix 访客评论已提交待审核 (${postVerify.moderationNotice})`,
			submitTriggered: true
		};
		let finalVerify = postVerify;
		let finalUrl = postSubmitUrl;
		if (verifyReload) {
			const cleanReloadUrl = stripWpModerationParams(command.url);
			await page.goto(cleanReloadUrl, {
				timeout: timeoutMs,
				waitUntil: "domcontentloaded"
			});
			const reloadWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 5e3, timeoutMs);
			const reloadDeadline = Date.now() + reloadWaitMaxMs;
			const reloadMaxPolls = reloadWaitMaxMs > 0 ? Math.max(1, Math.ceil(reloadWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 1;
			await scrollPageStep(page, 1);
			finalVerify = (await safeVerifyResult(page, command, timeoutMs, sleep, options.signal)).verify;
			for (let poll = 0; poll < reloadMaxPolls && Date.now() < reloadDeadline && !finalVerify.liveLinkFound && !finalVerify.moderationNotice && !finalVerify.escapedHtmlDetected; poll++) {
				const remaining = reloadDeadline - Date.now();
				if (remaining <= 0) break;
				await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
				await scrollPageStep(page, 1);
				finalVerify = (await safeVerifyResult(page, command, timeoutMs, sleep, options.signal)).verify;
			}
			finalUrl = page.url();
		}
		const finalTitle = await page.title().catch(() => inspection.title);
		if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType: "wix",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: "Wix 评论提交后检测到正文 HTML 被转义，链接未生效（严禁重发）",
			submitTriggered: true
		};
		if (finalVerify.liveLinkFound) return {
			kind: "comment_publish",
			page: ref,
			outcome: "live",
			siteType: "wix",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: `Wix 访客评论公开页重载核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
			submitTriggered: true
		};
		if (finalVerify.moderationNotice) return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType: "wix",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			postSubmitUrl,
			evidence: `Wix 访客评论已提交待审核 (${finalVerify.moderationNotice})`,
			submitTriggered: true
		};
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType: "wix",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			reason: "optimistic_dom_not_persisted",
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? finalVerify.snippet === void 0 ? {} : { postSubmitSnippet: finalVerify.snippet } : { postSubmitSnippet },
			evidence: hadOptimisticLinkBeforeReload ? "Wix 提交后虽出现乐观 DOM 评论但干净 URL 重载后消失 (optimistic_dom_not_persisted)，严禁误报 live 或重试" : "已触发 Wix Publish 但干净 URL 重载后未确认持久可点击链接 (optimistic_dom_not_persisted，严禁自动重试)",
			submitTriggered: true
		};
	}
	if (inspection.childFrames?.captchaDetected) return {
		kind: "comment_publish",
		page: ref,
		outcome: "blocked_captcha",
		siteType: "other",
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		evidence: "在页面子 iframe 中检测到 CAPTCHA 人机验证，未尝试绕过",
		suggestedTags: ["has_captcha"],
		submitTriggered: false
	};
	return buildFallbackResult(ref, "other", inspection);
}
// lib/types/host/browser-playwright/compact-snapshot.js
/**
* Compact DOM snapshot compressors for `browser action="snapshot"` (`aria`, `text`,
* and fallback plain text). Prunes decorative header/nav/footer/SVG bloat while
* preserving interactive forms, inputs, buttons, comments, auth gates, and alerts.
*/
const BOILERPLATE_ROLES = /* @__PURE__ */ new Set([
	"banner",
	"navigation",
	"contentinfo",
	"complementary"
]);
const DECORATIVE_ROLES = /* @__PURE__ */ new Set([
	"presentation",
	"none",
	"separator"
]);
const WRAPPER_ROLES = /* @__PURE__ */ new Set([
	"generic",
	"group",
	"list",
	"listitem",
	"region",
	"article",
	"main",
	"section",
	"paragraph"
]);
const FORM_CONTROL_ROLES = /* @__PURE__ */ new Set([
	"form",
	"textbox",
	"searchbox",
	"combobox",
	"listbox",
	"checkbox",
	"radio",
	"spinbutton",
	"switch",
	"button",
	"dialog",
	"alertdialog",
	"alert",
	"status",
	"iframe"
]);
const INPUT_ROLES = /* @__PURE__ */ new Set([
	"textbox",
	"searchbox",
	"combobox",
	"listbox",
	"checkbox",
	"radio",
	"spinbutton",
	"switch"
]);
const AUTH_OR_ACTION_PATTERN = /sign\s*in|log\s*in|sign\s*up|register|submit|add\s*(?:site|tool|listing|url)|comment|reply|post|login|oauth|google|github|登录|注册|提交|评论|入驻|申请|发布|回复|验证/iu;
const COMMENT_OR_FORM_HINT_PATTERN = /comment|respond|reply|review|submit|form|author|email|website|url|captcha|recaptcha|moderation|awaiting|login|sign\s*in|评论|回复|提交|审核|验证码|登录/iu;
const STATUS_FEEDBACK_PATTERN = /\b(?:thank\s+you|thanks\s+for\s+submitting|submitted|successfully|success|pending\s+review|under\s+review|pending\s+approval|awaiting\s+moderation|already\s+submitted|already\s+exists|duplicate|error|failed|invalid|required|please\s+enter|please\s+fill)\b|提交成功|已提交|审核中|等待审核|待审核|已存在|重复提交|必填|错误|失败/iu;
function collapseWs(value) {
	return value.replace(/\s+/gu, " ").trim();
}
function truncateInline(value, maxLen) {
	const clean = collapseWs(value);
	if (clean.length <= maxLen) return clean;
	return `${clean.slice(0, maxLen - 1)}…`;
}
function parseAriaLine(line) {
	if (line.trim().length === 0) return void 0;
	const indent = line.length - line.trimStart().length;
	const trimmed = line.trim();
	if (!trimmed.startsWith("- ")) {
		const clean = truncateInline(trimmed, 140);
		const isStatusNotice = STATUS_FEEDBACK_PATTERN.test(trimmed);
		return {
			indent,
			rawTrimmed: trimmed,
			role: "meta",
			isPropertyLine: true,
			isBoilerplate: false,
			isDecorative: false,
			isInteractive: false,
			isPriority: isStatusNotice,
			isStatusNotice,
			isWrapperOnly: false,
			formatted: `${" ".repeat(indent)}${clean}`
		};
	}
	const body = trimmed.slice(2);
	if (body.startsWith("/")) {
		const clean = truncateInline(body, 120);
		return {
			indent,
			rawTrimmed: trimmed,
			role: "url",
			isPropertyLine: true,
			isBoilerplate: false,
			isDecorative: false,
			isInteractive: false,
			isPriority: false,
			isStatusNotice: false,
			isWrapperOnly: false,
			formatted: `${" ".repeat(indent)}- ${clean}`
		};
	}
	const roleMatch = /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(?:\s*\[[^\]]*\])*\s*:(?:\s*(.*))?$/u.exec(body) ?? /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(.*)$/u.exec(body);
	const role = (roleMatch?.[1] ?? "text").toLowerCase();
	const quotedName = roleMatch?.[2] ?? "";
	const isPropertyLine = role === "text";
	const isBoilerplate = BOILERPLATE_ROLES.has(role);
	const isDecorative = DECORATIVE_ROLES.has(role) || role === "img" && quotedName.length === 0 && !AUTH_OR_ACTION_PATTERN.test(body);
	const isFormControl = FORM_CONTROL_ROLES.has(role);
	const isAuthOrAction = AUTH_OR_ACTION_PATTERN.test(body);
	const isStatusNotice = role === "alert" || role === "alertdialog" || role === "status" || STATUS_FEEDBACK_PATTERN.test(body);
	const isInteractive = isFormControl || (role === "link" || role === "menuitem") && isAuthOrAction;
	const isPriority = isFormControl || isAuthOrAction || isStatusNotice || COMMENT_OR_FORM_HINT_PATTERN.test(body);
	const colonIdx = body.indexOf(":");
	const isWrapperOnly = WRAPPER_ROLES.has(role) && colonIdx >= 0 && body.slice(colonIdx + 1).trim().length === 0;
	let compactBody = body;
	if (role === "heading") compactBody = truncateInline(body, 120);
	else if (role === "paragraph" || role === "text" || role === "generic") {
		if (colonIdx >= 0) {
			const prefix = body.slice(0, colonIdx + 1);
			const val = body.slice(colonIdx + 1).trim();
			compactBody = val.length > 0 ? `${prefix} ${truncateInline(val, 140)}` : prefix;
		} else compactBody = truncateInline(body, 140);
	} else compactBody = truncateInline(body, 180);
	return {
		indent,
		rawTrimmed: trimmed,
		role,
		isPropertyLine,
		isBoilerplate,
		isDecorative,
		isInteractive,
		isPriority,
		isStatusNotice,
		isWrapperOnly,
		formatted: `${" ".repeat(indent)}- ${compactBody}`
	};
}
function dropEmptyWrappers(entries) {
	const result = [...entries];
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = result.length - 1; i >= 0; i--) {
			const current = result[i];
			if (!current.isWrapperOnly) continue;
			const next = result[i + 1];
			if (next === void 0 || next.indent <= current.indent) {
				result.splice(i, 1);
				changed = true;
			}
		}
	}
	return result;
}
function collapseSiblingLinks(entries) {
	const out = [];
	let collapsedCount = 0;
	let i = 0;
	while (i < entries.length) {
		const current = entries[i];
		if (current.role !== "link" || current.keepPriority) {
			out.push(current);
			i++;
			continue;
		}
		const groupIndents = [];
		let j = i;
		while (j < entries.length) {
			const head = entries[j];
			if (head.indent !== current.indent || head.role !== "link" || head.keepPriority) break;
			groupIndents.push(j);
			j++;
			while (j < entries.length && entries[j].indent > current.indent) j++;
		}
		if (groupIndents.length <= 6) for (let k = i; k < j; k++) out.push(entries[k]);
		else {
			const fifthStart = groupIndents[4];
			for (let k = i; k < fifthStart; k++) out.push(entries[k]);
			const omitted = groupIndents.length - 4;
			collapsedCount += omitted;
			out.push({
				indent: current.indent,
				rawTrimmed: `- ... (+${omitted} links)`,
				role: "meta",
				isPropertyLine: true,
				isBoilerplate: false,
				isDecorative: false,
				isInteractive: false,
				isPriority: false,
				isStatusNotice: false,
				isWrapperOnly: false,
				keepPriority: false,
				formatted: `${" ".repeat(current.indent)}- ... (+${omitted} links)`
			});
		}
		i = j;
	}
	return {
		entries: out,
		collapsedCount
	};
}
/**
* Collapse long `<select>` / `combobox` / `listbox` option lists (> 15 options)
* into first 3 + `... (共 N 项)` + last 2 so a single country/state dropdown
* never blows the 4,500-char compact snapshot budget.
*/
function collapseLongOptionLists(entries) {
	const out = [];
	let collapsedCount = 0;
	let i = 0;
	while (i < entries.length) {
		const current = entries[i];
		if (current.role !== "option") {
			out.push(current);
			i++;
			continue;
		}
		const optionStarts = [];
		let j = i;
		while (j < entries.length) {
			const head = entries[j];
			if (head.indent !== current.indent || head.role !== "option") break;
			optionStarts.push(j);
			j++;
			while (j < entries.length && entries[j].indent > current.indent) j++;
		}
		const total = optionStarts.length;
		if (total <= 15) for (let k = i; k < j; k++) out.push(entries[k]);
		else {
			const headEnd = optionStarts[3];
			const tailStart = optionStarts[total - 2];
			for (let k = i; k < headEnd; k++) out.push(entries[k]);
			const omitted = total - 5;
			collapsedCount += omitted;
			out.push({
				indent: current.indent,
				rawTrimmed: `- ... (共 ${total} 项)`,
				role: "meta",
				isPropertyLine: true,
				isBoilerplate: false,
				isDecorative: false,
				isInteractive: false,
				isPriority: current.keepPriority,
				isStatusNotice: false,
				isWrapperOnly: false,
				keepPriority: current.keepPriority,
				formatted: `${" ".repeat(current.indent)}- ... (共 ${total} 项)`
			});
			for (let k = tailStart; k < j; k++) out.push(entries[k]);
		}
		i = j;
	}
	return {
		entries: out,
		collapsedCount
	};
}
function budgetAriaLines(entries, maxChars) {
	const allText = entries.map((e) => e.formatted).join("\n");
	if (allText.length <= maxChars) return {
		text: allText,
		truncated: false
	};
	const selected = new Array(entries.length).fill(false);
	let usedChars = 0;
	const tryPick = (predicate) => {
		for (let i = 0; i < entries.length; i++) {
			if (selected[i]) continue;
			const entry = entries[i];
			if (!predicate(entry)) continue;
			const cost = entry.formatted.length + (usedChars > 0 ? 1 : 0);
			if (usedChars + cost <= maxChars) {
				selected[i] = true;
				usedChars += cost;
			}
		}
	};
	tryPick((entry) => entry.isStatusNotice);
	tryPick((entry) => entry.keepPriority);
	tryPick(() => true);
	const lines = [];
	for (let i = 0; i < entries.length; i++) if (selected[i]) lines.push(entries[i].formatted);
	if (lines.length === 0) return {
		text: allText.slice(0, maxChars),
		truncated: true
	};
	return {
		text: lines.join("\n").slice(0, maxChars),
		truncated: true
	};
}
/**
* Compress a Playwright ARIA snapshot by pruning boilerplate navigation/footer/SVG
* subtrees, deduplicating prose, collapsing long link lists, and prioritizing
* forms/inputs/comments under tight character budgets.
*/
function compactAriaSnapshot(rawAria, maxChars) {
	const rawLines = rawAria.split(/\r?\n/u);
	const counts = {
		forms: 0,
		inputs: 0,
		buttons: 0,
		links: 0,
		iframes: 0,
		alerts: 0
	};
	let prunedCount = 0;
	const stack = [];
	const kept = [];
	let lastKeptFormatted = "";
	for (const rawLine of rawLines) {
		const parsed = parseAriaLine(rawLine);
		if (parsed === void 0) continue;
		if (parsed.role === "form") counts.forms++;
		else if (INPUT_ROLES.has(parsed.role)) counts.inputs++;
		else if (parsed.role === "button") counts.buttons++;
		else if (parsed.role === "link") counts.links++;
		else if (parsed.role === "iframe") counts.iframes++;
		else if (parsed.role === "alert" || parsed.role === "alertdialog" || parsed.role === "status") counts.alerts++;
		while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indent) stack.pop();
		const parent = stack[stack.length - 1];
		const inBoilerplate = (parent?.boilerplate ?? false) || parsed.isBoilerplate;
		const inPrioritySubtree = (parent?.priority ?? false) || parsed.isPriority;
		if (inBoilerplate) {
			if (parsed.isInteractive || parsed.isStatusNotice) {
				kept.push({
					...parsed,
					keepPriority: true
				});
				lastKeptFormatted = parsed.formatted;
				stack.push({
					indent: parsed.indent,
					boilerplate: true,
					priority: true
				});
			} else if (parsed.role === "url" && parent?.priority) {
				kept.push({
					...parsed,
					keepPriority: true
				});
				lastKeptFormatted = parsed.formatted;
			} else {
				prunedCount++;
				stack.push({
					indent: parsed.indent,
					boilerplate: true,
					priority: false
				});
			}
			continue;
		}
		if (parsed.isDecorative) {
			prunedCount++;
			continue;
		}
		if (parsed.formatted === lastKeptFormatted && !parsed.isInteractive && !parsed.isStatusNotice) {
			prunedCount++;
			continue;
		}
		kept.push({
			...parsed,
			keepPriority: inPrioritySubtree
		});
		lastKeptFormatted = parsed.formatted;
		stack.push({
			indent: parsed.indent,
			boilerplate: false,
			priority: inPrioritySubtree
		});
	}
	const withoutEmpty = dropEmptyWrappers(kept);
	const { entries: withCollapsedLinks, collapsedCount: collapsedLinks } = collapseSiblingLinks(withoutEmpty);
	const { entries: finalEntries, collapsedCount: collapsedOptions } = collapseLongOptionLists(withCollapsedLinks);
	const totalPruned = prunedCount + collapsedLinks + collapsedOptions + Math.max(0, kept.length - withoutEmpty.length);
	const compactedUnbounded = finalEntries.map((e) => e.formatted).join("\n");
	const reductionPct = rawAria.length > 0 ? Math.max(0, Math.round((1 - compactedUnbounded.length / rawAria.length) * 100)) : 0;
	const compactSummary = `forms=${counts.forms} inputs=${counts.inputs} buttons=${counts.buttons} links=${counts.links} iframes=${counts.iframes} alerts=${counts.alerts} pruned=${totalPruned} (raw=${rawAria.length}c -> ${compactedUnbounded.length}c, -${reductionPct}%)`;
	const budgeted = budgetAriaLines(finalEntries, maxChars);
	return {
		text: budgeted.text,
		truncated: budgeted.truncated,
		compactSummary
	};
}
/** Evaluated in the browser for compact `snapshot format="text"`. */
const COMPACT_TEXT_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isHidden = (el) => {
    if (!el || el.hidden) return true;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return true;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return !!(style && (style.display === 'none' || style.visibility === 'hidden'));
  };
  const isBoilerplate = (el) => {
    const bp = el.closest('header,footer,nav,aside,[role="banner"],[role="navigation"],[role="contentinfo"]');
    if (!bp) return false;
    return !bp.querySelector('form,textarea,input:not([type="hidden"]),[role="dialog"],[role="alertdialog"]');
  };

  const forms = Array.from(document.querySelectorAll('form')).filter(f => !isHidden(f));
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea,select')).filter(i => !isHidden(i));
  const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"]')).filter(b => !isHidden(b));
  const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => !isHidden(f));

  const formatSelectSummary = (selectEl) => {
    const opts = Array.from(selectEl.options || []).map(o => clean(o.textContent || o.value)).filter(Boolean);
    if (opts.length === 0) return '';
    if (opts.length <= 15) return ' [' + opts.slice(0, 6).join(', ') + (opts.length > 6 ? ', ...' : '') + ']';
    const head = opts.slice(0, 3);
    const tail = opts.slice(-2);
    return ' [' + head.join(', ') + ', ... (共 ' + opts.length + ' 项), ' + tail.join(', ') + ']';
  };

  const formLines = forms.slice(0, 8).map((form, idx) => {
    const action = clean(form.getAttribute('action'));
    const idAttr = form.id ? '#' + form.id : '';
    const ctrls = Array.from(form.querySelectorAll('input:not([type="hidden"]),textarea,select,button'))
      .filter(c => !isHidden(c))
      .slice(0, 14)
      .map(c => {
        const tag = c.localName;
        const type = tag === 'input' ? ':' + (c.type || 'text') : '';
        const idSel = c.id ? '#' + clean(c.id).slice(0, 32) : '';
        const nameVal = clean(c.getAttribute('name'));
        const nameSel = nameVal ? '[name="' + nameVal.slice(0, 32) + '"]' : '';
        const hint = clean(c.getAttribute('placeholder') || c.getAttribute('aria-label') || (tag === 'button' ? clean(c.textContent) : ''));
        const selPart = idSel + nameSel;
        const labelPart = selPart
          ? (tag === 'button' && hint ? '(' + hint.slice(0, 28) + ')' : '')
          : (hint ? '(' + hint.slice(0, 32) + ')' : '');
        const optsPart = tag === 'select' ? formatSelectSummary(c) : '';
        return tag + type + selPart + labelPart + optsPart;
      });
    return 'form[' + idx + ']' + idAttr + (action ? ' action=' + action.slice(0, 60) : '') + ': ' + (ctrls.join(', ') || '(no visible fields)');
  });

  const statusKeywordRegex = /\b(?:thank\s+you|thanks\s+for\s+submitting|submitted|successfully|pending\s+review|under\s+review|pending\s+approval|awaiting\s+moderation|already\s+submitted|already\s+exists|error|required|please\s+enter|please\s+fill)\b|提交成功|已提交|审核中|等待审核|待审核|已存在|必填|错误|失败/i;
  const alerts = [];
  const pushAlert = (rawText) => {
    const text = clean(rawText).slice(0, 200);
    if (text && !alerts.includes(text) && alerts.length < 8) alerts.push(text);
  };
  for (const el of document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="status"],.comment-awaiting-moderation,.wp-die-message,#error-page')) {
    if (isHidden(el)) continue;
    pushAlert(el.innerText || el.textContent);
  }
  if (alerts.length < 8) {
    for (const el of document.querySelectorAll('p,span,div,li,strong,small,h1,h2,h3,label')) {
      if (alerts.length >= 8) break;
      if (isHidden(el) || el.closest('script,style,noscript,svg')) continue;
      if (el.children && el.children.length > 3) continue;
      const text = clean(el.innerText || el.textContent);
      if (text.length >= 3 && text.length <= 220 && statusKeywordRegex.test(text)) {
        pushAlert(text);
      }
    }
  }

  const rawBodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const mainRoot = document.querySelector('main,article,[role="main"],#comments,#respond') || document.body;
  const mainLines = [];
  if (mainRoot) {
    const walker = document.createTreeWalker(mainRoot, NodeFilter.SHOW_ELEMENT);
    const seen = new Set();
    let node = walker.currentNode;
    while (node && mainLines.length < 120) {
      if (node.nodeType === 1) {
        const el = node;
        if (!['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(el.tagName) && !isHidden(el) && !isBoilerplate(el)) {
          if (/^(H1|H2|H3|H4|P|LI|LABEL|BUTTON|A|TEXTAREA)$/u.test(el.tagName)) {
            const text = clean(el.innerText || el.textContent);
            if (text && text.length >= 2 && !seen.has(text)) {
              seen.add(text);
              mainLines.push(text.slice(0, 180));
            }
          }
        }
      }
      node = walker.nextNode();
    }
  }

  return {
    forms: forms.length,
    inputs: inputs.length,
    buttons: buttons.length,
    iframes: iframes.length,
    alerts,
    formLines,
    mainLines,
    rawChars: rawBodyText.length,
  };
})()`;
/** Format the evaluated `COMPACT_TEXT_SCRIPT` result under `maxChars`. */
function formatCompactTextEvaluation(raw, maxChars) {
	const data = typeof raw === "object" && raw !== null ? raw : {};
	const forms = typeof data.forms === "number" ? data.forms : 0;
	const inputs = typeof data.inputs === "number" ? data.inputs : 0;
	const buttons = typeof data.buttons === "number" ? data.buttons : 0;
	const iframes = typeof data.iframes === "number" ? data.iframes : 0;
	const alerts = Array.isArray(data.alerts) ? data.alerts.filter((v) => typeof v === "string") : [];
	const formLines = Array.isArray(data.formLines) ? data.formLines.filter((v) => typeof v === "string") : [];
	const mainLines = Array.isArray(data.mainLines) ? data.mainLines.filter((v) => typeof v === "string") : [];
	const rawChars = typeof data.rawChars === "number" ? data.rawChars : 0;
	const sections = [];
	if (alerts.length > 0) sections.push("[alerts]\n" + alerts.map((line) => `- ${line}`).join("\n"));
	if (formLines.length > 0) sections.push("[forms]\n" + formLines.map((line) => `- ${line}`).join("\n"));
	if (mainLines.length > 0) sections.push("[content]\n" + mainLines.join("\n"));
	const fullCompact = sections.join("\n\n");
	const effectiveRaw = Math.max(rawChars, fullCompact.length);
	const reductionPct = effectiveRaw > 0 ? Math.max(0, Math.round((1 - fullCompact.length / effectiveRaw) * 100)) : 0;
	const compactSummary = `forms=${forms} inputs=${inputs} buttons=${buttons} iframes=${iframes} alerts=${alerts.length} (raw=${rawChars}c -> ${fullCompact.length}c, -${reductionPct}%)`;
	if (fullCompact.length <= maxChars) return {
		text: fullCompact,
		truncated: false,
		compactSummary
	};
	return {
		text: fullCompact.slice(0, maxChars),
		truncated: true,
		compactSummary
	};
}
/** Fallback pure-text compressor used when `page.evaluate` is unavailable or selector-scoped. */
function compactPlainText(rawText, maxChars) {
	const rawLines = rawText.split(/\r?\n/u);
	const cleaned = [];
	let prev = "";
	let pruned = 0;
	for (const line of rawLines) {
		const normalized = collapseWs(line);
		if (normalized.length === 0) {
			pruned++;
			continue;
		}
		if (normalized === prev) {
			pruned++;
			continue;
		}
		cleaned.push(normalized);
		prev = normalized;
	}
	const statusLines = cleaned.filter((line) => STATUS_FEEDBACK_PATTERN.test(line));
	const priority = cleaned.filter((line) => COMMENT_OR_FORM_HINT_PATTERN.test(line) || STATUS_FEEDBACK_PATTERN.test(line));
	const regular = cleaned.filter((line) => !COMMENT_OR_FORM_HINT_PATTERN.test(line) && !STATUS_FEEDBACK_PATTERN.test(line));
	const unbounded = cleaned.join("\n");
	const reductionPct = rawText.length > 0 ? Math.max(0, Math.round((1 - unbounded.length / rawText.length) * 100)) : 0;
	const compactSummary = `lines=${cleaned.length} priority=${priority.length} pruned=${pruned} (raw=${rawText.length}c -> ${unbounded.length}c, -${reductionPct}%)`;
	if (unbounded.length <= maxChars) return {
		text: unbounded,
		truncated: false,
		compactSummary
	};
	const selected = /* @__PURE__ */ new Set();
	let used = 0;
	for (const list of [
		statusLines,
		priority,
		regular
	]) for (const line of list) {
		if (selected.has(line)) continue;
		const cost = line.length + (used > 0 ? 1 : 0);
		if (used + cost <= maxChars) {
			selected.add(line);
			used += cost;
		}
	}
	const ordered = cleaned.filter((line) => selected.has(line));
	return {
		text: ordered.length > 0 ? ordered.join("\n").slice(0, maxChars) : unbounded.slice(0, maxChars),
		truncated: true,
		compactSummary
	};
}
const AUTOFILL_POLL_INTERVAL_MS = 400;
const INSPECT_DIRECTORY_AUTOFILL_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.disabled) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };

  const unique = (el, sel) => {
    if (!sel) return false;
    try {
      const list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };

  const selectorFor = (el) => {
    if (!el) return '';
    if (el.id) {
      const byId = '#' + escapeCss(el.id);
      if (unique(el, byId)) return byId;
    }
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      const byName = el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
      if (unique(el, byName)) return byName;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTestId = '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byTestId)) return byTestId;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      const byPh = el.localName + '[placeholder="' + placeholder.replace(/"/g, '\\"') + '"]';
      if (unique(el, byPh)) return byPh;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 7; node = node.parentElement, depth++) {
      const tag = node.localName;
      const parent = node.parentNode;
      if (!parent) break;
      const siblings = Array.from(parent.children || []).filter(s => s.localName === tag);
      const seg = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? seg + ' > ' + path : seg;
      if (unique(el, path)) return path;
    }
    return '';
  };

  const labelTextFor = (el) => {
    const parts = [];
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (lbl) parts.push(clean(lbl.innerText || lbl.textContent));
      } catch {}
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) parts.push(clean(wrappingLabel.innerText || wrappingLabel.textContent));
    parts.push(el.getAttribute('name') || '');
    parts.push(el.id || '');
    parts.push(el.getAttribute('placeholder') || '');
    parts.push(el.getAttribute('aria-label') || '');
    return clean(parts.join(' ')).toLowerCase();
  };

  const captchaDetected = !!document.querySelector(
    '.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]'
  );

  const visibleInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'))
    .filter(el => isVisible(el) && !el.closest('header, nav, footer, [role="search"]'));

  const hasPasswordField = visibleInputs.some(el => el.localName === 'input' && (el.type || '').toLowerCase() === 'password');
  const nonAuthInputs = visibleInputs.filter(el => {
    const type = el.localName === 'input' ? (el.type || 'text').toLowerCase() : 'textarea';
    return type !== 'password' && type !== 'search';
  });

  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const loginRequired = (hasPasswordField && nonAuthInputs.length <= 1)
    || (nonAuthInputs.length === 0 && /\b(?:sign\s*in\s+to\s+submit|log\s*in\s+to\s+submit|please\s+sign\s*in|please\s+log\s*in)\b|请先登录|登录后提交/i.test(bodyText));

  const fields = [];
  const usedEls = new Set();

  const pickField = (role, predicate) => {
    const el = nonAuthInputs.find(candidate => !usedEls.has(candidate) && predicate(candidate));
    if (!el) return;
    const selector = selectorFor(el);
    if (!selector) return;
    usedEls.add(el);
    fields.push({
      role,
      selector,
      value: clean(el.value || ''),
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
    });
  };

  // 1. URL input
  pickField('url', el => {
    if (el.localName !== 'input') return false;
    const type = (el.type || '').toLowerCase();
    const sig = labelTextFor(el);
    return type === 'url' || /\b(?:url|website|site[\s_-]?url|homepage|link|domain|tool[\s_-]?url)\b|网址|网站地址|链接/i.test(sig);
  });

  // 2. Email input
  pickField('email', el => {
    if (el.localName !== 'input') return false;
    const type = (el.type || '').toLowerCase();
    const sig = labelTextFor(el);
    return type === 'email' || /\b(?:email|e-mail|contact[\s_-]?mail|mail)\b|邮箱|电子邮件/i.test(sig);
  });

  // 3. Name / Title input
  pickField('name', el => {
    if (el.localName !== 'input') return false;
    const sig = labelTextFor(el);
    return /\b(?:name|title|tool[\s_-]?name|product[\s_-]?name|site[\s_-]?name|project[\s_-]?name|app[\s_-]?name)\b|名称|网站名|产品名|标题/i.test(sig);
  });

  // 4. Tagline / Short Description
  pickField('tagline', el => {
    const sig = labelTextFor(el);
    return /\b(?:tagline|slogan|short[\s_-]?desc(?:ription)?|summary|subtitle|one[\s_-]?liner|headline|brief|pitch)\b|一句话|简介|标语|简短描述|副标题/i.test(sig);
  });

  // 5. Long Description / Introduction
  pickField('description', el => {
    const sig = labelTextFor(el);
    if (/\b(?:description|desc|intro(?:duction)?|detail|about|overview|content|long[\s_-]?desc)\b|详细描述|介绍|描述|说明/i.test(sig)) {
      return true;
    }
    return el.localName === 'textarea';
  });

  // Autofill / Fetch button detection (MkDirs / AI-Autofill / magic fill).
  const allButtons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
    .filter(el => isVisible(el) && !el.closest('header, nav, footer'));

  const autofillRegex = /\b(?:ai[\s-]*autofill|auto[\s-]*fill|fetch(?:\s+(?:info|data|meta|metadata|website|details|from\s+url))?|magic\s+fill|extract|import\s+from\s+url|get\s+info|scrape|fill\s+with\s+ai)\b|一键获取|自动获取|自动填充|抓取信息|获取信息|ai\s*填充/i;
  const autofillBtn = allButtons.find(el => {
    const text = clean((el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || ''));
    const hook = clean((el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-hook') || ''));
    return autofillRegex.test(text) || /autofill|fetch-meta|ai-fill/i.test(hook);
  });

  const autofillButtonBusy = !!(autofillBtn && (
    autofillBtn.getAttribute('aria-busy') === 'true'
    || /\b(?:fetching|loading|extracting|analyzing|generating)\b|获取中|填充中|加载中/i.test(clean(autofillBtn.innerText || autofillBtn.textContent))
  ));

  const submitBtn = allButtons.find(el => {
    if (el === autofillBtn) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'submit') return true;
    if (el.localName === 'button' && (el.type || '').toLowerCase() === 'submit') return true;
    const text = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
    return /\b(?:submit|publish|add\s+(?:tool|site|product|listing)|create\s+listing|send|continue\s+to\s+submit)\b|提交|发布|申请入驻|添加网站/i.test(text);
  });

  const selects = Array.from(document.querySelectorAll('select'))
    .filter(el => isVisible(el) && !el.closest('header, nav, footer'))
    .slice(0, 8)
    .map(el => {
      const sel = selectorFor(el);
      const count = el.options ? el.options.length : 0;
      return (sel || 'select') + (el.required ? '*' : '') + '(' + count + ' opts)';
    });

  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter(el => !el.disabled && !el.closest('header, nav, footer'))
    .slice(0, 6)
    .map(el => {
      const sel = selectorFor(el);
      const accept = clean(el.getAttribute('accept'));
      return (sel || 'input[type="file"]') + (el.required ? '*' : '') + (accept ? '(' + accept.slice(0, 24) + ')' : '');
    });

  const extraRequiredEmpty = [];
  for (const el of nonAuthInputs) {
    if (usedEls.has(el)) continue;
    const req = !!(el.required || el.getAttribute('aria-required') === 'true');
    if (req && clean(el.value || '').length === 0) {
      extraRequiredEmpty.push(selectorFor(el) || labelTextFor(el).slice(0, 32));
    }
  }
  for (const el of Array.from(document.querySelectorAll('select')).filter(isVisible)) {
    const req = !!(el.required || el.getAttribute('aria-required') === 'true');
    if (req && clean(el.value || '').length === 0) {
      extraRequiredEmpty.push(selectorFor(el) || 'select');
    }
  }

  return {
    url: location.href,
    title: clean(document.title),
    captchaDetected,
    loginRequired,
    ...(autofillBtn ? { autofillButtonSelector: selectorFor(autofillBtn) } : {}),
    ...(autofillBtn ? { autofillButtonBusy } : {}),
    ...(submitBtn ? { submitSelector: selectorFor(submitBtn) } : {}),
    fields,
    selects,
    fileInputs,
    extraRequiredEmpty,
  };
})()`;
function defaultSleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(new BrowserError("browser directory_autofill aborted", "BROWSER_ABORTED"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new BrowserError("browser directory_autofill aborted", "BROWSER_ABORTED"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function throwIfAborted$1(signal) {
	if (signal?.aborted) throw new BrowserError("browser directory_autofill aborted", "BROWSER_ABORTED");
}
function toFieldStates(fields) {
	return fields.map((field) => ({
		role: field.role,
		selector: field.selector,
		filled: field.value.length > 0,
		required: field.required,
		...field.value.length > 0 ? { valuePreview: field.value.length > 60 ? `${field.value.slice(0, 57)}...` : field.value } : {}
	}));
}
async function executeDirectoryAutofill(page, ref, command, options) {
	const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs;
	const waitAfterFetchMs = Math.min(command.waitAfterFetchMs ?? options.waitAfterFetchMs ?? 4e3, Math.max(timeoutMs, 1e4));
	const sleep = options.sleepImpl ?? defaultSleep;
	throwIfAborted$1(options.signal);
	if (command.url !== void 0) {
		await page.goto(command.url, {
			timeout: timeoutMs,
			waitUntil: "domcontentloaded"
		});
		throwIfAborted$1(options.signal);
	}
	await dismissBlockingOverlays(page, timeoutMs);
	let inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
	if (inspection.captchaDetected) return {
		kind: "directory_autofill",
		page: ref,
		outcome: "blocked_captcha",
		url: inspection.url,
		title: inspection.title,
		autofillTriggered: false,
		autofilledFields: [],
		filledFields: [],
		remainingRequired: [],
		fields: toFieldStates(inspection.fields),
		...inspection.selects.length > 0 ? { selects: inspection.selects } : {},
		...inspection.fileInputs.length > 0 ? { fileInputs: inspection.fileInputs } : {},
		...inspection.submitSelector ? { submitSelector: inspection.submitSelector } : {},
		evidence: "目录提交页检测到 CAPTCHA 人机验证，未尝试绕过"
	};
	if (inspection.loginRequired) return {
		kind: "directory_autofill",
		page: ref,
		outcome: "needs_login",
		url: inspection.url,
		title: inspection.title,
		autofillTriggered: false,
		autofilledFields: [],
		filledFields: [],
		remainingRequired: [],
		fields: toFieldStates(inspection.fields),
		evidence: "目录提交页需要登录（请使用 snapshot format=\"interactive\" 检查 Google SSO 或邮箱登录）"
	};
	if (inspection.fields.length === 0) return {
		kind: "directory_autofill",
		page: ref,
		outcome: "no_form",
		url: inspection.url,
		title: inspection.title,
		autofillTriggered: false,
		autofilledFields: [],
		filledFields: [],
		remainingRequired: [],
		fields: [],
		...inspection.selects.length > 0 ? { selects: inspection.selects } : {},
		...inspection.fileInputs.length > 0 ? { fileInputs: inspection.fileInputs } : {},
		evidence: "未检测到目录站 URL/名称/描述提交表单"
	};
	const filledFields = [];
	const autofilledFields = [];
	let autofillTriggered = false;
	const urlField = inspection.fields.find((f) => f.role === "url");
	if (urlField && command.websiteUrl.trim().length > 0) {
		await page.locator(urlField.selector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
		filledFields.push("url");
	}
	if (inspection.autofillButtonSelector && urlField) {
		const preValues = new Map(inspection.fields.filter((f) => f.role === "name" || f.role === "tagline" || f.role === "description").map((f) => [f.role, f.value]));
		await dismissBlockingOverlays(page, timeoutMs);
		await page.locator(inspection.autofillButtonSelector).first().click({ timeout: timeoutMs });
		autofillTriggered = true;
		const deadline = Date.now() + waitAfterFetchMs;
		const maxPolls = waitAfterFetchMs > 0 ? Math.max(1, Math.ceil(waitAfterFetchMs / AUTOFILL_POLL_INTERVAL_MS)) : 1;
		for (let poll = 0; poll < maxPolls && (poll === 0 || Date.now() < deadline); poll++) {
			throwIfAborted$1(options.signal);
			const remaining = deadline - Date.now();
			if (remaining > 0) await sleep(Math.min(AUTOFILL_POLL_INTERVAL_MS, remaining), options.signal);
			inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
			if (inspection.fields.filter((f) => (f.role === "name" || f.role === "tagline" || f.role === "description") && f.value.length > 0 && f.value !== (preValues.get(f.role) ?? "")).length > 0 && !inspection.autofillButtonBusy) break;
		}
		for (const f of inspection.fields) if ((f.role === "name" || f.role === "tagline" || f.role === "description") && f.value.length > 0 && f.value !== (preValues.get(f.role) ?? "")) autofilledFields.push(f.role);
	} else inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
	const backfillPairs = [
		["name", command.name?.trim()],
		["tagline", command.tagline?.trim()],
		["description", command.description?.trim()],
		["email", command.email?.trim()]
	];
	for (const [role, value] of backfillPairs) {
		if (!value) continue;
		const field = inspection.fields.find((f) => f.role === role);
		if (field && field.value.length === 0) {
			await page.locator(field.selector).first().fill(value, { timeout: timeoutMs });
			filledFields.push(role);
		}
	}
	const finalInspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
	const fieldStates = toFieldStates(finalInspection.fields);
	const remainingRequired = [...fieldStates.filter((f) => f.required && !f.filled).map((f) => `${f.role}(${f.selector})`), ...finalInspection.extraRequiredEmpty];
	const outcome = remainingRequired.length === 0 && fieldStates.some((f) => f.filled) ? "ready_to_submit" : "partial_filled";
	const summaryBits = [
		autofillTriggered ? `autofill触发(回填:${autofilledFields.join(",") || "无"})` : "常规目录填表",
		`补齐:${filledFields.join(",") || "无"}`,
		remainingRequired.length > 0 ? `待补必填:${remainingRequired.join(", ")}` : "必填字段已就绪"
	];
	return {
		kind: "directory_autofill",
		page: ref,
		outcome,
		url: finalInspection.url,
		title: finalInspection.title,
		autofillTriggered,
		autofilledFields,
		filledFields,
		remainingRequired,
		fields: fieldStates,
		...finalInspection.selects.length > 0 ? { selects: finalInspection.selects } : {},
		...finalInspection.fileInputs.length > 0 ? { fileInputs: finalInspection.fileInputs } : {},
		...finalInspection.submitSelector ? { submitSelector: finalInspection.submitSelector } : {},
		evidence: summaryBits.join("；")
	};
}
// lib/types/host/browser-playwright/interactive.js
const VISIBLE_CONTROLS_SCRIPT = String.raw`(() => {
  const probe = 'a[href],button,iframe,summary,input[type=submit],input[type=button],input[type=image],input[type=url],[role=button],[role=link]';
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const roots = [document];
  const candidates = [];
  let passwordFields = 0, emailFields = 0, forms = 0, emailLinks = 0;

  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.matches('input[type=password]')) passwordFields++;
      if (el.matches('input[type=email],input[name*="email" i],input[id*="email" i]')) emailFields++;
      if (el.matches('form')) forms++;
      if (el.matches('a[href^="mailto:" i]')) emailLinks++;
      // A script-driven logo link may have neither href nor an ARIA role.
      if (el.matches(probe) || el.localName === 'a') candidates.push(el);
    }
  }

  function unique(el, selector) {
    if (selector !== clean(selector)) return false;
    try {
      // Playwright CSS pierces open shadow roots, so check the whole locator scope.
      return roots.every(root => {
        const matches = root.querySelectorAll(selector);
        return root === el.getRootNode()
          ? matches.length === 1 && matches[0] === el
          : matches.length === 0;
      });
    } catch {
      return false;
    }
  }

  function selectorFor(el) {
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      if (unique(el, byId)) return byId;
    }
    const nameAttr = el.getAttribute('name');
    if (el.localName === 'input' && nameAttr) {
      const byName = 'input[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
      if (unique(el, byName)) return byName;
    }
    const classes = Array.from(el.classList).filter(name => /^[-_a-zA-Z][\w-]*$/.test(name)).slice(0, 3);
    if (classes.length) {
      const byClass = el.localName + '.' + classes.map(name => CSS.escape(name)).join('.');
      if (unique(el, byClass)) return byClass;
    }
    let path = '';
    for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const tag = node.localName;
      const siblings = Array.from(node.parentNode.children).filter(sibling => sibling.localName === tag);
      const segment = siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag;
      path = path ? segment + ' > ' + path : segment;
      if (unique(el, path)) return path;
    }
    return '';
  }

  const controls = [];
  let truncated = false;
  for (const el of candidates) {
    if (el.disabled === true || el.matches(':disabled')) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.05) continue;
    const background = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(style.backgroundImage);
    if (!el.matches(probe) && !background) continue;
    if (controls.length === 300) {
      truncated = true;
      break;
    }

    const attr = name => el.getAttribute(name);
    const tag = el.localName;
    const inputType = tag === 'input' ? el.type : '';
    const image = tag === 'img' || inputType === 'image' ? el : el.querySelector('img');
    controls.push({
      tag: clean(tag), role: clean(attr('role')), inputType: clean(inputType),
      text: clean(el.innerText) || clean(el.textContent),
      // Button captions are useful; live form values can contain credentials.
      value: tag === 'button' || /^(submit|button|image)$/.test(inputType) ? clean(attr('value')) : '',
      ariaLabel: clean(attr('aria-label')), title: clean(attr('title')), alt: clean(attr('alt')),
      ...(inputType === 'url' && clean(attr('name')) ? { name: clean(attr('name')) } : {}),
      ...(inputType === 'url' && clean(attr('placeholder')) ? { placeholder: clean(attr('placeholder')) } : {}),
      imageAlt: clean(image?.getAttribute('alt')), imageSrc: clean(image?.getAttribute('src')),
      href: clean(attr('href')), src: clean(attr('src')), id: clean(el.id), classes: clean(attr('class')),
      data: clean(Array.from(el.attributes)
        .filter(({ name }) => /^data-.*(?:provider|service|oauth|auth|login|signin|sign-in|action|testid|name|label|idp|sso)/i.test(name))
        .map(({ name, value }) => name + '=' + clean(value)).join(' ')),
      background: clean(background?.[1] ?? background?.[2] ?? background?.[3]),
      formAction: clean((el.form ?? el.closest('form'))?.getAttribute('action')),
      selector: selectorFor(el),
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      hasImage: !!image, hasSvg: tag === 'svg' || !!el.querySelector('svg'),
      inBoilerplate: !!el.closest('header,footer,nav,aside,[role="banner"],[role="navigation"],[role="contentinfo"]'),
    });
  }
  return { controls, passwordFields, emailFields, forms, emailLinks, truncated };
})()`;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function readNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readBoolean(value) {
	return value === true;
}
function parseControlReport(report) {
	const data = isRecord(report) ? report : {};
	const controls = [];
	for (const row of Array.isArray(data.controls) ? data.controls : []) {
		if (!isRecord(row)) continue;
		const tag = readString(row.tag);
		if (!tag) continue;
		controls.push({
			tag,
			role: readString(row.role),
			inputType: readString(row.inputType),
			text: readString(row.text),
			value: readString(row.value),
			ariaLabel: readString(row.ariaLabel),
			title: readString(row.title),
			alt: readString(row.alt),
			imageAlt: readString(row.imageAlt),
			imageSrc: readString(row.imageSrc),
			href: readString(row.href),
			src: readString(row.src),
			id: readString(row.id),
			classes: readString(row.classes),
			data: readString(row.data),
			background: readString(row.background),
			formAction: readString(row.formAction),
			selector: readString(row.selector),
			x: readNumber(row.x),
			y: readNumber(row.y),
			inViewport: readBoolean(row.inViewport),
			hasImage: readBoolean(row.hasImage),
			hasSvg: readBoolean(row.hasSvg),
			...row.inBoilerplate === true ? { inBoilerplate: true } : {},
			...readString(row.name) ? { name: readString(row.name) } : {},
			...readString(row.placeholder) ? { placeholder: readString(row.placeholder) } : {}
		});
	}
	return {
		controls,
		passwordFields: readNumber(data.passwordFields),
		emailFields: readNumber(data.emailFields),
		forms: readNumber(data.forms),
		emailLinks: readNumber(data.emailLinks),
		truncated: readBoolean(data.truncated)
	};
}
const PROVIDERS = {
	google: /\bgoogle\b|googleapis|gstatic|googleusercontent|accounts\.google|\bgsi\b|gsi\/button|g\.co\//,
	facebook: /\bfacebook\b|fb-login|fbconnect|\bfb\b/,
	github: /\bgithub\b/,
	apple: /\bapple\b|appleid|signin\.apple/,
	microsoft: /\bmicrosoft\b|live\.com|outlook|msal|\bazure(ad)?\b/,
	"x-twitter": /\btwitter\b|\bx\.com\b|\btwitter\.com\b/,
	discord: /\bdiscord\b/,
	linkedin: /\blinkedin\b/,
	amazon: /\bamazon\b|amazoncognito/,
	steam: /\bsteam\b/,
	twitch: /\btwitch\b/,
	yahoo: /\byahoo\b/,
	wordpress: /wordpress\.com/,
	reddit: /\breddit\b/,
	tiktok: /\btiktok\b/,
	telegram: /\btelegram\b/
};
const AUTH_PATTERN = /\b(?:sign[ -]?(?:in|up|on)|log[ -]?(?:in|on)|continue|oauth|authori[sz]e|sso|auth|connect|callback|gsi|provider|idp)\b/;
const AUTH_URL_PATTERN = /oauth|openid|authori[sz]e|sso|\bauth\b|\/auth|login|signin|sign-in|connect|gsi|callback/;
const NON_AUTH_URL_PATTERN = /play\.google\.com|plus\.google\.com|\/share(?:\/|[?#\s]|$)|sharer|intent\/tweet|\/maps\//;
const EMAIL_SIGN_IN = {
	provider: "email-password",
	strength: "auth"
};
function evidenceText(...fields) {
	return fields.map((field) => {
		try {
			return decodeURIComponent(field);
		} catch {
			return field;
		}
	}).join(" ").toLowerCase().replace(/_/g, "-");
}
function readSignIn(control) {
	if (control.inputType === "password") return EMAIL_SIGN_IN;
	const labelled = evidenceText(control.text, control.value, control.ariaLabel, control.title, control.alt, control.imageAlt, control.imageSrc, control.id, control.classes, control.data, control.background);
	const linked = evidenceText(control.href, control.src, control.formAction);
	if (NON_AUTH_URL_PATTERN.test(linked)) return void 0;
	const authLabel = AUTH_PATTERN.test(labelled);
	const haystack = labelled + " " + linked;
	const provider = Object.entries(PROVIDERS).find(([, pattern]) => pattern.test(haystack))?.[0];
	if (provider !== void 0) {
		if (authLabel || AUTH_URL_PATTERN.test(linked)) return {
			provider,
			strength: "auth"
		};
		if ([
			"button",
			"summary",
			"input"
		].includes(control.tag) || control.role === "button" || !control.text && (control.hasImage || control.hasSvg || control.background)) return {
			provider,
			strength: "provider"
		};
		return;
	}
	if (authLabel && /\bemail\b/.test(evidenceText(control.text, control.value, control.ariaLabel, control.title))) return EMAIL_SIGN_IN;
}
const INTERACTIVE_ACTION_PATTERN = /sign\s*in|log\s*in|sign\s*up|register|submit|add\s*(?:site|tool|listing|url)|comment|reply|post|login|oauth|google|github|登录|注册|提交|评论|入驻|申请/iu;
function compactAttrValue(key, value) {
	if ((key === "src" || key === "bg") && value.startsWith("data:")) return "data:...";
	if ((key === "href" || key === "src" || key === "bg") && value.length > 90 && !AUTH_URL_PATTERN.test(value)) return `${value.slice(0, 87)}...`;
	if (key === "cls" && value.length > 40) return `${value.slice(0, 37)}...`;
	return value;
}
function renderPageControls(title, report, options) {
	const isCompact = options?.compact === true;
	const counts = /* @__PURE__ */ new Map();
	const lines = [];
	let prunedBoilerplateLinks = 0;
	for (let index = 0; index < report.controls.length; index++) {
		const control = report.controls[index];
		const signIn = readSignIn(control);
		if (signIn) counts.set(signIn.provider, (counts.get(signIn.provider) ?? 0) + 1);
		const type = control.tag === "iframe" ? "iframe" : control.tag === "a" || control.role === "link" ? "link" : control.tag === "input" && control.inputType === "url" ? "input[type=url]" : control.tag;
		const label = control.text || control.value || control.imageAlt || control.alt || control.ariaLabel || control.title || control.placeholder || "";
		if (isCompact && control.inBoilerplate === true && signIn === void 0 && type === "link" && !INTERACTIVE_ACTION_PATTERN.test(`${label} ${control.href}`)) {
			prunedBoilerplateLinks++;
			continue;
		}
		const fields = [
			`#${index + 1} ${type}`,
			label ? JSON.stringify(label) : control.hasImage || control.hasSvg || control.background ? "(icon only)" : "",
			signIn ? `signin=${signIn.provider}${signIn.strength === "provider" ? "?" : ""}` : "",
			control.selector ? `css=${quote(control.selector)}` : "",
			`xy=${control.x},${control.y}${control.inViewport ? "" : " (scroll first)"}`
		];
		const rawAlt = control.imageAlt || control.alt;
		const attrs = isCompact ? {
			alt: rawAlt && rawAlt !== label ? rawAlt : "",
			aria: control.ariaLabel && control.ariaLabel !== label ? control.ariaLabel : "",
			title: control.title && control.title !== label ? control.title : "",
			href: control.href,
			src: control.src || control.imageSrc,
			id: control.id,
			name: control.name ?? "",
			placeholder: control.placeholder && control.placeholder !== label ? control.placeholder : "",
			cls: control.classes,
			bg: control.background,
			form: control.formAction
		} : {
			alt: rawAlt,
			aria: control.ariaLabel,
			title: control.title,
			href: control.href,
			src: control.src || control.imageSrc,
			id: control.id,
			name: control.name ?? "",
			placeholder: control.placeholder ?? "",
			cls: control.classes,
			bg: control.background,
			form: control.formAction
		};
		for (const [key, rawValue] of Object.entries(attrs)) {
			if (!rawValue) continue;
			const value = isCompact ? compactAttrValue(key, rawValue) : rawValue;
			fields.push(`${key}=${quote(value)}`);
		}
		if (control.data) fields.push(/^data-[\w-]+=[^\s"]+$/i.test(control.data) ? control.data : `data=${quote(control.data)}`);
		lines.push(fields.filter(Boolean).join(" "));
	}
	if (isCompact && prunedBoilerplateLinks > 0) lines.push(`... (${prunedBoilerplateLinks} boilerplate nav/footer link(s) pruned; pass full=true to inspect all)`);
	const fieldCount = (count) => count ? `yes ×${count}` : "no";
	const stats = [
		`${report.forms} ${report.forms === 1 ? "form" : "forms"}`,
		`password field: ${fieldCount(report.passwordFields)}`,
		`email field: ${fieldCount(report.emailFields)}`,
		`mailto links: ×${report.emailLinks}`
	];
	return [
		`interactive: ${report.controls.length} visible controls on ${title.trim() ? JSON.stringify(title.trim()) : "(untitled)"} (${stats.join(", ")})`,
		`sign-in candidates: ${Array.from(counts, ([provider, count]) => `${provider} ×${count}`).join(", ") || "none"}`,
		...lines
	].join("\n");
}
function quote(value) {
	return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}
// lib/types/host/browser-playwright/provider.js
/**
* Playwright persistent-Chromium implementation of the browser automation seam.
*/
const PLAYWRIGHT_BROWSER_PROVIDER_ID = "playwright";
const DEFAULT_SNAPSHOT_MAX_CHARS = 6e4;
const STRICT_MODE_INSPECT_TIMEOUT_MS = 1500;
const STRICT_MODE_PATTERN = /strict mode violation/iu;
const NAVIGATE_TIMEOUT_PATTERN = /timeout|timed\s+out/iu;
const STATIC_ASSET_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|js|map)(?:[?#]|$)|google-analytics|googletagmanager|doubleclick|fonts\.googleapis/iu;
const COLLECT_DOM_NOTICES_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };
  const out = [];
  const push = (raw) => {
    const t = clean(raw).slice(0, 220);
    if (t.length >= 2 && !out.includes(t) && out.length < 10) out.push(t);
  };
  const explicitSelectors = [
    '[role="alert"]',
    '[role="alertdialog"]',
    '[role="dialog"]',
    '[role="status"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    '.toast',
    '.toastify',
    '.notyf',
    '.swal2-popup',
    '.layui-layer',
    '.el-message',
    '.el-notification',
    '.ant-message',
    '.ant-notification',
    '[class*="toast" i]',
    '[class*="snackbar" i]',
    '[class*="alert" i]',
    '[class*="modal" i]',
  ];
  for (const sel of explicitSelectors) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch {}
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      push(el.innerText || el.textContent);
    }
  }
  const keywordRegex = /\b(?:thank\s+you|thanks\s+for\s+submitting|submitted|successfully|pending\s+review|under\s+review|already\s+submitted|already\s+exists|error|invalid|required)\b|提交成功|已提交|审核中|等待审核|待审核|已存在|重复提交|失败|错误|请填写/i;
  for (const el of document.querySelectorAll('p, span, div, li, strong, small, h2, h3')) {
    if (out.length >= 10) break;
    if (!isVisible(el) || el.closest('script,style,noscript,svg,header,nav,footer')) continue;
    if (el.children && el.children.length > 3) continue;
    const t = clean(el.innerText || el.textContent);
    if (t.length >= 3 && t.length <= 220 && keywordRegex.test(t)) {
      push(t);
    }
  }
  return out;
})()`;
async function bringPageWindowToFront(page) {
	try {
		const client = await page.context().newCDPSession(page);
		try {
			const info = await client.send("Browser.getWindowForTarget");
			const windowId = info?.windowId;
			const bounds = info?.bounds;
			if (windowId !== void 0 && bounds !== void 0) {
				if (bounds.windowState !== void 0 && bounds.windowState !== "normal") await client.send("Browser.setWindowBounds", {
					windowId,
					bounds: { windowState: "normal" }
				});
				if (bounds.left === void 0 || bounds.top === void 0 || bounds.left < 0 || bounds.top < 0 || bounds.left > 4e3 || bounds.top > 4e3) await client.send("Browser.setWindowBounds", {
					windowId,
					bounds: {
						left: 80,
						top: 80,
						width: Math.max(bounds.width ?? 1280, 1024),
						height: Math.max(bounds.height ?? 860, 720)
					}
				});
			}
		} finally {
			await client.detach().catch(() => void 0);
		}
	} catch {}
	await page.bringToFront();
}
function assertPositiveInteger(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`browser-playwright: ${name} must be a positive integer, got ${value}`);
}
function truncate(text, maxChars) {
	if (text.length <= maxChars) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, maxChars),
		truncated: true
	};
}
function parseSelector(raw) {
	let rest = raw;
	const frames = [];
	while (true) {
		const frame = /^frame\((.+)\)>>/u.exec(rest);
		if (frame === null) break;
		frames.push(frame[1]);
		rest = rest.slice(frame[0].length);
	}
	const prefixed = /^(role|label|placeholder|text|xy):(.*)$/su.exec(rest);
	if (prefixed === null) return {
		mode: "css",
		frames,
		value: rest
	};
	const kind = prefixed[1];
	const body = prefixed[2];
	if (kind === "xy") {
		const xy = /^(\d+),(\d+)$/u.exec(body);
		if (xy === null) throw new BrowserError(`browser xy selector must be xy:<x>,<y> with non-negative integers, got "${raw}"`, "BROWSER_ACTION_FAILED");
		return {
			mode: "xy",
			frames,
			x: Number(xy[1]),
			y: Number(xy[2])
		};
	}
	if (kind === "role") {
		const split = body.indexOf("|");
		if (split < 0) return {
			mode: "role",
			frames,
			value: body
		};
		const role = body.slice(0, split);
		const name = body.slice(split + 1);
		if (role.length === 0 || name.length === 0) throw new BrowserError(`browser role selector must be role:<role>|<name> with both non-empty, got "${raw}"`, "BROWSER_ACTION_FAILED");
		return {
			mode: "role",
			frames,
			value: role,
			name
		};
	}
	if (body.length === 0) throw new BrowserError(`browser ${kind} selector must be ${kind}:<text> with non-empty text`, "BROWSER_ACTION_FAILED");
	return {
		mode: kind,
		frames,
		value: body
	};
}
function buildLocator(page, addressing) {
	if (addressing.mode === "xy") return void 0;
	let root = page;
	for (const frame of addressing.frames) root = root.frameLocator(frame);
	switch (addressing.mode) {
		case "css": return root.locator(addressing.value);
		case "role": return root.getByRole(addressing.value, ...addressing.name === void 0 ? [] : [{ name: addressing.name }]);
		case "label": return root.getByLabel(addressing.value);
		case "placeholder": return root.getByPlaceholder(addressing.value);
		case "text": return root.getByText(addressing.value);
		default: return assertNever(addressing, "unhandled selector addressing");
	}
}
function applyNth(locator, nth) {
	if (nth === void 0) return locator;
	if (!Number.isSafeInteger(nth) || nth < 0) throw new BrowserError(`browser nth must be a non-negative integer, got ${nth}`, "BROWSER_ACTION_FAILED");
	return locator.nth(nth);
}
function elementLocator(page, addressing, nth) {
	const locator = buildLocator(page, addressing);
	if (locator === void 0) throw new BrowserError("browser xy addressing supports click only", "BROWSER_ACTION_FAILED");
	return applyNth(locator, nth);
}
async function inspectStrictModeCandidates(locator, timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS) {
	let timer;
	const inspect = async () => {
		const total = await locator.count();
		if (!Number.isFinite(total) || total <= 0) return void 0;
		const limit = Math.min(total, 5);
		const evalTimeout = Math.max(100, Math.min(timeoutMs, 1e3));
		return {
			total,
			candidates: await Promise.all(Array.from({ length: limit }, async (_, index) => {
				const nthLocator = locator.nth(index);
				const [meta, visible] = await Promise.all([nthLocator.evaluate((rawNode) => {
					const el = rawNode;
					if (!el || typeof el.tagName !== "string") return { tag: "unknown" };
					const tag = el.tagName.toLowerCase();
					const attr = (key) => {
						const raw = typeof el.getAttribute === "function" ? el.getAttribute(key) : null;
						if (typeof raw !== "string") return void 0;
						const cleaned = raw.replace(/\s+/gu, " ").trim();
						return cleaned.length > 0 ? cleaned.slice(0, 80) : void 0;
					};
					const typeAttr = attr("type");
					const inferredRole = attr("role") ?? (tag === "button" || tag === "input" && (typeAttr === "button" || typeAttr === "submit" || typeAttr === "reset") ? "button" : tag === "a" && attr("href") !== void 0 ? "link" : tag === "input" || tag === "textarea" ? "textbox" : tag === "select" ? "combobox" : void 0);
					const cleanedText = (typeof el.innerText === "string" && el.innerText.trim().length > 0 ? el.innerText : typeof el.textContent === "string" ? el.textContent : "").replace(/\s+/gu, " ").trim();
					const text = cleanedText.length > 0 ? cleanedText.length > 80 ? `${cleanedText.slice(0, 80)}…` : cleanedText : void 0;
					const ariaLabel = attr("aria-label");
					const name = attr("name");
					return {
						tag,
						...inferredRole === void 0 ? {} : { role: inferredRole },
						...text === void 0 ? {} : { text },
						...ariaLabel === void 0 ? {} : { ariaLabel },
						...name === void 0 ? {} : { name },
						...typeAttr === void 0 ? {} : { type: typeAttr }
					};
				}, void 0, { timeout: evalTimeout }).catch(() => ({ tag: "unknown" })), nthLocator.isVisible().catch(() => void 0)]);
				return {
					index,
					...meta,
					...visible === void 0 ? {} : { visible }
				};
			}))
		};
	};
	try {
		return await Promise.race([inspect().catch(() => void 0), new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve(void 0);
			}, timeoutMs);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
function formatStrictModeCandidates(inspection) {
	const lines = [`Matched ${inspection.total} element(s) (showing first ${inspection.candidates.length}):`];
	for (const candidate of inspection.candidates) {
		const parts = [`  [${candidate.index}] <${candidate.tag}>`];
		if (candidate.role !== void 0) parts.push(`role=${candidate.role}`);
		if (candidate.type !== void 0) parts.push(`type=${candidate.type}`);
		if (candidate.text !== void 0) parts.push(`text=${JSON.stringify(candidate.text)}`);
		if (candidate.ariaLabel !== void 0) parts.push(`aria-label=${JSON.stringify(candidate.ariaLabel)}`);
		if (candidate.name !== void 0) parts.push(`name=${JSON.stringify(candidate.name)}`);
		if (candidate.visible !== void 0) parts.push(`visible=${String(candidate.visible)}`);
		lines.push(parts.join(" "));
	}
	const suggested = inspection.candidates.find((c) => c.visible !== false && c.role !== void 0 && (c.ariaLabel !== void 0 || c.text !== void 0)) ?? inspection.candidates.find((c) => c.role !== void 0 && (c.ariaLabel !== void 0 || c.text !== void 0));
	const label = suggested?.ariaLabel ?? suggested?.text;
	if (suggested !== void 0 && suggested.role !== void 0 && label !== void 0) lines.push(`Hint: pass nth: <i> (0-based, e.g. nth: ${suggested.index}) or use an exact selector such as role:${suggested.role}|${label}.`);
	else lines.push("Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.");
	return lines.join("\n");
}
async function enrichStrictModeError(commandKind, locator, error, timeoutMs = STRICT_MODE_INSPECT_TIMEOUT_MS) {
	const rawMessage = String(error instanceof Error ? error.message : error);
	if (!STRICT_MODE_PATTERN.test(rawMessage)) return void 0;
	const inspection = await inspectStrictModeCandidates(locator, timeoutMs);
	const details = inspection !== void 0 && inspection.candidates.length > 0 ? formatStrictModeCandidates(inspection) : "Hint: pass nth: <i> (0-based) or use an exact role:button|<name> selector.";
	return new BrowserError(`playwright ${commandKind} failed: ${rawMessage}\n${details}`, "BROWSER_ACTION_FAILED", { cause: error });
}
function throwIfAborted(signal, commandKind) {
	if (signal?.aborted) throw new BrowserError(`browser ${commandKind} aborted`, "BROWSER_ABORTED");
}
var PlaywrightSession = class {
	context;
	defaultTimeoutMs;
	defaultMaxChars;
	closed = false;
	pages = /* @__PURE__ */ new Map();
	pageToRef = /* @__PURE__ */ new WeakMap();
	pageMeta = /* @__PURE__ */ new Map();
	chains = /* @__PURE__ */ new Map();
	popupCollectors = /* @__PURE__ */ new Set();
	keeperPage;
	creatingInternalPage = 0;
	legacyTail = Promise.resolve();
	lastRef;
	refSeq = 0;
	popupSeq = 0;
	constructor(context, defaultTimeoutMs, defaultMaxChars) {
		this.context = context;
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.defaultMaxChars = defaultMaxChars;
		this.context.on("close", () => {
			this.closed = true;
		});
		this.context.on("page", (newPage) => {
			if (this.creatingInternalPage > 0) return;
			if (newPage === this.keeperPage || this.pageToRef.has(newPage)) return;
			const ref = `popup${++this.popupSeq}`;
			this.registerPage(ref, newPage, true);
			for (const collector of this.popupCollectors) collector({
				ref,
				page: newPage
			});
		});
		for (const existing of this.context.pages()) this.adopt(existing);
	}
	isClosed() {
		return this.closed;
	}
	async act(command, signal) {
		throwIfAborted(signal, command.kind);
		if (this.closed) throw new BrowserError("browser session is closed", "BROWSER_ACTION_FAILED");
		if (command.kind === "listPages") return await this.execute(command, signal);
		return await (command.page === void 0 ? this.chained(this.legacyTail, (tail) => {
			this.legacyTail = tail;
		}, command, signal) : this.chained(this.chains.get(command.page) ?? Promise.resolve(), (tail) => {
			this.chains.set(command.page, tail);
		}, command, signal));
	}
	chained(previous, store, command, signal) {
		const next = previous.then(() => this.execute(command, signal));
		store(next.catch(() => void 0));
		return next;
	}
	async execute(command, signal) {
		throwIfAborted(signal, command.kind);
		try {
			switch (command.kind) {
				case "navigate": {
					const { page, ref } = await this.resolveForNavigate(command.page);
					const baseTimeout = command.timeoutMs ?? this.defaultTimeoutMs;
					const timeout = command.siteHint === "wix_blog" ? Math.max(baseTimeout, DEFAULT_WIX_NAV_TIMEOUT_MS) : baseTimeout;
					const requestedWaitUntil = command.waitUntil;
					if (requestedWaitUntil === void 0) await page.goto(command.url, {
						timeout,
						waitUntil: "domcontentloaded"
					});
					else try {
						await page.goto(command.url, {
							timeout,
							waitUntil: requestedWaitUntil
						});
					} catch (error) {
						if (requestedWaitUntil !== "domcontentloaded" && NAVIGATE_TIMEOUT_PATTERN.test(String(error instanceof Error ? error.message : error))) {
							const readyState = typeof page.evaluate === "function" ? await page.evaluate(() => globalThis.document?.readyState ?? "").catch(() => "") : "";
							const currentUrl = page.url();
							if ((readyState === "interactive" || readyState === "complete") && currentUrl.length > 0 && currentUrl !== "about:blank") return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
						}
						throw error;
					}
					return await this.pageResult(page, ref, command.maxChars ?? this.defaultMaxChars);
				}
				case "snapshot": {
					const { page, ref } = await this.requirePage(command.page);
					const maxChars = command.maxChars ?? this.defaultMaxChars;
					const isCompact = command.compact === true;
					if (command.format === "aria") {
						const tree = await page.locator(command.selector ?? "body").ariaSnapshot();
						const title = await page.title();
						if (isCompact) {
							const compacted = compactAriaSnapshot(tree, maxChars);
							return {
								kind: "page",
								page: ref,
								url: page.url(),
								title,
								text: compacted.text,
								truncated: compacted.truncated,
								compactSummary: compacted.compactSummary
							};
						}
						const { text, truncated } = truncate(tree, maxChars);
						return {
							kind: "page",
							page: ref,
							url: page.url(),
							title,
							text,
							truncated
						};
					}
					if (command.format === "interactive") {
						const report = parseControlReport(await page.evaluate(VISIBLE_CONTROLS_SCRIPT));
						const title = await page.title();
						const rawRendered = renderPageControls(title, report);
						const rendered = isCompact ? renderPageControls(title, report, { compact: true }) : rawRendered;
						const { text, truncated } = truncate(rendered, maxChars);
						const compactSummary = isCompact ? `controls=${report.controls.length} forms=${report.forms} (raw=${rawRendered.length}c -> ${rendered.length}c)` : void 0;
						return {
							kind: "page",
							page: ref,
							url: page.url(),
							title,
							text,
							truncated: truncated || report.truncated,
							...compactSummary === void 0 ? {} : { compactSummary }
						};
					}
					if (isCompact) {
						if (command.selector === void 0 && typeof page.evaluate === "function") try {
							const compacted = formatCompactTextEvaluation(await page.evaluate(COMPACT_TEXT_SCRIPT), maxChars);
							return {
								kind: "page",
								page: ref,
								url: page.url(),
								title: await page.title(),
								text: compacted.text,
								truncated: compacted.truncated,
								compactSummary: compacted.compactSummary
							};
						} catch {}
						const [url, title, rawText] = await Promise.all([
							Promise.resolve(page.url()),
							page.title(),
							page.innerText(command.selector ?? "body")
						]);
						const compacted = compactPlainText(rawText, maxChars);
						return {
							kind: "page",
							page: ref,
							url,
							title,
							text: compacted.text,
							truncated: compacted.truncated,
							compactSummary: compacted.compactSummary
						};
					}
					return await this.pageResult(page, ref, maxChars, command.selector);
				}
				case "click": {
					const { page } = await this.requirePage(command.page);
					const addressing = parseSelector(command.selector);
					const runClick = async () => {
						if (addressing.mode === "xy") {
							await page.mouse.click(addressing.x, addressing.y);
							return;
						}
						const locator = elementLocator(page, addressing, command.nth);
						await this.runLocatorAction("click", locator, () => locator.click({ timeout: this.defaultTimeoutMs }));
					};
					if (command.captureSubmitFeedback === true) {
						const { value: submitFeedback, openedPages } = await this.withPopupCapture(() => this.runClickWithSubmitFeedback(page, runClick, command.feedbackWaitMs ?? 2e3, signal));
						return {
							kind: "acked",
							submitFeedback,
							...openedPages.length > 0 ? {
								popupPageRef: openedPages[openedPages.length - 1].ref,
								openedPages
							} : {}
						};
					}
					const { openedPages } = await this.withPopupCapture(runClick);
					return {
						kind: "acked",
						...openedPages.length > 0 ? {
							popupPageRef: openedPages[openedPages.length - 1].ref,
							openedPages
						} : {}
					};
				}
				case "fill": {
					const { page } = await this.requirePage(command.page);
					const locator = elementLocator(page, parseSelector(command.selector), command.nth);
					await this.runLocatorAction("fill", locator, () => locator.fill(command.value, { timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "select": {
					const { page } = await this.requirePage(command.page);
					const locator = elementLocator(page, parseSelector(command.selector), command.nth);
					await this.runLocatorAction("select", locator, () => locator.selectOption(command.value, { timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "check": {
					const { page } = await this.requirePage(command.page);
					const locator = elementLocator(page, parseSelector(command.selector), command.nth);
					await this.runLocatorAction("check", locator, () => locator.check({ timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "press": {
					const { page } = await this.requirePage(command.page);
					await page.keyboard.press(command.key);
					return { kind: "acked" };
				}
				case "upload": {
					const { page } = await this.requirePage(command.page);
					const locator = elementLocator(page, parseSelector(command.selector), command.nth);
					await this.runLocatorAction("upload", locator, () => locator.setInputFiles([...command.files], { timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "screenshot": {
					const { page } = await this.requirePage(command.page);
					return {
						kind: "screenshot",
						pngBase64: (await page.screenshot({
							type: "png",
							timeout: this.defaultTimeoutMs
						})).toString("base64")
					};
				}
				case "waitFor": {
					if (command.selector === void 0 && command.url === void 0) throw new BrowserError("waitFor requires a selector or a url", "BROWSER_ACTION_FAILED");
					const { page } = await this.requirePage(command.page);
					const timeout = command.timeoutMs ?? this.defaultTimeoutMs;
					if (command.selector !== void 0) {
						const locator = elementLocator(page, parseSelector(command.selector), command.nth);
						await this.runLocatorAction("waitFor", locator, () => locator.waitFor({
							state: "visible",
							timeout
						}));
					} else await page.waitForURL(command.url, { timeout });
					return { kind: "acked" };
				}
				case "probe": {
					const { page, ref } = await this.requirePage(command.page);
					const url = page.url();
					const title = await page.title().catch(() => "");
					const selectorVisible = command.selector === void 0 ? void 0 : await elementLocator(page, parseSelector(command.selector)).first().isVisible().catch(() => false);
					return {
						kind: "probe",
						page: ref,
						url,
						title,
						...selectorVisible === void 0 ? {} : { selectorVisible }
					};
				}
				case "comment_publish": {
					const { page, ref } = await this.resolveForNavigate(command.page);
					const { value: result, openedPages } = await this.withPopupCapture(() => executeCommentPublish(page, ref, command, {
						defaultTimeoutMs: this.defaultTimeoutMs,
						...signal === void 0 ? {} : { signal }
					}));
					return openedPages.length > 0 ? {
						...result,
						popupPageRef: openedPages[openedPages.length - 1].ref,
						openedPages
					} : result;
				}
				case "directory_autofill": {
					const { page, ref } = command.url !== void 0 ? await this.resolveForNavigate(command.page) : await this.requirePage(command.page);
					return await executeDirectoryAutofill(page, ref, command, {
						defaultTimeoutMs: this.defaultTimeoutMs,
						...signal === void 0 ? {} : { signal }
					});
				}
				case "listPages": {
					for (const ctxPage of this.context.pages()) {
						if (ctxPage === this.keeperPage || ctxPage.isClosed()) continue;
						if (!this.pageToRef.has(ctxPage)) this.adopt(ctxPage);
					}
					const infos = [];
					for (const [ref, p] of this.pages.entries()) {
						if (p.isClosed()) continue;
						const meta = this.pageMeta.get(ref);
						const url = p.url();
						const title = await p.title().catch(() => "");
						infos.push({
							ref,
							url,
							title,
							isPopup: meta?.isPopup ?? false,
							...ref === this.lastRef ? { active: true } : {}
						});
					}
					return {
						kind: "pages",
						pages: infos
					};
				}
				case "bringToFront": {
					const { page } = await this.requirePage(command.page);
					await bringPageWindowToFront(page);
					return { kind: "acked" };
				}
				case "closePage": {
					const { page, ref } = await this.requirePage(command.page);
					if (this.context.pages().filter((p) => !p.isClosed()).filter((p) => p !== page).length === 0 && typeof this.context.newPage === "function") {
						const blank = await this.createInternalPage();
						this.keeperPage = blank;
						blank.on("close", () => {
							if (this.keeperPage === blank) this.keeperPage = void 0;
						});
					}
					await page.close();
					this.removePageMapping(ref, page);
					return { kind: "acked" };
				}
				default: return assertNever(command, "unhandled browser command kind");
			}
		} catch (error) {
			if (error instanceof BrowserError) throw error;
			throw new BrowserError(`playwright ${command.kind} failed: ${String(error instanceof Error ? error.message : error)}`, "BROWSER_ACTION_FAILED", { cause: error });
		}
	}
	async runLocatorAction(commandKind, locator, run) {
		try {
			return await run();
		} catch (error) {
			const enriched = await enrichStrictModeError(commandKind, locator, error);
			if (enriched !== void 0) throw enriched;
			throw error;
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.context.close();
		} catch {}
	}
	async withPopupCapture(run) {
		const captured = [];
		const collector = (entry) => {
			captured.push(entry);
		};
		this.popupCollectors.add(collector);
		try {
			const value = await run();
			await Promise.resolve();
			const openedPages = [];
			for (const entry of captured) {
				if (entry.page.isClosed()) continue;
				if (entry.page.url() === "about:blank" && typeof entry.page.waitForLoadState === "function") await entry.page.waitForLoadState("domcontentloaded", { timeout: 300 }).catch(() => void 0);
				const title = await entry.page.title().catch(() => "");
				openedPages.push({
					ref: entry.ref,
					url: entry.page.url(),
					title,
					isPopup: true
				});
			}
			return {
				value,
				openedPages
			};
		} finally {
			this.popupCollectors.delete(collector);
		}
	}
	async runClickWithSubmitFeedback(page, runClick, waitMs, signal) {
		const beforeNotices = new Set(typeof page.evaluate === "function" ? await page.evaluate(COLLECT_DOM_NOTICES_SCRIPT).catch(() => []) : []);
		const dialogs = [];
		const networkResponses = [];
		const pendingBodyReads = [];
		const onDialog = (dialog) => {
			dialogs.push({
				type: typeof dialog.type === "function" ? dialog.type() : "alert",
				message: (typeof dialog.message === "function" ? dialog.message() : "").slice(0, 300)
			});
			if (typeof dialog.accept === "function") dialog.accept().catch(() => void 0);
		};
		const onResponse = (response) => {
			if (networkResponses.length >= 6) return;
			const req = typeof response.request === "function" ? response.request() : void 0;
			const resourceType = typeof req?.resourceType === "function" ? req.resourceType() : "";
			const method = typeof req?.method === "function" ? req.method().toUpperCase() : "GET";
			const url = typeof response.url === "function" ? response.url() : "";
			if (STATIC_ASSET_URL_PATTERN.test(url)) return;
			if (!(resourceType === "xhr" || resourceType === "fetch" || method === "POST" || method === "PUT" || method === "PATCH")) return;
			const status = typeof response.status === "function" ? response.status() : 0;
			const headers = typeof response.headers === "function" ? response.headers() : {};
			const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
			const readTask = (async () => {
				let bodySnippet;
				if (typeof response.text === "function" && (contentType.length === 0 || /(?:json|text|xml|html|javascript)/iu.test(contentType))) {
					const cleaned = (await response.text().catch(() => "")).replace(/\s+/gu, " ").trim();
					if (cleaned.length > 0) bodySnippet = cleaned.slice(0, 240);
				}
				networkResponses.push({
					url: url.slice(0, 180),
					status,
					...contentType ? { contentType: contentType.slice(0, 60) } : {},
					...bodySnippet === void 0 ? {} : { bodySnippet }
				});
			})();
			pendingBodyReads.push(readTask);
		};
		const attachable = page;
		attachable.on?.("dialog", onDialog);
		attachable.on?.("response", onResponse);
		try {
			await runClick().catch((error) => {
				if (isNavigationContextError(error)) return;
				throw error;
			});
			const clampedWait = Math.max(0, Math.min(waitMs, 5e3));
			if (clampedWait > 0) await new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new BrowserError("browser click aborted", "BROWSER_ABORTED"));
					return;
				}
				const onAbort = () => {
					clearTimeout(timer);
					reject(new BrowserError("browser click aborted", "BROWSER_ABORTED"));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, clampedWait);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: 1e3 }).catch(() => void 0);
			await Promise.allSettled(pendingBodyReads);
		} finally {
			const detach = attachable.off ?? attachable.removeListener;
			detach?.call(attachable, "dialog", onDialog);
			detach?.call(attachable, "response", onResponse);
		}
		const afterNotices = typeof page.evaluate === "function" ? await page.evaluate(COLLECT_DOM_NOTICES_SCRIPT).catch(() => []) : [];
		const newNotices = afterNotices.filter((n) => !beforeNotices.has(n));
		const domNotices = newNotices.length > 0 ? newNotices : afterNotices.slice(0, 3);
		const finalUrl = page.url();
		const title = await page.title().catch(() => "");
		return {
			...dialogs.length > 0 ? { dialogs } : {},
			...networkResponses.length > 0 ? { networkResponses } : {},
			...domNotices.length > 0 ? { domNotices } : {},
			finalUrl,
			...title ? { title } : {}
		};
	}
	async createInternalPage() {
		this.creatingInternalPage++;
		try {
			return await this.context.newPage();
		} finally {
			this.creatingInternalPage--;
		}
	}
	registerPage(ref, page, isPopup) {
		this.pages.set(ref, page);
		this.pageToRef.set(page, ref);
		this.pageMeta.set(ref, { isPopup });
		if (!isPopup) this.lastRef = ref;
		page.on("close", () => {
			this.removePageMapping(ref, page);
		});
	}
	removePageMapping(ref, page) {
		if (this.pages.get(ref) !== page) return;
		this.pages.delete(ref);
		this.pageMeta.delete(ref);
		this.chains.delete(ref);
		if (this.lastRef === ref) this.lastRef = this.findFallbackBusinessRef();
	}
	findFallbackBusinessRef() {
		let fallbackPopup;
		for (const [candidateRef, candidatePage] of this.pages.entries()) {
			if (candidatePage.isClosed()) continue;
			if (this.pageMeta.get(candidateRef)?.isPopup) fallbackPopup = candidateRef;
			else return candidateRef;
		}
		return fallbackPopup;
	}
	adopt(page) {
		const existingRef = this.pageToRef.get(page);
		if (existingRef !== void 0 && this.pages.get(existingRef) === page) {
			this.lastRef = existingRef;
			return existingRef;
		}
		const ref = `p${++this.refSeq}`;
		this.registerPage(ref, page, false);
		return ref;
	}
	async requirePage(ref) {
		if (ref === void 0) {
			if (this.lastRef !== void 0) {
				const active = this.pages.get(this.lastRef);
				if (active !== void 0 && !active.isClosed()) return {
					page: active,
					ref: this.lastRef
				};
			}
			const fallbackRef = this.findFallbackBusinessRef();
			if (fallbackRef !== void 0) {
				const fallbackPage = this.pages.get(fallbackRef);
				this.lastRef = fallbackRef;
				return {
					page: fallbackPage,
					ref: fallbackRef
				};
			}
			if (this.keeperPage !== void 0 && !this.keeperPage.isClosed()) {
				const promoted = this.keeperPage;
				this.keeperPage = void 0;
				return {
					page: promoted,
					ref: this.adopt(promoted)
				};
			}
			const pages = this.context.pages().filter((p) => !p.isClosed() && p !== this.keeperPage);
			const last = pages[pages.length - 1];
			if (last) return {
				page: last,
				ref: this.adopt(last)
			};
			const page = await this.createInternalPage();
			return {
				page,
				ref: this.adopt(page)
			};
		}
		const page = this.pages.get(ref);
		if (page === void 0 || page.isClosed()) throw new BrowserError(`browser page "${ref}" is not open`, "BROWSER_ACTION_FAILED");
		if (!this.pageMeta.get(ref)?.isPopup) this.lastRef = ref;
		return {
			page,
			ref
		};
	}
	async resolveForNavigate(ref) {
		if (ref !== void 0) {
			const existing = this.pages.get(ref);
			if (existing !== void 0 && !existing.isClosed()) {
				if (!this.pageMeta.get(ref)?.isPopup) this.lastRef = ref;
				return {
					page: existing,
					ref
				};
			}
			if (this.keeperPage !== void 0 && !this.keeperPage.isClosed()) {
				const page = this.keeperPage;
				this.keeperPage = void 0;
				this.registerPage(ref, page, false);
				return {
					page,
					ref
				};
			}
			const page = await this.createInternalPage();
			this.registerPage(ref, page, false);
			return {
				page,
				ref
			};
		}
		return await this.requirePage(void 0);
	}
	async pageResult(page, ref, maxChars, selector) {
		const [url, title, rawText] = await Promise.all([
			Promise.resolve(page.url()),
			page.title(),
			page.innerText(selector ?? "body")
		]);
		const { text, truncated } = truncate(rawText, maxChars);
		return {
			kind: "page",
			page: ref,
			url,
			title,
			text,
			truncated
		};
	}
};
var PlaywrightBrowserProvider = class {
	config;
	id = PLAYWRIGHT_BROWSER_PROVIDER_ID;
	constructor(config) {
		this.config = config;
	}
	available() {
		return true;
	}
	async open(signal) {
		throwIfAborted(signal, "launch");
		assertPositiveInteger("defaultTimeoutMs", this.config.defaultTimeoutMs);
		let context;
		try {
			context = await chromium.launchPersistentContext(this.config.userDataDir, {
				headless: this.config.headless,
				timeout: this.config.defaultTimeoutMs,
				...this.config.channel.length > 0 ? { channel: this.config.channel } : {},
				...this.config.executablePath !== void 0 && this.config.executablePath.length > 0 ? { executablePath: this.config.executablePath } : {},
				...this.config.ignoreDefaultArgs.length > 0 ? { ignoreDefaultArgs: [...this.config.ignoreDefaultArgs] } : {},
				args: [...this.config.windowPosition === void 0 ? [] : [`--window-position=${this.config.windowPosition}`], ...this.config.launchArgs]
			});
		} catch (error) {
			throw new BrowserError(`failed to launch the persistent browser profile at ${this.config.userDataDir}: ${String(error instanceof Error ? error.message : error)}`, "BROWSER_LAUNCH_FAILED", { cause: error });
		}
		return new PlaywrightSession(context, this.config.defaultTimeoutMs, DEFAULT_SNAPSHOT_MAX_CHARS);
	}
};
// lib/types/host/browser-playwright/index.js
/**
* Service Provider for the Playwright persistent-Chromium browser seam.
*/
const name = "browser-playwright";
const inject = ["browser"];
const Config = z.object({
	userDataDir: z.string(),
	headless: z.boolean().default(false),
	channel: z.string().default("chrome"),
	defaultTimeoutMs: z.number().default(1e4),
	launchArgs: z.array(z.string()).default([]),
	ignoreDefaultArgs: z.array(z.string()).default([]),
	windowPosition: z.string()
});
function apply(ctx, config) {
	const userDataDir = (config.userDataDir ?? process.env.DSH_BACKLINK_BROWSER_PROFILE ?? dshHomePath("backlink-browser-profile")).trim();
	if (userDataDir.length === 0) throw new Error("browser-playwright: userDataDir must not be empty");
	const defaultTimeoutMs = config.defaultTimeoutMs ?? 1e4;
	if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new Error(`browser-playwright: defaultTimeoutMs must be a positive integer, got ${defaultTimeoutMs}`);
	const resolved = {
		userDataDir,
		headless: config.headless ?? false,
		channel: config.channel ?? "chrome",
		defaultTimeoutMs,
		launchArgs: config.launchArgs ?? [],
		ignoreDefaultArgs: config.ignoreDefaultArgs ?? [],
		windowPosition: config.windowPosition
	};
	ctx.effect(() => ctx.browser.registerProvider(new PlaywrightBrowserProvider(resolved)), "browser-playwright: provider");
}
export { Config, PLAYWRIGHT_BROWSER_PROVIDER_ID, PlaywrightBrowserProvider, apply, inject, name };
