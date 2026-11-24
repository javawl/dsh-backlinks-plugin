/**
 * Safe dismissal helper for visible marketing popups, Klaviyo modals, cookie
 * consent banners, and blocking non-auth dialogs before clicking targets.
 *
 * Strictly preserves login/signup dialogs and CAPTCHA modals so downstream
 * classifiers can report `needs_login` or `blocked_captcha` accurately.
 */
export const INSPECT_BLOCKING_OVERLAY_SCRIPT = String.raw `(() => {
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
export async function dismissBlockingOverlays(page, timeoutMs) {
    if (typeof page.evaluate !== 'function') {
        return { dismissed: false };
    }
    const before = await page
        .evaluate(INSPECT_BLOCKING_OVERLAY_SCRIPT)
        .catch(() => ({ detected: false }));
    if (!before?.detected) {
        return { dismissed: false };
    }
    if (typeof page.keyboard?.press === 'function') {
        await page.keyboard.press('Escape').catch(() => undefined);
    }
    const afterEsc = await page
        .evaluate(INSPECT_BLOCKING_OVERLAY_SCRIPT)
        .catch(() => ({ detected: false }));
    if (!afterEsc?.detected) {
        return { dismissed: true, ...(before.kind === undefined ? {} : { kind: before.kind }) };
    }
    const closeSelector = afterEsc.closeSelector ?? before.closeSelector;
    if (closeSelector && typeof page.locator === 'function') {
        const clickTimeout = Math.min(1_500, Math.max(400, timeoutMs));
        await page.locator(closeSelector).first().click({ timeout: clickTimeout }).catch(() => undefined);
        return { dismissed: true, ...(before.kind === undefined ? {} : { kind: before.kind }) };
    }
    return { dismissed: true, ...(before.kind === undefined ? {} : { kind: before.kind }) };
}
