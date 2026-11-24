/**
 * Deterministic Playwright fast-path for WordPress, Wix, Typecho, custom blog,
 * and Blogger iframe comment publishing (`browser action="comment_publish"`).
 *
 * Strictly enforces:
 * - Zero CAPTCHA bypass: detects reCAPTCHA/hCaptcha/Turnstile/SecureImg/math
 *   captchas and returns `blocked_captcha` (`submitTriggered: false`).
 * - Idempotency: once a submit action is triggered (`submitTriggered: true`),
 *   any post-submit uncertainty returns `uncertain_after_submit` and never retries.
 * - Rich-editor safety: never types raw `<a>` markup into `contenteditable` editors;
 *   on Wix Ricos/Tiptap without a toolbar link button, enters URL + Space and
 *   verifies an `<a href>` was created before clicking Publish.
 * - Anti-optimistic-DOM guardrail: Wix post-submit checks `role=dialog` for 2-3s
 *   and reloads the clean URL before declaring `live`.
 */
import { BrowserError } from "../browser/types.js";
import { dismissBlockingOverlays } from "./overlay.js";
export const DEFAULT_LAZY_WAIT_MAX_MS = 2_500;
export const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 9_000;
export const DEFAULT_WIX_EXPAND_WAIT_MAX_MS = 4_000;
export const DEFAULT_WIX_POST_SUBMIT_WAIT_MS = 2_500;
const LAZY_POLL_INTERVAL_MS = 400;
const POST_SUBMIT_POLL_INTERVAL_MS = 500;
const FRAME_INSPECT_TIMEOUT_MS = 1_000;
const BOTTOM_SNAPSHOT_MAX_CHARS = 1_200;
/** Strip unapproved/moderation query parameters before public reload verification (preserving `#comment-ID`). */
export function stripWpModerationParams(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        parsed.searchParams.delete('unapproved');
        parsed.searchParams.delete('moderation-hash');
        return parsed.toString();
    }
    catch {
        return rawUrl;
    }
}
/** Build plain/HTML comment body: plain text when `url` field exists, HTML `<a>` otherwise. */
export function buildWpCommentContent(commentText, websiteUrl, anchorText, hasUrlField) {
    const cleanComment = commentText.trim();
    const cleanUrl = websiteUrl?.trim();
    if (hasUrlField || !cleanUrl) {
        return cleanComment;
    }
    if (/<a\b[^>]*href\s*=/iu.test(cleanComment)) {
        return cleanComment;
    }
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
export function stripHtmlLinkForRichEditor(commentText, anchorText, websiteUrl) {
    const linkMatch = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(commentText);
    const extractedHref = linkMatch?.[1]?.trim();
    const extractedAnchor = linkMatch?.[2]?.replace(/<[^>]+>/gu, '').trim();
    const plainText = commentText
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/giu, '$1')
        .replace(/\s+/gu, ' ')
        .trim();
    const finalAnchor = anchorText?.trim() || extractedAnchor || undefined;
    const finalUrl = websiteUrl?.trim() || extractedHref || undefined;
    return {
        plainText,
        ...(finalAnchor === undefined ? {} : { anchorText: finalAnchor }),
        ...(finalUrl === undefined ? {} : { websiteUrl: finalUrl }),
    };
}
/**
 * Self-contained browser evaluation script inspecting WordPress (including
 * collapsed comment triggers), Typecho, custom blog forms, Wix (with member-wall
 * fast detection & multilingual triggers), Blogger iframes, comments-closed
 * banners, CAPTCHAs, and minimal fallback form metadata.
 */
export const INSPECT_COMMENT_PAGE_SCRIPT = String.raw `(() => {
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
  const isTypecho = !!(
    document.querySelector('meta[name="generator"][content*="Typecho" i]')
    || (document.querySelector('input[name="mail"]') && document.querySelector('textarea[name="text"]'))
  );
  const hasBloggerCommentIframe = !!document.querySelector('iframe[src*="blogger.com/comment" i]');

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

  // WordPress comment form detection (including hidden #comment collapsed trigger detection).
  const allWpTextareas = Array.from(document.querySelectorAll('textarea[name="comment"], textarea#comment'));
  const wpCommentTextarea = allWpTextareas.find(isVisible) || null;
  const wpAnyTextarea = wpCommentTextarea || allWpTextareas[0] || null;
  const wpFormCandidate = document.querySelector('form#commentform, form[action*="wp-comments-post.php"]')
    || (wpAnyTextarea ? wpAnyTextarea.closest('form') : null);

  let wordpress = { found: false };
  if (wpFormCandidate && isVisible(wpFormCandidate)) {
    const commentEl = wpFormCandidate.querySelector('textarea[name="comment"], textarea#comment, textarea:not([name*="ak_"])');
    const authorEl = wpFormCandidate.querySelector('input[name="author"], input#author');
    const emailEl = wpFormCandidate.querySelector('input[name="email"], input#email, input[type="email"]');
    const urlEl = wpFormCandidate.querySelector('input[name="url"], input#url, input[type="url"], input[name*="website" i]');
    const submitEl = wpFormCandidate.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])');
    const captcha = detectFormCaptcha(wpFormCandidate, 'wordpress');

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

  const bodyTextClean = extractVisibleText(document.body);
  const hasCommentsLoadingText = /\bcomments\s+loading\b|\bloading\s+comments\b/i.test(bodyTextClean);
  const hasLazyPlaceholder = isWix && (
    !!document.querySelector('[data-hook="comments-section-placeholder"]')
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
  const hasCommentHintText = /\b(?:write a comment|comments?|leave a comment|add a comment|escreva|escribe|escribir|kirjoita|kommentar|écrire|coment[aá]rios?|commentaires?|kommentare?|评论|留言)\b/i.test(tailWindowText);
  const isComplexWixLayout = isWix && (
    !!document.querySelector('[id*="SITE_CONTAINER"], [data-hook="recent-posts"]')
    || /wix-warmup-data|communities-blog-ooi/i.test(docHtmlPrefix)
    || scrollHeight > 1800
    || readyState !== 'complete'
    || hasCommentHintText
  );

  const wixHasCommentSection = isWix && wixCommentRoots.length > 0;
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
    .find(el => isVisible(el) && wixLoginRegex.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));

  const wixCommentScopedLogin = loginButtons.length > 0 && !hasVisibleWixGuestInputs;
  const wixLoginRequired = isWix && (
    wixCommentScopedLogin
    || (wixLoginRegex.test(wixContainerText) && !hasVisibleWixGuestInputs)
    || (!!wixGlobalLoginButton && !hasVisibleWixGuestInputs)
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
    hasCommentCountOnly: isWix && hasCommentCountOnly,
    hasBlogPostStructure,
    isBlogListPage,
    isComplexWixLayout,
    ...(commentHooks.length > 0 ? { commentHooks } : {}),
    ...(wixLoginInfo ? { loginInfo: wixLoginInfo } : {}),
  };

  if (isWix && !wixLoginRequired) {
    const editorEl = Array.from(document.querySelectorAll(
      '[data-hook*="comment-box"] [contenteditable="true"], [data-hook="ricos-tiptap-editor"] [contenteditable="true"], [data-hook="fullRicosEditor"] [contenteditable="true"], [data-hook="create-comment-input"], [data-hook*="comment"] [contenteditable="true"], [data-hook*="comment"] [role="textbox"], [data-hook*="comment"] textarea, [data-hook*="comment"] .tiptap.ProseMirror, [data-hook*="comment"] .public-DraftEditor-content, [placeholder*="Write a comment" i], [aria-label*="Write a comment" i]'
    )).find(el => isVisible(el) && (el.getAttribute('contenteditable') === 'true' || el.localName === 'textarea' || el.getAttribute('role') === 'textbox'));

    const triggerTextRegex = /write\s+a\s+comment|leave\s+a\s+comment|add\s+a\s+comment|post\s+a\s+comment|escribir|escribe\s+un\s+coment|escreva|kirjoita|kommentar|écrire|ecrire|写评论|发表评论|留下评论/i;
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
          return /^\s*(?:write|leave|add|post)\s+a\s+comment\b|^\s*(?:escribir|escribe|escreva|kirjoita|kommentar|écrire|ecrire|写评论)/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
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
        return /^(?:publish|post|submit|comment|reply|publicar|enviar|publier|veröffentlichen|julkaise|发布|提交|评论)$/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
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
/** Post-Publish Wix inspection checking visible `role=dialog` for reCAPTCHA, login/signup, or moderation. */
export const INSPECT_WIX_POST_SUBMIT_SCRIPT = String.raw `(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
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

  const moderationRegex = /awaiting\s+moderation|pending\s+approval|pending\s+review|held\s+for\s+moderation|submitted\s+for\s+review|under\s+review|moderation|waiting\s+for\s+approval|aguardando\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)|pendiente\s+de\s+(?:moderaci[oó]n|aprobaci[oó]n)|en\s+attente\s+de\s+(?:mod[ée]ration|validation)|wartet\s+auf\s+(?:freischaltung|moderation)|等待审核|待审核|审核通过后显示/i;
  const loginRegex = /\b(?:sign\s*up|log\s*in|sign\s*in|continue\s+with\s+google|sign\s+up\s+with\s+google|sign\s+in\s+with\s+google|already\s+a\s+member|faça\s+login|iniciar\s+sesi[oó]n|se\s+connecter|anmelden|kirjaudu)\b|登录|注册/i;

  let hasCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile'
  );
  let hasLoginDialog = false;
  let moderationNotice = '';
  let dialogText = '';
  const loginButtons = [];
  const ssoProviders = [];
  let hasEmailForm = false;

  for (const dialog of dialogs) {
    const text = extractText(dialog);
    if (!dialogText && text) dialogText = text.slice(0, 240);
    if (
      dialog.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile')
      || /\b(?:recaptcha|hcaptcha|turnstile|i'm\s+not\s+a\s+robot)\b/i.test(text)
    ) {
      hasCaptcha = true;
    }
    if (
      dialog.querySelector('[data-testid*="signUp" i], [data-testid*="login" i], input[type="password"]')
      || loginRegex.test(text)
    ) {
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
    const modMatch = moderationRegex.exec(text);
    if (modMatch && !moderationNotice) {
      moderationNotice = modMatch[0];
    }
  }

  return {
    hasCaptcha,
    hasLoginDialog,
    ...(moderationNotice ? { moderationNotice } : {}),
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
export const INSPECT_CHILD_FRAME_SCRIPT = String.raw `(() => {
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
/** Script evaluated inside `iframe[src*="blogger.com/comment"]`. */
export const INSPECT_BLOGGER_FRAME_SCRIPT = String.raw `(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    return true;
  };
  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const hasCaptcha = !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha" i], .h-captcha, .cf-turnstile')
    || /\brecaptcha\b/i.test(bodyText);
  const closedMatch = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+(?:closed|disabled)\b|评论已关闭/i.exec(bodyText);
  const modMatch = /awaiting\s+moderation|visible\s+after\s+approval|pending\s+approval|comment\s+will\s+be\s+published\s+after|等待审核|待审核/i.exec(bodyText);
  const errMatch = /your\s+comment\s+could\s+not\s+be\s+saved|error|invalid/i.exec(bodyText);

  const commentEl = Array.from(document.querySelectorAll('textarea#commentBody, textarea[name="commentBody"], textarea'))
    .find(isVisible);
  const identitySelect = document.querySelector('select#identityMenu, select[name="identityMenu"]');
  const supportsNameUrlIdentity = !!(identitySelect && Array.from(identitySelect.options || []).some(o => /nameurl/i.test(o.value)));
  const anonNameEl = Array.from(document.querySelectorAll('input#anonName, input[name="anonName"]')).find(isVisible);
  const anonUrlEl = Array.from(document.querySelectorAll('input#anonURL, input[name="anonURL"]')).find(isVisible);
  const submitEl = Array.from(document.querySelectorAll('input#postCommentSubmit, button#postCommentSubmit, input[name="postCommentSubmit"], button[name="postCommentSubmit"], button[type="submit"], input[type="submit"], button'))
    .find(el => isVisible(el) && /^(?:publish|post|submit|send|发布|发表)$/i.test(clean(el.innerText || el.textContent || el.getAttribute('value'))));

  const signInBtn = Array.from(document.querySelectorAll('a, button, [role="button"]')).find(el =>
    isVisible(el) && /\b(?:sign\s*in(?:\s+with\s+google)?|log\s*in)\b/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')))
  );
  const loginRequired = !commentEl && (!!signInBtn || /\bsign\s*in\s+with\s+google\b|\bto\s+leave\s+a\s+comment.*sign\s*in\b/i.test(bodyText));

  const sel = (el, fallback) => {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    const name = el.getAttribute('name');
    if (name) return el.localName + '[name="' + name + '"]';
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
    ...(commentEl ? { commentSelector: sel(commentEl, 'textarea') } : {}),
    ...(identitySelect ? { identitySelectSelector: sel(identitySelect, 'select#identityMenu'), supportsNameUrlIdentity } : {}),
    ...(anonNameEl ? { anonNameSelector: sel(anonNameEl, 'input[name="anonName"]') } : {}),
    ...(anonUrlEl ? { anonUrlSelector: sel(anonUrlEl, 'input[name="anonURL"]') } : {}),
    ...(submitEl ? { submitSelector: sel(submitEl, 'input[type="submit"], button[type="submit"]') } : {}),
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
export function verifyCommentResultInDom(params) {
    const dom = globalThis;
    const clean = (v) => String(v ?? '').replace(/\s+/gu, ' ').trim();
    const normalizeUrl = (raw) => {
        try {
            const parsed = new URL(raw, dom.location.href);
            const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
            const path = parsed.pathname.replace(/\/+$/u, '');
            return `${host}${path}`;
        }
        catch {
            return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/u, '').replace(/\/+$/u, '');
        }
    };
    let targetHost = '';
    const normalizedTarget = params.websiteUrl ? normalizeUrl(params.websiteUrl) : '';
    if (params.websiteUrl) {
        try {
            targetHost = new URL(params.websiteUrl).hostname.toLowerCase().replace(/^www\./u, '');
        }
        catch {
            targetHost = '';
        }
    }
    const cleanAnchor = clean(params.anchorText).toLowerCase();
    const errEl = dom.document.querySelector('.wp-die-message, #error-page');
    const errText = clean(errEl ? (errEl.innerText || errEl.textContent) : '');
    const bodyText = clean(dom.document.body ? (dom.document.body.innerText || dom.document.body.textContent) : '');
    const wpErrorMatch = /duplicate\s+comment\s+detected|comment\s+submission\s+failure|sorry,\s+you\s+must\s+be\s+logged\s+in|you\s+are\s+posting\s+comments\s+too\s+quickly/iu.exec(errText || bodyText);
    const wpErrorMessage = errText || (wpErrorMatch ? wpErrorMatch[0] : undefined);
    const captchaDetected = Boolean(dom.document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i]'));
    const modEl = dom.document.querySelector('.comment-awaiting-moderation, .moderation-notice, [class*="awaiting-moderation" i]');
    const modText = clean(modEl ? (modEl.innerText || modEl.textContent) : '');
    const modPattern = new RegExp([
        'your\\s+comment\\s+is\\s+awaiting\\s+moderation',
        'awaiting\\s+moderation',
        'pending\\s+approval',
        'pending\\s+moderation',
        'pending\\s+review',
        'held\\s+for\\s+moderation',
        'submitted\\s+for\\s+review',
        'waiting\\s+for\\s+(?:moderation|approval)',
        'comment\\s+is\\s+under\\s+review',
        'esperando\\s+moderaci[oó]n',
        'pendiente\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)',
        'esperando\\s+ser\\s+moderado',
        'en\\s+attente\\s+de\\s+(?:mod[ée]ration|validation|approbation)',
        'wartet\\s+auf\\s+(?:freischaltung|moderation)',
        'muss\\s+noch\\s+freigeschaltet\\s+werden',
        'aguardando\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)',
        'aguarda\\s+modera[çc][ãa]o',
        'pendente\\s+de\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)',
        'دیدگاه\\s+شما\\s+در\\s+انتظار\\s+(?:بررسی|تایید|تأیید)',
        'در\\s+انتظار\\s+(?:بررسی|تایید|تأیید)',
        'در\\s+صف\\s+بررسی',
        'پس\\s+از\\s+(?:تایید|تأیید)\\s+نمایش',
        '等待审核',
        '待审核',
        '审核通过后显示',
        '正在等待审核',
        '审核后显示',
    ].join('|'), 'iu');
    const modMatch = modPattern.exec(modText || bodyText);
    const moderationNotice = modText || (modMatch ? modMatch[0] : undefined);
    // Check if visible text contains literal escaped `<a href=...>` pointing to our URL.
    const escapedPattern = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)/giu;
    let escapedHtmlDetected = false;
    let escMatch;
    while ((escMatch = escapedPattern.exec(bodyText)) !== null) {
        const rawEscHref = escMatch[1] ?? '';
        if (!normalizedTarget || normalizeUrl(rawEscHref).includes(normalizedTarget) || (targetHost && rawEscHref.toLowerCase().includes(targetHost))) {
            escapedHtmlDetected = true;
            break;
        }
    }
    const matchesTargetLink = (link) => {
        const hrefAttr = clean(link.getAttribute('href'));
        if (!hrefAttr || hrefAttr.startsWith('#') || hrefAttr.startsWith('javascript:'))
            return undefined;
        const normHref = normalizeUrl(hrefAttr);
        const linkText = clean(link.innerText || link.textContent);
        const hrefMatches = normalizedTarget.length > 0 && (normHref === normalizedTarget
            || normHref.startsWith(`${normalizedTarget}/`)
            || (targetHost.length > 0 && normHref.split('/')[0] === targetHost));
        const anchorMatches = cleanAnchor.length > 0 && linkText.toLowerCase().includes(cleanAnchor);
        if (hrefMatches || (normalizedTarget.length === 0 && anchorMatches)) {
            return { href: hrefAttr, text: linkText };
        }
        return undefined;
    };
    // Check specific `#comment-<digits>` node first when present in post-submit URL.
    let commentNodeLinkFound = false;
    let matchedHref;
    let matchedAnchor;
    if (params.commentId) {
        const cleanId = params.commentId.replace(/^#/u, '');
        const specificSelectors = [`#${cleanId}`, `#div-${cleanId}`, `[id$="${cleanId}"]`];
        for (const sel of specificSelectors) {
            let node = null;
            try {
                node = dom.document.querySelector(sel);
            }
            catch {
                node = null;
            }
            if (!node)
                continue;
            for (const link of node.querySelectorAll('a[href]')) {
                const hit = matchesTargetLink(link);
                if (hit) {
                    commentNodeLinkFound = true;
                    matchedHref = hit.href;
                    matchedAnchor = hit.text;
                    break;
                }
            }
            if (commentNodeLinkFound)
                break;
        }
    }
    // Strictly require a clickable `<a href>` link outside nav/header/footer (preferring comment containers).
    if (matchedHref === undefined) {
        const scopeContainers = Array.from(dom.document.querySelectorAll('#comments, .comment-list, .comments-area, [data-hook*="comment"], main, article'));
        const candidateLinks = [];
        const seenLinks = new Set();
        const pushLinks = (root) => {
            for (const anchor of root.querySelectorAll('a[href]')) {
                if (anchor.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]'))
                    continue;
                if (!seenLinks.has(anchor)) {
                    seenLinks.add(anchor);
                    candidateLinks.push(anchor);
                }
            }
        };
        for (const container of scopeContainers)
            pushLinks(container);
        if (candidateLinks.length === 0)
            pushLinks(dom.document);
        for (const link of candidateLinks) {
            const hit = matchesTargetLink(link);
            if (hit) {
                matchedHref = hit.href;
                matchedAnchor = hit.text;
                break;
            }
        }
    }
    const snippetRoot = errEl ?? modEl ?? dom.document.querySelector('#comments, .comments-area, [data-hook*="comment"]') ?? dom.document.body;
    const rawSnippet = clean(snippetRoot ? (snippetRoot.innerText || snippetRoot.textContent) : bodyText);
    const snippet = rawSnippet.length > 0 ? rawSnippet.slice(0, 260) : undefined;
    return {
        liveLinkFound: matchedHref !== undefined,
        ...(params.commentId ? { commentNodeLinkFound } : {}),
        ...(matchedHref === undefined ? {} : { matchedHref }),
        ...(matchedAnchor === undefined ? {} : { matchedAnchor }),
        escapedHtmlDetected,
        ...(moderationNotice === undefined ? {} : { moderationNotice }),
        ...(wpErrorMessage === undefined ? {} : { wpErrorMessage }),
        ...(captchaDetected ? { captchaDetected: true } : {}),
        ...(snippet === undefined ? {} : { snippet }),
    };
}
const WIX_PROGRESSIVE_SCROLL_STEPS = [0.3, 0.6, 0.85, 1.0];
const DEFAULT_PROGRESSIVE_SCROLL_STEPS = [0.5, 0.85, 1.0];
export const CAPTCHA_FRAME_URL_PATTERN = /recaptcha|hcaptcha|turnstile/iu;
export const KNOWN_COMMENT_FRAME_URL_PATTERN = /disqus\.com|blogger\.com\/comment|giscus\.app|utteranc\.es|hyvor\.com|commentbox\.io|intensedebate|facebook\.com\/plugins\/comments|comments-ooi|wixapps\.net\/.*comment|comment.*iframe/iu;
export const NON_COMMENT_FRAME_URL_PATTERN = /^$|^about:blank$|^javascript:|doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net\/.*fbevents|video\.wixstatic\.com|youtube\.com(?:\/|$)|youtu\.be|vimeo\.com|trustpilot\.com|engage\.wixapps\.net|usrfiles\.com|filesusr\.com|google\.com\/maps|maps\.google\.com|calendly\.com|intercom\.io|tawk\.to|crisp\.chat|klaviyo\.com|spotify\.com\/embed|soundcloud\.com\/player/iu;
function defaultSleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject(new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new BrowserError('browser comment_publish aborted', 'BROWSER_ABORTED');
    }
}
export function isNavigationContextError(error) {
    const msg = String(error instanceof Error ? error.message : error);
    if (/session is closed/iu.test(msg))
        return false;
    return /execution context was destroyed|frame was detached|cannot find context with specified id|most likely because of a navigation/iu.test(msg);
}
async function scrollPageStep(page, fraction) {
    await page.evaluate((stepFraction) => {
        const dom = globalThis;
        const docHeight = Math.max(dom.document.documentElement?.scrollHeight ?? 0, dom.document.body?.scrollHeight ?? 0);
        const placeholder = dom.document.querySelector('[data-hook="comments-section-placeholder"], [data-hook="comment-box-placeholder"], [data-hook*="comment-box"], [data-hook="comments-section"]');
        if (placeholder && typeof placeholder.scrollIntoView === 'function') {
            placeholder.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        else if (stepFraction >= 0.65) {
            const anchor = dom.document.querySelector('#comments, #respond, form#commentform, [data-hook="top-level-comment-list"], iframe[src*="blogger.com/comment"]');
            if (anchor && typeof anchor.scrollIntoView === 'function') {
                anchor.scrollIntoView({ behavior: 'instant', block: 'center' });
            }
            else if (typeof dom.window.scrollTo === 'function') {
                dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
            }
        }
        else if (typeof dom.window.scrollTo === 'function') {
            dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
        }
        if (typeof dom.Event === 'function' && typeof dom.window.dispatchEvent === 'function') {
            try {
                dom.window.dispatchEvent(new dom.Event('scroll'));
            }
            catch {
                // ignore synthetic event errors
            }
        }
    }, fraction).catch(() => undefined);
}
async function evaluateFrameWithTimeout(frame, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            frame.evaluate(INSPECT_CHILD_FRAME_SCRIPT).catch(() => null),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
export async function inspectChildFrames(page) {
    if (typeof page.frames !== 'function') {
        return {
            frames: [],
            hasActionableCommentFrame: false,
            hasUnknownInteractiveFrame: false,
            captchaDetected: false,
        };
    }
    const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined;
    const frameSummaries = [];
    let hasActionableCommentFrame = false;
    let hasUnknownInteractiveFrame = false;
    let captchaDetected = false;
    let commentsClosedPhrase;
    let bloggerFrameUrl;
    let inspectedCount = 0;
    for (const frame of page.frames()) {
        if (frame === mainFrame)
            continue;
        if (typeof frame.isDetached === 'function' && frame.isDetached())
            continue;
        const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
        // Always detect CAPTCHA iframes first.
        if (CAPTCHA_FRAME_URL_PATTERN.test(frameUrl)) {
            captchaDetected = true;
            frameSummaries.push(`${frameUrl.slice(0, 90)} [captcha]`);
            continue;
        }
        const knownComment = KNOWN_COMMENT_FRAME_URL_PATTERN.test(frameUrl);
        if (!knownComment && NON_COMMENT_FRAME_URL_PATTERN.test(frameUrl)) {
            continue;
        }
        if (/blogger\.com\/comment/iu.test(frameUrl)) {
            bloggerFrameUrl ??= frameUrl;
        }
        if (knownComment) {
            hasActionableCommentFrame = true;
        }
        let detail = null;
        if (inspectedCount < 6 && typeof frame.evaluate === 'function') {
            inspectedCount++;
            detail = await evaluateFrameWithTimeout(frame, FRAME_INSPECT_TIMEOUT_MS);
        }
        const tags = [];
        if (detail?.captchaDetected) {
            captchaDetected = true;
            tags.push('captcha');
        }
        if (detail?.commentsClosedPhrase) {
            commentsClosedPhrase ??= detail.commentsClosedPhrase;
            tags.push('closed');
        }
        if (detail?.hasEditor) {
            hasActionableCommentFrame = true;
            tags.push('editor');
        }
        if (detail?.hasTrigger) {
            hasActionableCommentFrame = true;
            tags.push('trigger');
        }
        if (detail?.loginRequired) {
            hasActionableCommentFrame = true;
            tags.push('login');
        }
        if (!knownComment && tags.length === 0) {
            hasUnknownInteractiveFrame = true;
            if (detail?.snippet)
                tags.push(`text:${detail.snippet.slice(0, 50)}`);
            else
                tags.push('cross-origin');
        }
        frameSummaries.push(`${frameUrl.slice(0, 90)}${tags.length > 0 ? ` [${tags.join(',')}]` : ''}`);
    }
    return {
        frames: frameSummaries,
        hasActionableCommentFrame,
        hasUnknownInteractiveFrame,
        captchaDetected,
        ...(commentsClosedPhrase === undefined ? {} : { commentsClosedPhrase }),
        ...(bloggerFrameUrl === undefined ? {} : { bloggerFrameUrl }),
    };
}
function hasActionableCommentSurface(inspection) {
    return (inspection.wordpress.found
        || Boolean(inspection.wordpress.collapsedTriggerSelector)
        || Boolean(inspection.genericComment?.found)
        || inspection.commentsClosed.matched
        || inspection.wix.captchaDetected
        || inspection.wix.loginRequired
        || inspection.wix.hasGuestEditor
        || inspection.wix.triggerSelector !== undefined
        || Boolean(inspection.hasBloggerCommentIframe)
        || Boolean(inspection.childFrames?.bloggerFrameUrl)
        || Boolean(inspection.childFrames?.captchaDetected)
        || Boolean(inspection.childFrames?.hasActionableCommentFrame));
}
async function inspectCommentPageWithFrames(page) {
    const base = await page.evaluate(INSPECT_COMMENT_PAGE_SCRIPT);
    const childFrames = await inspectChildFrames(page);
    const hasChildSignals = childFrames.frames.length > 0
        || childFrames.captchaDetected
        || childFrames.hasActionableCommentFrame
        || childFrames.hasUnknownInteractiveFrame
        || childFrames.commentsClosedPhrase !== undefined
        || childFrames.bloggerFrameUrl !== undefined;
    if (!hasChildSignals) {
        return base;
    }
    const extraFramesLine = childFrames.frames.length > 0
        ? `[child-frames] ${childFrames.frames.slice(0, 4).join(' ; ')}`
        : '';
    const combinedBottom = [base.bottomSnapshot, extraFramesLine]
        .filter((part) => Boolean(part && part.length > 0))
        .join('\n')
        .slice(0, BOTTOM_SNAPSHOT_MAX_CHARS);
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
    };
}
async function verifyResult(page, command, commentId) {
    return await page.evaluate(verifyCommentResultInDom, {
        ...(command.websiteUrl === undefined ? {} : { websiteUrl: command.websiteUrl }),
        ...(command.anchorText === undefined ? {} : { anchorText: command.anchorText }),
        commentText: command.commentText,
        ...(command.authorName === undefined ? {} : { authorName: command.authorName }),
        ...(commentId === undefined ? {} : { commentId }),
    });
}
/**
 * Navigation-resilient verification wrapper: retries cleanly after
 * `Execution context was destroyed` / `frame was detached` during 302 redirects.
 */
async function safeVerifyResult(page, command, timeoutMs, sleep, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const currentUrl = page.url();
        const commentIdMatch = /#(comment-\d+)\b/iu.exec(currentUrl);
        const commentId = commentIdMatch?.[1];
        try {
            const verify = await verifyResult(page, command, commentId);
            return { verify, currentUrl, ...(commentId === undefined ? {} : { commentId }) };
        }
        catch (error) {
            if (!isNavigationContextError(error) || attempt === 2) {
                throw error;
            }
            if (typeof page.waitForLoadState === 'function') {
                await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
            }
            await sleep(Math.min(300, timeoutMs), signal);
        }
    }
    const fallbackUrl = page.url();
    return {
        verify: { liveLinkFound: false, escapedHtmlDetected: false },
        currentUrl: fallbackUrl,
    };
}
/** Verify whether the Wix contenteditable editor now contains a real `<a href>` matching targetUrl. */
async function checkRichEditorHasLink(page, editorSelector, websiteUrl) {
    return await page.evaluate(({ selector, targetUrl }) => {
        const dom = globalThis;
        const editor = dom.document.querySelector(selector);
        if (!editor)
            return false;
        let targetHost = '';
        try {
            targetHost = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./u, '');
        }
        catch {
            targetHost = targetUrl.toLowerCase();
        }
        for (const anchor of editor.querySelectorAll('a[href]')) {
            const href = String(anchor.getAttribute('href') ?? '').trim().toLowerCase();
            if (!href || href.startsWith('javascript:'))
                continue;
            if (targetHost.length === 0 || href.includes(targetHost)) {
                return true;
            }
        }
        return false;
    }, { selector: editorSelector, targetUrl: websiteUrl }).catch(() => false);
}
function inferSiteType(inspection) {
    if (inspection.wordpress.found || inspection.isWordPress)
        return 'wordpress';
    if (inspection.genericComment?.kind === 'typecho' || inspection.isTypecho)
        return 'typecho';
    if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl)
        return 'blogger';
    if (inspection.isWix)
        return 'wix';
    return 'other';
}
function buildFallbackResult(ref, siteType, inspection, evidence) {
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
    };
}
function buildNeedsLoginResult(ref, siteType, inspection, evidence, loginInfo, finalUrlOverride) {
    const effectiveLoginInfo = loginInfo ?? inspection.wix.loginInfo;
    return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'needs_login',
        siteType,
        title: inspection.title,
        finalUrl: finalUrlOverride ?? inspection.finalUrl,
        evidence,
        submitTriggered: false,
        ...(effectiveLoginInfo === undefined ? {} : { loginInfo: effectiveLoginInfo }),
        formSummary: {
            ...inspection.formSummary,
            hasLoginWall: true,
        },
        ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
    };
}
function buildWixNoFormDiagnosis(inspection) {
    if (inspection.wix.isBlogListPage) {
        return '当前页面为 Wix 博客列表/索引页（非单篇文章 /post/），需要挑选近期文章进入后再探测评论框（安全护栏拒判 no_form，未触发提交）';
    }
    if (inspection.wix.hasLazyPlaceholder || inspection.wix.hasCommentCountOnly) {
        return 'Wix 博客仍处于 comments-section-placeholder/comment-count 懒加载阶段且未完成挂载，需 LLM 滚动复核（安全护栏拒判 no_form，未触发提交）';
    }
    if (inspection.childFrames?.hasActionableCommentFrame || inspection.childFrames?.hasUnknownInteractiveFrame) {
        return 'Wix 页面存在可疑子 iframe，可能承载延迟/第三方评论组件，转交 LLM 核查（安全护栏拒判 no_form，未触发提交）';
    }
    if (inspection.wix.hasCommentSection || inspection.wix.triggerSelector) {
        return '检测到 Wix 评论容器/触发器但未确认访客输入框或登录模态框，转交 LLM 接管（安全护栏拒判 no_form，未触发提交）';
    }
    if (inspection.wix.hasBlogPostStructure || inspection.wix.isComplexWixLayout) {
        return '复杂 Wix 博客文章/Thunderbolt 布局在等待窗口内未暴露确定性评论表单，附带底部快照转交 LLM 二次确认（安全护栏拒判 no_form，未触发提交）';
    }
    return 'Wix 页面未定位到确定性评论入口，附带底部快照转交 LLM 二次确认（未触发提交）';
}
/** Shared submission + 302-resilient post-submit/reload verification for WP, Typecho, and custom blog forms. */
async function submitAndVerifyStandardForm(page, ref, siteType, siteLabel, inspection, form, command, options) {
    const { timeoutMs, verifyReload, probeOnly, sleep, signal } = options;
    if (form.captcha?.detected || inspection.childFrames?.captchaDetected) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'blocked_captcha',
            siteType,
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            ...(form.captcha?.templateSignature === undefined ? {} : { templateSignature: form.captcha.templateSignature }),
            evidence: `${siteLabel} 评论区存在 ${form.captcha?.kind ?? 'captcha'} 人机验证，未尝试绕过`,
            suggestedTags: ['has_captcha'],
            submitTriggered: false,
        };
    }
    if (probeOnly) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'form_ready',
            siteType,
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            probeOnly: true,
            submitTriggered: false,
            formSummary: inspection.formSummary,
            ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
        };
    }
    if ((form.authorRequired && !command.authorName?.trim()) || (form.emailRequired && !command.authorEmail?.trim())) {
        return buildFallbackResult(ref, siteType, inspection, `${siteLabel} 评论表单缺少必填的 authorName 或 authorEmail 参数，转交常规流程处理`);
    }
    const hasUrlField = form.urlSelector !== undefined;
    const commentBody = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasUrlField);
    await dismissBlockingOverlays(page, timeoutMs);
    await page.locator(form.commentSelector).first().fill(commentBody, { timeout: timeoutMs });
    if (form.authorSelector !== undefined && command.authorName?.trim()) {
        await page.locator(form.authorSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
    }
    if (form.emailSelector !== undefined && command.authorEmail?.trim()) {
        await page.locator(form.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
    }
    if (form.urlSelector !== undefined && command.websiteUrl?.trim()) {
        await page.locator(form.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
    }
    if (form.submitSelector === undefined) {
        return buildFallbackResult(ref, siteType, inspection, `${siteLabel} 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）`);
    }
    await dismissBlockingOverlays(page, timeoutMs);
    // Point of no return: clicking submit marks submitTriggered=true (idempotent: never retry on uncertainty).
    const submitLocator = page.locator(form.submitSelector).first();
    const navWaitTimeout = Math.min(10_000, timeoutMs);
    const navPromise = typeof page.waitForNavigation === 'function'
        ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navWaitTimeout }).catch(() => null)
        : typeof page.waitForLoadState === 'function'
            ? page.waitForLoadState('domcontentloaded', { timeout: navWaitTimeout }).catch(() => null)
            : Promise.resolve(null);
    await Promise.all([
        navPromise,
        submitLocator.click({ timeout: timeoutMs }).catch((error) => {
            if (isNavigationContextError(error))
                return null;
            throw error;
        }),
    ]);
    // Check post-submit URL & DOM BEFORE reloading clean URL (tolerating 302 execution-context destruction).
    const postCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
    const postSubmitUrl = postCheck.currentUrl;
    const postVerify = postCheck.verify;
    const postCommentId = postCheck.commentId;
    const postSubmitSnippet = postVerify.snippet;
    if (postVerify.wpErrorMessage) {
        const mentionsCaptcha = /captcha|spam|security/iu.test(postVerify.wpErrorMessage);
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'uncertain_after_submit',
            siteType,
            title: await page.title().catch(() => inspection.title),
            finalUrl: postSubmitUrl,
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
            evidence: `提交后页面返回错误提示: ${postVerify.wpErrorMessage.slice(0, 160)}`,
            ...(mentionsCaptcha ? { suggestedTags: ['has_captcha'] } : {}),
            submitTriggered: true,
        };
    }
    const isWpEndpoint = /wp-comments-post\.php/iu.test(postSubmitUrl);
    const cleanPublicUrl = isWpEndpoint ? command.url : stripWpModerationParams(postSubmitUrl);
    const sawModeration = Boolean(postVerify.moderationNotice || /[?&](?:unapproved|moderation-hash)=/iu.test(postSubmitUrl));
    // Definitive moderation signal right after submit -> immediately return `submitted` keeping `#comment-ID` URL.
    if (sawModeration) {
        const modTitle = await page.title().catch(() => inspection.title);
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'submitted',
            siteType,
            title: modTitle,
            finalUrl: cleanPublicUrl,
            publicUrl: cleanPublicUrl,
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
            evidence: `${siteLabel} 评论已提交等待审核 (${postVerify.moderationNotice ?? 'unapproved'})`,
            submitTriggered: true,
        };
    }
    const postHasCommentIdLink = Boolean(postCommentId && (postVerify.commentNodeLinkFound || postVerify.liveLinkFound));
    let finalVerify = postVerify;
    let finalUrl = cleanPublicUrl;
    if (verifyReload) {
        await page.goto(cleanPublicUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        await scrollPageStep(page, 1.0);
        const reloadCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
        finalUrl = reloadCheck.currentUrl;
        finalVerify = reloadCheck.verify;
    }
    const finalTitle = await page.title().catch(() => inspection.title);
    if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'uncertain_after_submit',
            siteType,
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
            evidence: '提交后检测到正文 HTML 被转义，链接未生效（遵守幂等铁律严禁重发）',
            submitTriggered: true,
        };
    }
    if (finalVerify.liveLinkFound) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'live',
            siteType,
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            evidence: `${siteLabel} 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
            submitTriggered: true,
        };
    }
    if (finalVerify.moderationNotice) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'submitted',
            siteType,
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            postSubmitUrl,
            evidence: `${siteLabel} 评论已提交等待审核 (${finalVerify.moderationNotice})`,
            submitTriggered: true,
        };
    }
    // Page-cache downgrade: post-submit `#comment-ID` already showed our clickable link, and reload has no error/captcha.
    if (postHasCommentIdLink && !finalVerify.wpErrorMessage && !finalVerify.captchaDetected) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'submitted',
            siteType,
            title: finalTitle,
            finalUrl,
            publicUrl: cleanPublicUrl,
            reason: 'post_submit_comment_id_cached',
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
            evidence: `${siteLabel} 提交后 #${postCommentId} 节点已确认含目标链接，公开页重载暂未渲染（疑似站方页面缓存），降级回写 submitted (post_submit_comment_id_cached)`,
            submitTriggered: true,
        };
    }
    return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'uncertain_after_submit',
        siteType,
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        postSubmitUrl,
        ...(postSubmitSnippet === undefined ? (finalVerify.snippet === undefined ? {} : { postSubmitSnippet: finalVerify.snippet }) : { postSubmitSnippet }),
        evidence: `已点击 ${siteLabel} 提交但重载公开页未确认目标链接或待审核提示（严禁自动重试）`,
        submitTriggered: true,
    };
}
/** Handle Blogger comment iframe (`iframe[src*="blogger.com/comment"]`). */
async function executeBloggerCommentIframe(page, ref, inspection, command, options) {
    if (typeof page.frames !== 'function')
        return undefined;
    const bloggerFrame = page.frames().find(frame => {
        if (typeof frame.isDetached === 'function' && frame.isDetached())
            return false;
        const u = typeof frame.url === 'function' ? frame.url() : '';
        return /blogger\.com\/comment/iu.test(u);
    });
    if (!bloggerFrame || typeof bloggerFrame.evaluate !== 'function')
        return undefined;
    let detail = null;
    try {
        detail = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT);
    }
    catch {
        return undefined;
    }
    if (!detail)
        return undefined;
    if (detail.hasCaptcha) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'blocked_captcha',
            siteType: 'blogger',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            templateSignature: 'blogger:recaptcha_captcha',
            evidence: 'Blogger 评论 iframe 内检测到 CAPTCHA 人机验证，未尝试绕过',
            suggestedTags: ['has_captcha'],
            submitTriggered: false,
        };
    }
    if (detail.commentsClosedPhrase) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'comments_closed',
            siteType: 'blogger',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            skipReason: `Blogger 评论 iframe 提示评论已关闭(${detail.commentsClosedPhrase})`,
            suggestedTags: ['评论关闭'],
            submitTriggered: false,
        };
    }
    if (detail.loginRequired) {
        return buildNeedsLoginResult(ref, 'blogger', inspection, 'Blogger 评论 iframe 需要登录 Google 账号后发表评论（未触发提交）', detail.loginInfo);
    }
    if (!detail.hasEditor || !detail.commentSelector) {
        return undefined;
    }
    if (options.probeOnly) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'form_ready',
            siteType: 'blogger',
            title: inspection.title,
            finalUrl: inspection.finalUrl,
            probeOnly: true,
            submitTriggered: false,
            formSummary: inspection.formSummary,
            ...(inspection.bottomSnapshot === undefined ? {} : { bottomSnapshot: inspection.bottomSnapshot }),
        };
    }
    if (typeof bloggerFrame.locator !== 'function') {
        return buildFallbackResult(ref, 'blogger', inspection, '检测到 Blogger 评论 iframe 但当前环境不支持 frame.locator，转交 LLM 使用 frame()>> 处理');
    }
    // Select Name/URL identity if available and authorName/websiteUrl provided.
    let activeDetail = detail;
    if (detail.identitySelectSelector && detail.supportsNameUrlIdentity && (command.authorName || command.websiteUrl)) {
        const idLocator = bloggerFrame.locator(detail.identitySelectSelector).first();
        if (typeof idLocator.selectOption === 'function') {
            await idLocator.selectOption('NAMEURL', { timeout: options.timeoutMs }).catch(() => undefined);
            const refreshed = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
            if (refreshed)
                activeDetail = refreshed;
        }
    }
    const hasAnonUrl = activeDetail.anonUrlSelector !== undefined;
    const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasAnonUrl);
    await bloggerFrame.locator(activeDetail.commentSelector ?? detail.commentSelector).first().fill(body, { timeout: options.timeoutMs });
    if (activeDetail.anonNameSelector && command.authorName?.trim()) {
        await bloggerFrame.locator(activeDetail.anonNameSelector).first().fill(command.authorName.trim(), { timeout: options.timeoutMs });
    }
    if (activeDetail.anonUrlSelector && command.websiteUrl?.trim()) {
        await bloggerFrame.locator(activeDetail.anonUrlSelector).first().fill(command.websiteUrl.trim(), { timeout: options.timeoutMs });
    }
    if (!activeDetail.submitSelector) {
        return buildFallbackResult(ref, 'blogger', inspection, 'Blogger 评论框已填充但未定位到 Publish 按钮，转交 LLM 接管（未触发提交）');
    }
    await bloggerFrame.locator(activeDetail.submitSelector).first().click({ timeout: options.timeoutMs });
    await options.sleep(Math.min(1_500, options.timeoutMs), options.signal);
    const postFrame = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
    const postSubmitUrl = page.url();
    const postSubmitSnippet = postFrame?.snippet;
    if (postFrame?.hasCaptcha) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'blocked_captcha',
            siteType: 'blogger',
            title: inspection.title,
            finalUrl: postSubmitUrl,
            templateSignature: 'blogger:recaptcha_captcha',
            evidence: 'Blogger 评论提交后弹出 CAPTCHA 人机验证，未尝试绕过',
            suggestedTags: ['has_captcha'],
            submitTriggered: false,
        };
    }
    if (postFrame?.moderationNotice) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'submitted',
            siteType: 'blogger',
            title: inspection.title,
            finalUrl: postSubmitUrl,
            publicUrl: postSubmitUrl,
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
            evidence: `Blogger 评论已提交等待审核 (${postFrame.moderationNotice})`,
            submitTriggered: true,
        };
    }
    let finalUrl = postSubmitUrl;
    let finalVerify;
    if (options.verifyReload) {
        await page.goto(command.url, { timeout: options.timeoutMs, waitUntil: 'domcontentloaded' });
        await scrollPageStep(page, 1.0);
        const check = await safeVerifyResult(page, command, options.timeoutMs, options.sleep, options.signal);
        finalUrl = check.currentUrl;
        finalVerify = check.verify;
    }
    else {
        const check = await safeVerifyResult(page, command, options.timeoutMs, options.sleep, options.signal);
        finalUrl = check.currentUrl;
        finalVerify = check.verify;
    }
    const finalTitle = await page.title().catch(() => inspection.title);
    if (finalVerify.liveLinkFound) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'live',
            siteType: 'blogger',
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            evidence: `Blogger 评论公开页核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
            submitTriggered: true,
        };
    }
    if (finalVerify.moderationNotice) {
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'submitted',
            siteType: 'blogger',
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            postSubmitUrl,
            evidence: `Blogger 评论已提交等待审核 (${finalVerify.moderationNotice})`,
            submitTriggered: true,
        };
    }
    return {
        kind: 'comment_publish',
        page: ref,
        outcome: 'uncertain_after_submit',
        siteType: 'blogger',
        title: finalTitle,
        finalUrl,
        publicUrl: finalUrl,
        postSubmitUrl,
        ...(postSubmitSnippet === undefined ? (finalVerify.snippet === undefined ? {} : { postSubmitSnippet: finalVerify.snippet }) : { postSubmitSnippet }),
        evidence: '已点击 Blogger Publish 但公开页未确认目标链接或待审核提示（严禁自动重试）',
        submitTriggered: true,
    };
}
export async function executeCommentPublish(page, ref, command, options) {
    const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs;
    const verifyReload = command.verifyReload !== false;
    const probeOnly = command.probeOnly === true;
    const baseLazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? DEFAULT_LAZY_WAIT_MAX_MS, timeoutMs);
    const wixLazyWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? DEFAULT_WIX_LAZY_WAIT_MAX_MS, timeoutMs);
    const wixExpandWaitMaxMs = Math.min(options.wixExpandWaitMaxMs ?? DEFAULT_WIX_EXPAND_WAIT_MAX_MS, timeoutMs);
    const wixPostSubmitWaitMs = Math.min(options.wixPostSubmitWaitMs ?? DEFAULT_WIX_POST_SUBMIT_WAIT_MS, timeoutMs);
    const sleep = options.sleepImpl ?? defaultSleep;
    throwIfAborted(options.signal);
    await page.goto(command.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    throwIfAborted(options.signal);
    let inspection = await inspectCommentPageWithFrames(page);
    // Progressive multi-step scroll + anchor scrollIntoView + 8-10s Wix lazy-load polling.
    if (!hasActionableCommentSurface(inspection)) {
        let activeWaitMaxMs = inspection.isWix ? wixLazyWaitMaxMs : baseLazyWaitMaxMs;
        const startAt = Date.now();
        let deadline = startAt + activeWaitMaxMs;
        let maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0;
        for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
            throwIfAborted(options.signal);
            const steps = inspection.isWix ? WIX_PROGRESSIVE_SCROLL_STEPS : DEFAULT_PROGRESSIVE_SCROLL_STEPS;
            const fraction = steps[Math.min(poll, steps.length - 1)];
            await scrollPageStep(page, fraction);
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
            const prevIsWix = inspection.isWix;
            inspection = await inspectCommentPageWithFrames(page);
            if (!prevIsWix && inspection.isWix && options.lazyWaitMaxMs === undefined) {
                activeWaitMaxMs = wixLazyWaitMaxMs;
                deadline = startAt + activeWaitMaxMs;
                maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0;
            }
            if (hasActionableCommentSurface(inspection))
                break;
        }
    }
    // Expand collapsed WordPress comment form (e.g. SmartMag `a.ts-button`, `ADD A COMMENT`).
    if (!inspection.wordpress.found && inspection.wordpress.collapsedTriggerSelector) {
        await dismissBlockingOverlays(page, timeoutMs);
        await page.locator(inspection.wordpress.collapsedTriggerSelector).first().click({ timeout: timeoutMs }).catch(() => undefined);
        await sleep(Math.min(400, timeoutMs), options.signal);
        inspection = await inspectCommentPageWithFrames(page);
    }
    // 1. WordPress standard comment form branch.
    if (inspection.wordpress.found) {
        return await submitAndVerifyStandardForm(page, ref, 'wordpress', 'WordPress', inspection, inspection.wordpress, command, {
            timeoutMs,
            verifyReload,
            probeOnly,
            sleep,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }
    // 1b. Typecho (author/mail/url/text) & custom blog comment forms (name/email/website/body).
    if (inspection.genericComment?.found) {
        const gc = inspection.genericComment;
        const siteType = gc.kind === 'typecho' ? 'typecho' : 'other';
        const label = gc.kind === 'typecho' ? 'Typecho' : '博客评论';
        return await submitAndVerifyStandardForm(page, ref, siteType, label, inspection, gc, command, {
            timeoutMs,
            verifyReload,
            probeOnly,
            sleep,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }
    // 1c. Blogger comment iframe branch (`iframe[src*="blogger.com/comment"]`).
    if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl) {
        const bloggerResult = await executeBloggerCommentIframe(page, ref, inspection, command, {
            timeoutMs,
            verifyReload,
            probeOnly,
            sleep,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (bloggerResult !== undefined) {
            return bloggerResult;
        }
    }
    // 2. Explicit comments-closed banner (when no active form is available).
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
        };
    }
    // 3. Wix blog comment branch (with overlay dismissal, member-wall fast check, Space autolink, post-submit dialog + reload double verification).
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
            };
        }
        if (inspection.wix.loginRequired) {
            return buildNeedsLoginResult(ref, 'wix', inspection, 'Wix 评论区为会员登录模板（检测到登录按钮且无访客 Name/Email 字段），未触发 Publish，请先登录或走 Google SSO');
        }
        if (!inspection.wix.hasGuestEditor && inspection.wix.triggerSelector) {
            await dismissBlockingOverlays(page, timeoutMs);
            const triggerLocator = page.locator(inspection.wix.triggerSelector).first();
            let clickError;
            try {
                const scrollableTrigger = triggerLocator;
                if (typeof scrollableTrigger.scrollIntoViewIfNeeded === 'function') {
                    await scrollableTrigger.scrollIntoViewIfNeeded({ timeout: Math.min(3_000, timeoutMs) }).catch(() => undefined);
                }
                await triggerLocator.click({ timeout: timeoutMs });
            }
            catch (error) {
                clickError = error;
            }
            if (clickError !== undefined) {
                return buildFallbackResult(ref, 'wix', inspection, `点击 Wix 评论展开触发器失败 (${clickError instanceof Error ? clickError.message : String(clickError)})，转交 LLM 接管（未触发提交）`);
            }
            const expandDeadline = Date.now() + wixExpandWaitMaxMs;
            const expandMaxPolls = wixExpandWaitMaxMs > 0
                ? Math.max(1, Math.ceil(wixExpandWaitMaxMs / LAZY_POLL_INTERVAL_MS))
                : 1;
            let sawLoginWithoutCaptcha = false;
            for (let poll = 0; poll < expandMaxPolls && (poll === 0 || Date.now() < expandDeadline); poll++) {
                throwIfAborted(options.signal);
                const remaining = expandDeadline - Date.now();
                if (remaining > 0) {
                    await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
                }
                inspection = await inspectCommentPageWithFrames(page);
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
                    };
                }
                if (inspection.wix.loginRequired) {
                    if (!sawLoginWithoutCaptcha && poll + 1 < expandMaxPolls) {
                        sawLoginWithoutCaptcha = true;
                        continue;
                    }
                    return buildNeedsLoginResult(ref, 'wix', inspection, '展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish');
                }
                if (inspection.wix.hasGuestEditor && inspection.wix.editorSelector) {
                    break;
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
                };
            }
            if (inspection.wix.loginRequired) {
                return buildNeedsLoginResult(ref, 'wix', inspection, '展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish');
            }
        }
        if (inspection.childFrames?.hasActionableCommentFrame && (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector)) {
            return buildFallbackResult(ref, 'wix', inspection, '在子 iframe 中检测到疑似评论/登录组件，转交 LLM 使用 frame()>> 进一步确认（未触发提交）');
        }
        if (!inspection.wix.hasGuestEditor || !inspection.wix.editorSelector) {
            const canSafelyDeclareWixNoForm = !inspection.wix.hasCommentSection
                && !inspection.wix.hasLazyPlaceholder
                && !inspection.wix.hasCommentCountOnly
                && !inspection.wix.triggerSelector
                && !inspection.wix.hasBlogPostStructure
                && !inspection.wix.isBlogListPage
                && !inspection.wix.isComplexWixLayout
                && !(inspection.childFrames?.hasActionableCommentFrame)
                && !(inspection.childFrames?.hasUnknownInteractiveFrame)
                && (inspection.readyState === undefined || inspection.readyState !== 'loading');
            if (canSafelyDeclareWixNoForm) {
                return {
                    kind: 'comment_publish',
                    page: ref,
                    outcome: 'no_form',
                    siteType: 'wix',
                    title: inspection.title,
                    finalUrl: inspection.finalUrl,
                    skipReason: 'Wix 静态页面经渐进滚动、懒加载等待与 iframe 过滤检查后确认无评论模块',
                    suggestedTags: ['no_form'],
                    submitTriggered: false,
                };
            }
            return buildFallbackResult(ref, 'wix', inspection, buildWixNoFormDiagnosis(inspection));
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
            };
        }
        const wix = inspection.wix;
        const editorSelector = wix.editorSelector;
        const hasWebsiteField = wix.websiteSelector !== undefined;
        if (wix.editorIsContentEditable) {
            const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
            await dismissBlockingOverlays(page, timeoutMs);
            const editorLocator = page.locator(editorSelector).first();
            if (stripped.websiteUrl && !hasWebsiteField && wix.linkButtonSelector) {
                await editorLocator.click({ timeout: timeoutMs });
                await editorLocator.fill(stripped.plainText, { timeout: timeoutMs });
                const anchorToSelect = stripped.anchorText ?? stripped.websiteUrl;
                const selectedOk = await page.evaluate(({ selector, anchor }) => {
                    const dom = globalThis;
                    const el = dom.document.querySelector(selector);
                    if (!el)
                        return false;
                    const walker = dom.document.createTreeWalker(el, dom.NodeFilter?.SHOW_TEXT ?? 4);
                    let node = walker.nextNode();
                    while (node) {
                        const text = node.textContent ?? '';
                        const idx = text.toLowerCase().indexOf(anchor.toLowerCase());
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
                }, { selector: editorSelector, anchor: anchorToSelect });
                if (!selectedOk) {
                    return buildFallbackResult(ref, 'wix', inspection, 'Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）');
                }
                await page.locator(wix.linkButtonSelector).first().click({ timeout: timeoutMs });
                const urlInputSelector = 'input[type="url"], input[placeholder*="http" i], input[placeholder*="url" i], input[placeholder*="link" i], input[aria-label*="url" i], input[aria-label*="link" i]';
                const urlInputCount = await page.locator(urlInputSelector).count().catch(() => 0);
                if (urlInputCount <= 0) {
                    return buildFallbackResult(ref, 'wix', inspection, '点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）');
                }
                const urlInput = page.locator(urlInputSelector).first();
                await urlInput.fill(stripped.websiteUrl, { timeout: timeoutMs });
                const applyBtnSelector = '[data-hook*="save" i], [data-hook*="apply" i], button[aria-label*="save" i], button[aria-label*="apply" i]';
                const applyCount = await page.locator(applyBtnSelector).count().catch(() => 0);
                if (applyCount > 0) {
                    await page.locator(applyBtnSelector).first().click({ timeout: timeoutMs });
                }
                else {
                    await urlInput.press('Enter', { timeout: timeoutMs });
                }
            }
            else if (stripped.websiteUrl && !hasWebsiteField) {
                // Wix Ricos/Tiptap without toolbar link button: fill text + URL, send Space to trigger autolink,
                // and confirm `<a href>` appeared in the editor before clicking Publish.
                const textWithUrl = stripped.plainText.toLowerCase().includes(stripped.websiteUrl.toLowerCase())
                    ? stripped.plainText
                    : `${stripped.plainText} ${stripped.websiteUrl}`.trim();
                await editorLocator.click({ timeout: timeoutMs });
                await editorLocator.fill(textWithUrl, { timeout: timeoutMs });
                if (typeof editorLocator.press === 'function') {
                    await editorLocator.press('Space', { timeout: timeoutMs }).catch(() => undefined);
                }
                else if (typeof page.keyboard?.press === 'function') {
                    await page.keyboard.press('Space').catch(() => undefined);
                }
                await sleep(Math.min(250, timeoutMs), options.signal);
                const autoLinked = await checkRichEditorHasLink(page, editorSelector, stripped.websiteUrl);
                if (!autoLinked) {
                    return buildFallbackResult(ref, 'wix', inspection, 'Wix 富文本评论框输入目标 URL 并补发 Space 后未确认 <a href> 自动转超链（避免发布无链评论，未触发提交）');
                }
            }
            else {
                await editorLocator.click({ timeout: timeoutMs });
                await editorLocator.fill(stripped.plainText, { timeout: timeoutMs });
            }
        }
        else {
            const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasWebsiteField);
            await page.locator(editorSelector).first().fill(body, { timeout: timeoutMs });
        }
        if (wix.nameSelector && command.authorName?.trim()) {
            await page.locator(wix.nameSelector).first().fill(command.authorName.trim(), { timeout: timeoutMs });
        }
        if (wix.emailSelector && command.authorEmail?.trim()) {
            await page.locator(wix.emailSelector).first().fill(command.authorEmail.trim(), { timeout: timeoutMs });
        }
        if (wix.websiteSelector && command.websiteUrl?.trim()) {
            await page.locator(wix.websiteSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
        }
        if (!wix.submitSelector) {
            return buildFallbackResult(ref, 'wix', inspection, 'Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）');
        }
        await dismissBlockingOverlays(page, timeoutMs);
        // Point of no return: click Publish, then wait 2-3s inspecting role=dialog before reloading.
        await page.locator(wix.submitSelector).first().click({ timeout: timeoutMs });
        const postSubmitDeadline = Date.now() + wixPostSubmitWaitMs;
        const postSubmitMaxPolls = wixPostSubmitWaitMs > 0
            ? Math.max(1, Math.ceil(wixPostSubmitWaitMs / POST_SUBMIT_POLL_INTERVAL_MS))
            : 1;
        let postDialog = { hasCaptcha: false, hasLoginDialog: false };
        let postFrames;
        for (let poll = 0; poll < postSubmitMaxPolls && (poll === 0 || Date.now() < postSubmitDeadline); poll++) {
            throwIfAborted(options.signal);
            const remaining = postSubmitDeadline - Date.now();
            if (remaining > 0) {
                await sleep(Math.min(POST_SUBMIT_POLL_INTERVAL_MS, remaining), options.signal);
            }
            postDialog = await page
                .evaluate(INSPECT_WIX_POST_SUBMIT_SCRIPT)
                .catch(() => ({ hasCaptcha: false, hasLoginDialog: false }));
            postFrames = await inspectChildFrames(page);
            if (postDialog.hasCaptcha || postFrames.captchaDetected) {
                return {
                    kind: 'comment_publish',
                    page: ref,
                    outcome: 'blocked_captcha',
                    siteType: 'wix',
                    title: await page.title().catch(() => inspection.title),
                    finalUrl: page.url(),
                    templateSignature: 'wix:signup_recaptcha',
                    evidence: '点击 Wix Publish 后弹出 reCAPTCHA 人机验证窗口，未尝试绕过',
                    suggestedTags: ['has_captcha'],
                    submitTriggered: false,
                };
            }
            if (postDialog.hasLoginDialog) {
                return buildNeedsLoginResult(ref, 'wix', inspection, '点击 Wix Publish 后弹出 Sign Up / Log in 登录窗口，非乐观成功，请先登录后再发表', postDialog.loginInfo, page.url());
            }
            if (postDialog.moderationNotice) {
                const currentUrl = page.url();
                return {
                    kind: 'comment_publish',
                    page: ref,
                    outcome: 'submitted',
                    siteType: 'wix',
                    title: await page.title().catch(() => inspection.title),
                    finalUrl: currentUrl,
                    publicUrl: currentUrl,
                    postSubmitUrl: currentUrl,
                    ...(postDialog.dialogText === undefined ? {} : { postSubmitSnippet: postDialog.dialogText }),
                    evidence: `Wix 评论提交后弹窗提示等待审核 (${postDialog.moderationNotice})`,
                    submitTriggered: true,
                };
            }
        }
        const postCheck = await safeVerifyResult(page, command, timeoutMs, sleep, options.signal);
        const postSubmitUrl = postCheck.currentUrl;
        const postVerify = postCheck.verify;
        const postSubmitSnippet = postVerify.snippet;
        const sawModeration = Boolean(postVerify.moderationNotice);
        const hadOptimisticLinkBeforeReload = postVerify.liveLinkFound;
        if (sawModeration) {
            return {
                kind: 'comment_publish',
                page: ref,
                outcome: 'submitted',
                siteType: 'wix',
                title: await page.title().catch(() => inspection.title),
                finalUrl: postSubmitUrl,
                publicUrl: postSubmitUrl,
                postSubmitUrl,
                ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
                evidence: `Wix 访客评论已提交待审核 (${postVerify.moderationNotice})`,
                submitTriggered: true,
            };
        }
        let finalVerify = postVerify;
        let finalUrl = postSubmitUrl;
        if (verifyReload) {
            const cleanReloadUrl = stripWpModerationParams(command.url);
            await page.goto(cleanReloadUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
            const reloadWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 5_000, timeoutMs);
            const reloadDeadline = Date.now() + reloadWaitMaxMs;
            const reloadMaxPolls = reloadWaitMaxMs > 0 ? Math.max(1, Math.ceil(reloadWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 1;
            await scrollPageStep(page, 1.0);
            finalVerify = (await safeVerifyResult(page, command, timeoutMs, sleep, options.signal)).verify;
            for (let poll = 0; poll < reloadMaxPolls && Date.now() < reloadDeadline
                && !finalVerify.liveLinkFound && !finalVerify.moderationNotice && !finalVerify.escapedHtmlDetected; poll++) {
                const remaining = reloadDeadline - Date.now();
                if (remaining <= 0)
                    break;
                await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
                await scrollPageStep(page, 1.0);
                finalVerify = (await safeVerifyResult(page, command, timeoutMs, sleep, options.signal)).verify;
            }
            finalUrl = page.url();
        }
        const finalTitle = await page.title().catch(() => inspection.title);
        if (finalVerify.escapedHtmlDetected && !finalVerify.liveLinkFound) {
            return {
                kind: 'comment_publish',
                page: ref,
                outcome: 'uncertain_after_submit',
                siteType: 'wix',
                title: finalTitle,
                finalUrl,
                publicUrl: finalUrl,
                postSubmitUrl,
                ...(postSubmitSnippet === undefined ? {} : { postSubmitSnippet }),
                evidence: 'Wix 评论提交后检测到正文 HTML 被转义，链接未生效（严禁重发）',
                submitTriggered: true,
            };
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
                evidence: `Wix 访客评论公开页重载核验通过: ${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}`,
                submitTriggered: true,
            };
        }
        if (finalVerify.moderationNotice) {
            return {
                kind: 'comment_publish',
                page: ref,
                outcome: 'submitted',
                siteType: 'wix',
                title: finalTitle,
                finalUrl,
                publicUrl: finalUrl,
                postSubmitUrl,
                evidence: `Wix 访客评论已提交待审核 (${finalVerify.moderationNotice})`,
                submitTriggered: true,
            };
        }
        return {
            kind: 'comment_publish',
            page: ref,
            outcome: 'uncertain_after_submit',
            siteType: 'wix',
            title: finalTitle,
            finalUrl,
            publicUrl: finalUrl,
            reason: 'optimistic_dom_not_persisted',
            postSubmitUrl,
            ...(postSubmitSnippet === undefined ? (finalVerify.snippet === undefined ? {} : { postSubmitSnippet: finalVerify.snippet }) : { postSubmitSnippet }),
            evidence: hadOptimisticLinkBeforeReload
                ? 'Wix 提交后虽出现乐观 DOM 评论但干净 URL 重载后消失 (optimistic_dom_not_persisted)，严禁误报 live 或重试'
                : '已触发 Wix Publish 但干净 URL 重载后未确认持久可点击链接 (optimistic_dom_not_persisted，严禁自动重试)',
            submitTriggered: true,
        };
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
        };
    }
    return buildFallbackResult(ref, 'other', inspection);
}
