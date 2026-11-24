/**
 * Deterministic fast-path for MkDirs / AI-Autofill and standard directory
 * submission pages (`browser action="directory_autofill"`).
 *
 * Performs URL fill -> optional Fetch/AI-Autofill trigger + wait for
 * auto-population -> backfill missing Name/Tagline/Description/Email ->
 * returns a compact form-state summary without blindly submitting.
 */
import { BrowserError } from "../browser/types.js";
import { dismissBlockingOverlays } from "./overlay.js";
export const DEFAULT_AUTOFILL_WAIT_MS = 4_000;
const AUTOFILL_POLL_INTERVAL_MS = 400;
export const INSPECT_DIRECTORY_AUTOFILL_SCRIPT = String.raw `(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const isElementShown = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };

  const isVisible = (el) => {
    if (!isElementShown(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
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
    if (el.parentElement) {
      const siblingInputs = el.parentElement.querySelectorAll('input:not([type="hidden"]), textarea');
      if (siblingInputs.length === 1) {
        const siblingLabel = el.parentElement.querySelector('label');
        if (siblingLabel && !siblingLabel.contains(el)) {
          parts.push(clean(siblingLabel.innerText || siblingLabel.textContent));
        }
      }
    }
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
    return type === 'url'
      || /(?:^|[\s_.-])(?:url|website|homepage|link|domain)(?:$|[\s_.-])|(?:site|tool|product|startup|app|project|web)[\s_-]?url|https?:\/\/|网址|网站地址|链接/i.test(sig);
  });

  // 2. Email input
  pickField('email', el => {
    if (el.localName !== 'input') return false;
    const type = (el.type || '').toLowerCase();
    const sig = labelTextFor(el);
    return type === 'email'
      || /(?:^|[\s_.-])(?:email|e-mail|mail)(?:$|[\s_.-])|contact[\s_-]?mail|邮箱|电子邮件/i.test(sig);
  });

  // 3. Name / Title input
  pickField('name', el => {
    if (el.localName !== 'input') return false;
    const sig = labelTextFor(el);
    return /(?:^|[\s_.-])(?:name|title)(?:$|[\s_.-])|(?:tool|product|site|project|app|startup|company)[\s_-]?(?:name|title)|名称|网站名|产品名|标题/i.test(sig);
  });

  // 4. Tagline / Short Description
  pickField('tagline', el => {
    const sig = labelTextFor(el);
    return /(?:tagline|slogan|short[\s_-]?desc(?:ription)?|summary|subtitle|one[\s_-]?liner|headline|brief|pitch)|一句话|简介|标语|简短描述|副标题/i.test(sig);
  });

  // 5. Long Description / Introduction
  pickField('description', el => {
    const sig = labelTextFor(el);
    if (/(?:description|desc|intro(?:duction)?|detail|about|overview|content|long[\s_-]?desc)|详细描述|介绍|描述|说明/i.test(sig)) {
      return true;
    }
    return el.localName === 'textarea';
  });

  // Login page / login wall detection (URL path + password form + OAuth / Sign-in wall without directory form).
  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const pathnameLower = (location.pathname || '/').toLowerCase();
  const isLoginPath = /(?:^|\/)(?:auth\/)?(?:log-?in|sign-?in|sign_in)(?:\/|$)/i.test(pathnameLower);
  const hasRealDirectoryFields = fields.some(f => f.role === 'url' || f.role === 'tagline' || f.role === 'description');
  const hasPasswordLoginForm = hasPasswordField && !hasRealDirectoryFields;

  const mainInteractiveEls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'))
    .filter(el => isElementShown(el) && !el.closest('header, nav, footer'));
  const hasOAuthLoginButton = mainInteractiveEls.some(el => {
    const label = clean(
      (el.innerText || el.textContent || '') + ' '
      + (el.getAttribute('aria-label') || '') + ' '
      + (el.getAttribute('title') || '') + ' '
      + (el.getAttribute('value') || '')
    );
    return /\b(?:sign\s*in|log\s*in|continue)\s+with\s+(?:google|github|apple|twitter|x|discord|magic\s+link)\b|\bgoogle\s+(?:sign\s*in|log\s*in)\b|使用\s*google\s*登录/i.test(label);
  });
  const hasLoginActionButton = mainInteractiveEls.some(el => {
    const label = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
    return /^(?:sign\s*in|log\s*in|sign\s*in\s+with\s+email|continue\s+with\s+email|send\s+magic\s+link|登录|登入)$/i.test(label);
  });
  const hasLoginHeading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(el => isElementShown(el) && !el.closest('header, nav, footer'))
    .some(el => /\b(?:sign\s*in|log\s*in|welcome\s+back|login\s+required|authentication\s+required)\b|请先登录|登录账号|欢迎回来/i.test(clean(el.innerText || el.textContent)));
  const hasExplicitLoginGateText = /\b(?:sign\s*in\s+to\s+submit|log\s*in\s+to\s+submit|please\s+sign\s*in|please\s+log\s*in|login\s+required|must\s+be\s+logged\s+in|you\s+need\s+to\s+sign\s*in|sign\s*in\s+to\s+continue|log\s*in\s+to\s+continue|sign\s*in\s+to\s+your\s+account|log\s*in\s+to\s+your\s+account)\b|请先登录|登录后提交|登录后继续/i.test(bodyText);

  let loginReason = '';
  if (isLoginPath && !hasRealDirectoryFields) {
    loginReason = 'login_url:' + pathnameLower;
  } else if (hasPasswordLoginForm) {
    loginReason = 'password_login_form';
  } else if (!hasRealDirectoryFields && hasOAuthLoginButton) {
    loginReason = 'oauth_login_wall';
  } else if (!hasRealDirectoryFields && hasLoginHeading && hasLoginActionButton) {
    loginReason = 'login_wall';
  } else if (!hasRealDirectoryFields && (nonAuthInputs.length === 0 || (fields.length === 1 && fields[0].role === 'email')) && hasExplicitLoginGateText) {
    loginReason = 'login_gate_text';
  }
  const loginRequired = loginReason.length > 0;

  // Autofill / Fetch button detection (MkDirs AI Autofill, StartupTrusted Fetch, magic fill).
  const allShownButtons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
    .filter(el => isElementShown(el) && !el.closest('header, nav, footer'));
  const allButtons = allShownButtons.filter(el => isVisible(el));

  const autofillRegex = /\b(?:ai[\s-]*autofill|auto[\s-]*fill|ai[\s-]*fill|auto[\s-]*fetch|fetch(?:\s+(?:info|data|meta|metadata|website|site|url|details|from\s+url))?|magic\s+fill|smart[\s-]*fill|analyze(?:\s+(?:url|website|site))?|extract|import\s+from\s+url|get\s+info|load\s+(?:info|metadata|details)|scrape|fill\s+with\s+ai)\b|一键获取|自动获取|自动填充|抓取信息|获取信息|ai\s*填充/i;
  const isAutofillCandidate = (el) => {
    const text = clean((el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || ''));
    if (/\b(?:sign\s*in|log\s*in|sign\s*up)\b|登录|注册/i.test(text)) return false;
    const hook = clean((el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-hook') || '') + ' ' + (el.id || ''));
    return autofillRegex.test(text) || /autofill|fetch-meta|fetch-btn|fetch-url|ai-fill/i.test(hook);
  };
  const autofillBtn = allButtons.find(isAutofillCandidate);
  const disabledAutofillBtn = autofillBtn ? null : allShownButtons.find(el => !isVisible(el) && isAutofillCandidate(el));

  const autofillButtonBusy = !!(autofillBtn && (
    autofillBtn.getAttribute('aria-busy') === 'true'
    || /\b(?:fetching|loading|extracting|analyzing|generating)\b|获取中|填充中|加载中|分析中/i.test(clean(autofillBtn.innerText || autofillBtn.textContent))
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
    ...(loginReason ? { loginReason } : {}),
    ...(autofillBtn ? { autofillButtonSelector: selectorFor(autofillBtn) } : {}),
    ...(disabledAutofillBtn ? { autofillButtonDisabled: true } : {}),
    ...(autofillBtn ? { autofillButtonBusy } : {}),
    ...(submitBtn ? { submitSelector: selectorFor(submitBtn) } : {}),
    fields,
    selects,
    fileInputs,
    extraRequiredEmpty,
  };
})()`;
/**
 * Inspect visible confirmation dialogs triggered after clicking `AI Autofill` / `Auto Fill`
 * (e.g. MkDirs confirmation popup containing an `Analyze` / `Confirm` / `Continue` button).
 */
export const INSPECT_AUTOFILL_CONFIRM_DIALOG_SCRIPT = String.raw `(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const isShown = (el) => {
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
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      const byName = el.localName + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]';
      if (unique(el, byName)) return byName;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const byAria = el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
      if (unique(el, byAria)) return byAria;
    }
    let path = '';
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 14; node = node.parentElement, depth++) {
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

  const dialogs = Array.from(document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-radix-dialog-content], [data-state="open"][role="dialog"], .modal.show, .modal-dialog'
  )).filter(isShown);

  const authOrCaptchaRegex = /\b(?:sign\s*in|log\s*in|sign\s*up|continue\s+with\s+google|recaptcha|hcaptcha|turnstile)\b/i;
  const cancelRegex = /^(?:cancel|close|dismiss|back|no|skip|×|✕|✖|x|取消|关闭|返回)$/i;
  const confirmBtnRegex = /^(?:analyze(?:\s+(?:website|site|url|now|page))?|confirm(?:\s+(?:&|and)?\s*(?:analyze|autofill|fill|continue))?|continue|start(?:\s+(?:analyzing|analysis|autofill))?|proceed|autofill(?:\s+now)?|auto[\s-]*fill|generate|fetch(?:\s+(?:info|data|metadata|website|url|now))?|extract|run|ok|yes|分析|开始分析|确认|继续|确定|一键填充|开始抓取)$/i;

  for (const dialog of dialogs) {
    if (dialog.querySelector('input[type="password"], .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i]')) {
      continue;
    }
    const dialogText = clean(dialog.innerText || dialog.textContent);
    if (authOrCaptchaRegex.test(dialogText)) continue;

    const urlInput = Array.from(dialog.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'))
      .find(el => {
        if (!isShown(el) || el.disabled) return false;
        const type = (el.type || 'text').toLowerCase();
        if (type === 'url') return true;
        const sig = clean((el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''));
        return /url|website|site|http|domain|link/i.test(sig);
      });

    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
      .filter(el => isShown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const confirmBtn = buttons.find(el => {
      const label = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title'));
      if (!label || cancelRegex.test(label)) return false;
      return confirmBtnRegex.test(label);
    });

    if (confirmBtn) {
      const buttonSelector = selectorFor(confirmBtn);
      if (buttonSelector) {
        const urlInputSelector = urlInput ? selectorFor(urlInput) : '';
        return {
          detected: true,
          buttonSelector,
          buttonLabel: clean(confirmBtn.innerText || confirmBtn.textContent || confirmBtn.getAttribute('value') || confirmBtn.getAttribute('aria-label')),
          ...(urlInputSelector ? { urlInputSelector, urlInputValue: clean(urlInput.value || '') } : {}),
        };
      }
    }
  }

  return { detected: false };
})()`;
function defaultSleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject(new BrowserError('browser directory_autofill aborted', 'BROWSER_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new BrowserError('browser directory_autofill aborted', 'BROWSER_ABORTED'));
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
        throw new BrowserError('browser directory_autofill aborted', 'BROWSER_ABORTED');
    }
}
function toFieldStates(fields) {
    return fields.map(field => ({
        role: field.role,
        selector: field.selector,
        filled: field.value.length > 0,
        required: field.required,
        ...(field.value.length > 0
            ? { valuePreview: field.value.length > 60 ? `${field.value.slice(0, 57)}...` : field.value }
            : {}),
    }));
}
export async function executeDirectoryAutofill(page, ref, command, options) {
    const timeoutMs = command.timeoutMs ?? options.defaultTimeoutMs;
    const waitAfterFetchMs = Math.min(command.waitAfterFetchMs ?? options.waitAfterFetchMs ?? DEFAULT_AUTOFILL_WAIT_MS, Math.max(timeoutMs, 10_000));
    const sleep = options.sleepImpl ?? defaultSleep;
    throwIfAborted(options.signal);
    if (command.url !== undefined) {
        await page.goto(command.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        throwIfAborted(options.signal);
    }
    await dismissBlockingOverlays(page, timeoutMs);
    let inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
    if (inspection.captchaDetected) {
        return {
            kind: 'directory_autofill',
            page: ref,
            outcome: 'blocked_captcha',
            url: inspection.url,
            title: inspection.title,
            autofillTriggered: false,
            autofilledFields: [],
            filledFields: [],
            remainingRequired: [],
            fields: toFieldStates(inspection.fields),
            ...(inspection.selects.length > 0 ? { selects: inspection.selects } : {}),
            ...(inspection.fileInputs.length > 0 ? { fileInputs: inspection.fileInputs } : {}),
            ...(inspection.submitSelector ? { submitSelector: inspection.submitSelector } : {}),
            evidence: '目录提交页检测到 CAPTCHA 人机验证，未尝试绕过',
        };
    }
    if (inspection.loginRequired) {
        const reasonNote = inspection.loginReason ? ` (${inspection.loginReason})` : '';
        return {
            kind: 'directory_autofill',
            page: ref,
            outcome: 'needs_login',
            url: inspection.url,
            title: inspection.title,
            autofillTriggered: false,
            autofilledFields: [],
            filledFields: [],
            remainingRequired: [],
            fields: toFieldStates(inspection.fields),
            evidence: `目录提交页需要登录${reasonNote}（请使用 snapshot format="interactive" 检查 Google SSO 或邮箱登录）`,
        };
    }
    if (inspection.fields.length === 0 && !inspection.autofillButtonSelector) {
        return {
            kind: 'directory_autofill',
            page: ref,
            outcome: 'no_form',
            url: inspection.url,
            title: inspection.title,
            autofillTriggered: false,
            autofilledFields: [],
            filledFields: [],
            remainingRequired: [],
            fields: [],
            ...(inspection.selects.length > 0 ? { selects: inspection.selects } : {}),
            ...(inspection.fileInputs.length > 0 ? { fileInputs: inspection.fileInputs } : {}),
            evidence: '未检测到目录站 URL/名称/描述提交表单',
        };
    }
    const filledFields = [];
    const autofilledFields = [];
    let autofillTriggered = false;
    let autofillConfirmClicked = false;
    let autofillConfirmLabel;
    // Step 1: Fill URL input first (required before clicking Fetch / AI-Autofill).
    const urlField = inspection.fields.find(f => f.role === 'url');
    if (urlField && command.websiteUrl.trim().length > 0) {
        await page.locator(urlField.selector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
        filledFields.push('url');
        // Re-inspect right after filling URL so buttons that unlock after URL entry (e.g. StartupTrusted Fetch / MkDirs AI Autofill) become discoverable.
        inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
        if (!inspection.autofillButtonSelector && inspection.autofillButtonDisabled) {
            await sleep(Math.min(250, timeoutMs), options.signal);
            inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
        }
    }
    const tryClickConfirmDialog = async () => {
        const dialog = await page
            .evaluate(INSPECT_AUTOFILL_CONFIRM_DIALOG_SCRIPT)
            .catch(() => ({ detected: false }));
        if (!dialog?.detected || !dialog.buttonSelector)
            return false;
        if (dialog.urlInputSelector && (!dialog.urlInputValue || dialog.urlInputValue.length === 0) && command.websiteUrl.trim().length > 0) {
            await page.locator(dialog.urlInputSelector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs }).catch(() => undefined);
            if (!filledFields.includes('url'))
                filledFields.push('url');
        }
        await page.locator(dialog.buttonSelector).first().click({ timeout: timeoutMs });
        autofillConfirmClicked = true;
        autofillConfirmLabel = dialog.buttonLabel || 'Confirm';
        return true;
    };
    // Step 2: Click MkDirs AI-Autofill / StartupTrusted Fetch button if available, confirm secondary modal (e.g. Analyze), and wait for fields to populate.
    if (inspection.autofillButtonSelector && (urlField || command.websiteUrl.trim().length > 0)) {
        const preValues = new Map(inspection.fields
            .filter(f => f.role === 'name' || f.role === 'tagline' || f.role === 'description')
            .map(f => [f.role, f.value]));
        await dismissBlockingOverlays(page, timeoutMs);
        await page.locator(inspection.autofillButtonSelector).first().click({ timeout: timeoutMs });
        autofillTriggered = true;
        // Immediately handle synchronous secondary confirmation modal (e.g. MkDirs `AI Autofill` -> `Analyze`).
        await tryClickConfirmDialog();
        let deadline = Date.now() + waitAfterFetchMs;
        const maxPolls = waitAfterFetchMs > 0 ? Math.max(1, Math.ceil(waitAfterFetchMs / AUTOFILL_POLL_INTERVAL_MS)) : 1;
        for (let poll = 0; poll < maxPolls + (autofillConfirmClicked ? 1 : 0) && (poll === 0 || Date.now() < deadline); poll++) {
            throwIfAborted(options.signal);
            const remaining = deadline - Date.now();
            if (remaining > 0) {
                await sleep(Math.min(AUTOFILL_POLL_INTERVAL_MS, remaining), options.signal);
            }
            if (!autofillConfirmClicked && await tryClickConfirmDialog()) {
                deadline = Date.now() + waitAfterFetchMs;
                continue;
            }
            inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
            const populated = inspection.fields.filter(f => (f.role === 'name' || f.role === 'tagline' || f.role === 'description')
                && f.value.length > 0
                && f.value !== (preValues.get(f.role) ?? ''));
            if (populated.length > 0 && !inspection.autofillButtonBusy) {
                break;
            }
        }
        for (const f of inspection.fields) {
            if ((f.role === 'name' || f.role === 'tagline' || f.role === 'description')
                && f.value.length > 0
                && f.value !== (preValues.get(f.role) ?? '')) {
                autofilledFields.push(f.role);
            }
        }
    }
    else {
        inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
    }
    // Step 3: Backfill any still-empty Name / Tagline / Description / Email fields from provided metadata.
    const backfillPairs = [
        ['name', command.name?.trim()],
        ['tagline', command.tagline?.trim()],
        ['description', command.description?.trim()],
        ['email', command.email?.trim()],
    ];
    for (const [role, value] of backfillPairs) {
        if (!value)
            continue;
        const field = inspection.fields.find(f => f.role === role);
        if (field && field.value.length === 0) {
            await page.locator(field.selector).first().fill(value, { timeout: timeoutMs });
            filledFields.push(role);
        }
    }
    // Re-inspect final form state cleanly.
    const finalInspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
    const fieldStates = toFieldStates(finalInspection.fields);
    const remainingRequired = [
        ...fieldStates.filter(f => f.required && !f.filled).map(f => `${f.role}(${f.selector})`),
        ...finalInspection.extraRequiredEmpty,
    ];
    const outcome = remainingRequired.length === 0 && fieldStates.some(f => f.filled)
        ? 'ready_to_submit'
        : 'partial_filled';
    const confirmNote = autofillConfirmClicked ? `二次确认:${autofillConfirmLabel ?? 'Confirm'}, ` : '';
    const summaryBits = [
        autofillTriggered
            ? `autofill触发(${confirmNote}回填:${autofilledFields.join(',') || '无'})`
            : '常规目录填表',
        `补齐:${filledFields.join(',') || '无'}`,
        remainingRequired.length > 0
            ? `待补必填:${remainingRequired.join(', ')}`
            : '必填字段已就绪',
    ];
    return {
        kind: 'directory_autofill',
        page: ref,
        outcome,
        url: finalInspection.url,
        title: finalInspection.title,
        autofillTriggered,
        ...(autofillConfirmClicked ? { autofillConfirmClicked: true } : {}),
        autofilledFields,
        filledFields,
        remainingRequired,
        fields: fieldStates,
        ...(finalInspection.selects.length > 0 ? { selects: finalInspection.selects } : {}),
        ...(finalInspection.fileInputs.length > 0 ? { fileInputs: finalInspection.fileInputs } : {}),
        ...(finalInspection.submitSelector ? { submitSelector: finalInspection.submitSelector } : {}),
        evidence: summaryBits.join('；'),
    };
}
