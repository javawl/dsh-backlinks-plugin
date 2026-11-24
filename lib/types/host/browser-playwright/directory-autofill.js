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
            evidence: '目录提交页需要登录（请使用 snapshot format="interactive" 检查 Google SSO 或邮箱登录）',
        };
    }
    if (inspection.fields.length === 0) {
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
    // Step 1: Fill URL input first (required before clicking Fetch / AI-Autofill).
    const urlField = inspection.fields.find(f => f.role === 'url');
    if (urlField && command.websiteUrl.trim().length > 0) {
        await page.locator(urlField.selector).first().fill(command.websiteUrl.trim(), { timeout: timeoutMs });
        filledFields.push('url');
    }
    // Step 2: Click MkDirs / AI-Autofill Fetch button if available, and wait for fields to populate.
    if (inspection.autofillButtonSelector && urlField) {
        const preValues = new Map(inspection.fields
            .filter(f => f.role === 'name' || f.role === 'tagline' || f.role === 'description')
            .map(f => [f.role, f.value]));
        await dismissBlockingOverlays(page, timeoutMs);
        await page.locator(inspection.autofillButtonSelector).first().click({ timeout: timeoutMs });
        autofillTriggered = true;
        const deadline = Date.now() + waitAfterFetchMs;
        const maxPolls = waitAfterFetchMs > 0 ? Math.max(1, Math.ceil(waitAfterFetchMs / AUTOFILL_POLL_INTERVAL_MS)) : 1;
        for (let poll = 0; poll < maxPolls && (poll === 0 || Date.now() < deadline); poll++) {
            throwIfAborted(options.signal);
            const remaining = deadline - Date.now();
            if (remaining > 0) {
                await sleep(Math.min(AUTOFILL_POLL_INTERVAL_MS, remaining), options.signal);
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
    const summaryBits = [
        autofillTriggered
            ? `autofill触发(回填:${autofilledFields.join(',') || '无'})`
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
