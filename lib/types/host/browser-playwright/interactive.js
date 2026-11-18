// Evaluated as an expression in the page; keep every dependency inside the IIFE.
export const VISIBLE_CONTROLS_SCRIPT = String.raw `(() => {
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
    });
  }
  return { controls, passwordFields, emailFields, forms, emailLinks, truncated };
})()`;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function readBoolean(value) {
    return value === true;
}
export function parseControlReport(report) {
    const data = isRecord(report) ? report : {};
    const controls = [];
    for (const row of Array.isArray(data.controls) ? data.controls : []) {
        if (!isRecord(row))
            continue;
        const tag = readString(row.tag);
        if (!tag)
            continue;
        controls.push({
            tag, role: readString(row.role), inputType: readString(row.inputType),
            text: readString(row.text), value: readString(row.value), ariaLabel: readString(row.ariaLabel),
            title: readString(row.title), alt: readString(row.alt), imageAlt: readString(row.imageAlt),
            imageSrc: readString(row.imageSrc), href: readString(row.href), src: readString(row.src),
            id: readString(row.id), classes: readString(row.classes), data: readString(row.data),
            background: readString(row.background), formAction: readString(row.formAction),
            selector: readString(row.selector), x: readNumber(row.x), y: readNumber(row.y),
            inViewport: readBoolean(row.inViewport), hasImage: readBoolean(row.hasImage), hasSvg: readBoolean(row.hasSvg),
        });
    }
    return {
        controls, passwordFields: readNumber(data.passwordFields), emailFields: readNumber(data.emailFields),
        forms: readNumber(data.forms), emailLinks: readNumber(data.emailLinks), truncated: readBoolean(data.truncated),
    };
}
const PROVIDERS = {
    google: /\bgoogle\b|googleapis|gstatic|googleusercontent|accounts\.google|\bgsi\b|gsi\/button|g\.co\//,
    facebook: /\bfacebook\b|fb-login|fbconnect|\bfb\b/,
    github: /\bgithub\b/,
    apple: /\bapple\b|appleid|signin\.apple/,
    microsoft: /\bmicrosoft\b|live\.com|outlook|msal|\bazure(ad)?\b/,
    'x-twitter': /\btwitter\b|\bx\.com\b|\btwitter\.com\b/,
    discord: /\bdiscord\b/,
    linkedin: /\blinkedin\b/,
    amazon: /\bamazon\b|amazoncognito/,
    steam: /\bsteam\b/,
    twitch: /\btwitch\b/,
    yahoo: /\byahoo\b/,
    wordpress: /wordpress\.com/,
    reddit: /\breddit\b/,
    tiktok: /\btiktok\b/,
    telegram: /\btelegram\b/,
};
const AUTH_PATTERN = /\b(?:sign[ -]?(?:in|up|on)|log[ -]?(?:in|on)|continue|oauth|authori[sz]e|sso|auth|connect|callback|gsi|provider|idp)\b/;
const AUTH_URL_PATTERN = /oauth|openid|authori[sz]e|sso|\bauth\b|\/auth|login|signin|sign-in|connect|gsi|callback/;
const NON_AUTH_URL_PATTERN = /play\.google\.com|plus\.google\.com|\/share(?:\/|[?#\s]|$)|sharer|intent\/tweet|\/maps\//;
const EMAIL_SIGN_IN = { provider: 'email-password', strength: 'auth' };
function evidenceText(...fields) {
    return fields.map(field => {
        try {
            return decodeURIComponent(field);
        }
        catch {
            return field;
        }
        // Underscores separate words in assets and attributes such as google_dark.svg.
    }).join(' ').toLowerCase().replace(/_/g, '-');
}
export function readSignIn(control) {
    if (control.inputType === 'password')
        return EMAIL_SIGN_IN;
    const labelled = evidenceText(control.text, control.value, control.ariaLabel, control.title, control.alt, control.imageAlt, control.imageSrc, control.id, control.classes, control.data, control.background);
    const linked = evidenceText(control.href, control.src, control.formAction);
    if (NON_AUTH_URL_PATTERN.test(linked))
        return undefined;
    const authLabel = AUTH_PATTERN.test(labelled);
    const haystack = labelled + ' ' + linked;
    const provider = Object.entries(PROVIDERS).find(([, pattern]) => pattern.test(haystack))?.[0];
    if (provider !== undefined) {
        if (authLabel || AUTH_URL_PATTERN.test(linked))
            return { provider, strength: 'auth' };
        if (['button', 'summary', 'input'].includes(control.tag) || control.role === 'button'
            || (!control.text && (control.hasImage || control.hasSvg || control.background))) {
            return { provider, strength: 'provider' };
        }
        return undefined;
    }
    if (authLabel && /\bemail\b/.test(evidenceText(control.text, control.value, control.ariaLabel, control.title))) {
        return EMAIL_SIGN_IN;
    }
}
export function renderPageControls(title, report) {
    const counts = new Map();
    const lines = report.controls.map((control, index) => {
        const signIn = readSignIn(control);
        if (signIn)
            counts.set(signIn.provider, (counts.get(signIn.provider) ?? 0) + 1);
        const type = control.tag === 'iframe' ? 'iframe' : control.tag === 'a' || control.role === 'link' ? 'link' : control.tag;
        const label = control.text || control.value || control.imageAlt || control.alt || control.ariaLabel || control.title;
        const fields = [
            `#${index + 1} ${type}`,
            label ? JSON.stringify(label) : control.hasImage || control.hasSvg || control.background ? '(icon only)' : '',
            signIn ? `signin=${signIn.provider}${signIn.strength === 'provider' ? '?' : ''}` : '',
            control.selector ? `css=${quote(control.selector)}` : '',
            `xy=${control.x},${control.y}${control.inViewport ? '' : ' (scroll first)'}`,
        ];
        for (const [key, value] of Object.entries({
            alt: control.imageAlt || control.alt, aria: control.ariaLabel, title: control.title,
            href: control.href, src: control.src || control.imageSrc, id: control.id, cls: control.classes,
            bg: control.background, form: control.formAction,
        })) {
            if (value)
                fields.push(`${key}=${quote(value)}`);
        }
        if (control.data)
            fields.push(/^data-[\w-]+=[^\s"]+$/i.test(control.data) ? control.data : `data=${quote(control.data)}`);
        return fields.filter(Boolean).join(' ');
    });
    const fieldCount = (count) => count ? `yes ×${count}` : 'no';
    const stats = [
        `${report.forms} ${report.forms === 1 ? 'form' : 'forms'}`,
        `password field: ${fieldCount(report.passwordFields)}`,
        `email field: ${fieldCount(report.emailFields)}`,
        `mailto links: ×${report.emailLinks}`,
    ];
    return [
        `interactive: ${report.controls.length} visible controls on ${title.trim() ? JSON.stringify(title.trim()) : '(untitled)'} (${stats.join(', ')})`,
        `sign-in candidates: ${Array.from(counts, ([provider, count]) => `${provider} ×${count}`).join(', ') || 'none'}`,
        ...lines,
    ].join('\n');
}
function quote(value) {
    return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}
