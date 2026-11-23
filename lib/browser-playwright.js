import { t as assertNever } from "./backlinks-types-C6425y97.js";
import { t as BrowserError } from "./types-DhIxLWiv.js";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { chromium } from "playwright-core";
const LAZY_POLL_INTERVAL_MS = 350;
/** Strip unapproved/moderation query parameters before public reload verification. */
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
/** Build WordPress comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
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
* Self-contained browser evaluation script inspecting WordPress, Wix,
* comments-closed banners, CAPTCHAs, and minimal fallback form metadata.
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
})()`;
/**
* Self-contained browser evaluation function checking post-submit / post-reload
* live clickable links, escaped HTML `<a>` text, moderation notices, and WP errors.
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
	const wpErrorMatch = /duplicate\s+comment\s+detected|comment\s+submission\s+failure|sorry,\s+you\s+must\s+be\s+logged\s+in/iu.exec(errText || bodyText);
	const wpErrorMessage = errText || (wpErrorMatch ? wpErrorMatch[0] : void 0);
	const modEl = dom.document.querySelector(".comment-awaiting-moderation");
	const modText = clean(modEl ? modEl.innerText || modEl.textContent : "");
	const modMatch = /your\s+comment\s+is\s+awaiting\s+moderation|awaiting\s+moderation|pending\s+approval|held\s+for\s+moderation|submitted\s+for\s+review|等待审核|待审核|审核通过后显示/iu.exec(modText || bodyText);
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
	let matchedHref;
	let matchedAnchor;
	for (const link of candidateLinks) {
		const hrefAttr = clean(link.getAttribute("href"));
		if (!hrefAttr || hrefAttr.startsWith("#") || hrefAttr.startsWith("javascript:")) continue;
		const normHref = normalizeUrl(hrefAttr);
		const linkText = clean(link.innerText || link.textContent);
		const hrefMatches = normalizedTarget.length > 0 && (normHref === normalizedTarget || normHref.startsWith(`${normalizedTarget}/`) || targetHost.length > 0 && normHref.split("/")[0] === targetHost);
		const anchorMatches = cleanAnchor.length > 0 && linkText.toLowerCase().includes(cleanAnchor);
		if (hrefMatches || normalizedTarget.length === 0 && anchorMatches) {
			matchedHref = hrefAttr;
			matchedAnchor = linkText;
			break;
		}
	}
	return {
		liveLinkFound: matchedHref !== void 0,
		...matchedHref === void 0 ? {} : { matchedHref },
		...matchedAnchor === void 0 ? {} : { matchedAnchor },
		escapedHtmlDetected,
		...moderationNotice === void 0 ? {} : { moderationNotice },
		...wpErrorMessage === void 0 ? {} : { wpErrorMessage }
	};
}
function defaultSleep(ms, signal) {
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
function throwIfAborted$1(signal) {
	if (signal?.aborted) throw new BrowserError("browser comment_publish aborted", "BROWSER_ABORTED");
}
async function scrollToCommentsArea(page) {
	await page.evaluate(() => {
		const dom = globalThis;
		const anchor = dom.document.querySelector("#comments, #respond, form#commentform, [data-hook*=\"comment\"], [id*=\"comment\"]");
		if (anchor && typeof anchor.scrollIntoView === "function") {
			anchor.scrollIntoView({
				behavior: "instant",
				block: "center"
			});
			return;
		}
		if (typeof dom.window.scrollTo === "function" && dom.document.body) dom.window.scrollTo(0, dom.document.body.scrollHeight ?? 0);
	}).catch(() => void 0);
}
function hasDetectedCommentSurface(inspection) {
	return inspection.wordpress.found || inspection.commentsClosed.matched || inspection.wix.hasCommentSection || inspection.wix.hasGuestEditor || inspection.wix.loginRequired || inspection.wix.captchaDetected;
}
async function inspectCommentPage(page) {
	return await page.evaluate(INSPECT_COMMENT_PAGE_SCRIPT);
}
async function verifyResult(page, command) {
	return await page.evaluate(verifyCommentResultInDom, {
		...command.websiteUrl === void 0 ? {} : { websiteUrl: command.websiteUrl },
		...command.anchorText === void 0 ? {} : { anchorText: command.anchorText },
		commentText: command.commentText,
		...command.authorName === void 0 ? {} : { authorName: command.authorName }
	});
}
function inferSiteType(inspection) {
	if (inspection.wordpress.found || inspection.isWordPress) return "wordpress";
	if (inspection.isWix) return "wix";
	return "other";
}
async function executeCommentPublish(page, ref, command, options) {
	const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs;
	const verifyReload = command.verifyReload !== false;
	const probeOnly = command.probeOnly === true;
	const lazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? 2500, timeoutMs);
	const sleep = options.sleepImpl ?? defaultSleep;
	throwIfAborted$1(options.signal);
	await page.goto(command.url, {
		timeout: timeoutMs,
		waitUntil: "domcontentloaded"
	});
	throwIfAborted$1(options.signal);
	let inspection = await inspectCommentPage(page);
	if (!hasDetectedCommentSurface(inspection)) {
		await scrollToCommentsArea(page);
		const deadline = Date.now() + lazyWaitMaxMs;
		while (Date.now() < deadline) {
			throwIfAborted$1(options.signal);
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
			inspection = await inspectCommentPage(page);
			if (hasDetectedCommentSurface(inspection)) break;
		}
	}
	if (inspection.wordpress.found) {
		const wp = inspection.wordpress;
		if (wp.captcha?.detected) return {
			kind: "comment_publish",
			page: ref,
			outcome: "blocked_captcha",
			siteType: "wordpress",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			...wp.captcha.templateSignature === void 0 ? {} : { templateSignature: wp.captcha.templateSignature },
			evidence: `WordPress 评论区存在 ${wp.captcha.kind ?? "captcha"} 人机验证，未尝试绕过`,
			suggestedTags: ["has_captcha"],
			submitTriggered: false
		};
		if (probeOnly) return {
			kind: "comment_publish",
			page: ref,
			outcome: "form_ready",
			siteType: "wordpress",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			probeOnly: true,
			submitTriggered: false,
			formSummary: inspection.formSummary
		};
		if (wp.authorRequired && !command.authorName?.trim() || wp.emailRequired && !command.authorEmail?.trim()) return {
			kind: "comment_publish",
			page: ref,
			outcome: "needs_llm_fallback",
			siteType: "wordpress",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			evidence: "WordPress 评论表单缺少必填的 authorName 或 authorEmail 参数，转交常规流程处理",
			submitTriggered: false,
			formSummary: inspection.formSummary
		};
		const hasUrlField = wp.urlSelector !== void 0;
		const wpBody = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasUrlField);
		await page.locator(wp.commentSelector).first().fill(wpBody, { timeout: timeoutMs });
		if (wp.authorSelector !== void 0 && command.authorName?.trim()) await page.locator(wp.authorSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
		if (wp.emailSelector !== void 0 && command.authorEmail?.trim()) await page.locator(wp.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
		if (wp.urlSelector !== void 0 && command.websiteUrl?.trim()) await page.locator(wp.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
		if (wp.submitSelector === void 0) return {
			kind: "comment_publish",
			page: ref,
			outcome: "needs_llm_fallback",
			siteType: "wordpress",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			evidence: "WordPress 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）",
			submitTriggered: false,
			formSummary: inspection.formSummary
		};
		const submitLocator = page.locator(wp.submitSelector).first();
		await Promise.allSettled([typeof page.waitForLoadState === "function" ? page.waitForLoadState("domcontentloaded", { timeout: Math.min(1e4, timeoutMs) }) : Promise.resolve(), submitLocator.click({ timeout: timeoutMs })]);
		const postSubmitUrl = page.url();
		const postVerify = await verifyResult(page, command);
		if (postVerify.wpErrorMessage) {
			const mentionsCaptcha = /captcha|spam|security/iu.test(postVerify.wpErrorMessage);
			return {
				kind: "comment_publish",
				page: ref,
				outcome: "uncertain_after_submit",
				siteType: "wordpress",
				title: await page.title().catch(() => inspection.title),
				finalUrl: postSubmitUrl,
				evidence: `提交后页面返回错误提示: ${postVerify.wpErrorMessage.slice(0, 160)}`,
				...mentionsCaptcha ? { suggestedTags: ["has_captcha"] } : {},
				submitTriggered: true
			};
		}
		const sawModeration = Boolean(postVerify.moderationNotice || /[?&](?:unapproved|moderation-hash)=/iu.test(postSubmitUrl));
		const cleanPublicUrl = /wp-comments-post\.php/iu.test(postSubmitUrl) ? command.url : stripWpModerationParams(postSubmitUrl);
		let finalVerify = postVerify;
		let finalUrl = cleanPublicUrl;
		if (verifyReload) {
			await page.goto(cleanPublicUrl, {
				timeout: timeoutMs,
				waitUntil: "domcontentloaded"
			});
			await scrollToCommentsArea(page);
			finalUrl = page.url();
			finalVerify = await verifyResult(page, command);
		}
		const finalTitle = await page.title().catch(() => inspection.title);
		if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType: "wordpress",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: "提交后检测到正文 HTML 被转义，链接未生效（遵守幂等铁律严禁重发）",
			submitTriggered: true
		};
		if (finalVerify.liveLinkFound) return {
			kind: "comment_publish",
			page: ref,
			outcome: "live",
			siteType: "wordpress",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: `WordPress 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
			submitTriggered: true
		};
		if (sawModeration || finalVerify.moderationNotice) return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType: "wordpress",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: `WordPress 评论已提交等待审核 (${finalVerify.moderationNotice ?? postVerify.moderationNotice ?? "unapproved"})`,
			submitTriggered: true
		};
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType: "wordpress",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: "已点击 WordPress 提交但重载公开页未确认目标链接或待审核提示（严禁自动重试）",
			submitTriggered: true
		};
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
		if (inspection.wix.loginRequired || inspection.wix.captchaDetected) return {
			kind: "comment_publish",
			page: ref,
			outcome: "blocked_captcha",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			templateSignature: "wix:signup_recaptcha",
			evidence: "Wix 博客评论区要求会员登录或存在 reCAPTCHA 人机验证，未尝试绕过",
			suggestedTags: ["has_captcha"],
			submitTriggered: false
		};
		if (!inspection.wix.hasCommentSection) return {
			kind: "comment_publish",
			page: ref,
			outcome: "no_form",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			skipReason: "Wix 博客评论区滚动探测后仍不存在",
			suggestedTags: ["no_form"],
			submitTriggered: false
		};
		if (!inspection.wix.hasGuestEditor && inspection.wix.triggerSelector) {
			await page.locator(inspection.wix.triggerSelector).first().click({ timeout: timeoutMs });
			await sleep(400, options.signal);
			inspection = await inspectCommentPage(page);
			if (inspection.wix.loginRequired || inspection.wix.captchaDetected) return {
				kind: "comment_publish",
				page: ref,
				outcome: "blocked_captcha",
				siteType: "wix",
				title: inspection.title,
				finalUrl: inspection.finalUrl,
				templateSignature: "wix:signup_recaptcha",
				evidence: "展开 Wix 评论区后触发会员登录/reCAPTCHA 验证，未尝试绕过",
				suggestedTags: ["has_captcha"],
				submitTriggered: false
			};
		}
		if (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector) return {
			kind: "comment_publish",
			page: ref,
			outcome: "no_form",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			skipReason: "Wix 博客未发现免登录访客评论框",
			suggestedTags: ["no_form"],
			submitTriggered: false
		};
		if (probeOnly) return {
			kind: "comment_publish",
			page: ref,
			outcome: "form_ready",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			probeOnly: true,
			submitTriggered: false,
			formSummary: inspection.formSummary
		};
		const wix = inspection.wix;
		const editorSelector = wix.editorSelector;
		const hasWebsiteField = wix.websiteSelector !== void 0;
		if (wix.editorIsContentEditable) {
			const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
			if (stripped.websiteUrl && !hasWebsiteField && !wix.linkButtonSelector) return {
				kind: "comment_publish",
				page: ref,
				outcome: "needs_llm_fallback",
				siteType: "wix",
				title: inspection.title,
				finalUrl: inspection.finalUrl,
				evidence: "Wix 富文本评论框未定位到链接工具按钮且无 Website 字段（避免把 <a> 原样转义，未触发提交）",
				submitTriggered: false,
				formSummary: inspection.formSummary
			};
			const editorLocator = page.locator(editorSelector).first();
			await editorLocator.click({ timeout: timeoutMs });
			await editorLocator.fill(stripped.plainText, { timeout: timeoutMs });
			if (stripped.websiteUrl && !hasWebsiteField && wix.linkButtonSelector) {
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
				})) return {
					kind: "comment_publish",
					page: ref,
					outcome: "needs_llm_fallback",
					siteType: "wix",
					title: inspection.title,
					finalUrl: inspection.finalUrl,
					evidence: "Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）",
					submitTriggered: false,
					formSummary: inspection.formSummary
				};
				await page.locator(wix.linkButtonSelector).first().click({ timeout: timeoutMs });
				const urlInputSelector = "input[type=\"url\"], input[placeholder*=\"http\" i], input[placeholder*=\"url\" i], input[placeholder*=\"link\" i], input[aria-label*=\"url\" i], input[aria-label*=\"link\" i]";
				if (await page.locator(urlInputSelector).count().catch(() => 0) <= 0) return {
					kind: "comment_publish",
					page: ref,
					outcome: "needs_llm_fallback",
					siteType: "wix",
					title: inspection.title,
					finalUrl: inspection.finalUrl,
					evidence: "点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）",
					submitTriggered: false,
					formSummary: inspection.formSummary
				};
				const urlInput = page.locator(urlInputSelector).first();
				await urlInput.fill(stripped.websiteUrl, { timeout: timeoutMs });
				const applyBtnSelector = "[data-hook*=\"save\" i], [data-hook*=\"apply\" i], button[aria-label*=\"save\" i], button[aria-label*=\"apply\" i]";
				if (await page.locator(applyBtnSelector).count().catch(() => 0) > 0) await page.locator(applyBtnSelector).first().click({ timeout: timeoutMs });
				else await urlInput.press("Enter", { timeout: timeoutMs });
			}
		} else {
			const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasWebsiteField);
			await page.locator(editorSelector).first().fill(body, { timeout: timeoutMs });
		}
		if (wix.nameSelector && command.authorName?.trim()) await page.locator(wix.nameSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
		if (wix.emailSelector && command.authorEmail?.trim()) await page.locator(wix.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
		if (wix.websiteSelector && command.websiteUrl?.trim()) await page.locator(wix.websiteSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
		if (!wix.submitSelector) return {
			kind: "comment_publish",
			page: ref,
			outcome: "needs_llm_fallback",
			siteType: "wix",
			title: inspection.title,
			finalUrl: inspection.finalUrl,
			evidence: "Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）",
			submitTriggered: false,
			formSummary: inspection.formSummary
		};
		await page.locator(wix.submitSelector).first().click({ timeout: timeoutMs });
		await sleep(Math.min(1200, timeoutMs), options.signal);
		const postVerify = await verifyResult(page, command);
		const sawModeration = Boolean(postVerify.moderationNotice);
		let finalVerify = postVerify;
		let finalUrl = page.url();
		if (verifyReload) {
			await page.goto(command.url, {
				timeout: timeoutMs,
				waitUntil: "domcontentloaded"
			});
			await scrollToCommentsArea(page);
			await sleep(Math.min(800, timeoutMs), options.signal);
			finalUrl = page.url();
			finalVerify = await verifyResult(page, command);
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
			evidence: `Wix 访客评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
			submitTriggered: true
		};
		if (sawModeration || finalVerify.moderationNotice) return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType: "wix",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			evidence: `Wix 访客评论已提交待审核 (${finalVerify.moderationNotice ?? postVerify.moderationNotice})`,
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
			evidence: "已触发 Wix Publish 但重载公开页未确认目标链接或待审核提示（严禁自动重试）",
			submitTriggered: true
		};
	}
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "needs_llm_fallback",
		siteType: "other",
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		submitTriggered: false,
		formSummary: inspection.formSummary
	};
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
		return {
			indent,
			rawTrimmed: trimmed,
			role: "meta",
			isPropertyLine: true,
			isBoilerplate: false,
			isDecorative: false,
			isInteractive: false,
			isPriority: false,
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
			isWrapperOnly: false,
			formatted: `${" ".repeat(indent)}- ${clean}`
		};
	}
	const roleMatch = /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(?:\s*\[[^\]]*\])*\s*:(?:\s*(.*))?$/u.exec(body) ?? /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(.*)$/u.exec(body);
	const role = (roleMatch?.[1] ?? "text").toLowerCase();
	const quotedName = roleMatch?.[2] ?? "";
	(roleMatch?.[3] ?? "").trim();
	const isPropertyLine = role === "text";
	const isBoilerplate = BOILERPLATE_ROLES.has(role);
	const isDecorative = DECORATIVE_ROLES.has(role) || role === "img" && quotedName.length === 0 && !AUTH_OR_ACTION_PATTERN.test(body);
	const isFormControl = FORM_CONTROL_ROLES.has(role);
	const isAuthOrAction = AUTH_OR_ACTION_PATTERN.test(body);
	const isInteractive = isFormControl || (role === "link" || role === "menuitem") && isAuthOrAction;
	const isPriority = isFormControl || isAuthOrAction || COMMENT_OR_FORM_HINT_PATTERN.test(body);
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
function budgetAriaLines(entries, maxChars) {
	const allText = entries.map((e) => e.formatted).join("\n");
	if (allText.length <= maxChars) return {
		text: allText,
		truncated: false
	};
	const selected = new Array(entries.length).fill(false);
	let usedChars = 0;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry.keepPriority) continue;
		const cost = entry.formatted.length + (usedChars > 0 ? 1 : 0);
		if (usedChars + cost <= maxChars) {
			selected[i] = true;
			usedChars += cost;
		}
	}
	for (let i = 0; i < entries.length; i++) {
		if (selected[i]) continue;
		const cost = entries[i].formatted.length + (usedChars > 0 ? 1 : 0);
		if (usedChars + cost <= maxChars) {
			selected[i] = true;
			usedChars += cost;
		}
	}
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
			if (parsed.isInteractive) {
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
		if (parsed.formatted === lastKeptFormatted && !parsed.isInteractive) {
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
	const { entries: finalEntries, collapsedCount } = collapseSiblingLinks(withoutEmpty);
	const totalPruned = prunedCount + collapsedCount + Math.max(0, kept.length - withoutEmpty.length);
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

  const formLines = forms.slice(0, 8).map((form, idx) => {
    const action = clean(form.getAttribute('action'));
    const idAttr = form.id ? '#' + form.id : '';
    const ctrls = Array.from(form.querySelectorAll('input:not([type="hidden"]),textarea,select,button'))
      .filter(c => !isHidden(c))
      .slice(0, 12)
      .map(c => {
        const tag = c.localName;
        const name = clean(c.getAttribute('name') || c.id || c.getAttribute('placeholder') || c.getAttribute('aria-label') || clean(c.textContent));
        const type = tag === 'input' ? ':' + (c.type || 'text') : '';
        return name ? tag + type + '(' + name.slice(0, 32) + ')' : tag + type;
      });
    return 'form[' + idx + ']' + idAttr + (action ? ' action=' + action.slice(0, 60) : '') + ': ' + (ctrls.join(', ') || '(no visible fields)');
  });

  const alerts = [];
  for (const el of document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="status"],.comment-awaiting-moderation,.wp-die-message,#error-page')) {
    if (isHidden(el)) continue;
    const text = clean(el.innerText || el.textContent).slice(0, 200);
    if (text && !alerts.includes(text)) alerts.push(text);
    if (alerts.length >= 5) break;
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
	const priority = cleaned.filter((line) => COMMENT_OR_FORM_HINT_PATTERN.test(line));
	const regular = cleaned.filter((line) => !COMMENT_OR_FORM_HINT_PATTERN.test(line));
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
	for (const line of priority) {
		const cost = line.length + (used > 0 ? 1 : 0);
		if (used + cost <= maxChars) {
			selected.add(line);
			used += cost;
		}
	}
	for (const line of regular) {
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
// lib/types/host/browser-playwright/interactive.js
const VISIBLE_CONTROLS_SCRIPT = String.raw`(() => {
  const probe = 'a[href],button,iframe,summary,input[type=submit],input[type=button],input[type=image],[role=button],[role=link]';
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
			...row.inBoilerplate === true ? { inBoilerplate: true } : {}
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
		const type = control.tag === "iframe" ? "iframe" : control.tag === "a" || control.role === "link" ? "link" : control.tag;
		const label = control.text || control.value || control.imageAlt || control.alt || control.ariaLabel || control.title;
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
	chains = /* @__PURE__ */ new Map();
	legacyTail = Promise.resolve();
	lastRef;
	refSeq = 0;
	constructor(context, defaultTimeoutMs, defaultMaxChars) {
		this.context = context;
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.defaultMaxChars = defaultMaxChars;
		this.context.on("close", () => {
			this.closed = true;
		});
		for (const existing of this.context.pages()) this.adopt(existing);
	}
	async act(command, signal) {
		throwIfAborted(signal, command.kind);
		if (this.closed) throw new BrowserError("browser session is closed", "BROWSER_ACTION_FAILED");
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
					await page.goto(command.url, {
						timeout: command.timeoutMs ?? this.defaultTimeoutMs,
						...command.waitUntil === void 0 ? {} : { waitUntil: command.waitUntil }
					});
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
					if (addressing.mode === "xy") {
						await page.mouse.click(addressing.x, addressing.y);
						return { kind: "acked" };
					}
					const locator = elementLocator(page, addressing, command.nth);
					await this.runLocatorAction("click", locator, () => locator.click({ timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
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
					return await executeCommentPublish(page, ref, command, {
						defaultTimeoutMs: this.defaultTimeoutMs,
						...signal === void 0 ? {} : { signal }
					});
				}
				case "bringToFront": {
					const { page } = await this.requirePage(command.page);
					await bringPageWindowToFront(page);
					return { kind: "acked" };
				}
				case "closePage": {
					const { page, ref } = await this.requirePage(command.page);
					await page.close();
					this.pages.delete(ref);
					this.chains.delete(ref);
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
	adopt(page) {
		const ref = `p${++this.refSeq}`;
		this.pages.set(ref, page);
		this.lastRef = ref;
		page.on("close", () => {
			this.pages.delete(ref);
		});
		return ref;
	}
	async requirePage(ref) {
		if (ref === void 0) {
			const pages = this.context.pages();
			const last = pages[pages.length - 1];
			if (last) {
				if (this.pages.get(this.lastRef ?? "") !== last) this.adopt(last);
				return {
					page: last,
					ref: this.lastRef
				};
			}
			const page = await this.context.newPage();
			return {
				page,
				ref: this.adopt(page)
			};
		}
		const page = this.pages.get(ref);
		if (page === void 0 || page.isClosed()) throw new BrowserError(`browser page "${ref}" is not open`, "BROWSER_ACTION_FAILED");
		this.lastRef = ref;
		return {
			page,
			ref
		};
	}
	async resolveForNavigate(ref) {
		if (ref !== void 0) {
			const existing = this.pages.get(ref);
			if (existing !== void 0 && !existing.isClosed()) {
				this.lastRef = ref;
				return {
					page: existing,
					ref
				};
			}
			const page = await this.context.newPage();
			this.pages.set(ref, page);
			this.lastRef = ref;
			page.on("close", () => {
				this.pages.delete(ref);
			});
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
