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
const DEFAULT_WIX_LAZY_WAIT_MAX_MS = 2e4;
const DEFAULT_WIX_NAV_TIMEOUT_MS = 2e4;
const DEFAULT_COMMENT_NAV_TIMEOUT_MS = 15e3;
const DEFAULT_COMMENT_STEP_TIMEOUT_MS = 7e3;
const DEFAULT_LARGE_WP_FORM_WAIT_MAX_MS = 15e3;
const DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS = 1e4;
const LAZY_POLL_INTERVAL_MS = 400;
const NON_WIX_POLL_INTERVAL_MS = 450;
const LARGE_WP_COMMENT_NODE_THRESHOLD = 30;
const POST_SUBMIT_POLL_INTERVAL_MS = 500;
const FRAME_INSPECT_TIMEOUT_MS = 1e3;
const BOTTOM_SNAPSHOT_MAX_CHARS = 1200;
/**
* Clamp a single Playwright interaction timeout (`fill`/`click`/`waitFor`) to an
* explicit short cap (default 7,000ms) and any remaining tool deadline, preventing
* Playwright's 30,000ms default from stacking across steps.
*/
function resolveStepTimeoutMs(timeoutMs, deadlineAt, capMs = DEFAULT_COMMENT_STEP_TIMEOUT_MS) {
	let budget = Math.min(Math.max(1, timeoutMs), capMs);
	if (deadlineAt !== void 0) {
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) return 1;
		budget = Math.min(budget, remaining);
	}
	return Math.max(1, Math.floor(budget));
}
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
/** Check whether a URL or redirect Location contains WordPress `unapproved=` or `moderation-hash=` query params. */
function hasWpModerationUrlParams(rawUrl) {
	if (!rawUrl) return false;
	return /[?&](?:unapproved|moderation-hash)=/iu.test(rawUrl);
}
/** Extract positive numeric WordPress comment ID from a URL hash (`#comment-123`) or token (`comment-123`). */
function extractCommentNumericId(raw) {
	if (!raw) return void 0;
	const match = /(?:#|^)comment-(\d+)\b/iu.exec(raw.trim());
	if (!match?.[1]) return void 0;
	const num = Number(match[1]);
	return Number.isSafeInteger(num) && num > 0 ? num : void 0;
}
/** Append a lightweight cache-busting query parameter while preserving any `#comment-ID` hash. */
function appendCacheBustParam(rawUrl, nonce = Date.now()) {
	try {
		const parsed = new URL(rawUrl);
		parsed.searchParams.set("_cb", String(nonce));
		return parsed.toString();
	} catch {
		return rawUrl;
	}
}
const PROTECTED_RESOURCE_URL_PATTERN = /wixstatic\.com|wix\.com|parastorage\.com|wixapps\.net|accounts\.google\.com|apis\.google\.com|googleusercontent\.com|gstatic\.com|recaptcha\.net|google\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|leancloud|avoscloud|blogger\.com|blogspot\.com/iu;
const AD_OR_TRACKER_URL_PATTERN = /doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|connect\.facebook\.net|hotjar\.com|clarity\.ms|taboola\.com|outbrain\.com|criteo\.com|adnxs\.com|pubmatic\.com|quantserve\.com|scorecardresearch\.com|amazon-adsystem\.com|ads-twitter\.com|mc\.yandex\.ru|hm\.baidu\.com|cnzz\.com|plausible\.io|segment\.io|mixpanel\.com|fullstory\.com|newrelic\.com|nr-data\.net/iu;
const NEVER_ABORT_RESOURCE_TYPES = /* @__PURE__ */ new Set([
	"document",
	"stylesheet",
	"xhr",
	"fetch",
	"websocket",
	"eventsource"
]);
const LIGHTWEIGHT_ABORT_RESOURCE_TYPES = /* @__PURE__ */ new Set([
	"image",
	"media",
	"font"
]);
/**
* Decide whether a request during `comment_publish` navigation should be aborted.
* Never blocks `document`, `stylesheet` (protects `:visible`), `xhr`/`fetch`, or
* Wix / Google OAuth / reCAPTCHA / hCaptcha / Turnstile / LeanCloud / Blogger domains.
*/
function shouldAbortCommentPublishRequest(url, resourceType) {
	const typeLower = resourceType.trim().toLowerCase();
	if (NEVER_ABORT_RESOURCE_TYPES.has(typeLower)) return false;
	if (PROTECTED_RESOURCE_URL_PATTERN.test(url)) return false;
	if (LIGHTWEIGHT_ABORT_RESOURCE_TYPES.has(typeLower)) return true;
	if (AD_OR_TRACKER_URL_PATTERN.test(url)) return true;
	return false;
}
/**
* Multilingual Google SSO button matcher (EN, KO, JA, ZH, ES, FR, DE, IT, PT, RU, TR, NL, PL, TH, ID; case-insensitive).
* Shared as a single source of truth between `INSPECT_WIX_SSO_DIALOG_SCRIPT` and unit tests.
*/
const WIX_GOOGLE_SSO_BUTTON_PATTERN = new RegExp([
	"(?:log\\s*in|sign\\s*in|sign\\s*up|continue)\\s+with\\s+google",
	"google\\s*로그인",
	"google(?:으?로|\\s*계정으로)\\s*(?:로그인|계속(?:하기)?|(?:회원\\s*)?가입)",
	"google\\s*(?:회원\\s*)?가입",
	"구글(?:으?로|\\s*계정으로)?\\s*(?:로그인|계속(?:하기)?|(?:회원\\s*)?가입)",
	"google\\s*(?:アカウント)?で(?:ログイン|続行|登録|サインイン)",
	"google\\s*ログイン",
	"(?:使用|通过|通過|用|继续使用|繼續使用)\\s*google\\s*(?:账号|帳號|账户|帳戶)?(?:登录|登入|注册|註冊)?",
	"google\\s*(?:账号|帳號)(?:登录|登入)",
	"(?:continuar|inicia(?:r)?\\s+sesi[oó]n|registrarse|reg[ií]strate|acceder|ingresar)\\s+con\\s+google",
	"(?:continuer|se\\s+connecter|connectez-vous|identifiez-vous|s['’]inscrire|connexion)\\s+avec\\s+google",
	"(?:mit|[üu]ber)\\s+google\\s+(?:anmelden|fortfahren|einloggen|registrieren)",
	"weiter\\s+mit\\s+google",
	"(?:accedi|continua|registrati)\\s+con\\s+google",
	"(?:continuar|entrar|fazer\\s+login|fa[çc]a\\s+login|iniciar\\s+sess[ãa]o|inscrever-se|cadastre-se)\\s+com\\s+(?:o\\s+)?google",
	"(?:войти|вход|продолжить|зарегистрироваться)\\s+(?:через|с(?:\\s+помощью)?)\\s+google",
	"google\\s+ile\\s+(?:devam|giri[şs]|oturum)",
	"(?:inloggen|doorgaan)\\s+met\\s+google",
	"(?:zaloguj\\s+si[eę]|kontynuuj)\\s+(?:przez|z)\\s+google",
	"(?:masuk|lanjutkan|daftar)\\s+dengan\\s+google",
	"(?:เข้าสู่ระบบ|ดำเนินการต่อ)ด้วย\\s*google"
].join("|"), "i");
/**
* Multilingual Wix member login-entry trigger matcher (EN, ES, PT, FR, DE, IT, JA, RU, KO, ZH, FI, PL, NL, TR, ID, TH).
* Shared between `INSPECT_COMMENT_PAGE_SCRIPT`, `INSPECT_WIX_SSO_DIALOG_SCRIPT`, and unit tests.
*/
const WIX_LOGIN_TRIGGER_BUTTON_PATTERN = new RegExp([
	"\\b(?:log\\s*in|sign\\s*in|sign\\s*up)(?:\\s+to\\s+(?:comment|publish|reply|post))?\\b",
	"\\binicia(?:r)?\\s+sesi[oó]n(?:\\s+para\\s+(?:comentar|publicar))?\\b",
	"\\b(?:acceder|ingresar|reg[ií]strate|registrarse)\\b",
	"\\b(?:entrar|fazer\\s+login|fa[çc]a\\s+login|iniciar\\s+sess[ãa]o|cadastre-se|registrar-se)\\b",
	"\\b(?:se\\s+connecter|connectez-vous|connexion|s['’]inscrire|identifiez-vous)\\b",
	"\\b(?:anmelden|einloggen|registrieren|jetzt\\s+anmelden)\\b",
	"\\b(?:accedi|registrati)\\b",
	"\\b(?:kirjaudu(?:\\s+sis[äa][äa]n)?|zaloguj(?:\\s+si[eę])?|inloggen|aanmelden|giri[şs]\\s+yap|oturum\\s+a[çc]|masuk)\\b",
	"войти|вход|зарегистрироваться|авторизоваться",
	"ログイン|サインイン|会員登録|新規登録",
	"google\\s*(?:으?로\\s*)?로그인|구글\\s*로그인|로그인|회원\\s*가입",
	"เข้าสู่ระบบ|ลงทะเบียน",
	"登录|登入"
].join("|"), "i");
/**
* CSS selector matching existing Wix comment list / item / content / body containers.
* Links and text inside these containers belong to user-generated comments (including spam
* anchor links like "DM play login" / "Jai Club Login") and MUST NEVER trigger Wix login detection.
*/
const WIX_COMMENT_CONTENT_SELECTOR = [
	"[data-hook*=\"comment-content\" i]",
	"[data-hook*=\"comment-item\" i]",
	"[data-hook*=\"comment-list\" i]",
	"[data-hook*=\"comments-list\" i]",
	"[data-hook=\"top-level-comment-list\"]",
	"[data-hook=\"single-comment\"]",
	"[data-hook*=\"comment-body\" i]",
	"[data-hook*=\"comment-text\" i]",
	"[data-hook*=\"comment-replies\" i]",
	"[data-hook*=\"reply-list\" i]",
	"[data-hook=\"ricos-viewer\"]",
	"[data-testid*=\"comment-content\" i]",
	"[data-testid*=\"comment-item\" i]",
	"[data-testid*=\"comment-list\" i]",
	".comment-list",
	".comments-list",
	".comment-item",
	".comment-body",
	".comment-content",
	".single-comment"
].join(", ");
const WIX_AUTH_HOST_PATTERN = /^(?:(?:[\w-]+\.)?users\.wix\.com|(?:www\.)?wix\.com|(?:[\w-]+\.)?wixapps\.net|accounts\.google\.com)$/iu;
/**
* Multilingual comment submit button label matcher shared between WordPress, OpenCart
* (including Journal2/Journal3 themes), and custom blog comment forms.
*/
const MULTILINGUAL_SUBMIT_BUTTON_PATTERN = new RegExp([
	"post\\s+comment",
	"post\\s+reply",
	"leave\\s+a\\s+comment",
	"add\\s+comment",
	"comment",
	"publish(?:\\s+comment)?",
	"submit(?:\\s+comment)?",
	"reply",
	"send(?:\\s+comment)?",
	"si[ųu]sti(?:\\s+komentar[ąa])?",
	"pateikti(?:\\s+komentar[ąa])?",
	"paskelbti(?:\\s+komentar[ąa])?",
	"komentuoti",
	"υποβολ[ήη](?:\\s+σχολ[ίι]ου)?",
	"αποστολ[ήη](?:\\s+σχολ[ίι]ου)?",
	"δημοσ[ίι]ευση(?:\\s+σχολ[ίι]ου)?",
	"gönder",
	"yorum\\s+gönder",
	"yorumu\\s+gönder",
	"yorum\\s+yap",
	"yayınla",
	"enviar(?:\\s+comentario)?",
	"publicar(?:\\s+comentario)?",
	"comentar",
	"publier(?:\\s+le\\s+commentaire)?",
	"poster\\s+un\\s+commentaire",
	"envoyer",
	"commenter",
	"kommentar\\s+(?:absenden|abschicken|senden|veröffentlichen)",
	"absenden",
	"veröffentlichen",
	"senden",
	"invia(?:\\s+commento)?",
	"pubblica(?:\\s+commento)?",
	"publicar\\s+coment[aá]rio",
	"enviar\\s+coment[aá]rio",
	"odeslat(?:\\s+koment[áa][řr])?",
	"odosla[ťt]",
	"wy[śs]lij(?:\\s+komentarz)?",
	"opublikuj(?:\\s+komentarz)?",
	"dodaj\\s+komentarz",
	"verzenden",
	"versturen",
	"plaatsen",
	"skicka(?:\\s+kommentar)?",
	"l[äa]het[äa]",
	"julkaise",
	"trimite(?:\\s+comentariu)?",
	"k[üu]ld[ée]s",
	"bek[üu]ld[ée]s",
	"отправить(?:\\s+комментарий)?",
	"опубликовать",
	"изпрати",
	"надіслати",
	"відправити",
	"g[ửu]i(?:\\s+b[ìi]nh\\s+lu[ậa]n)?",
	"kirim(?:\\s+komentar)?",
	"ส่ง",
	"โพสต์",
	"เผยแพร่",
	"コメントを送信",
	"コメントを投稿",
	"投稿",
	"送信",
	"등록",
	"게시",
	"댓글\\s*등록",
	"发表评论",
	"提交评论",
	"发布",
	"提交",
	"发送",
	"留言"
].join("|"), "iu");
new RegExp(`^(?:${MULTILINGUAL_SUBMIT_BUTTON_PATTERN.source})$`, "iu");
/** Multilingual Wix RCE toolbar Link button matcher (matches camelCase/underscore hooks like `LinkButton`/`textInlineStyleButton_LINK` & localized aria-labels). */
const WIX_RCE_LINK_BUTTON_PATTERN = /(?:^|[^a-z])link(?:$|[^a-z])|link[-_]?btn|link[-_]?button|add[-_]?link|insert[-_]?link|inlineStyleButton_LINK|enlace|v[ií]nculo|hiperv[ií]nculo|\blien\b|verkn[üu]pfung|collegamento|odno[śs]nik|ba[ğg]lant[ıi]|링크|リンク|ссылк|插入链接|超链接|超連結|链接|連結/iu;
const WIX_RCE_UNLINK_BUTTON_PATTERN = /unlink|remove[-_ ]?link|delete[-_ ]?link|eliminar[-_ ]?enlace|quitar[-_ ]?enlace|supprimer[-_ ]?lien|링크\s*제거|取消链接|移除链接|삭제/iu;
/**
* Multilingual WordPress / blog / OpenCart moderation-pending notice matcher
* covering EN, FR, DE, CS, SK, ES, RU, PL, ID, PT, IT, TR, NL, JA, KO, VI, FA, TH, ZH.
*/
const MULTILINGUAL_MODERATION_PATTERN = new RegExp([
	"your\\s+comment\\s+is\\s+awaiting\\s+moderation",
	"awaiting\\s+(?:moderation|approval)",
	"pending\\s+(?:approval|moderation|review)",
	"held\\s+for\\s+moderation",
	"submitted\\s+(?:for\\s+review|to\\s+the\\s+webmaster\\s+for\\s+approval)",
	"waiting\\s+for\\s+(?:moderation|approval)",
	"comment\\s+is\\s+under\\s+review",
	"will\\s+be\\s+(?:published|visible|shown)\\s+(?:once|after)\\s+(?:it\\s+is\\s+)?approved",
	"esperando\\s+(?:moderaci[oó]n|(?:a\\s+ser\\s+)?(?:moderado|aprobado))",
	"pendiente\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)",
	"(?:en|a\\s+la)\\s+espera\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)",
	"en\\s+attente\\s+de\\s+(?:mod[ée]ration|validation|approbation)",
	"attente\\s+de\\s+mod[ée]ration",
	"votre\\s+commentaire\\s+est\\s+en\\s+attente",
	"wartet\\s+auf\\s+(?:eine\\s+)?(?:freischaltung|freigabe|moderation|genehmigung|[üu]berpr[üu]fung)",
	"muss\\s+(?:noch\\s+)?(?:freigeschaltet|moderiert|gepr[üu]ft)(?:\\s+werden)?",
	"zur\\s+moderation\\s+zur[üu]ckgehalten",
	"(?:v[áa][šs]\\s+koment[áa][řr]\\s+)?[čc]ek[áa]\\s+na\\s+(?:schv[áa]len[íi]|moderov[áa]n[íi]|moderaci)",
	"[čc]ak[áa]\\s+na\\s+schv[áa]lenie",
	"in\\s+attesa\\s+di\\s+(?:moderazione|approvazione)",
	"aguardando\\s+(?:por\\s+)?(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
	"a\\s+aguardar\\s+modera[çc][ãa]o",
	"aguarda\\s+modera[çc][ãa]o",
	"esperando\\s+modera[çc][ãa]o",
	"pendente\\s+de\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
	"(?:tw[óo]j\\s+komentarz\\s+)?oczekuje\\s+na\\s+(?:moderacj[ęe]|zatwierdzenie|akceptacj[ęe])",
	"(?:komentar\\s+anda\\s+)?(?:sedang\\s+)?menunggu\\s+(?:moderasi|persetujuan)",
	"wacht\\s+op\\s+(?:moderatie|goedkeuring)",
	"(?:yorumunuz\\s+)?onay\\s+bekliyor",
	"moderasyon\\s+bekliyor",
	"ожидает\\s+(?:проверки|модерации|одобрения|подтверждения)",
	"на\\s+(?:модерации|проверке)",
	"находится\\s+на\\s+модерации",
	"承認待ち",
	"審査中",
	"승인\\s*대기",
	"검토\\s*중",
	"[đd]ang\\s+ch[ờo]\\s+(?:duy[ệe]t|ki[ểe]m\\s+duy[ệe]t)",
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
].join("|"), "iu");
/** Match any multilingual moderation-pending notice from visible text. */
function matchModerationNotice(text) {
	const clean = text.replace(/\s+/gu, " ").trim();
	if (clean.length === 0) return void 0;
	return MULTILINGUAL_MODERATION_PATTERN.exec(clean)?.[0];
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

  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));

  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
    return true;
  };

  const multilingualSubmitBtnRegex = new RegExp('^(?:' + ${JSON.stringify(MULTILINGUAL_SUBMIT_BUTTON_PATTERN.source)} + ')$', 'iu');

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
    if (el.classList && el.classList.contains('comment-submit')) {
      const byOcClass = el.localName + '.comment-submit';
      if (uniqueInScope(el, byOcClass)) return byOcClass;
      if (uniqueInScope(el, '.comment-submit')) return '.comment-submit';
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
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 36; node = node.parentElement, depth++) {
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

  const safeFallbackSelectorFor = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const hookAttr = el.getAttribute('data-hook');
    if (hookAttr) return el.localName + '[data-hook="' + hookAttr.replace(/"/g, '\\"') + '"]';
    const testIdAttr = el.getAttribute('data-testid');
    if (testIdAttr) return el.localName + '[data-testid="' + testIdAttr.replace(/"/g, '\\"') + '"]';
    const aria = el.getAttribute('aria-label');
    if (aria) return el.localName + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
    const ph = el.getAttribute('placeholder');
    if (ph) return el.localName + '[placeholder="' + ph.replace(/"/g, '\\"') + '"]';
    if (el.getAttribute('role') === 'textbox') return el.localName + '[role="textbox"]';
    if (el.getAttribute('contenteditable') === 'true') return el.localName + '[contenteditable="true"]';
    return el.localName || '';
  };

  const docHtmlPrefix = (document.documentElement ? document.documentElement.innerHTML : '').slice(0, 65536);
  const isWix = !!(
    document.querySelector('[data-hook*="comment"], wix-comments, [class*="wix-comments" i], [id*="wix-comments" i], [id*="SITE_CONTAINER"], meta[name="generator"][content*="Wix" i], script[src*="wixstatic.com"], script[src*="parastorage.com"], script#wix-warmup-data, script#wix-viewer-model')
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

  const hasOpenCartPageMarker = !!(
    document.querySelector('link[href*="catalog/view/theme"], script[src*="catalog/view/theme"], link[href*="journal2"], link[href*="journal3"], script[src*="journal2"], script[src*="journal3"], .journal-blog, .post-comments .comment-form, body[class*="journal"], button#button-comment, button#button-review, .comment-submit')
    || /catalog\/view\/theme|journal3\/|journal2\/|route=(?:journal\d*\/)?(?:blog|comment|review|article)|route=product\/product/i.test(docHtmlPrefix + ' ' + location.href)
  );

  // WordPress comment form detection (including hidden #comment collapsed trigger & Jetpack Verbum Gutenberg contenteditable).
  const allWpTextareas = Array.from(document.querySelectorAll('textarea[name="comment"], textarea#comment'));
  const wpCommentTextarea = allWpTextareas.find(isVisible) || null;
  const wpAnyTextarea = wpCommentTextarea || allWpTextareas[0] || null;
  const rawWpFormCandidate = document.querySelector('form#commentform, form[action*="wp-comments-post.php"]')
    || (wpAnyTextarea ? wpAnyTextarea.closest('form') : null)
    || (isWordPress ? document.querySelector('.verbum-comments form, .jetpack-comments form, #respond form, #respond.comment-respond, .verbum-comments, .jetpack-comments') : null);
  const isActuallyOpenCartForm = !!(
    rawWpFormCandidate
    && !isWordPress
    && !rawWpFormCandidate.matches('form#commentform, form[action*="wp-comments-post.php"]')
    && (
      !!rawWpFormCandidate.querySelector('.comment-submit, #button-comment, #button-review')
      || (hasOpenCartPageMarker && (
        Boolean(rawWpFormCandidate.closest('.post-comments, .comment-form, #blog-comment, .blog-comment, .journal-blog'))
        || /^form-(?:review|comment)$|^comment-form$/i.test(rawWpFormCandidate.id || '')
      ))
    )
  );
  const wpFormCandidate = isActuallyOpenCartForm ? null : rawWpFormCandidate;

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
      wpSearchScope.querySelectorAll('#submit, button#submit, input#submit, button.comment-submit, input.comment-submit, a.comment-submit, .comment-submit, button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"]), [role="button"]')
    ).find(el => {
      if (!isVisible(el)) return false;
      if (el.id === 'submit' || el.type === 'submit' || (el.classList && el.classList.contains('comment-submit'))) return true;
      const t = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
      return multilingualSubmitBtnRegex.test(t);
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

  // If #commentform is hidden inside a WooCommerce Reviews tab (e.g. /product/* #tab-title-reviews a),
  // locate the visible Reviews tab trigger so we can expand it before WordPress form detection.
  if (!wordpress.found && (wpAnyTextarea || wpFormCandidate || document.querySelector('#tab-reviews, #reviews, .woocommerce-tabs, .reviews_tab, #tab-title-reviews'))) {
    const reviewsTabTextRegex = /\b(?:reviews?|ratings?|opiniones|rese[ñn]as|avis|bewertungen|avalia[çc][õo]es|recensioni|отзывы|ulasan)\b|评价|评论|レビュー|리뷰/i;
    const reviewsTabEl =
      Array.from(document.querySelectorAll('#tab-title-reviews a, #tab-title-reviews button, #tab-title-reviews, .reviews_tab a, .reviews_tab button, li.reviews_tab > a, a[href="#tab-reviews"], a[href="#reviews"], [aria-controls="tab-reviews"], [data-target="#tab-reviews"], [data-bs-target="#tab-reviews"]'))
        .find(el => isVisible(el) && !el.closest('header, nav, [role="navigation"]'))
      || Array.from(document.querySelectorAll('.woocommerce-tabs [role="tab"], .woocommerce-tabs a, .wc-tabs a, [role="tablist"] [role="tab"], [role="tablist"] a'))
        .find(el => {
          if (!isVisible(el) || el.closest('header, nav, [role="navigation"]')) return false;
          const t = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('href'));
          return reviewsTabTextRegex.test(t);
        });
    if (reviewsTabEl) {
      const tabSel = selectorFor(reviewsTabEl) || safeFallbackSelectorFor(reviewsTabEl);
      if (tabSel) {
        wordpress = { found: false, reviewsTabSelector: tabSel };
      }
    }
  }

  // If #comment exists in DOM but is hidden (collapsed theme such as SmartMag), find expand trigger.
  if (!wordpress.found && !wordpress.reviewsTabSelector && (wpAnyTextarea || wpFormCandidate)) {
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
      let sel = '';
      const clsList = Array.from(collapsedTrigger.classList || []);
      for (const cls of clsList) {
        if (!cls) continue;
        const byClass = collapsedTrigger.localName + '.' + escapeCss(cls);
        if (uniqueInScope(collapsedTrigger, byClass)) {
          sel = byClass;
          break;
        }
      }
      sel = sel || selectorFor(collapsedTrigger);
      if (sel) {
        wordpress = { found: false, collapsedTriggerSelector: sel };
      }
    }
  }

  // Non-WP comment forms: Valine (no <form> wrapper), Typecho (author/mail/url/text) & common custom blog forms (name/email/website/body).
  let genericComment = { found: false };
  if (!wordpress.found && !isWix) {
    // 0) Valine comment widget (input.vnick / input.vmail / input.vlink / textarea.veditor / button.vsubmit).
    const valineEditorEl = Array.from(document.querySelectorAll('textarea.veditor, .v textarea.veditor, #vcomments textarea.veditor'))
      .find(isVisible);
    if (valineEditorEl) {
      const valineScope = valineEditorEl.closest('.vwrap, .v, #vcomments, [class*="valine" i]') || document;
      const vNickEl = Array.from(valineScope.querySelectorAll('input.vnick')).find(isVisible);
      const vMailEl = Array.from(valineScope.querySelectorAll('input.vmail')).find(isVisible);
      const vLinkEl = Array.from(valineScope.querySelectorAll('input.vlink')).find(isVisible);
      const vSubmitEl = Array.from(valineScope.querySelectorAll('button.vsubmit, .vsubmit')).find(isVisible);
      if (vSubmitEl || vNickEl || vMailEl || vLinkEl) {
        const captcha = valineScope !== document ? detectFormCaptcha(valineScope, 'valine') : { detected: false };
        const preferClassSel = (el, classSel) => (el && uniqueInScope(el, classSel) ? classSel : (selectorFor(el, valineScope) || classSel));
        genericComment = {
          found: true,
          kind: 'valine',
          ...(valineScope !== document ? { formSelector: selectorFor(valineScope) || '.vwrap' } : {}),
          commentSelector: preferClassSel(valineEditorEl, 'textarea.veditor'),
          ...(vNickEl ? { authorSelector: preferClassSel(vNickEl, 'input.vnick') } : {}),
          ...(vMailEl ? { emailSelector: preferClassSel(vMailEl, 'input.vmail') } : {}),
          ...(vLinkEl ? { urlSelector: preferClassSel(vLinkEl, 'input.vlink') } : {}),
          ...(vSubmitEl ? { submitSelector: preferClassSel(vSubmitEl, 'button.vsubmit') } : {}),
          ...(captcha.detected ? { captcha } : {}),
        };
      }
    }

    const visibleForms = Array.from(document.querySelectorAll('form')).filter(isVisible);
    // 1) Typecho comment form
    if (!genericComment.found) {
      for (const form of visibleForms) {
        const textEl = Array.from(form.querySelectorAll('textarea[name="text"], textarea#textarea')).find(isVisible);
        const mailEl = Array.from(form.querySelectorAll('input[name="mail"]')).find(isVisible);
        const authorEl = Array.from(form.querySelectorAll('input[name="author"]')).find(isVisible);
        const urlEl = Array.from(form.querySelectorAll('input[name="url"]')).find(isVisible);
        const formAction = clean(form.getAttribute('action'));
        const looksTypecho = !!(textEl && isVisible(textEl) && (mailEl || /\/comment(?:\/|$|\?)/i.test(formAction) || isTypecho));
        if (looksTypecho) {
          const submitEl = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button.submit, button:not([type="button"]):not([type="reset"])')).find(isVisible);
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
    }

    // 1b) OpenCart blog/product comment & review forms (#button-comment / #button-review / Journal2 & Journal3 .comment-submit / #form-review + name/text).
    if (!genericComment.found) {
      const ocSubmitCandidates = Array.from(document.querySelectorAll(
        'button#button-comment, input#button-comment, a#button-comment, button#button-review, input#button-review, a#button-review, button.comment-submit, input.comment-submit, a.comment-submit, .comment-submit'
      )).filter(isVisible);
      const ocScopes = [];
      for (const btn of ocSubmitCandidates) {
        const container = btn.closest('form, .comment-form, #form-review, #form-comment, #comment-form, #blog-comment, .blog-comment, #tab-review, .post-comments, #comments, section, article, main') || btn.parentElement?.parentElement || document;
        if (container && !ocScopes.includes(container)) ocScopes.push(container);
      }
      for (const formEl of Array.from(document.querySelectorAll(
        'form#form-review, form#form-comment, form#comment-form, #form-review, #form-comment, .comment-form form, .comment-form, .post-comments form, #blog-comment form, #blog-comment, .blog-comment'
      )).filter(isVisible)) {
        if (!ocScopes.includes(formEl)) ocScopes.push(formEl);
      }
      for (const scope of ocScopes) {
        const textEl = Array.from(scope.querySelectorAll(
          'textarea[name="text"], textarea#input-review, textarea#input-comment, textarea[name="comment"]'
        )).find(isVisible);
        if (!textEl) continue;
        const nameEl = Array.from(scope.querySelectorAll(
          'input[name="name"], input#input-name, input[name="author"]'
        )).find(isVisible);
        const emailEl = Array.from(scope.querySelectorAll(
          'input[name="email"], input#input-email, input[type="email"]'
        )).find(isVisible);
        const urlEl = Array.from(scope.querySelectorAll(
          'input[name="website"], input[name="url"], input[type="url"]'
        )).find(isVisible);
        const submitEl =
          Array.from(scope.querySelectorAll(
            'button#button-comment, input#button-comment, a#button-comment, button#button-review, input#button-review, a#button-review, button.comment-submit, input.comment-submit, a.comment-submit, .comment-submit'
          )).find(isVisible)
          || Array.from(scope.querySelectorAll(
            'button[type="submit"], input[type="submit"], button, input[type="button"], a.btn, a.button, [role="button"]'
          )).find(el => {
            if (!isVisible(el)) return false;
            if (el.closest('.comment-list, .comments-list, .comment-item, .single-comment')) return false;
            if (el.type === 'submit') return true;
            if (el.classList && (el.classList.contains('reply-btn') || el.classList.contains('comment-reply'))) return false;
            const lbl = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title'));
            if (/^reply$/i.test(lbl)) return false;
            return multilingualSubmitBtnRegex.test(lbl);
          });
        const isOcCommentContainer = Boolean(
          (scope.matches && scope.matches('.comment-form, .post-comments, .blog-comment, #blog-comment, #form-comment, #form-review, #comment-form, #tab-review'))
          || (scope.closest && scope.closest('.comment-form, .post-comments, .blog-comment, #blog-comment, .journal-blog'))
        );
        const hasExplicitOcMarker = Boolean(
          (submitEl && (
            /^button-(?:comment|review)$/i.test(submitEl.id || '')
            || (submitEl.classList && submitEl.classList.contains('comment-submit'))
          ))
          || /^form-(?:review|comment)$|^comment-form$/i.test(scope.id || '')
          || /route=.*(?:blog|comment|review|article)/i.test(clean(scope.getAttribute && scope.getAttribute('action')) + ' ' + location.href)
          || (hasOpenCartPageMarker && isOcCommentContainer)
        );
        const looksLikeDirectory = /\b(?:submit\s+(?:tool|site|product|listing)|tool\s+name|site_title|site_url)\b/i.test(
          clean(scope.outerHTML || '').slice(0, 1200)
        );
        if (hasExplicitOcMarker && !looksLikeDirectory && (nameEl || submitEl)) {
          const captcha = scope !== document ? detectFormCaptcha(scope, 'opencart') : { detected: false };
          genericComment = {
            found: true,
            kind: 'opencart',
            ...(scope !== document ? { formSelector: selectorFor(scope) || (scope.id ? '#' + escapeCss(scope.id) : '') } : {}),
            commentSelector: selectorFor(textEl, scope),
            ...(nameEl ? {
              authorSelector: selectorFor(nameEl, scope),
              authorRequired: !!(nameEl.required || nameEl.getAttribute('aria-required') === 'true'),
            } : {}),
            ...(emailEl ? {
              emailSelector: selectorFor(emailEl, scope),
              emailRequired: !!(emailEl.required || emailEl.getAttribute('aria-required') === 'true'),
            } : {}),
            ...(urlEl ? {
              urlSelector: selectorFor(urlEl, scope),
            } : {}),
            ...(submitEl ? {
              submitSelector: selectorFor(submitEl, scope),
            } : {}),
            ...(captcha.detected ? { captcha } : {}),
          };
          break;
        }
      }
    }

    // 2) Custom blog comment form (name / email / website / body or comment-scoped form)
    if (!genericComment.found) {
      for (const form of visibleForms) {
        const commentEl = Array.from(form.querySelectorAll(
          'textarea[name="body"], textarea[name="comment"], textarea[name="content"], textarea[name="message"], textarea[id*="comment" i], textarea[placeholder*="comment" i], textarea'
        )).find(el => {
          if (!isVisible(el)) return false;
          const attrSig = clean((el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || ''));
          if (/body|comment|content|message|yorum|comentario|commentaire|kommentar|commento|коммент|コメント|评论|留言/i.test(attrSig)) return true;
          return !!form.closest('#comments, #respond, .comments, .comments-area, .comment-section');
        });
        if (!commentEl || !isVisible(commentEl)) continue;
        const formMeta = clean(
          (form.id || '') + ' '
          + (form.getAttribute('class') || '') + ' '
          + (form.getAttribute('action') || '') + ' '
          + (form.closest('#comments, #respond, .comments, .comments-area, .comment-section') ? 'comment-section' : '')
        );
        const submitEl = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"]), button, [role="button"]')).find(el => {
          if (!isVisible(el)) return false;
          if (el.type === 'submit') return true;
          const label = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
          return multilingualSubmitBtnRegex.test(label);
        });
        const submitText = submitEl ? clean(submitEl.innerText || submitEl.textContent || submitEl.getAttribute('value') || submitEl.getAttribute('aria-label')) : '';
        const authorEl = Array.from(form.querySelectorAll('input[name="name"], input[name="author"], input[id="name"], input[id="author"]')).find(isVisible);
        const emailEl = Array.from(form.querySelectorAll('input[name="email"], input[name="mail"], input[type="email"]')).find(isVisible);
        const urlEl = Array.from(form.querySelectorAll('input[name="website"], input[name="url"], input[name="homepage"], input[type="url"]')).find(isVisible);

        const hasClassicBlogBodyTuple = !!(
          commentEl.getAttribute('name') === 'body'
          && (authorEl || emailEl || urlEl)
        );
        const hasCommentContext = /comment|reply|respond|yorum|comentario|commentaire|kommentar|commento|коммент|コメント|评论|留言/i.test(formMeta + ' ' + submitText)
          || (multilingualSubmitBtnRegex.test(submitText) && !!(authorEl || emailEl || urlEl));
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
  const allCommentHookEls = Array.from(document.querySelectorAll('[data-hook*="comment" i], [data-testid*="comment" i], wix-comments, [class*="wix-comments" i], [id*="wix-comments" i], #comments'));
  const commentHooks = [];
  for (const el of allCommentHookEls) {
    const h = clean(el.getAttribute('data-hook') || el.getAttribute('data-testid') || (el.localName === 'wix-comments' ? 'wix-comments' : (el.id === 'comments' ? '#comments' : '')));
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
      || el.localName === 'wix-comments'
      || isContentEditableEl(el)
      || el.getAttribute('role') === 'textbox'
      || el.getAttribute('role') === 'button'
      || /comment-box-placeholder/i.test(h);
    return !!(text || hasInteractiveChild || isInteractiveItself);
  });

  const pathLower = (location.pathname || '/').toLowerCase();
  const hasPostSlugUrl = /\/post\/[^/?#]+|\/single-post\/[^/?#]+/i.test(pathLower);
  const postHrefLinks = Array.from(document.querySelectorAll('a[href*="/post/"], a[href*="/single-post/"]'))
    .map(a => clean(a.getAttribute('href')))
    .filter(Boolean);
  const uniquePostLinks = Array.from(new Set(postHrefLinks));
  const multiCardCount = document.querySelectorAll('[data-hook="feed-post"], [data-hook="post-list-item"], [data-hook="post-footer"], [data-hook="more-button"]').length;
  const hasSingleArticleNode = !!document.querySelector('article[data-hook="post"], [data-hook="post-hero-image"], [data-hook="comments-section-placeholder"], [data-hook*="comment-box"], wix-comments');
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

  const wixCommentContentSelector = ${JSON.stringify(WIX_COMMENT_CONTENT_SELECTOR)};
  const wixAuthHostRegex = new RegExp(${JSON.stringify(WIX_AUTH_HOST_PATTERN.source)}, 'i');
  const isInsideWixCommentContent = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      return Boolean((el.matches && el.matches(wixCommentContentSelector)) || (el.closest && el.closest(wixCommentContentSelector)));
    } catch {
      return false;
    }
  };
  const isAllowedWixLoginHref = (rawHref) => {
    const trimmed = clean(rawHref);
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return true;
    if (/^(?:mailto:|tel:|data:|blob:|sms:)/i.test(trimmed)) return false;
    try {
      const base = new URL(location.href);
      const parsed = new URL(trimmed, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const targetHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const pageHost = base.hostname.toLowerCase().replace(/^www\./, '');
      if (targetHost === pageHost) return true;
      return wixAuthHostRegex.test(parsed.hostname);
    } catch {
      return false;
    }
  };
  const isAllowedWixLoginTriggerEl = (el) => {
    if (!el || !isVisible(el) || isInsideWixCommentContent(el)) return false;
    if (el.localName === 'a') {
      const rawHref = clean(el.getAttribute('href'));
      if (!isAllowedWixLoginHref(rawHref)) return false;
      const hookSig = clean(el.getAttribute('data-hook')) + ' ' + clean(el.getAttribute('data-testid'));
      const isAuthHook = /login|signup|sign-up|sign-in/i.test(hookSig);
      const isRoleBtn = el.getAttribute('role') === 'button';
      const inAuthDialog = Boolean(el.closest && el.closest('[id^="SM_ROOT_COMP"], [role="dialog"], [aria-modal="true"]'));
      if (isAuthHook || isRoleBtn || inAuthDialog || !rawHref || rawHref === '#' || rawHref.startsWith('#') || /^javascript:/i.test(rawHref)) {
        return true;
      }
      try {
        const parsed = new URL(rawHref, location.href);
        if (wixAuthHostRegex.test(parsed.hostname)) return true;
        return /(?:login|log-in|signin|sign-in|signup|sign-up|auth|account|member|oauth|sso|session)/i.test(parsed.pathname + parsed.search + parsed.hash);
      } catch {
        return false;
      }
    }
    return true;
  };
  const extractVisibleTextWithoutCommentContent = (el) => {
    if (!el || isInsideWixCommentContent(el)) return '';
    const clone = el.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const s of clone.querySelectorAll('script,style,noscript,' + wixCommentContentSelector)) s.remove();
    }
    return extractVisibleText(clone);
  };

  // Detect visible Wix comment editor FIRST so already-logged-in Wix blogs (e.g. visible
  // comment-box-rce-wrapper + Publish) are never blocked by leftover comment-count or placeholders,
  // while strictly excluding collapsed [data-hook="comment-box-placeholder"] nodes or readOnly fakes.
  const isInsideCommentBoxPlaceholder = (el) => !!(
    el && el.closest && el.closest('[data-hook="comment-box-placeholder"], [data-hook*="comment-box-placeholder" i], [data-hook="open-comment-box"]')
  );
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
    'wix-comments [contenteditable="true"]',
    'wix-comments [contenteditable=""]',
    'wix-comments [role="textbox"]',
    'wix-comments textarea',
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
  ].join(', '))).find(el => {
    if (!isVisible(el) || isInsideCommentBoxPlaceholder(el) || isInsideWixCommentContent(el)) return false;
    if (el.readOnly || el.disabled || el.getAttribute('aria-readonly') === 'true') return false;
    if (isContentEditableEl(el) || el.localName === 'textarea') return true;
    return el.getAttribute('role') === 'textbox' && el.localName !== 'button' && el.localName !== 'a';
  }) : null;

  const wixHasCommentSection = isWix && (wixCommentRoots.length > 0 || !!wixEditorEl);
  const wixLoginRegex = /\b(?:log\s*in|sign\s*in)\s+to\s+(?:comment|publish|reply|post)\b|\b(?:log\s*in|sign\s*in)\s+to\s+publish\s+as\s+a\s+member\b|\bsign\s*up\s+to\s+comment\b|fa[çc]a\s+login\s+para\s+(?:comentar|publicar)|fazer\s+login\s+para\s+(?:comentar|publicar)|entrar\s+para\s+(?:comentar|publicar)|inicia(?:r)?\s+sesi[oó]n\s+para\s+(?:comentar|publicar)|connectez-vous\s+pour\s+(?:commenter|publier)|se\s+connecter\s+pour\s+(?:commenter|publier)|anmelden.*komment|войти.*коммент|ログイン.*コメント|댓글.*로그인|로그인.*댓글|회원으로\s*로그인|登录.*(?:评论|发表)/i;
  const wixShortLoginBtnRegex = new RegExp(${JSON.stringify(WIX_LOGIN_TRIGGER_BUTTON_PATTERN.source)}, 'i');

  const visibleBoxPlaceholder = isWix
    ? Array.from(document.querySelectorAll('button[data-hook="comment-box-placeholder"], [data-hook="comment-box-placeholder"], [data-hook="open-comment-box"], [data-hook*="comment-box-placeholder" i]'))
        .find(el => isVisible(el) && el !== wixEditorEl && !isInsideWixCommentContent(el))
    : null;
  const visibleBoxPlaceholderText = visibleBoxPlaceholder
    ? clean(visibleBoxPlaceholder.innerText || visibleBoxPlaceholder.textContent || visibleBoxPlaceholder.getAttribute('aria-label'))
    : '';
  const hasExpandableLoggedInPlaceholder = !!(
    visibleBoxPlaceholder
    && !wixLoginRegex.test(visibleBoxPlaceholderText)
    && !wixShortLoginBtnRegex.test(visibleBoxPlaceholderText)
  );
  const wixLoggedInSubmitBtn = isWix
    ? Array.from(document.querySelectorAll(
        '[data-hook="submit-comment-button"], [data-hook="publish-comment-button"], [data-hook*="comment-box"] [data-hook="primary-btn"], [data-hook*="comment-box"] [data-hook*="publish" i], wix-comments [data-hook="submit-comment-button"], wix-comments [data-hook="publish-comment-button"]'
      )).find(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !isInsideWixCommentContent(el))
    : null;

  const wixContainerText = wixCommentRoots.map(r => extractVisibleText(r)).join(' ');
  const wixCommentChromeText = wixCommentRoots
    .filter(r => !isInsideWixCommentContent(r))
    .map(r => extractVisibleTextWithoutCommentContent(r))
    .filter(Boolean)
    .join(' ');
  const pageVisibleCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile, textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]'
  );
  const wixExplicitMemberLogin = Array.from(document.querySelectorAll(
    '[data-hook="login-as-member-text-button"], [data-testid="signUp.headline"], [data-testid="login.headline"]'
  )).find(el => isVisible(el) && !isInsideWixCommentContent(el));

  const wixMemberDialog = Array.from(document.querySelectorAll('[id^="SM_ROOT_COMP"], [role="dialog"]')).find(el => {
    if (!isVisible(el)) return false;
    const t = extractVisibleText(el);
    return !!(
      el.querySelector('input[type="password"], [data-testid*="signUp" i], [data-testid*="login" i], iframe[src*="recaptcha" i]')
      || /\b(?:log\s*in\s+to|sign\s*up\s+to|continue\s+with\s+google|sign\s+up\s+with\s+google|sign\s+in\s+with\s+google|already\s+a\s+member|iniciar\s+sesi[oó]n\s+con\s+google|continuar\s+con\s+google|se\s+connecter\s+avec\s+google|continuer\s+avec\s+google|mit\s+google\s+(?:anmelden|fortfahren)|accedi\s+con\s+google|entrar\s+com\s+(?:o\s+)?google)\b|google\s*(?:으?로|\s*계정으로)?\s*(?:로그인|계속)|войти\s+через\s+google/i.test(t)
    );
  });

  // Check visible guest Name/Email inputs inside Wix comment roots.
  const hasVisibleWixGuestInputs = wixCommentRoots.some(root => {
    if (isInsideWixCommentContent(root)) return false;
    const nameIn = Array.from(root.querySelectorAll('input[type="text"], input:not([type])')).find(el =>
      isVisible(el) && !isInsideWixCommentContent(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')))
    );
    const emailIn = Array.from(root.querySelectorAll('input[type="email"], input[name*="email" i]')).find(el => isVisible(el) && !isInsideWixCommentContent(el));
    return !!(nameIn || emailIn);
  });

  // Prioritize logged-in state: when an editable Wix comment box / non-login comment-box-placeholder /
  // active logged-in submit button is visible with no explicit unlogged prompt or auth dialog, skip login detection.
  const hasExplicitWixLoginHookInCommentChrome = wixCommentRoots
    .filter(r => !isInsideWixCommentContent(r))
    .some(scope => Array.from(scope.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i]')).some(el =>
      isAllowedWixLoginTriggerEl(el) && !el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')
    ));
  const hasExplicitWixUnloggedPrompt = Boolean(
    wixExplicitMemberLogin
    || wixMemberDialog
    || hasExplicitWixLoginHookInCommentChrome
    || (wixLoginRegex.test(wixCommentChromeText) && !hasVisibleWixGuestInputs)
  );
  const wixHasLoggedInSurface = Boolean(
    isWix
    && !hasExplicitWixUnloggedPrompt
    && (wixEditorEl || hasExpandableLoggedInPlaceholder || wixLoggedInSubmitBtn)
  );

  // Collect login controls inside Wix comment chrome (strictly excluding comment list/body & external third-party links) or open member dialog.
  const loginControlScopes = wixHasLoggedInSurface
    ? []
    : [
        ...wixCommentRoots.filter(r => !isInsideWixCommentContent(r)),
        ...(wixMemberDialog ? [wixMemberDialog] : []),
      ];
  const loginButtons = [];
  const ssoProviders = [];
  const pushUnique = (arr, val, limit) => {
    if (val && !arr.includes(val) && arr.length < limit) arr.push(val);
  };
  for (const scope of loginControlScopes) {
    for (const el of scope.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i], button, a, [role="button"]')) {
      if (!isAllowedWixLoginTriggerEl(el)) continue;
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

  const wixGlobalLoginButton = wixHasLoggedInSurface
    ? null
    : Array.from(document.querySelectorAll('[data-hook*="login" i], [data-testid*="signUp" i], [data-testid*="login" i], button, a, [role="button"]'))
        .find(el =>
          isAllowedWixLoginTriggerEl(el)
          && !el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')
          && wixLoginRegex.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')))
        );

  const wixCommentScopedLogin = loginButtons.length > 0 && !hasVisibleWixGuestInputs;
  const wixLoginRequired = isWix && !wixHasLoggedInSurface && (
    wixCommentScopedLogin
    || (wixLoginRegex.test(wixCommentChromeText) && !hasVisibleWixGuestInputs)
    || (!wixEditorEl && !!wixGlobalLoginButton && !hasVisibleWixGuestInputs)
    || (!!wixExplicitMemberLogin && !hasVisibleWixGuestInputs)
    || !!wixMemberDialog
  );

  const hasNativeWixCommentContainer = isWix && (
    wixCommentRoots.length > 0
    || !!wixEditorEl
    || !!visibleBoxPlaceholder
    || !!wixExplicitMemberLogin
    || placeholderEls.length > 0
    || hasCounterHookEl
    || !!document.querySelector('wix-comments, [class*="wix-comments" i], [id*="wix-comments" i], [data-hook="comments-section"], [data-hook="comment-box"], [data-hook="comment-box-rce-wrapper"], [data-hook="top-level-comment-list"]')
  );

  const wixLoginInfo = wixLoginRequired
    ? {
        loginButtons,
        ssoProviders,
        ...(wixMemberDialog && wixMemberDialog.querySelector('input[type="email"], input[type="password"]') ? { hasEmailForm: true } : {}),
        ...(wixMemberDialog ? { dialogText: extractVisibleText(wixMemberDialog).slice(0, 200) } : {}),
      }
    : undefined;

  const signupRecaptchaAlwaysRegex = /(?:\\{0,4}["']|&quot;)?signupRecaptchaOption(?:\\{0,4}["']|&quot;)?\s*:\s*(?:\\{0,4}["']|&quot;)ALWAYS(?:\\{0,4}["']|&quot;)/i;
  let wixSignupRecaptchaAlways = false;
  if (isWix) {
    for (const scriptEl of document.querySelectorAll('script')) {
      const scriptText = scriptEl.textContent || '';
      if (scriptText.length > 0 && /signupRecaptchaOption/i.test(scriptText) && signupRecaptchaAlwaysRegex.test(scriptText)) {
        wixSignupRecaptchaAlways = true;
        break;
      }
    }
    if (!wixSignupRecaptchaAlways && document.documentElement) {
      const fullHtml = document.documentElement.innerHTML || '';
      if (/signupRecaptchaOption/i.test(fullHtml) && signupRecaptchaAlwaysRegex.test(fullHtml)) {
        wixSignupRecaptchaAlways = true;
      }
    }
  }

  let wix = {
    hasCommentSection: wixHasCommentSection,
    hasNativeWixCommentContainer,
    loginRequired: wixLoginRequired,
    captchaDetected: isWix && pageVisibleCaptcha,
    ...(wixSignupRecaptchaAlways ? { signupRecaptchaAlways: true } : {}),
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

    const triggerTextRegex = /write\s+a\s+comment|leave\s+a\s+comment|add\s+a\s+comment|post\s+a\s+comment|escribir|escribe\s+un\s+coment|escreva|kirjoita|kommentar|écrire|ecrire|댓글\s*(?:작성|쓰기|남기기)|댓글을\s*작성|写评论|发表评论|留下评论|เขียนความคิดเห็น/i;
    const triggerEl = editorEl ? null : (
      visibleBoxPlaceholder
      || Array.from(document.querySelectorAll('[data-hook*="comment" i] button, [data-hook*="comment" i] [role="button"], [data-testid*="comment" i] button, [data-testid*="comment" i] [role="button"], wix-comments button, wix-comments [role="button"], #comments button, [placeholder*="Write a comment" i], [placeholder*="comment" i]'))
        .find(el => {
          if (!isVisible(el) || el === editorEl || isInsideWixCommentContent(el)) return false;
          const h = clean(el.getAttribute('data-hook'));
          if (isCounterHook(h)) return false;
          return triggerTextRegex.test(clean(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label')));
        })
      || Array.from(document.querySelectorAll('main button, article button, main [role="button"], article [role="button"], button'))
        .find(el => {
          if (!isVisible(el) || el === editorEl || isInsideWixCommentContent(el) || el.closest('header, nav, [role="navigation"]')) return false;
          return /^\s*(?:write|leave|add|post)\s+a\s+comment\b|^\s*(?:escribir|escribe|escreva|kirjoita|kommentar|écrire|ecrire|댓글\s*(?:작성|쓰기|남기기)|写评论|เขียนความคิดเห็น)/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label')));
        })
    );

    if (editorEl) {
      const boxScope = editorEl.closest('[data-hook*="comment-box"]:not([data-hook*="rce-wrapper"])')
        || (editorEl.parentElement ? editorEl.parentElement.closest('[data-hook*="comment"]:not([data-hook*="rce-wrapper"]), [data-testid*="comment"], wix-comments, form') : null)
        || editorEl.closest('[data-hook="comment-box-rce-wrapper"]')
        || document;
      const outerScope = editorEl.closest('[data-hook*="comments-section"], [data-testid*="comment"], wix-comments, #comments, section, article, form')
        || (boxScope.parentElement ? boxScope.parentElement.closest('[data-hook*="comment"], [data-testid*="comment"], wix-comments, section, article, main') : null)
        || (boxScope.parentElement && boxScope.parentElement !== document.body ? boxScope.parentElement : null)
        || document;
      const nameEl = Array.from(boxScope.querySelectorAll('input[type="text"], input:not([type])')).find(el => isVisible(el) && /name|nick|author|昵称|姓名/i.test(clean((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''))));
      const emailEl = Array.from(boxScope.querySelectorAll('input[type="email"], input[name*="email" i]')).find(isVisible);
      const websiteEl = Array.from(boxScope.querySelectorAll('input[type="url"], input[name*="website" i], input[name*="url" i], input[placeholder*="website" i]')).find(isVisible);
      const wixRceLinkRegex = new RegExp(${JSON.stringify(WIX_RCE_LINK_BUTTON_PATTERN.source)}, 'i');
      const wixRceUnlinkRegex = new RegExp(${JSON.stringify(WIX_RCE_UNLINK_BUTTON_PATTERN.source)}, 'i');
      const findLinkBtn = (scope) => Array.from(scope.querySelectorAll('button, [role="button"]')).find(el => {
        if (!isVisible(el)) return false;
        const sig = clean((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-hook') || '') + ' ' + (el.getAttribute('data-testid') || ''));
        return sig.length > 0 && !wixRceUnlinkRegex.test(sig) && wixRceLinkRegex.test(sig);
      });
      const findSubmitBtn = (scope) => Array.from(scope.querySelectorAll('[data-hook="submit-comment-button"], [data-hook="publish-comment-button"], [data-hook*="publish" i], [data-hook="primary-btn"], button[type="submit"], button, [role="button"]')).find(el => {
        if (!isVisible(el)) return false;
        const hook = clean(el.getAttribute('data-hook'));
        if (hook === 'submit-comment-button' || hook === 'publish-comment-button') return true;
        if (hook === 'primary-btn' && el.closest('[data-hook*="comment-box"], [data-hook*="comments-section"], [data-hook*="comment"]')) return true;
        return /^(?:publish(?:\s+comment)?|post(?:\s+comment)?|submit(?:\s+comment)?|comment|reply|publicar|enviar|publier|veröffentlichen|julkaise|เผยแพร่|โพสต์|ส่ง|公開|게시|등록|댓글\s*등록|发布|提交|评论)$/i.test(
          clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'))
        );
      });
      const linkBtnInBox = findLinkBtn(boxScope);
      const linkBtn = linkBtnInBox || findLinkBtn(outerScope);
      const linkBtnScope = linkBtnInBox ? boxScope : outerScope;
      const submitInBox = findSubmitBtn(boxScope);
      const submitEl = submitInBox || findSubmitBtn(outerScope);
      const submitScope = submitInBox ? boxScope : outerScope;

      const resolvedEditorSelector = selectorFor(editorEl, boxScope) || safeFallbackSelectorFor(editorEl);
      const resolvedSubmitSelector = submitEl ? (selectorFor(submitEl, submitScope) || safeFallbackSelectorFor(submitEl)) : '';
      const collapsedPlaceholderFallback = !resolvedSubmitSelector && visibleBoxPlaceholder
        ? (selectorFor(visibleBoxPlaceholder) || safeFallbackSelectorFor(visibleBoxPlaceholder))
        : '';
      if (collapsedPlaceholderFallback) {
        wix = {
          ...wix,
          hasCommentSection: true,
          loginRequired: false,
          hasGuestEditor: false,
          hasCommentCountOnly: false,
          triggerSelector: collapsedPlaceholderFallback,
        };
      } else {
        wix = {
          ...wix,
          hasCommentSection: true,
          loginRequired: false,
          hasGuestEditor: true,
          hasCommentCountOnly: false,
          editorSelector: resolvedEditorSelector,
          editorIsContentEditable: isContentEditableEl(editorEl) || editorEl.getAttribute('role') === 'textbox',
          ...(nameEl ? { nameSelector: selectorFor(nameEl, boxScope) || safeFallbackSelectorFor(nameEl) } : {}),
          ...(emailEl ? { emailSelector: selectorFor(emailEl, boxScope) || safeFallbackSelectorFor(emailEl) } : {}),
          ...(websiteEl ? { websiteSelector: selectorFor(websiteEl, boxScope) || safeFallbackSelectorFor(websiteEl) } : {}),
          ...(linkBtn ? { linkButtonSelector: selectorFor(linkBtn, linkBtnScope) || safeFallbackSelectorFor(linkBtn) } : {}),
          ...(resolvedSubmitSelector ? { submitSelector: resolvedSubmitSelector } : {}),
        };
      }
    } else if (triggerEl) {
      const resolvedTriggerSelector = selectorFor(triggerEl) || safeFallbackSelectorFor(triggerEl);
      wix = {
        ...wix,
        hasCommentSection: true,
        loginRequired: false,
        hasGuestEditor: false,
        hasCommentCountOnly: false,
        ...(resolvedTriggerSelector ? { triggerSelector: resolvedTriggerSelector } : {}),
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
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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
  const loginRegex = /\b(?:sign\s*up|log\s*in|sign\s*in|continue\s+with\s+google|sign\s+up\s+with\s+google|sign\s+in\s+with\s+google|already\s+a\s+member|faça\s+login|entrar\s+com\s+(?:o\s+)?google|iniciar\s+sesi[oó]n|se\s+connecter|anmelden|accedi|kirjaudu)\b|google\s*(?:으?로|\s*계정으로)?\s*(?:로그인|계속)|로그인|회원\s*가입|войти|ログイン|เข้าสู่ระบบ|ลงทะเบียน|登录|注册/i;
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

  const signupRecaptchaAlwaysRegex = /(?:\\{0,4}["']|&quot;)?signupRecaptchaOption(?:\\{0,4}["']|&quot;)?\s*:\s*(?:\\{0,4}["']|&quot;)ALWAYS(?:\\{0,4}["']|&quot;)/i;
  let signupRecaptchaAlways = false;
  for (const scriptEl of document.querySelectorAll('script')) {
    const scriptText = scriptEl.textContent || '';
    if (scriptText.length > 0 && /signupRecaptchaOption/i.test(scriptText) && signupRecaptchaAlwaysRegex.test(scriptText)) {
      signupRecaptchaAlways = true;
      break;
    }
  }
  if (!signupRecaptchaAlways && document.documentElement) {
    const fullHtml = document.documentElement.innerHTML || '';
    if (/signupRecaptchaOption/i.test(fullHtml) && signupRecaptchaAlwaysRegex.test(fullHtml)) {
      signupRecaptchaAlways = true;
    }
  }

  return {
    hasCaptcha,
    hasLoginDialog,
    ...(signupRecaptchaAlways ? { signupRecaptchaAlways: true } : {}),
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
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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
		"awaiting\\s+(?:moderation|approval)",
		"pending\\s+(?:approval|moderation|review)",
		"held\\s+for\\s+moderation",
		"submitted\\s+(?:for\\s+review|to\\s+the\\s+webmaster\\s+for\\s+approval)",
		"waiting\\s+for\\s+(?:moderation|approval)",
		"comment\\s+is\\s+under\\s+review",
		"will\\s+be\\s+(?:published|visible|shown)\\s+(?:once|after)\\s+(?:it\\s+is\\s+)?approved",
		"esperando\\s+(?:moderaci[oó]n|(?:a\\s+ser\\s+)?(?:moderado|aprobado))",
		"pendiente\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)",
		"(?:en|a\\s+la)\\s+espera\\s+de\\s+(?:moderaci[oó]n|aprobaci[oó]n)",
		"en\\s+attente\\s+de\\s+(?:mod[ée]ration|validation|approbation)",
		"attente\\s+de\\s+mod[ée]ration",
		"votre\\s+commentaire\\s+est\\s+en\\s+attente",
		"wartet\\s+auf\\s+(?:eine\\s+)?(?:freischaltung|freigabe|moderation|genehmigung|[üu]berpr[üu]fung)",
		"muss\\s+(?:noch\\s+)?(?:freigeschaltet|moderiert|gepr[üu]ft)(?:\\s+werden)?",
		"zur\\s+moderation\\s+zur[üu]ckgehalten",
		"(?:v[áa][šs]\\s+koment[áa][řr]\\s+)?[čc]ek[áa]\\s+na\\s+(?:schv[áa]len[íi]|moderov[áa]n[íi]|moderaci)",
		"[čc]ak[áa]\\s+na\\s+schv[áa]lenie",
		"in\\s+attesa\\s+di\\s+(?:moderazione|approvazione)",
		"aguardando\\s+(?:por\\s+)?(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
		"a\\s+aguardar\\s+modera[çc][ãa]o",
		"aguarda\\s+modera[çc][ãa]o",
		"esperando\\s+modera[çc][ãa]o",
		"pendente\\s+de\\s+(?:modera[çc][ãa]o|aprova[çc][ãa]o)",
		"(?:tw[óo]j\\s+komentarz\\s+)?oczekuje\\s+na\\s+(?:moderacj[ęe]|zatwierdzenie|akceptacj[ęe])",
		"(?:komentar\\s+anda\\s+)?(?:sedang\\s+)?menunggu\\s+(?:moderasi|persetujuan)",
		"wacht\\s+op\\s+(?:moderatie|goedkeuring)",
		"(?:yorumunuz\\s+)?onay\\s+bekliyor",
		"moderasyon\\s+bekliyor",
		"ожидает\\s+(?:проверки|модерации|одобрения|подтверждения)",
		"на\\s+(?:модерации|проверке)",
		"находится\\s+на\\s+модерации",
		"承認待ち",
		"審査中",
		"승인\\s*대기",
		"검토\\s*중",
		"[đd]ang\\s+ch[ờo]\\s+(?:duy[ệe]t|ki[ểe]m\\s+duy[ệe]t)",
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
	const ocSuccessEl = dom.document.querySelector(".alert-success, .alert.alert-success, #form-review .alert-success, #form-comment .alert-success, .post-comments .alert-success, .comment-form .alert-success, .comment-form .success");
	const openCartSuccessNotice = clean(ocSuccessEl ? ocSuccessEl.innerText || ocSuccessEl.textContent : "") || void 0;
	const ocErrorEl = dom.document.querySelector(".alert-danger, .alert.alert-danger, #form-review .alert-danger, #form-comment .alert-danger, .post-comments .alert-danger, .comment-form .alert-danger, .comment-form .warning, .comment-form .text-danger");
	const openCartErrorNotice = clean(ocErrorEl ? ocErrorEl.innerText || ocErrorEl.textContent : "") || void 0;
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
		const scopeContainers = Array.from(dom.document.querySelectorAll("#comments, .comment-list, .comments-area, .post-comments, wix-comments, [data-hook*=\"comment\"], [data-testid*=\"comment\"], main, article"));
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
		for (const link of candidateLinks) {
			const hit = matchesTargetLink(link);
			if (hit) {
				matchedHref = hit.href;
				matchedAnchor = hit.text;
				break;
			}
		}
		if (matchedHref === void 0) for (const anchor of dom.document.querySelectorAll("a[href]")) {
			if (seenLinks.has(anchor)) continue;
			if (anchor.closest("header, nav, footer, [role=\"banner\"], [role=\"navigation\"], [role=\"contentinfo\"]")) continue;
			const hit = matchesTargetLink(anchor);
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
		...errEl ? { hasWpDieDom: true } : {},
		...captchaDetected ? { captchaDetected: true } : {},
		...openCartSuccessNotice === void 0 ? {} : { openCartSuccessNotice },
		...openCartErrorNotice === void 0 ? {} : { openCartErrorNotice },
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
const THIRD_PARTY_COMMENT_FRAME_URL_PATTERN = /commentsplugin\.com|disqus\.com|giscus\.app|utteranc\.es|hyvor\.com|commentbox\.io|intensedebate|facebook\.com\/plugins\/comments|powr\.io|elfsight\.com|vuukle\.com|graphcomment\.com|cusdis\.com|remark42|twikoo|waline/iu;
const WIX_NATIVE_FRAME_URL_PATTERN = /(?:^|\.)(?:wix\.com|wixsite\.com|wixapps\.net|wixstatic\.com|parastorage\.com)(?:[:/]|$)|comments-ooi/iu;
const KNOWN_COMMENT_FRAME_URL_PATTERN = /commentsplugin\.com|disqus\.com|blogger\.com\/comment|blogspot\.com\/comment|jetpack\.wordpress\.com\/jetpack-comment|giscus\.app|utteranc\.es|hyvor\.com|commentbox\.io|intensedebate|facebook\.com\/plugins\/comments|comments-ooi|wixapps\.net\/.*comment|comment.*iframe/iu;
const NON_COMMENT_FRAME_URL_PATTERN = /^$|^about:blank$|^javascript:|doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net\/.*fbevents|video\.wixstatic\.com|youtube\.com(?:\/|$)|youtu\.be|vimeo\.com|trustpilot\.com|engage\.wixapps\.net|usrfiles\.com|filesusr\.com|google\.com\/maps|maps\.google\.com|calendly\.com|intercom\.io|tawk\.to|crisp\.chat|klaviyo\.com|spotify\.com\/embed|soundcloud\.com\/player/iu;
/**
* Determine whether a child iframe URL belongs to a third-party non-Wix comment widget
* (e.g. `commentsplugin.com`, `disqus.com`, etc.) rather than Wix-native/same-origin/Blogger/CAPTCHA frames.
*/
function isThirdPartyNonWixCommentFrameUrl(frameUrl, pageUrl) {
	const cleanUrl = frameUrl.trim();
	if (cleanUrl.length === 0) return false;
	if (CAPTCHA_FRAME_URL_PATTERN.test(cleanUrl)) return false;
	if (/blogger\.com\/comment|blogspot\.com\/comment/iu.test(cleanUrl)) return false;
	if (THIRD_PARTY_COMMENT_FRAME_URL_PATTERN.test(cleanUrl)) return true;
	if (NON_COMMENT_FRAME_URL_PATTERN.test(cleanUrl)) return false;
	if (WIX_NATIVE_FRAME_URL_PATTERN.test(cleanUrl)) return false;
	try {
		const parsed = new URL(cleanUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (pageUrl) {
			const pageHost = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./u, "");
			if (parsed.hostname.toLowerCase().replace(/^www\./u, "") === pageHost) return false;
		}
		return true;
	} catch {
		return false;
	}
}
const POST_SUBMIT_WAF_FINGERPRINT_PATTERN = /litespeed|cloudflare|attention\s+required!|just\s+a\s+moment|sucuri|wordfence|mod_?security|modsecurity|imperva|incapsula|akamai|barracuda|cloudfront|403\s+forbidden|access\s+denied|request\s+blocked|forbidden\s+you\s+don'?t\s+have\s+permission|not\s+acceptable|too\s+many\s+requests|blocked\s+by\s+(?:firewall|waf|security)/iu;
const REAL_WAF_VENDOR_PATTERN = /litespeed|cloudflare|cf-ray|cf-mitigated|attention\s+required!|just\s+a\s+moment|sucuri|wordfence|mod_?security|modsecurity|imperva|incapsula|akamai|barracuda|cloudfront|x-amz-cf/iu;
const WP_DIE_HTML_MARKER_PATTERN = /id\s*=\s*["']error-page["']|class\s*=\s*["'][^"']*wp-die-message/iu;
const WP_DIE_FORM_VALIDATION_PATTERN = /please\s+(?:add|select)\s+(?:a\s+)?rating|please\s+fill\s+(?:in\s+)?the\s+required\s+fields|error\s*:\s*please\s+(?:enter|fill|type|select|add)|please\s+enter\s+(?:a\s+)?(?:valid\s+)?(?:email|name|comment|rating)|please\s+type\s+(?:your\s+)?comment|please\s+complete\s+(?:all\s+)?required\s+fields|required\s+fields?\s+(?:are\s+)?missing|you\s+must\s+(?:rate|select\s+a\s+rating|agree|accept|check)/iu;
/** Detect whether an HTTP 403 response is a WordPress `wp_die` form-validation error (e.g. missing rating) rather than a WAF block. */
function isWpDieFormValidationError(text, rawHtml, hasWpDieDom) {
	const combined = `${text} ${rawHtml ?? ""}`;
	if (REAL_WAF_VENDOR_PATTERN.test(combined)) return false;
	if (WP_DIE_FORM_VALIDATION_PATTERN.test(combined)) return true;
	if (Boolean(hasWpDieDom || rawHtml && WP_DIE_HTML_MARKER_PATTERN.test(rawHtml)) && !/\b(?:403\s+forbidden|access\s+denied|request\s+blocked|blocked\s+by\s+(?:firewall|waf|security))\b/iu.test(combined)) return true;
	return false;
}
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
/** Detect HTTP 403 or 406/429 WAF-fingerprinted blocks returned after comment submission (distinguishing WP `wp_die` validation 403s). */
function detectPostSubmitWafBlock(input) {
	const combined = [
		Object.entries(input.responseHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join(" "),
		input.title ?? "",
		input.postSubmitSnippet ?? "",
		input.responseSnippet ?? ""
	].filter(Boolean).join(" ");
	const bestSnippet = (input.postSubmitSnippet?.trim() || input.responseSnippet?.trim() || input.title?.trim() || void 0)?.slice(0, 260);
	if (input.httpStatus === 403) {
		if (isWpDieFormValidationError(combined, input.rawResponseBody, input.hasWpDieDom)) return {
			blocked: false,
			httpStatus: 403,
			isWpDieValidation: true,
			...bestSnippet === void 0 ? {} : {
				wpDieMessage: bestSnippet,
				snippet: bestSnippet
			}
		};
		return {
			blocked: true,
			httpStatus: 403,
			provider: inferPostSubmitWafProvider(combined),
			...bestSnippet === void 0 ? {} : { snippet: bestSnippet }
		};
	}
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
async function isLocatorDisabled(locator, timeoutMs = 3e3) {
	const probe = locator;
	const shortTimeout = Math.max(1, Math.min(timeoutMs, 3e3));
	try {
		if (typeof probe.isDisabled === "function") {
			if (await probe.isDisabled({ timeout: shortTimeout })) return true;
		}
	} catch {}
	try {
		if (typeof probe.getAttribute === "function") {
			const ariaDisabled = await probe.getAttribute("aria-disabled", { timeout: shortTimeout });
			if (ariaDisabled !== null && ariaDisabled.toLowerCase() === "true") return true;
			if (await probe.getAttribute("disabled", { timeout: shortTimeout }) !== null) return true;
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
			}, void 0, { timeout: shortTimeout }) === true) return true;
		}
	} catch {}
	return false;
}
const INSPECT_DISABLED_SUBMIT_LOGIN_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
    return true;
  };
  const loginPromptRegex = /\b(?:must\s+be\s+logged\s+in|log\s*in\s+to\s+(?:comment|post|publish|reply)|sign\s*in\s+to\s+(?:comment|post|publish|reply)|please\s+(?:log\s*in|sign\s*in)|login\s+required|sign\s*up\s+to\s+comment)\b|请先登录|登录后(?:评论|发表)/i;
  const commentContentSel = ${JSON.stringify(WIX_COMMENT_CONTENT_SELECTOR)};
  const wixAuthHostRegex = new RegExp(${JSON.stringify(WIX_AUTH_HOST_PATTERN.source)}, 'i');
  const isInsideCommentContent = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      return Boolean((el.matches && el.matches(commentContentSel)) || (el.closest && el.closest(commentContentSel)));
    } catch {
      return false;
    }
  };
  const isAllowedLinkHref = (rawHref) => {
    const trimmed = clean(rawHref);
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return true;
    if (/^(?:mailto:|tel:|data:|blob:|sms:)/i.test(trimmed)) return false;
    try {
      const base = new URL(location.href);
      const parsed = new URL(trimmed, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const targetHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const pageHost = base.hostname.toLowerCase().replace(/^www\./, '');
      return targetHost === pageHost || wixAuthHostRegex.test(parsed.hostname);
    } catch {
      return false;
    }
  };
  const scopes = Array.from(document.querySelectorAll('#respond, #comments, .comments-area, [data-hook*="comment" i], wix-comments, [role="dialog"], form, main, article'))
    .filter(el => isVisible(el) && !isInsideCommentContent(el));
  const targets = scopes.length > 0 ? scopes : (document.body ? [document.body] : []);
  let matchedText = '';
  const loginButtons = [];
  const ssoProviders = [];
  for (const scope of targets) {
    const clone = scope.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const s of clone.querySelectorAll('script,style,noscript,' + commentContentSel)) s.remove();
    }
    const t = clean(clone ? (clone.innerText || clone.textContent) : (scope.innerText || scope.textContent));
    const m = loginPromptRegex.exec(t);
    if (m && !matchedText) matchedText = m[0];
    for (const btn of scope.querySelectorAll('button, a, [role="button"]')) {
      if (!isVisible(btn) || isInsideCommentContent(btn) || btn.closest('header, nav, footer, [role="navigation"]')) continue;
      if (btn.localName === 'a' && !isAllowedLinkHref(btn.getAttribute('href'))) continue;
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
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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
function isTimeoutError(error) {
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const msg = String(error instanceof Error ? error.message : error);
	if (/session is closed|has been closed|target closed/iu.test(msg)) return false;
	return /\btimeout\b|\btimed\s*out\b|timeout\s+\d+\s*ms\s+exceeded/iu.test(msg);
}
const ERROR_PAGE_URL_PATTERN = /^(?:chrome-error:|edge-error:|about:neterror|about:blank$)/iu;
function isBrowserErrorPageUrl(rawUrl) {
	const trimmed = rawUrl.trim();
	if (trimmed.length === 0) return true;
	return ERROR_PAGE_URL_PATTERN.test(trimmed);
}
/**
* Commit-first navigation for slow/weak-network Wix sites (`siteHint === 'wix_blog'`):
* enters as soon as response headers commit (20s timeout), waits best-effort for
* `domcontentloaded` / visible body content without failing when SSR DOM is already
* usable, and still throws cleanly on `commit` timeout, `chrome-error://`, or empty docs.
*/
async function navigateWixWithCommit(page, url, options) {
	const navTimeoutMs = Math.max(options.timeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS);
	const domReadyWaitMs = Math.min(options.domReadyWaitMs ?? 6e3, navTimeoutMs);
	const sleep = options.sleep ?? defaultSleep$1;
	throwIfAborted$2(options.signal);
	await page.goto(url, {
		timeout: navTimeoutMs,
		waitUntil: "commit"
	});
	throwIfAborted$2(options.signal);
	const afterCommitUrl = typeof page.url === "function" ? page.url() : "";
	if (isBrowserErrorPageUrl(afterCommitUrl)) throw new BrowserError(`navigation failed for ${url}: browser error page (${afterCommitUrl || "empty"})`, "BROWSER_ACTION_FAILED");
	let domLoadTimedOut = false;
	let domLoadError;
	if (typeof page.waitForLoadState === "function") try {
		await page.waitForLoadState("domcontentloaded", { timeout: domReadyWaitMs });
	} catch (error) {
		throwIfAborted$2(options.signal);
		domLoadTimedOut = true;
		domLoadError = error;
	}
	const postWaitUrl = typeof page.url === "function" ? page.url() : "";
	if (isBrowserErrorPageUrl(postWaitUrl)) throw new BrowserError(`navigation failed for ${url}: browser error page (${postWaitUrl || "empty"})`, "BROWSER_ACTION_FAILED");
	const checkDomReady = async () => {
		if (isBrowserErrorPageUrl(typeof page.url === "function" ? page.url() : "")) return {
			hasContent: false,
			emptyDocument: true,
			urlError: true
		};
		if (typeof page.evaluate !== "function") {
			if (typeof page.innerText === "function") {
				const hasTxt = (await page.innerText("body").catch(() => "")).trim().length > 0;
				return {
					hasContent: hasTxt,
					emptyDocument: !hasTxt,
					urlError: false
				};
			}
			return {
				hasContent: true,
				emptyDocument: false,
				urlError: false
			};
		}
		try {
			const probe = await page.evaluate(() => {
				const doc = globalThis.document;
				const body = doc?.body;
				const text = String(body?.innerText || body?.textContent || "").replace(/\s+/gu, " ").trim();
				const childCount = body?.children ? body.children.length : 0;
				const htmlLen = doc?.documentElement?.innerHTML ? doc.documentElement.innerHTML.length : 0;
				const titleLen = String(doc?.title ?? "").trim().length;
				return {
					textLength: text.length,
					childCount,
					htmlLen,
					titleLen
				};
			});
			return {
				hasContent: probe.textLength > 0 || probe.childCount > 0 || probe.htmlLen > 128,
				emptyDocument: probe.textLength === 0 && probe.childCount === 0 && probe.titleLen === 0 && probe.htmlLen < 32,
				urlError: false
			};
		} catch (error) {
			if (isNavigationContextError(error)) return {
				hasContent: false,
				emptyDocument: false,
				urlError: false
			};
			return {
				hasContent: false,
				emptyDocument: true,
				urlError: false
			};
		}
	};
	let health = await checkDomReady();
	if (health.urlError) throw new BrowserError(`navigation failed for ${url}: browser error page (${typeof page.url === "function" ? page.url() : "unknown"})`, "BROWSER_ACTION_FAILED");
	if (!health.hasContent && domReadyWaitMs > 0) {
		const pollCapMs = Math.min(2400, domReadyWaitMs);
		const pollDeadline = Date.now() + pollCapMs;
		const maxPolls = Math.max(1, Math.ceil(pollCapMs / 300));
		for (let poll = 0; poll < maxPolls && Date.now() < pollDeadline && !health.hasContent; poll++) {
			throwIfAborted$2(options.signal);
			const rem = pollDeadline - Date.now();
			if (rem <= 0) break;
			await sleep(Math.min(300, rem), options.signal);
			health = await checkDomReady();
			if (health.urlError) throw new BrowserError(`navigation failed for ${url}: browser error page (${typeof page.url === "function" ? page.url() : "unknown"})`, "BROWSER_ACTION_FAILED");
		}
	}
	if (health.emptyDocument || domLoadTimedOut && !health.hasContent) {
		const detail = domLoadError instanceof Error ? domLoadError.message : domLoadTimedOut ? "domcontentloaded timed out with empty document" : "empty document after commit";
		throw new BrowserError(`navigation timed out for ${url}: ${detail}`, "BROWSER_ACTION_FAILED", ...domLoadError === void 0 ? [] : [{ cause: domLoadError }]);
	}
}
async function scrollWpCommentFormIntoView(page, timeoutMs) {
	if (typeof page.locator !== "function") return;
	const targetSelector = "form#commentform, textarea#comment, textarea[name=\"comment\"], form[action*=\"wp-comments-post.php\"]";
	try {
		const probeLoc = await resolveFirstVisibleLocator(page, targetSelector);
		if ((typeof probeLoc.isVisible === "function" ? await probeLoc.isVisible().catch(() => false) : true) && typeof probeLoc.scrollIntoViewIfNeeded === "function") await probeLoc.scrollIntoViewIfNeeded({ timeout: Math.min(2e3, timeoutMs) }).catch(() => void 0);
	} catch {}
}
/**
* Commit-first navigation for non-Wix `comment_publish` (WordPress / Valine / Typecho / custom blogs):
* - Navigates with `waitUntil: 'commit'` (default 15s, respecting higher caller timeoutMs).
* - Fast early-exit for normal complete pages, no-form pages, and pages where `#commentform` /
*   `textarea#comment` / `textarea[name="comment"]` is already mounted (scrolls it into view immediately
*   without waiting for unrelated footer scripts).
* - Dynamically relaxes the form-readiness polling ceiling up to 15,000ms (polling every ~450ms) when
*   streaming (`document.readyState === 'loading'` with DOM growth or WP markers) or high-comment WordPress
*   large-page signals (`wp-content` / `wp-includes` / `.comment-list` / `.commentlist` / >30 `[id^="comment-"]`)
*   are detected before `#commentform` / `#comment` mounts.
*/
async function navigateCommentPageWithCommit(page, url, options) {
	const navTimeoutMs = Math.max(options.timeoutMs, DEFAULT_COMMENT_NAV_TIMEOUT_MS);
	const domReadyWaitMs = Math.min(options.domReadyWaitMs ?? 7e3, navTimeoutMs);
	const largeWpCeiling = Math.max(navTimeoutMs, DEFAULT_LARGE_WP_FORM_WAIT_MAX_MS);
	const largeWpWaitMs = Math.max(domReadyWaitMs, Math.min(options.largeWpFormWaitMaxMs ?? 15e3, largeWpCeiling));
	const sleep = options.sleep ?? defaultSleep$1;
	throwIfAborted$2(options.signal);
	await page.goto(url, {
		timeout: navTimeoutMs,
		waitUntil: "commit"
	});
	throwIfAborted$2(options.signal);
	const afterCommitUrl = typeof page.url === "function" ? page.url() : "";
	if (isBrowserErrorPageUrl(afterCommitUrl)) throw new BrowserError(`navigation failed for ${url}: browser error page (${afterCommitUrl || "empty"})`, "BROWSER_ACTION_FAILED");
	const probeReady = async () => {
		if (isBrowserErrorPageUrl(typeof page.url === "function" ? page.url() : "")) return {
			ready: false,
			hasDirectWpForm: false,
			hasContent: false,
			emptyDocument: true,
			urlError: true,
			isLoading: false,
			hasWpLargePageSignals: false,
			commentItemCount: 0,
			hasCommentsClosedBanner: false,
			textLen: 0,
			nodeCount: 0
		};
		if (typeof page.evaluate !== "function") return {
			ready: true,
			hasDirectWpForm: false,
			hasContent: true,
			emptyDocument: false,
			urlError: false,
			isLoading: false,
			hasWpLargePageSignals: false,
			commentItemCount: 0,
			hasCommentsClosedBanner: false,
			textLen: 1,
			nodeCount: 1
		};
		try {
			const probe = await page.evaluate((commentNodeThreshold) => {
				const doc = globalThis.document;
				const hasDirectWpForm = Boolean(doc?.querySelector?.("form#commentform, form[action*=\"wp-comments-post.php\"], textarea#comment, textarea[name=\"comment\"]"));
				const hasOtherTerminalDom = Boolean(doc?.querySelector?.("textarea.veditor, textarea[name=\"text\"], .verbum-comments [contenteditable=\"true\"], .jetpack-comments [contenteditable=\"true\"], iframe[src*=\"blogger.com/comment\"], iframe[src*=\"blogspot.com/comment\"], #error-page, .wp-die-message"));
				const isLoading = String(doc?.readyState ?? "complete") === "loading";
				const body = doc?.body;
				const childCount = body?.children ? body.children.length : 0;
				const nodeCount = doc?.getElementsByTagName ? doc.getElementsByTagName("*").length : childCount;
				const textLen = (nodeCount > 800 ? String(body?.textContent ?? "") : String(body?.innerText || body?.textContent || "")).trim().length;
				const titleLen = String(doc?.title ?? "").trim().length;
				const htmlLen = textLen === 0 && childCount === 0 ? doc?.documentElement?.innerHTML ? doc.documentElement.innerHTML.length : 0 : 256;
				const commentItemCount = doc?.querySelectorAll ? doc.querySelectorAll("[id^=\"comment-\"]").length : 0;
				const hasWpLargePageSignals = Boolean(doc?.querySelector?.("link[href*=\"wp-content\"], script[src*=\"wp-content\"], link[href*=\"wp-includes\"], script[src*=\"wp-includes\"], .comment-list, .commentlist, meta[name=\"generator\"][content*=\"WordPress\" i]")) || /wp-content|wp-includes/iu.test(String(doc?.head?.innerHTML ?? "").slice(0, 16384)) || commentItemCount > commentNodeThreshold;
				let hasCommentsClosedBanner = false;
				if (!hasDirectWpForm && !isLoading && commentItemCount > commentNodeThreshold && doc?.querySelectorAll) {
					const closedRegex = /\bcomments\s+are\s+closed\b|\bcommenting\s+(?:is|has\s+been)\s+closed\b|\bcomments\s+(?:have\s+been\s+)?disabled\b|评论已关闭|评论功能已关闭|已关闭评论/iu;
					const closedNodes = doc.querySelectorAll(".nocomments, #respond, .comments-area .no-comments");
					for (let i = 0; i < closedNodes.length; i++) {
						const node = closedNodes[i];
						const t = String(node?.innerText || node?.textContent || "");
						if (closedRegex.test(t)) {
							hasCommentsClosedBanner = true;
							break;
						}
					}
				}
				return {
					hasDirectWpForm,
					hasOtherTerminalDom,
					isLoading,
					textLen,
					childCount,
					nodeCount,
					htmlLen,
					titleLen,
					commentItemCount,
					hasWpLargePageSignals,
					hasCommentsClosedBanner
				};
			}, LARGE_WP_COMMENT_NODE_THRESHOLD);
			const hasContent = probe.textLen > 0 || probe.childCount > 0 || probe.htmlLen > 128;
			const emptyDocument = probe.textLen === 0 && probe.childCount === 0 && probe.titleLen === 0 && probe.htmlLen < 32;
			const highCommentPending = probe.commentItemCount > LARGE_WP_COMMENT_NODE_THRESHOLD && !probe.hasCommentsClosedBanner;
			return {
				ready: probe.hasDirectWpForm || probe.hasOtherTerminalDom || hasContent && !probe.isLoading && !highCommentPending,
				hasDirectWpForm: probe.hasDirectWpForm,
				hasContent,
				emptyDocument,
				urlError: false,
				isLoading: probe.isLoading,
				hasWpLargePageSignals: probe.hasWpLargePageSignals,
				commentItemCount: probe.commentItemCount,
				hasCommentsClosedBanner: probe.hasCommentsClosedBanner,
				textLen: probe.textLen,
				nodeCount: probe.nodeCount
			};
		} catch (error) {
			if (isNavigationContextError(error)) return {
				ready: false,
				hasDirectWpForm: false,
				hasContent: false,
				emptyDocument: false,
				urlError: false,
				isLoading: true,
				hasWpLargePageSignals: false,
				commentItemCount: 0,
				hasCommentsClosedBanner: false,
				textLen: 0,
				nodeCount: 0
			};
			return {
				ready: false,
				hasDirectWpForm: false,
				hasContent: false,
				emptyDocument: true,
				urlError: false,
				isLoading: false,
				hasWpLargePageSignals: false,
				commentItemCount: 0,
				hasCommentsClosedBanner: false,
				textLen: 0,
				nodeCount: 0
			};
		}
	};
	let health = await probeReady();
	if (health.urlError) throw new BrowserError(`navigation failed for ${url}: browser error page (${typeof page.url === "function" ? page.url() : "unknown"})`, "BROWSER_ACTION_FAILED");
	if (!health.ready && domReadyWaitMs > 0) {
		const startAt = Date.now();
		let usingExtendedWait = Boolean(!health.hasDirectWpForm && (health.isLoading && health.hasWpLargePageSignals || health.commentItemCount > LARGE_WP_COMMENT_NODE_THRESHOLD && !health.hasCommentsClosedBanner));
		let activeWaitMs = usingExtendedWait ? largeWpWaitMs : domReadyWaitMs;
		let deadline = startAt + activeWaitMs;
		let maxPolls = Math.max(1, Math.ceil(activeWaitMs / NON_WIX_POLL_INTERVAL_MS));
		let prevTextLen = health.textLen;
		let prevNodeCount = health.nodeCount;
		let prevCommentCount = health.commentItemCount;
		for (let poll = 0; poll < maxPolls && Date.now() < deadline && !health.ready; poll++) {
			throwIfAborted$2(options.signal);
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(NON_WIX_POLL_INTERVAL_MS, remaining), options.signal);
			health = await probeReady();
			if (health.urlError) throw new BrowserError(`navigation failed for ${url}: browser error page (${typeof page.url === "function" ? page.url() : "unknown"})`, "BROWSER_ACTION_FAILED");
			if (health.ready) break;
			const domGrew = health.textLen > prevTextLen || health.nodeCount > prevNodeCount || health.commentItemCount > prevCommentCount;
			prevTextLen = Math.max(prevTextLen, health.textLen);
			prevNodeCount = Math.max(prevNodeCount, health.nodeCount);
			prevCommentCount = Math.max(prevCommentCount, health.commentItemCount);
			if (Boolean(!usingExtendedWait && !health.hasDirectWpForm && (health.isLoading && (domGrew || health.hasWpLargePageSignals) || health.commentItemCount > LARGE_WP_COMMENT_NODE_THRESHOLD && !health.hasCommentsClosedBanner))) {
				usingExtendedWait = true;
				activeWaitMs = largeWpWaitMs;
				deadline = startAt + activeWaitMs;
				maxPolls = Math.max(1, Math.ceil(activeWaitMs / NON_WIX_POLL_INTERVAL_MS));
			}
		}
	}
	if (health.hasDirectWpForm) {
		await scrollWpCommentFormIntoView(page, navTimeoutMs);
		return;
	}
	if (health.emptyDocument && !health.hasContent) throw new BrowserError(`navigation timed out for ${url}: empty document after commit`, "BROWSER_ACTION_FAILED");
}
/** Collect max existing numeric `#comment-<ID>` currently present in the DOM before WordPress comment submit. */
async function collectMaxExistingCommentId(page) {
	if (typeof page.evaluate !== "function") return 0;
	return await page.evaluate(() => {
		const dom = globalThis;
		let maxId = 0;
		const consider = (raw) => {
			if (!raw) return;
			const m = /(?:^|#)comment-(\d+)\b/iu.exec(raw.trim());
			if (!m?.[1]) return;
			const n = Number(m[1]);
			if (Number.isSafeInteger(n) && n > maxId) maxId = n;
		};
		for (const el of dom.document.querySelectorAll("[id^=\"comment-\"]")) consider(el.getAttribute("id"));
		for (const a of dom.document.querySelectorAll("a[href*=\"#comment-\"]")) consider(a.getAttribute("href"));
		return maxId;
	}).catch(() => 0);
}
/**
* Resolve a strict-mode-safe single locator, picking the first visible non-CAPTCHA-response
* element when a selector matches multiple nodes (e.g. dual Wix buttons or hidden modals).
*/
async function resolveFirstVisibleLocator(page, selector) {
	const base = page.locator(selector);
	const probe = base;
	if (typeof probe.count === "function" && typeof probe.nth === "function") {
		const total = await probe.count().catch(() => 0);
		if (total > 1) {
			const limit = Math.min(total, 15);
			for (let i = 0; i < limit; i++) {
				const candidate = probe.nth(i);
				const nameAttr = typeof candidate.getAttribute === "function" ? (await candidate.getAttribute("name").catch(() => null))?.toLowerCase() ?? "" : "";
				if (nameAttr === "g-recaptcha-response" || nameAttr === "h-captcha-response" || nameAttr === "cf-turnstile-response") continue;
				if (typeof candidate.isVisible === "function" ? await candidate.isVisible().catch(() => false) : false) return candidate;
			}
		}
	}
	return base.first();
}
async function scrollPageStep(page, fraction, scrollToBottom = false) {
	if (scrollToBottom) return await page.evaluate((stepFraction) => {
		const dom = globalThis;
		const getDocHeight = () => Math.max(dom.document.documentElement?.scrollHeight ?? 0, dom.document.body?.scrollHeight ?? 0);
		const viewportH = dom.window.innerHeight ?? 0;
		const currentY = dom.window.scrollY ?? dom.document.documentElement?.scrollTop ?? 0;
		const beforeHeight = getDocHeight();
		const wasAlreadyAtBottom = beforeHeight > viewportH && viewportH > 0 && currentY + viewportH >= beforeHeight - 24;
		const placeholder = dom.document.querySelector("[data-hook=\"comments-section-placeholder\"], [data-hook=\"comment-box-placeholder\"], [data-hook*=\"comment-box\"], [data-hook=\"comments-section\"], wix-comments");
		const anchor = dom.document.querySelector("#comments, #respond, form#commentform, [data-hook=\"top-level-comment-list\"], iframe[src*=\"blogger.com/comment\"]");
		if (placeholder && typeof placeholder.scrollIntoView === "function") placeholder.scrollIntoView({
			behavior: "instant",
			block: "center"
		});
		else if (stepFraction >= .65 && anchor && typeof anchor.scrollIntoView === "function") anchor.scrollIntoView({
			behavior: "instant",
			block: "center"
		});
		const docHeight = getDocHeight();
		if (typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, docHeight);
		if (dom.document.scrollingElement) try {
			dom.document.scrollingElement.scrollTop = docHeight;
		} catch {}
		if (wasAlreadyAtBottom && placeholder && typeof placeholder.getBoundingClientRect === "function" && typeof placeholder.scrollIntoView === "function") {
			const rect = placeholder.getBoundingClientRect();
			if (rect && rect.bottom < 0) placeholder.scrollIntoView({
				behavior: "instant",
				block: "center"
			});
		}
		if (typeof dom.Event === "function" && typeof dom.window.dispatchEvent === "function") try {
			dom.window.dispatchEvent(new dom.Event("scroll"));
		} catch {}
		return getDocHeight();
	}, fraction).catch(() => 0);
	return await page.evaluate((stepFraction) => {
		const dom = globalThis;
		const docHeight = Math.max(dom.document.documentElement?.scrollHeight ?? 0, dom.document.body?.scrollHeight ?? 0);
		const placeholder = dom.document.querySelector("[data-hook=\"comments-section-placeholder\"], [data-hook=\"comment-box-placeholder\"], [data-hook*=\"comment-box\"], [data-hook=\"comments-section\"], wix-comments");
		if (placeholder && typeof placeholder.scrollIntoView === "function") {
			placeholder.scrollIntoView({
				behavior: "instant",
				block: "center"
			});
			if (stepFraction >= 1 && typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, docHeight);
		} else if (stepFraction >= .65) {
			const anchor = dom.document.querySelector("#comments, #respond, form#commentform, [data-hook=\"top-level-comment-list\"], iframe[src*=\"blogger.com/comment\"]");
			if (anchor && typeof anchor.scrollIntoView === "function") {
				anchor.scrollIntoView({
					behavior: "instant",
					block: "center"
				});
				if (stepFraction >= 1 && typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, docHeight);
			} else if (typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
		} else if (typeof dom.window.scrollTo === "function") dom.window.scrollTo(0, Math.round(docHeight * stepFraction));
		if (typeof dom.Event === "function" && typeof dom.window.dispatchEvent === "function") try {
			dom.window.dispatchEvent(new dom.Event("scroll"));
		} catch {}
		return docHeight;
	}, fraction).catch(() => 0);
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
		hasThirdPartyCommentFrame: false,
		hasNonThirdPartyCommentFrame: false,
		hasUnknownInteractiveFrame: false,
		captchaDetected: false,
		directCaptchaFrameDetected: false
	};
	const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : void 0;
	const mainFrameUrl = (typeof mainFrame?.url === "function" ? mainFrame.url() : "") || (typeof page.url === "function" ? page.url() : "");
	const frameSummaries = [];
	let hasActionableCommentFrame = false;
	let hasThirdPartyCommentFrame = false;
	let hasNonThirdPartyCommentFrame = false;
	let hasUnknownInteractiveFrame = false;
	let captchaDetected = false;
	let directCaptchaFrameDetected = false;
	let commentsClosedPhrase;
	let nonThirdPartyCommentsClosedPhrase;
	let bloggerFrameUrl;
	let inspectedCount = 0;
	for (const frame of page.frames()) {
		if (frame === mainFrame) continue;
		if (typeof frame.isDetached === "function" && frame.isDetached()) continue;
		const frameUrl = typeof frame.url === "function" ? frame.url() : "";
		const parentFrame = typeof frame.parentFrame === "function" ? frame.parentFrame() : null;
		const parentFrameUrl = parentFrame && parentFrame !== mainFrame && typeof parentFrame.url === "function" ? parentFrame.url() : "";
		if (CAPTCHA_FRAME_URL_PATTERN.test(frameUrl)) {
			captchaDetected = true;
			if (!Boolean(parentFrameUrl && isThirdPartyNonWixCommentFrameUrl(parentFrameUrl, mainFrameUrl))) directCaptchaFrameDetected = true;
			frameSummaries.push(`${frameUrl.slice(0, 90)} [captcha]`);
			continue;
		}
		const frameName = typeof frame.name === "function" ? frame.name() : "";
		const isBloggerFrame = /blogger\.com\/comment|blogspot\.com\/comment/iu.test(frameUrl) || /^comment-editor$/iu.test(frameName);
		const knownComment = KNOWN_COMMENT_FRAME_URL_PATTERN.test(frameUrl) || isBloggerFrame;
		if (!knownComment && NON_COMMENT_FRAME_URL_PATTERN.test(frameUrl)) continue;
		const isThirdPartyComment = !isBloggerFrame && isThirdPartyNonWixCommentFrameUrl(frameUrl, mainFrameUrl);
		if (isBloggerFrame) bloggerFrameUrl ??= frameUrl || "comment-editor";
		if (knownComment) {
			hasActionableCommentFrame = true;
			if (isThirdPartyComment) hasThirdPartyCommentFrame = true;
			else hasNonThirdPartyCommentFrame = true;
		}
		let detail = null;
		if (inspectedCount < 6 && typeof frame.evaluate === "function") {
			inspectedCount++;
			detail = await evaluateFrameWithTimeout(frame, FRAME_INSPECT_TIMEOUT_MS);
		}
		const tags = [];
		if (detail?.captchaDetected) {
			captchaDetected = true;
			if (!isThirdPartyComment) directCaptchaFrameDetected = true;
			tags.push("captcha");
		}
		if (detail?.commentsClosedPhrase) {
			commentsClosedPhrase ??= detail.commentsClosedPhrase;
			if (!isThirdPartyComment) nonThirdPartyCommentsClosedPhrase ??= detail.commentsClosedPhrase;
			tags.push("closed");
		}
		if (detail?.hasEditor) {
			hasActionableCommentFrame = true;
			if (isThirdPartyComment) hasThirdPartyCommentFrame = true;
			else hasNonThirdPartyCommentFrame = true;
			tags.push("editor");
		}
		if (detail?.hasTrigger) {
			hasActionableCommentFrame = true;
			if (isThirdPartyComment) hasThirdPartyCommentFrame = true;
			else hasNonThirdPartyCommentFrame = true;
			tags.push("trigger");
		}
		if (detail?.loginRequired) {
			hasActionableCommentFrame = true;
			if (isThirdPartyComment) hasThirdPartyCommentFrame = true;
			else hasNonThirdPartyCommentFrame = true;
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
		hasThirdPartyCommentFrame,
		hasNonThirdPartyCommentFrame,
		hasUnknownInteractiveFrame,
		captchaDetected,
		directCaptchaFrameDetected,
		...commentsClosedPhrase === void 0 ? {} : { commentsClosedPhrase },
		...nonThirdPartyCommentsClosedPhrase === void 0 ? {} : { nonThirdPartyCommentsClosedPhrase },
		...bloggerFrameUrl === void 0 ? {} : { bloggerFrameUrl }
	};
}
function hasEffectiveWixChildFrameCaptcha(inspection, frames) {
	if (!frames) return false;
	if (inspection.isWix && inspection.wix.hasNativeWixCommentContainer) return Boolean(frames.directCaptchaFrameDetected);
	return frames.captchaDetected;
}
function hasActionableCommentSurface(inspection) {
	const hasNativeWixSurface = inspection.wix.captchaDetected || inspection.wix.loginRequired || inspection.wix.hasGuestEditor || Boolean(inspection.wix.triggerSelector);
	const deferThirdPartyFrameToNativeWix = Boolean(inspection.isWix && inspection.wix.hasNativeWixCommentContainer && !hasNativeWixSurface && !inspection.childFrames?.hasNonThirdPartyCommentFrame && !inspection.childFrames?.bloggerFrameUrl);
	const effectiveChildCaptcha = hasEffectiveWixChildFrameCaptcha(inspection, inspection.childFrames);
	return inspection.wordpress.found || Boolean(inspection.wordpress.reviewsTabSelector) || Boolean(inspection.wordpress.collapsedTriggerSelector) || Boolean(inspection.genericComment?.found) || inspection.commentsClosed.matched || hasNativeWixSurface || Boolean(inspection.hasBloggerCommentIframe) || Boolean(inspection.childFrames?.bloggerFrameUrl) || effectiveChildCaptcha || !deferThirdPartyFrameToNativeWix && Boolean(inspection.childFrames?.hasActionableCommentFrame);
}
async function inspectCommentPageWithFrames(page) {
	const base = await page.evaluate(INSPECT_COMMENT_PAGE_SCRIPT);
	const childFrames = await inspectChildFrames(page);
	if (!(childFrames.frames.length > 0 || childFrames.captchaDetected || childFrames.hasActionableCommentFrame || childFrames.hasUnknownInteractiveFrame || childFrames.commentsClosedPhrase !== void 0 || childFrames.bloggerFrameUrl !== void 0)) return base;
	const extraFramesLine = childFrames.frames.length > 0 ? `[child-frames] ${childFrames.frames.slice(0, 4).join(" ; ")}` : "";
	const combinedBottom = [base.bottomSnapshot, extraFramesLine].filter((part) => Boolean(part && part.length > 0)).join("\n").slice(0, BOTTOM_SNAPSHOT_MAX_CHARS);
	const prioritizeNativeWix = base.isWix && Boolean(base.wix.hasNativeWixCommentContainer);
	const effectiveClosedPhrase = prioritizeNativeWix ? childFrames.nonThirdPartyCommentsClosedPhrase : childFrames.commentsClosedPhrase;
	const effectiveChildCaptcha = prioritizeNativeWix ? Boolean(childFrames.directCaptchaFrameDetected) : childFrames.captchaDetected;
	return {
		...base,
		commentsClosed: base.commentsClosed.matched || !effectiveClosedPhrase ? base.commentsClosed : {
			matched: true,
			phrase: effectiveClosedPhrase
		},
		wix: {
			...base.wix,
			captchaDetected: base.wix.captchaDetected || base.isWix && effectiveChildCaptcha
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
/**
* Steady-state inspection wrapper: when an opening page triggers a JS redirect or
* browser check causing `Execution context was destroyed` / `Cannot find context with specified id`,
* waits 2000ms and retries 1 time cleanly instead of throwing immediately.
*/
async function safeInspectCommentPageWithFrames(page, options) {
	try {
		return await inspectCommentPageWithFrames(page);
	} catch (error) {
		if (!isNavigationContextError(error)) throw error;
		throwIfAborted$2(options.signal);
		const retryWaitMs = options.contextRetryDelayMs ?? 2e3;
		await options.sleep(retryWaitMs, options.signal);
		if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: Math.min(3e3, options.timeoutMs) }).catch(() => void 0);
		return await inspectCommentPageWithFrames(page);
	}
}
const INSPECT_WIX_SSO_DIALOG_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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

  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const hasCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile, textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]'
  );
  const signupRecaptchaAlwaysRegex = /(?:\\{0,4}["']|&quot;)?signupRecaptchaOption(?:\\{0,4}["']|&quot;)?\s*:\s*(?:\\{0,4}["']|&quot;)ALWAYS(?:\\{0,4}["']|&quot;)/i;
  let signupRecaptchaAlways = false;
  for (const scriptEl of document.querySelectorAll('script')) {
    const t = scriptEl.textContent || '';
    if (t.length > 0 && /signupRecaptchaOption/i.test(t) && signupRecaptchaAlwaysRegex.test(t)) {
      signupRecaptchaAlways = true;
      break;
    }
  }
  if (!signupRecaptchaAlways && document.documentElement) {
    const html = document.documentElement.innerHTML || '';
    if (/signupRecaptchaOption/i.test(html) && signupRecaptchaAlwaysRegex.test(html)) {
      signupRecaptchaAlways = true;
    }
  }

  const techRegex = /looks\s+like\s+there\s+was\s+a\s+technical\s+issue|there\s+was\s+a\s+technical\s+issue|something\s+went\s+wrong[\s\S]{0,80}try\s+again\s+later/i;
  const techMatch = techRegex.exec(bodyText);

  const wixCommentContentSelector = ${JSON.stringify(WIX_COMMENT_CONTENT_SELECTOR)};
  const wixAuthHostRegex = new RegExp(${JSON.stringify(WIX_AUTH_HOST_PATTERN.source)}, 'i');
  const isInsideWixCommentContent = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      return Boolean((el.matches && el.matches(wixCommentContentSelector)) || (el.closest && el.closest(wixCommentContentSelector)));
    } catch {
      return false;
    }
  };
  const isAllowedWixLoginHref = (rawHref) => {
    const trimmed = clean(rawHref);
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return true;
    if (/^(?:mailto:|tel:|data:|blob:|sms:)/i.test(trimmed)) return false;
    try {
      const base = new URL(location.href);
      const parsed = new URL(trimmed, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const targetHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const pageHost = base.hostname.toLowerCase().replace(/^www\./, '');
      if (targetHost === pageHost) return true;
      return wixAuthHostRegex.test(parsed.hostname);
    } catch {
      return false;
    }
  };
  const isAllowedWixLoginTriggerEl = (el) => {
    if (!el || !isVisible(el) || isInsideWixCommentContent(el)) return false;
    if (el.localName === 'a') {
      const rawHref = clean(el.getAttribute('href'));
      if (!isAllowedWixLoginHref(rawHref)) return false;
      const hookSig = clean(el.getAttribute('data-hook')) + ' ' + clean(el.getAttribute('data-testid'));
      const isAuthHook = /login|signup|sign-up|sign-in/i.test(hookSig);
      const isRoleBtn = el.getAttribute('role') === 'button';
      const inAuthDialog = Boolean(el.closest && el.closest('[id^="SM_ROOT_COMP"], [role="dialog"], [aria-modal="true"]'));
      if (isAuthHook || isRoleBtn || inAuthDialog || !rawHref || rawHref === '#' || rawHref.startsWith('#') || /^javascript:/i.test(rawHref)) {
        return true;
      }
      try {
        const parsed = new URL(rawHref, location.href);
        if (wixAuthHostRegex.test(parsed.hostname)) return true;
        return /(?:login|log-in|signin|sign-in|signup|sign-up|auth|account|member|oauth|sso|session)/i.test(parsed.pathname + parsed.search + parsed.hash);
      } catch {
        return false;
      }
    }
    return true;
  };

  const googleBtnRegex = new RegExp(${JSON.stringify(WIX_GOOGLE_SSO_BUTTON_PATTERN.source)}, 'i');
  const dialogScopes = Array.from(document.querySelectorAll('[id^="SM_ROOT_COMP"], [role="dialog"], [aria-modal="true"]')).filter(isVisible);
  const searchScopes = dialogScopes.length > 0
    ? dialogScopes
    : Array.from(document.querySelectorAll('[data-hook*="comment" i], wix-comments, main, article')).filter(el => isVisible(el) && !isInsideWixCommentContent(el));
  const effectiveScopes = searchScopes.length > 0 ? searchScopes : (document.body ? [document.body] : []);

  let googleBtn = null;
  for (const scope of effectiveScopes) {
    const isInAuthDialog = dialogScopes.includes(scope);
    googleBtn = Array.from(scope.querySelectorAll('button, a, [role="button"], [data-testid*="google" i], [data-hook*="google" i]')).find(el => {
      if (!isAllowedWixLoginTriggerEl(el)) return false;
      const visibleLabel = clean((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
      const lbl = clean(
        visibleLabel + ' '
        + (el.getAttribute('data-testid') || '') + ' '
        + (el.getAttribute('data-hook') || '')
      );
      if (googleBtnRegex.test(lbl) || /(?:google[-_]?sso|google[-_]?login|google[-_]?sign|socialAuth.*google|googleAuth)/i.test(lbl)) {
        return true;
      }
      return isInAuthDialog && /^google$/i.test(visibleLabel);
    });
    if (googleBtn) break;
  }

  const loginTriggerRegex = new RegExp(${JSON.stringify(WIX_LOGIN_TRIGGER_BUTTON_PATTERN.source)}, 'i');
  const isNavElement = el => Boolean(el.closest && el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]'));
  const loginTrigger =
    Array.from(document.querySelectorAll('[data-hook="login-as-member-text-button"], [data-hook*="login" i], [data-testid="switchToLogin"], [data-testid*="login-button" i]'))
      .find(el => isAllowedWixLoginTriggerEl(el) && el !== googleBtn && !isNavElement(el))
    || Array.from(document.querySelectorAll('[data-hook*="comment" i] button, [data-hook*="comment" i] a, [data-hook*="comment" i] [role="button"], [data-testid*="comment" i] button, [data-testid*="comment" i] a, [data-testid*="comment" i] [role="button"], wix-comments button, wix-comments a, wix-comments [role="button"], #comments button, #comments a, #comments [role="button"], [id^="SM_ROOT_COMP"] button, [id^="SM_ROOT_COMP"] a, [role="dialog"] button, [role="dialog"] a'))
      .find(el => {
        if (!isAllowedWixLoginTriggerEl(el) || el === googleBtn || isNavElement(el)) return false;
        const lbl = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        return loginTriggerRegex.test(lbl);
      })
    || Array.from(document.querySelectorAll('main button, main a, main [role="button"], article button, article a, article [role="button"]'))
      .find(el => {
        if (!isAllowedWixLoginTriggerEl(el) || el === googleBtn || isNavElement(el)) return false;
        const lbl = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        return loginTriggerRegex.test(lbl);
      });

  return {
    hasCaptcha,
    signupRecaptchaAlways,
    hasTechnicalIssue: !!techMatch,
    ...(techMatch ? { technicalIssueText: techMatch[0].slice(0, 180) } : {}),
    ...(loginTrigger ? { loginTriggerSelector: selectorFor(loginTrigger) } : {}),
    ...(googleBtn ? { googleButtonSelector: selectorFor(googleBtn) } : {}),
  };
})()`;
const INSPECT_GOOGLE_OAUTH_POPUP_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
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
    const dataId = el.getAttribute('data-identifier');
    if (dataId) {
      const byDataId = '[data-identifier="' + dataId.replace(/"/g, '\\"') + '"]';
      if (unique(el, byDataId)) return byDataId;
    }
    const dataEmail = el.getAttribute('data-email');
    if (dataEmail) {
      const byEmail = '[data-email="' + dataEmail.replace(/"/g, '\\"') + '"]';
      if (unique(el, byEmail)) return byEmail;
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

  const url = location.href || '';
  const bodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const hasCaptcha = !!document.querySelector(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile'
  );
  const techRegex = /looks\s+like\s+there\s+was\s+a\s+technical\s+issue|there\s+was\s+a\s+technical\s+issue/i;
  const techMatch = techRegex.exec(bodyText);

  const visiblePassword = Array.from(document.querySelectorAll('input[type="password"], input[name="Passwd"], input[name="password"]')).some(isVisible);
  const visibleMfaInput = Array.from(document.querySelectorAll('input[name="totpPin"], input[name="idvPin"], input[type="tel"][name*="phone" i], input[autocomplete="one-time-code"]')).some(isVisible);
  const isChallengeUrl = /\/(?:challenge\/(?:pwd|totp|dp|ipp|sk|bc|selection)|signin\/v2\/challenge)/i.test(url);
  const mfaTextMatch = /\b(?:2-step\s+verification|verify\s+it'?s\s+you|confirm\s+it'?s\s+you|enter\s+your\s+password|enter\s+the\s+code|security\s+key|authenticator\s+app)\b|输入密码|两步验证|验证您的身份|确认是您本人/i.exec(bodyText);
  const hasPasswordOrMfa = visiblePassword || visibleMfaInput || isChallengeUrl || !!mfaTextMatch;
  const mfaReason = visiblePassword
    ? 'password_input'
    : visibleMfaInput
      ? 'mfa_code_input'
      : isChallengeUrl
        ? 'challenge_url'
        : (mfaTextMatch ? mfaTextMatch[0] : undefined);

  const isAccountChooser = /accounts\.google\.com\/.*(?:accountchooser|selectaccount|o\/oauth2)/i.test(url)
    || !!document.querySelector('[data-identifier], [data-email]');
  const anotherAccountRegex = /use\s+another\s+account|add\s+account|使用其他账号|使用其他帐户|別のアカウント/i;
  let accountChoiceEl = null;
  if (isAccountChooser && !hasPasswordOrMfa) {
    accountChoiceEl = Array.from(document.querySelectorAll('[data-identifier], [data-email], [data-authuser], li[role="link"], div[role="link"][data-identifier]'))
      .find(el => {
        if (!isVisible(el)) return false;
        const t = clean(el.innerText || el.textContent);
        if (!t || anotherAccountRegex.test(t)) return false;
        const ident = el.getAttribute('data-identifier') || el.getAttribute('data-email') || '';
        return ident.includes('@') || /@/.test(t);
      });
  }

  const isConsentPage = /accounts\.google\.com\/.*(?:consent|oauth\/id|signin\/oauth|o\/oauth2)/i.test(url);
  const consentBtnRegex = /^(?:continue|allow|confirm|accept|继续|允许|授权|続行|許可|계속|허용|확인|continuar|continuer|continua|consenti|weiter|devam\s+et|продолжить)$/i;
  let consentEl = null;
  if (!hasPasswordOrMfa && !accountChoiceEl && (isConsentPage || !!document.querySelector('#submit_approve_access'))) {
    consentEl = Array.from(document.querySelectorAll('#submit_approve_access, button, [role="button"], input[type="submit"]'))
      .find(el => {
        if (!isVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (el.id === 'submit_approve_access') return true;
        const lbl = clean(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
        return consentBtnRegex.test(lbl);
      });
  }

  return {
    url,
    hasCaptcha,
    hasPasswordOrMfa,
    ...(mfaReason ? { mfaReason } : {}),
    hasTechnicalIssue: !!techMatch,
    ...(techMatch ? { technicalIssueText: techMatch[0].slice(0, 180) } : {}),
    ...(accountChoiceEl ? { accountChoiceSelector: selectorFor(accountChoiceEl) } : {}),
    ...(consentEl ? { consentButtonSelector: selectorFor(consentEl) } : {}),
  };
})()`;
function buildWixTechnicalIssueResult(ref, inspection, detail, finalUrlOverride) {
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "manual_required",
		siteType: "wix",
		title: inspection.title,
		finalUrl: finalUrlOverride ?? inspection.finalUrl,
		reason: "wix_google_sso_technical_issue",
		templateSignature: "wix:google_sso_technical_issue",
		evidence: `Wix Google SSO 回调出现限流/技术报错 (${detail.slice(0, 140)})，已快速熔断中止（严禁重试）`,
		submitTriggered: false
	};
}
async function waitForOAuthPopup(page, timeoutMs, clickAction) {
	const pageWithEvents = page;
	let popupPromise = Promise.resolve(null);
	if (typeof pageWithEvents.waitForEvent === "function") popupPromise = pageWithEvents.waitForEvent("popup", { timeout: timeoutMs }).catch(() => null);
	else {
		const ctx = typeof pageWithEvents.context === "function" ? pageWithEvents.context() : void 0;
		if (ctx && typeof ctx.waitForEvent === "function") popupPromise = ctx.waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
	}
	await clickAction();
	return await popupPromise;
}
/**
* One-click Wix Google SSO login helper:
* 1. Click visible login trigger (if modal not already open) and re-check CAPTCHA / `signupRecaptchaOption=ALWAYS`.
* 2. Click multilingual Google SSO button and drive Google Account Chooser / OAuth Consent popup automatically.
* 3. Immediately abort on CAPTCHA (`blocked_captcha`), password/MFA (`needs_login`), or Wix `"Looks like there was a technical issue"` (`manual_required` + `wix:google_sso_technical_issue`).
* 4. Confirm Wix login wall cleared & editor mounted before returning `logged_in`.
*/
async function attemptWixAutoGoogleSso(page, ref, initialInspection, options) {
	const { timeoutMs, sleep, signal } = options;
	const popupTimeoutMs = Math.min(options.wixSsoPopupTimeoutMs ?? 4e3, timeoutMs);
	const completeWaitMs = Math.min(options.wixSsoCompleteWaitMs ?? 8e3, timeoutMs);
	if (typeof page.evaluate !== "function") return {
		status: "fallback_needs_login",
		inspection: initialInspection
	};
	let ssoDialog = await page.evaluate(INSPECT_WIX_SSO_DIALOG_SCRIPT).catch(() => ({
		hasCaptcha: false,
		signupRecaptchaAlways: false,
		hasTechnicalIssue: false
	}));
	if (ssoDialog.hasTechnicalIssue) return {
		status: "terminal",
		result: buildWixTechnicalIssueResult(ref, initialInspection, ssoDialog.technicalIssueText ?? "Looks like there was a technical issue", page.url())
	};
	if (ssoDialog.hasCaptcha || ssoDialog.signupRecaptchaAlways) return {
		status: "terminal",
		result: buildWixSignupRecaptchaBlockedResult(ref, initialInspection, "Wix Google SSO 登录前检测到人机验证 / signupRecaptchaOption=\"ALWAYS\"，未尝试绕过", { finalUrl: page.url() })
	};
	if (!ssoDialog.googleButtonSelector && ssoDialog.loginTriggerSelector) {
		await dismissBlockingOverlays(page, timeoutMs);
		await (await resolveFirstVisibleLocator(page, ssoDialog.loginTriggerSelector)).click({ timeout: Math.min(5e3, timeoutMs) }).catch(() => void 0);
		const modalDeadline = Date.now() + Math.min(2500, timeoutMs);
		for (let poll = 0; poll < 6; poll++) {
			throwIfAborted$2(signal);
			await sleep(Math.min(350, timeoutMs), signal);
			ssoDialog = await page.evaluate(INSPECT_WIX_SSO_DIALOG_SCRIPT).catch(() => ({
				hasCaptcha: false,
				signupRecaptchaAlways: false,
				hasTechnicalIssue: false
			}));
			const frames = await inspectChildFrames(page);
			if (ssoDialog.hasCaptcha || ssoDialog.signupRecaptchaAlways || hasEffectiveWixChildFrameCaptcha(initialInspection, frames)) return {
				status: "terminal",
				result: buildWixSignupRecaptchaBlockedResult(ref, initialInspection, "打开 Wix 登录弹层后检测到 CAPTCHA / signupRecaptchaOption=\"ALWAYS\"，立即中止未尝试绕过", { finalUrl: page.url() })
			};
			if (ssoDialog.hasTechnicalIssue) return {
				status: "terminal",
				result: buildWixTechnicalIssueResult(ref, initialInspection, ssoDialog.technicalIssueText ?? "Looks like there was a technical issue", page.url())
			};
			if (ssoDialog.googleButtonSelector || Date.now() >= modalDeadline) break;
		}
	}
	const preClickFrames = await inspectChildFrames(page);
	if (ssoDialog.hasCaptcha || ssoDialog.signupRecaptchaAlways || hasEffectiveWixChildFrameCaptcha(initialInspection, preClickFrames)) return {
		status: "terminal",
		result: buildWixSignupRecaptchaBlockedResult(ref, initialInspection, "Wix 登录弹层存在 CAPTCHA / signupRecaptchaOption=\"ALWAYS\"，立即中止未尝试绕过", { finalUrl: page.url() })
	};
	if (ssoDialog.hasTechnicalIssue) return {
		status: "terminal",
		result: buildWixTechnicalIssueResult(ref, initialInspection, ssoDialog.technicalIssueText ?? "Looks like there was a technical issue", page.url())
	};
	if (!ssoDialog.googleButtonSelector) return {
		status: "fallback_needs_login",
		inspection: initialInspection,
		note: "未找到可见 Google SSO 按钮"
	};
	const googleLocator = await resolveFirstVisibleLocator(page, ssoDialog.googleButtonSelector);
	let clickFailed = false;
	const popup = await waitForOAuthPopup(page, popupTimeoutMs, async () => {
		try {
			await googleLocator.click({ timeout: Math.min(5e3, timeoutMs) });
		} catch {
			clickFailed = true;
		}
	});
	if (clickFailed && !popup) return {
		status: "fallback_needs_login",
		inspection: initialInspection,
		note: "点击 Google SSO 按钮失败"
	};
	if (popup) {
		let stalledPolls = 0;
		for (let step = 0; step < 8; step++) {
			throwIfAborted$2(signal);
			if (typeof popup.isClosed === "function" && popup.isClosed()) break;
			if (typeof popup.waitForLoadState === "function") await popup.waitForLoadState("domcontentloaded", { timeout: Math.min(3e3, timeoutMs) }).catch(() => void 0);
			if (typeof popup.isClosed === "function" && popup.isClosed()) break;
			if (typeof popup.evaluate !== "function") break;
			const popupInfo = await popup.evaluate(INSPECT_GOOGLE_OAUTH_POPUP_SCRIPT).catch(() => null);
			if (!popupInfo) {
				if (typeof popup.isClosed === "function" && popup.isClosed()) break;
				await sleep(Math.min(350, timeoutMs), signal);
				continue;
			}
			if (popupInfo.hasCaptcha) return {
				status: "terminal",
				result: buildWixSignupRecaptchaBlockedResult(ref, initialInspection, "Google OAuth 授权弹窗内检测到 CAPTCHA 人机验证，立即中止未尝试绕过", { finalUrl: page.url() })
			};
			if (popupInfo.hasTechnicalIssue) return {
				status: "terminal",
				result: buildWixTechnicalIssueResult(ref, initialInspection, popupInfo.technicalIssueText ?? "Looks like there was a technical issue", page.url())
			};
			if (popupInfo.hasPasswordOrMfa) return {
				status: "fallback_needs_login",
				inspection: initialInspection,
				note: `Google OAuth 弹出密码/二次验证 (${popupInfo.mfaReason ?? "mfa"})，停止自动登录并退回 needs_login`
			};
			if (popupInfo.accountChoiceSelector) {
				stalledPolls = 0;
				await popup.locator(popupInfo.accountChoiceSelector).first().click({ timeout: Math.min(5e3, timeoutMs) }).catch(() => void 0);
				await sleep(Math.min(400, timeoutMs), signal);
				continue;
			}
			if (popupInfo.consentButtonSelector) {
				stalledPolls = 0;
				await popup.locator(popupInfo.consentButtonSelector).first().click({ timeout: Math.min(5e3, timeoutMs) }).catch(() => void 0);
				await sleep(Math.min(400, timeoutMs), signal);
				continue;
			}
			stalledPolls++;
			if (stalledPolls >= 2) return {
				status: "fallback_needs_login",
				inspection: initialInspection,
				note: `Google OAuth 弹窗停留在未知页面 (${popupInfo.url.slice(0, 80)})，退回 needs_login`
			};
			await sleep(Math.min(400, timeoutMs), signal);
		}
	}
	const completeDeadline = Date.now() + completeWaitMs;
	const maxPolls = completeWaitMs > 0 ? Math.max(1, Math.ceil(completeWaitMs / 400)) : 1;
	let latestInspection = initialInspection;
	for (let poll = 0; poll < maxPolls; poll++) {
		throwIfAborted$2(signal);
		const postSsoDialog = await page.evaluate(INSPECT_WIX_SSO_DIALOG_SCRIPT).catch(() => ({
			hasCaptcha: false,
			signupRecaptchaAlways: false,
			hasTechnicalIssue: false
		}));
		if (postSsoDialog.hasTechnicalIssue) return {
			status: "terminal",
			result: buildWixTechnicalIssueResult(ref, latestInspection, postSsoDialog.technicalIssueText ?? "Looks like there was a technical issue", page.url())
		};
		if (postSsoDialog.hasCaptcha || postSsoDialog.signupRecaptchaAlways) return {
			status: "terminal",
			result: buildWixSignupRecaptchaBlockedResult(ref, latestInspection, "Wix Google SSO 回调后出现 CAPTCHA / signupRecaptchaOption=\"ALWAYS\"，未尝试绕过", { finalUrl: page.url() })
		};
		latestInspection = await safeInspectCommentPageWithFrames(page, {
			timeoutMs,
			sleep,
			signal
		}).catch(() => latestInspection);
		if (latestInspection.wix.captchaDetected || hasEffectiveWixChildFrameCaptcha(latestInspection, latestInspection.childFrames)) return {
			status: "terminal",
			result: buildWixSignupRecaptchaBlockedResult(ref, latestInspection, "Wix Google SSO 回调后检测到 reCAPTCHA 人机验证，未尝试绕过", { finalUrl: page.url() })
		};
		if (!latestInspection.wix.loginRequired && (latestInspection.wix.hasGuestEditor || latestInspection.wix.triggerSelector)) return {
			status: "logged_in",
			inspection: latestInspection
		};
		if (!popup && poll >= 1) break;
		const remaining = completeDeadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(400, remaining), signal);
	}
	return {
		status: "fallback_needs_login",
		inspection: latestInspection,
		note: popup ? "Google SSO 弹窗结束后 Wix 页面未恢复已登录评论框" : "点击 Google SSO 未触发 OAuth 弹窗且页面仍处于未登录状态"
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
/**
* Inspect visible Wix RCE toolbar Link button (including floating/portal toolbars
* that only mount after focusing the editor or selecting anchor text).
*/
const FIND_WIX_RCE_TOOLBAR_LINK_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');
  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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

  const linkRegex = new RegExp(${JSON.stringify(WIX_RCE_LINK_BUTTON_PATTERN.source)}, 'i');
  const unlinkRegex = new RegExp(${JSON.stringify(WIX_RCE_UNLINK_BUTTON_PATTERN.source)}, 'i');
  const isNav = el => Boolean(el.closest && el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]'));
  const scopes = [
    ...Array.from(document.querySelectorAll('[data-hook*="toolbar" i], [role="toolbar"], [data-hook*="ricos" i], [data-hook*="comment-box" i], [data-hook*="comments-section" i], [data-hook*="comment" i], [class*="toolbar" i]')).filter(isVisible),
  ];
  const seen = new Set();
  const orderedScopes = [];
  for (const s of scopes) {
    if (!seen.has(s)) {
      seen.add(s);
      orderedScopes.push(s);
    }
  }
  if (document.body) orderedScopes.push(document.body);

  for (const scope of orderedScopes) {
    const candidates = Array.from(scope.querySelectorAll('button, [role="button"], [data-hook*="link" i]'));
    for (const el of candidates) {
      if (!isVisible(el) || isNav(el)) continue;
      if (el.localName === 'a' && el.getAttribute('href')) continue;
      const sig = clean(
        (el.getAttribute('data-hook') || '') + ' '
        + (el.getAttribute('data-testid') || '') + ' '
        + (el.getAttribute('aria-label') || '') + ' '
        + (el.getAttribute('title') || '') + ' '
        + (el.innerText || el.textContent || '')
      );
      if (!sig || unlinkRegex.test(sig) || !linkRegex.test(sig)) continue;
      const sel = selectorFor(el);
      if (sel) return { found: true, selector: sel };
    }
  }
  return { found: false };
})()`;
const WIX_LINK_EDITABLE_INPUT_GUARD = ":not([readonly]):not([aria-readonly=\"true\"]):not([role=\"combobox\"]):not([type=\"hidden\"]):not([type=\"checkbox\"]):not([type=\"radio\"]):not([disabled])";
const WIX_LINK_URL_INPUT_PRIORITY_SELECTOR = [
	`input[type="url"]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`[data-hook="linkPanelInput"] input${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[data-hook="linkPanelInput"]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="http" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="www" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="url" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="web" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="enlace" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="endereço" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="endereco" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="dirección" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="direccion" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="link" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="lien" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="링크" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="ссылк" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[placeholder*="链接" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="url" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="web" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="enlace" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="endereço" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="endereco" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="dirección" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="direccion" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="link" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="lien" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="링크" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="ссылк" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[aria-label*="链接" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`
].join(", ");
const WIX_LINK_URL_INPUT_FALLBACK_SELECTOR = [
	`input[data-hook*="linkPanel" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`input[data-hook*="link" i]${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`[data-hook*="linkPanel" i] input${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`[data-hook*="link-modal" i] input${WIX_LINK_EDITABLE_INPUT_GUARD}`,
	`[data-hook*="linkModal" i] input${WIX_LINK_EDITABLE_INPUT_GUARD}`
].join(", ");
[WIX_LINK_URL_INPUT_PRIORITY_SELECTOR, WIX_LINK_URL_INPUT_FALLBACK_SELECTOR].join(", ");
const WIX_LINK_APPLY_BUTTON_SELECTOR = [
	"[data-hook*=\"linkPanelConfirm\" i]",
	"[data-hook*=\"link-panel-confirm\" i]",
	"[data-hook*=\"actionButtonSave\" i]",
	"[data-hook*=\"save\" i]",
	"[data-hook*=\"apply\" i]",
	"[data-hook*=\"confirm\" i]",
	"button[aria-label*=\"save\" i]",
	"button[aria-label*=\"apply\" i]",
	"button[aria-label*=\"guardar\" i]",
	"button[aria-label*=\"salvar\" i]",
	"button[aria-label*=\"enregistrer\" i]",
	"button[aria-label*=\"speichern\" i]",
	"button[aria-label*=\"저장\" i]",
	"button[aria-label*=\"保存\" i]",
	"button[aria-label*=\"сохранить\" i]",
	"button[title*=\"save\" i]",
	"button[title*=\"salvar\" i]",
	"button[title*=\"guardar\" i]",
	"button[title*=\"enregistrer\" i]",
	"button[title*=\"speichern\" i]",
	"button[title*=\"保存\" i]",
	"[data-hook*=\"linkPanel\" i] button[type=\"submit\"]",
	"[role=\"dialog\"] button[type=\"submit\"]"
].join(", ");
/** Resolve the first visible editable (non-readonly, non-combobox) URL input inside a Wix RCE link modal, prioritizing explicit URL/web inputs over generic modal inputs. */
async function resolveWixLinkUrlInputLocator(page) {
	const tryTier = async (selector) => {
		const base = page.locator(selector);
		const total = await base.count().catch(() => 0);
		if (total <= 0) return void 0;
		const probe = base;
		if (typeof probe.nth === "function") {
			const limit = Math.min(total, 15);
			for (let i = 0; i < limit; i++) {
				const candidate = probe.nth(i);
				if (!(typeof candidate.isVisible === "function" ? await candidate.isVisible().catch(() => false) : true)) continue;
				const [ro, ariaRo, role] = typeof candidate.getAttribute === "function" ? await Promise.all([
					candidate.getAttribute("readonly").catch(() => null),
					candidate.getAttribute("aria-readonly").catch(() => null),
					candidate.getAttribute("role").catch(() => null)
				]) : [
					null,
					null,
					null
				];
				if (ro !== null || ariaRo?.toLowerCase() === "true" || role?.toLowerCase() === "combobox") continue;
				return candidate;
			}
			return;
		}
		return base.first();
	};
	return await tryTier(WIX_LINK_URL_INPUT_PRIORITY_SELECTOR) ?? await tryTier(WIX_LINK_URL_INPUT_FALLBACK_SELECTOR);
}
/** Select an anchor substring inside a contenteditable editor and notify selection listeners. */
async function selectTextInRichEditor(page, editorSelector, anchor) {
	return await page.evaluate(({ selector, needle }) => {
		const dom = globalThis;
		const el = dom.document.querySelector(selector);
		if (!el || !needle) return false;
		const walker = dom.document.createTreeWalker(el, dom.NodeFilter?.SHOW_TEXT ?? 4);
		let node = walker.nextNode();
		while (node) {
			const idx = (node.textContent ?? "").toLowerCase().indexOf(needle.toLowerCase());
			if (idx >= 0) {
				const range = dom.document.createRange();
				range.setStart(node, idx);
				range.setEnd(node, idx + needle.length);
				const sel = dom.window.getSelection?.();
				if (sel) {
					sel.removeAllRanges();
					sel.addRange(range);
				}
				if (typeof dom.Event === "function" && typeof el.dispatchEvent === "function") try {
					el.dispatchEvent(new dom.Event("mouseup", { bubbles: true }));
					el.dispatchEvent(new dom.Event("keyup", { bubbles: true }));
				} catch {}
				return true;
			}
			node = walker.nextNode();
		}
		return false;
	}, {
		selector: editorSelector,
		needle: anchor
	}).catch(() => false);
}
async function applyWixLinkPopover(page, targetUrl, stepTimeoutMs, excludeSubmitSelector) {
	const urlInput = await resolveWixLinkUrlInputLocator(page);
	if (!urlInput) return false;
	await urlInput.fill(targetUrl, { timeout: stepTimeoutMs });
	if (await page.locator(WIX_LINK_APPLY_BUTTON_SELECTOR).count().catch(() => 0) > 0) {
		const applyBtn = await resolveFirstVisibleLocator(page, WIX_LINK_APPLY_BUTTON_SELECTOR);
		const isCommentPublishBtn = excludeSubmitSelector ? await applyBtn.evaluate?.((el, sel) => {
			const node = el;
			try {
				return Boolean(node?.matches?.(sel));
			} catch {
				return false;
			}
		}, excludeSubmitSelector).catch(() => false) : false;
		if ((typeof applyBtn.isVisible === "function" ? await applyBtn.isVisible().catch(() => true) : true) && !isCommentPublishBtn) {
			await applyBtn.click({ timeout: stepTimeoutMs });
			return true;
		}
	}
	const localizedConfirmSel = await page.evaluate((submitSel) => {
		const g = globalThis;
		const escapeCss = (v) => typeof g.CSS !== "undefined" && typeof g.CSS.escape === "function" ? g.CSS.escape(v) : String(v).replace(/([^\w-])/g, "\\$1");
		const clean = (v) => String(v ?? "").replace(/\s+/gu, " ").trim();
		const isVisible = (el) => {
			if (!el || el.nodeType !== 1) return false;
			if (el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
			for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
				if (cur.hidden) return false;
				if (cur.getAttribute?.("aria-hidden") === "true") return false;
				const style = typeof g.getComputedStyle === "function" ? g.getComputedStyle(cur) : null;
				if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
			}
			return true;
		};
		const unique = (el, sel) => {
			if (!sel) return false;
			try {
				const list = g.document.querySelectorAll(sel);
				return list.length === 1 && list[0] === el;
			} catch {
				return false;
			}
		};
		const selectorFor = (el) => {
			const hook = el.getAttribute?.("data-hook");
			if (hook) {
				const s = `[data-hook="${hook.replace(/"/g, "\\\"")}"]`;
				if (unique(el, s)) return s;
			}
			const testId = el.getAttribute?.("data-testid");
			if (testId) {
				const s = `[data-testid="${testId.replace(/"/g, "\\\"")}"]`;
				if (unique(el, s)) return s;
			}
			if (el.id) {
				const s = `#${escapeCss(el.id)}`;
				if (unique(el, s)) return s;
			}
			const aria = el.getAttribute?.("aria-label");
			if (aria) {
				const s = `${el.localName ?? "button"}[aria-label="${aria.replace(/"/g, "\\\"")}"]`;
				if (unique(el, s)) return s;
			}
			let path = "";
			for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 14; node = node.parentElement, depth++) {
				const tag = node.localName ?? "button";
				const parent = node.parentElement;
				if (!parent) break;
				const siblings = Array.from(parent.children ?? []).filter((s) => s.localName === tag);
				const seg = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag;
				path = path ? `${seg} > ${path}` : seg;
				if (unique(el, path)) return path;
			}
			return "";
		};
		const labelRegex = /^(?:save|apply|done|ok|insert|add|confirm|guardar|aplicar|insertar|confirmar|salvar|inserir|enregistrer|appliquer|ins[ée]rer|speichern|[üu]bernehmen|einf[üu]gen|salva|applica|저장|적용|확인|保存|適用|сохранить|применить|确定|应用|插入)$/iu;
		const scopes = Array.from(g.document.querySelectorAll("[data-hook*=\"linkPanel\" i], [data-hook*=\"link-modal\" i], [data-hook*=\"linkModal\" i], [data-hook*=\"modal\" i], [role=\"dialog\"], [aria-modal=\"true\"], [class*=\"linkPanel\" i], [class*=\"popover\" i], [class*=\"modal\" i], [data-hook*=\"ricos\" i]")).filter(isVisible);
		if (g.document.body) scopes.push(g.document.body);
		for (const scope of scopes) for (const btn of Array.from(scope.querySelectorAll?.("button, [role=\"button\"]") ?? [])) {
			if (!isVisible(btn)) continue;
			if (btn.closest?.("header, nav, footer, [role=\"banner\"], [role=\"navigation\"], [role=\"contentinfo\"]")) continue;
			try {
				if (submitSel && btn.matches?.(submitSel)) continue;
			} catch {}
			const lbl = clean(btn.innerText || btn.textContent || btn.getAttribute?.("aria-label") || btn.getAttribute?.("title"));
			if (labelRegex.test(lbl)) {
				const sel = selectorFor(btn);
				if (sel) return sel;
			}
		}
		return "";
	}, excludeSubmitSelector ?? "").catch(() => "");
	if (localizedConfirmSel) await page.locator(localizedConfirmSel).first().click({ timeout: stepTimeoutMs });
	else if (typeof urlInput.press === "function") await urlInput.press("Enter", { timeout: stepTimeoutMs });
	else if (typeof page.keyboard?.press === "function") await page.keyboard.press("Enter").catch(() => void 0);
	return true;
}
/**
* Inspect and automatically select a 5-star rating inside a WordPress / WooCommerce /
* OpenCart comment or review form when a star rating control exists and is currently unselected.
*/
async function ensureWordPressStarRating(page, formSelector, stepTimeoutMs) {
	if (typeof page.evaluate !== "function") return {
		detected: false,
		alreadySelected: false,
		selected: false
	};
	const inspection = await page.evaluate((targetFormSel) => {
		const g = globalThis;
		const escapeCss = (value) => typeof g.CSS !== "undefined" && typeof g.CSS.escape === "function" ? g.CSS.escape(value) : String(value).replace(/([^\w-])/g, "\\$1");
		const isVisible = (el) => {
			if (!el || el.nodeType !== 1) return false;
			if (el.localName === "input" && (el.type || "").toLowerCase() === "hidden") return false;
			for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
				if (cur.hidden) return false;
				if (cur.getAttribute?.("aria-hidden") === "true") return false;
				const style = typeof g.getComputedStyle === "function" ? g.getComputedStyle(cur) : null;
				if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
			}
			return true;
		};
		const unique = (el, sel) => {
			if (!sel) return false;
			try {
				const list = g.document.querySelectorAll(sel);
				return list.length === 1 && list[0] === el;
			} catch {
				return false;
			}
		};
		const selectorFor = (el, scopeEl) => {
			if (!el) return "";
			if (el.id) {
				const byId = "#" + escapeCss(el.id);
				if (unique(el, byId)) return byId;
			}
			const tagName = el.localName ?? "div";
			const nameAttr = el.getAttribute?.("name");
			const valAttr = el.getAttribute?.("value");
			if (nameAttr && valAttr) {
				const byNameVal = `${tagName}[name="${nameAttr.replace(/"/g, "\\\"")}"][value="${valAttr.replace(/"/g, "\\\"")}"]`;
				if (unique(el, byNameVal)) return byNameVal;
			}
			if (nameAttr) {
				const byName = `${tagName}[name="${nameAttr.replace(/"/g, "\\\"")}"]`;
				if (unique(el, byName)) return byName;
			}
			const scopePrefix = scopeEl?.id ? `#${escapeCss(scopeEl.id)} ` : "";
			if (tagName === "a" && el.classList?.contains?.("star-5")) {
				const sel = `${scopePrefix}a.star-5`;
				if (unique(el, sel)) return sel;
			}
			if (tagName === "label") {
				const forAttr = el.getAttribute?.("for");
				if (forAttr) {
					const byFor = `label[for="${forAttr.replace(/"/g, "\\\"")}"]`;
					if (unique(el, byFor)) return byFor;
				}
			}
			let path = "";
			for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 14; node = node.parentElement, depth++) {
				const tag = node.localName ?? "div";
				const parent = node.parentElement;
				if (!parent) break;
				const siblings = Array.from(parent.children ?? []).filter((s) => s.localName === tag);
				const seg = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag;
				path = path ? `${seg} > ${path}` : seg;
				if (unique(el, path)) return path;
			}
			return "";
		};
		let scope = null;
		if (targetFormSel) try {
			scope = g.document.querySelector(targetFormSel);
		} catch {
			scope = null;
		}
		scope = scope || g.document.querySelector("form#commentform, form[action*=\"wp-comments-post.php\"], form#form-review, #form-review, #respond form, #respond");
		if (!scope) return {
			detected: false,
			alreadySelected: false
		};
		const starLink = Array.from(scope.querySelectorAll?.(".comment-form-rating a.star-5, .stars a.star-5, p.stars a.star-5") ?? []).find(isVisible) ?? null;
		const starsContainer = scope.querySelector?.(".comment-form-rating .stars, p.stars, .stars") ?? null;
		const starAlreadyActive = Boolean(starsContainer?.classList?.contains?.("selected") || starsContainer?.querySelector?.("a.active"));
		const selectEl = scope.querySelector?.("select[name=\"rating\"], select#rating, select[name*=\"rating\" i]") ?? null;
		let selectAlreadySelected = false;
		let bestSelectVal = "5";
		if (selectEl) {
			const curVal = String(selectEl.value || "").trim();
			selectAlreadySelected = curVal.length > 0 && curVal !== "0";
			const opts = Array.from(selectEl.options ?? []);
			if (!opts.some((o) => String(o.value ?? "").trim() === "5")) {
				const numericOpts = opts.map((o) => ({
					val: String(o.value ?? "").trim(),
					num: Number(o.value)
				})).filter((o) => o.val.length > 0 && Number.isFinite(o.num) && o.num > 0).sort((a, b) => b.num - a.num);
				if (numericOpts[0]) bestSelectVal = numericOpts[0].val;
				else {
					const nonEmpty = opts.filter((o) => String(o.value ?? "").trim().length > 0);
					if (nonEmpty.length > 0) bestSelectVal = String(nonEmpty[nonEmpty.length - 1].value ?? "").trim();
				}
			}
		}
		const radioInputs = Array.from(scope.querySelectorAll?.("input[type=\"radio\"][name=\"rating\"], input[type=\"radio\"][name*=\"rating\" i], input[type=\"radio\"][name*=\"star\" i]") ?? []);
		const radioAlreadySelected = radioInputs.some((r) => r.checked === true);
		let targetRadio = null;
		if (radioInputs.length > 0) {
			targetRadio = radioInputs.find((r) => String(r.value ?? "").trim() === "5") ?? null;
			if (!targetRadio) targetRadio = [...radioInputs].map((r) => ({
				el: r,
				num: Number(r.value)
			})).filter((x) => Number.isFinite(x.num) && x.num > 0).sort((a, b) => b.num - a.num)[0]?.el ?? radioInputs[radioInputs.length - 1] ?? null;
		}
		let radioLabel = null;
		if (targetRadio) {
			if (targetRadio.id) try {
				const explicitLbl = scope.querySelector?.(`label[for="${targetRadio.id.replace(/"/g, "\\\"")}"]`) ?? g.document.querySelector(`label[for="${targetRadio.id.replace(/"/g, "\\\"")}"]`);
				if (explicitLbl && isVisible(explicitLbl)) radioLabel = explicitLbl;
			} catch {}
			if (!radioLabel) {
				const wrapLbl = targetRadio.closest?.("label") ?? null;
				if (wrapLbl && isVisible(wrapLbl)) radioLabel = wrapLbl;
			}
		}
		const customStar = Array.from(scope.querySelectorAll?.(".comment-form-rating [data-rating=\"5\"], [class*=\"rating\" i] [data-rating=\"5\"], [class*=\"rating\" i] [data-value=\"5\"], [class*=\"star\" i][data-rating=\"5\"]") ?? []).find(isVisible) ?? null;
		const hiddenRatingInput = scope.querySelector?.("input[type=\"hidden\"][name=\"rating\"], input[type=\"hidden\"][name*=\"rating\" i]") ?? null;
		const hiddenAlreadySelected = Boolean(hiddenRatingInput && String(hiddenRatingInput.value || "").trim().length > 0 && String(hiddenRatingInput.value).trim() !== "0");
		if (!Boolean(starLink || selectEl || radioInputs.length > 0 || customStar)) return {
			detected: false,
			alreadySelected: false
		};
		return {
			detected: true,
			alreadySelected: Boolean(selectEl && selectAlreadySelected || radioInputs.length > 0 && radioAlreadySelected || starLink && !selectEl && starAlreadyActive || customStar && hiddenAlreadySelected),
			...starLink ? { starLinkSelector: selectorFor(starLink, scope) } : {},
			...selectEl ? {
				selectSelector: selectorFor(selectEl, scope),
				selectVisible: isVisible(selectEl),
				selectValue: bestSelectVal
			} : {},
			...targetRadio ? {
				radioSelector: selectorFor(targetRadio, scope),
				radioVisible: isVisible(targetRadio)
			} : {},
			...radioLabel ? { radioLabelSelector: selectorFor(radioLabel, scope) } : {},
			...customStar ? { customStarSelector: selectorFor(customStar, scope) } : {}
		};
	}, formSelector ?? "").catch(() => ({
		detected: false,
		alreadySelected: false
	}));
	if (!inspection.detected) return {
		detected: false,
		alreadySelected: false,
		selected: false
	};
	if (inspection.alreadySelected) return {
		detected: true,
		alreadySelected: true,
		selected: false
	};
	if (inspection.starLinkSelector && typeof page.locator === "function") {
		await (await resolveFirstVisibleLocator(page, inspection.starLinkSelector)).click({ timeout: stepTimeoutMs }).catch(() => void 0);
		if (inspection.selectSelector) await page.evaluate(({ sel, val }) => {
			const g = globalThis;
			const select = g.document.querySelector(sel);
			if (select && (!select.value || select.value === "0")) {
				select.value = val;
				if (typeof g.Event === "function" && typeof select.dispatchEvent === "function") {
					select.dispatchEvent(new g.Event("input", { bubbles: true }));
					select.dispatchEvent(new g.Event("change", { bubbles: true }));
				}
			}
		}, {
			sel: inspection.selectSelector,
			val: inspection.selectValue ?? "5"
		}).catch(() => void 0);
		return {
			detected: true,
			alreadySelected: false,
			selected: true,
			method: "star_link",
			value: inspection.selectValue ?? "5"
		};
	}
	if (inspection.selectSelector) {
		const val = inspection.selectValue ?? "5";
		let selectedViaPlaywright = false;
		if (inspection.selectVisible && typeof page.locator === "function") {
			const selLoc = page.locator(inspection.selectSelector).first();
			if (typeof selLoc.selectOption === "function") await selLoc.selectOption(val, { timeout: stepTimeoutMs }).then(() => {
				selectedViaPlaywright = true;
			}).catch(() => void 0);
		}
		if (!selectedViaPlaywright) await page.evaluate(({ sel, v }) => {
			const g = globalThis;
			const select = g.document.querySelector(sel);
			if (select) {
				select.value = v;
				if (typeof g.Event === "function" && typeof select.dispatchEvent === "function") {
					select.dispatchEvent(new g.Event("input", { bubbles: true }));
					select.dispatchEvent(new g.Event("change", { bubbles: true }));
				}
			}
		}, {
			sel: inspection.selectSelector,
			v: val
		}).catch(() => void 0);
		return {
			detected: true,
			alreadySelected: false,
			selected: true,
			method: "select",
			value: val
		};
	}
	if (inspection.radioSelector) {
		let checkedViaUi = false;
		if (inspection.radioVisible && typeof page.locator === "function") {
			const radioLoc = page.locator(inspection.radioSelector).first();
			if (typeof radioLoc.check === "function") await radioLoc.check({ timeout: stepTimeoutMs }).then(() => {
				checkedViaUi = true;
			}).catch(() => void 0);
			if (!checkedViaUi && typeof radioLoc.click === "function") await radioLoc.click({ timeout: stepTimeoutMs }).then(() => {
				checkedViaUi = true;
			}).catch(() => void 0);
		} else if (inspection.radioLabelSelector && typeof page.locator === "function") await page.locator(inspection.radioLabelSelector).first().click({ timeout: stepTimeoutMs }).then(() => {
			checkedViaUi = true;
		}).catch(() => void 0);
		await page.evaluate((sel) => {
			const g = globalThis;
			const input = g.document.querySelector(sel);
			if (input && !input.checked) {
				input.checked = true;
				if (typeof g.Event === "function" && typeof input.dispatchEvent === "function") {
					input.dispatchEvent(new g.Event("input", { bubbles: true }));
					input.dispatchEvent(new g.Event("change", { bubbles: true }));
				}
			}
		}, inspection.radioSelector).catch(() => void 0);
		return {
			detected: true,
			alreadySelected: false,
			selected: true,
			method: "radio",
			value: "5"
		};
	}
	if (inspection.customStarSelector && typeof page.locator === "function") {
		await page.locator(inspection.customStarSelector).first().click({ timeout: stepTimeoutMs }).catch(() => void 0);
		return {
			detected: true,
			alreadySelected: false,
			selected: true,
			method: "custom_star",
			value: "5"
		};
	}
	return {
		detected: true,
		alreadySelected: false,
		selected: false
	};
}
function inferSiteType(inspection) {
	if (inspection.wordpress.found || inspection.isWordPress) return "wordpress";
	if (inspection.genericComment?.kind === "valine") return "valine";
	if (inspection.genericComment?.kind === "opencart") return "opencart";
	if (inspection.genericComment?.kind === "typecho" || inspection.isTypecho) return "typecho";
	if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl) return "blogger";
	if (inspection.isWix) return "wix";
	return "other";
}
function buildFallbackResult(ref, siteType, inspection, evidence, reason, templateSignature) {
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "needs_llm_fallback",
		siteType,
		title: inspection.title,
		finalUrl: inspection.finalUrl,
		...evidence === void 0 ? {} : { evidence },
		...reason === void 0 ? {} : { reason },
		...templateSignature === void 0 ? {} : { templateSignature },
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
function buildWixSignupRecaptchaBlockedResult(ref, inspection, evidence, overrides) {
	return {
		kind: "comment_publish",
		page: ref,
		outcome: "blocked_captcha",
		siteType: "wix",
		title: overrides?.title ?? inspection.title,
		finalUrl: overrides?.finalUrl ?? inspection.finalUrl,
		reason: "wix_signup_recaptcha_always",
		templateSignature: "wix:signup_recaptcha",
		evidence,
		suggestedTags: ["has_captcha"],
		submitTriggered: false
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
/** Shared submission + Jetpack Verbum guest-flow + WP star-rating auto-select + OpenCart AJAX + 403/WAF detection + 302-resilient post-submit/reload verification for WP, Typecho, OpenCart, Valine, and custom blog forms. */
async function submitAndVerifyStandardForm(page, ref, siteType, siteLabel, inspection, form, command, options) {
	const { timeoutMs, deadlineAt, verifyReload, probeOnly, sleep, signal } = options;
	const stepTimeout = (capMs = DEFAULT_COMMENT_STEP_TIMEOUT_MS) => resolveStepTimeoutMs(timeoutMs, deadlineAt, capMs);
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
	await dismissBlockingOverlays(page, stepTimeout());
	const commentLocator = await resolveFirstVisibleLocator(page, form.commentSelector);
	if (form.commentIsContentEditable) {
		const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
		if (typeof commentLocator.click === "function") await commentLocator.click({ timeout: stepTimeout() }).catch(() => void 0);
		await commentLocator.fill(stripped.plainText, { timeout: stepTimeout() });
	} else {
		const commentBody = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasUrlField);
		await commentLocator.fill(commentBody, { timeout: stepTimeout() });
	}
	let authorFilled = false;
	let emailFilled = false;
	let urlFilled = false;
	if (form.authorSelector !== void 0 && command.authorName?.trim()) {
		await (await resolveFirstVisibleLocator(page, form.authorSelector)).fill(command.authorName.trim(), { timeout: stepTimeout() });
		authorFilled = true;
	}
	if (form.emailSelector !== void 0 && command.authorEmail?.trim()) {
		await (await resolveFirstVisibleLocator(page, form.emailSelector)).fill(command.authorEmail.trim(), { timeout: stepTimeout() });
		emailFilled = true;
	}
	if (form.urlSelector !== void 0 && command.websiteUrl?.trim()) {
		await (await resolveFirstVisibleLocator(page, form.urlSelector)).fill(command.websiteUrl.trim(), { timeout: stepTimeout() });
		urlFilled = true;
	}
	if (siteType === "wordpress" || siteType === "opencart") await ensureWordPressStarRating(page, form.formSelector, stepTimeout());
	let activeSubmitSelector = form.submitSelector;
	let activeInspection = inspection;
	if (activeSubmitSelector === void 0) return buildFallbackResult(ref, siteType, activeInspection, `${siteLabel} 评论框已填充但未定位到明确 Submit 按钮，转交 LLM 接管（未触发提交）`);
	await dismissBlockingOverlays(page, stepTimeout());
	let submitLocator = await resolveFirstVisibleLocator(page, activeSubmitSelector);
	if (await isLocatorDisabled(submitLocator, stepTimeout())) {
		const guestToggleSel = siteType === "wordpress" ? form.guestToggleSelector ?? await findDynamicJetpackGuestToggle(page) : void 0;
		if (guestToggleSel) {
			const toggleLocator = page.locator(guestToggleSel).first();
			if (!await isLocatorDisabled(toggleLocator, stepTimeout())) {
				await toggleLocator.click({ timeout: stepTimeout() }).catch(() => void 0);
				const expandDeadline = Date.now() + Math.min(2e3, stepTimeout());
				let refreshedWp = activeInspection.wordpress;
				for (let poll = 0; poll < 8; poll++) {
					throwIfAborted$2(signal);
					await sleep(Math.min(250, stepTimeout()), signal);
					const nextInspection = await inspectCommentPageWithFrames(page).catch(() => activeInspection);
					activeInspection = nextInspection;
					refreshedWp = nextInspection.wordpress;
					if (Boolean(!authorFilled && refreshedWp.authorSelector || !emailFilled && refreshedWp.emailSelector || !urlFilled && refreshedWp.urlSelector) || Date.now() >= expandDeadline) break;
				}
				if (!authorFilled && refreshedWp.authorSelector && command.authorName?.trim()) {
					await page.locator(refreshedWp.authorSelector).first().fill(command.authorName.trim(), { timeout: stepTimeout() });
					authorFilled = true;
				}
				if (!emailFilled && refreshedWp.emailSelector && command.authorEmail?.trim()) {
					await page.locator(refreshedWp.emailSelector).first().fill(command.authorEmail.trim(), { timeout: stepTimeout() });
					emailFilled = true;
				}
				if (!urlFilled && refreshedWp.urlSelector && command.websiteUrl?.trim()) {
					await page.locator(refreshedWp.urlSelector).first().fill(command.websiteUrl.trim(), { timeout: stepTimeout() });
					urlFilled = true;
				}
				if (refreshedWp.submitSelector) {
					activeSubmitSelector = refreshedWp.submitSelector;
					submitLocator = page.locator(activeSubmitSelector).first();
				}
				const enableDeadline = Date.now() + Math.min(2e3, stepTimeout());
				for (let poll = 0; poll < 8 && await isLocatorDisabled(submitLocator, stepTimeout()); poll++) {
					if (Date.now() >= enableDeadline) break;
					throwIfAborted$2(signal);
					await sleep(Math.min(200, stepTimeout()), signal);
				}
			}
		}
		if (await isLocatorDisabled(submitLocator, stepTimeout())) {
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
		const isValineLeanCloud = method === "POST" && /\/classes\/Comment(?:[/?#]|$)/iu.test(url);
		const isPost = method === "POST";
		const isPostOrDoc = isPost || resourceType === "document" || resourceType === "xhr" || resourceType === "fetch";
		if (!isWpEndpoint && !isValineLeanCloud && !isPostOrDoc) return;
		const entry = {
			url,
			status,
			headers: typeof r.headers === "function" ? r.headers() : {},
			isWpEndpoint,
			isPost,
			isPostOrDoc,
			isValineLeanCloud
		};
		capturedResponses.push(entry);
		if ((status === 403 || status === 406 || status === 429 || siteType === "opencart" && (isPost || resourceType === "xhr" || resourceType === "fetch") && status >= 200 && status < 400) && typeof r.text === "function") pendingBodyReads.push(r.text().then((raw) => {
			if (raw.length > 0) entry.rawBodySnippet = raw.slice(0, 2e3);
			const cleaned = raw.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
			if (cleaned.length > 0) entry.bodySnippet = cleaned.slice(0, 260);
		}).catch(() => void 0));
	};
	const pageWithEvents = page;
	if (typeof pageWithEvents.on === "function") pageWithEvents.on("response", onResponse);
	const preSubmitUrl = page.url();
	const preSubmitCommentIdNum = extractCommentNumericId(preSubmitUrl);
	const maxExistingCommentId = siteType === "wordpress" ? await collectMaxExistingCommentId(page) : 0;
	const navWaitTimeout = Math.min(1e4, timeoutMs, deadlineAt !== void 0 ? Math.max(1, deadlineAt - Date.now()) : 1e4);
	let navResponse = null;
	let clickTimeoutError;
	try {
		const navPromise = siteType === "valine" || siteType === "opencart" ? Promise.resolve(null) : typeof page.waitForNavigation === "function" ? page.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: navWaitTimeout
		}).catch(() => null) : typeof page.waitForLoadState === "function" ? page.waitForLoadState("domcontentloaded", { timeout: navWaitTimeout }).catch(() => null) : Promise.resolve(null);
		const [navRes] = await Promise.all([navPromise, submitLocator.click({ timeout: stepTimeout() }).catch((error) => {
			if (isNavigationContextError(error)) return null;
			if (isTimeoutError(error)) {
				clickTimeoutError = error;
				return null;
			}
			throw error;
		})]);
		navResponse = navRes;
		if (siteType === "valine" || siteType === "opencart") await sleep(Math.min(800, stepTimeout()), signal);
		else if (clickTimeoutError !== void 0) {
			throwIfAborted$2(signal);
			if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: Math.min(2e3, stepTimeout()) }).catch(() => void 0);
			await sleep(Math.min(500, stepTimeout()), signal);
		}
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
			isPost: false,
			isPostOrDoc: true,
			isValineLeanCloud: false
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
		...blockedResponse?.rawBodySnippet === void 0 ? {} : { rawResponseBody: blockedResponse.rawBodySnippet },
		...postVerify.hasWpDieDom ? { hasWpDieDom: true } : {},
		postSubmitUrl,
		...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
		title: postTitle
	});
	if (clickTimeoutError !== void 0) {
		const hasCommentUrlSignal = /#comment-\d+\b|[?&](?:unapproved|moderation-hash)=/iu.test(postSubmitUrl);
		const urlChanged = postSubmitUrl !== preSubmitUrl;
		const hasSubmitResponseTrace = capturedResponses.some((c) => c.isWpEndpoint || c.isPost || c.status === 403 || c.status === 406 || c.status === 429);
		const hasPostSubmitDomTrace = Boolean(wafBlock.blocked || wafBlock.isWpDieValidation || postVerify.wpErrorMessage || postVerify.moderationNotice || postVerify.liveLinkFound || postVerify.commentNodeLinkFound || postVerify.escapedHtmlDetected);
		if (!hasCommentUrlSignal && !urlChanged && !hasSubmitResponseTrace && !hasPostSubmitDomTrace) {
			const detail = clickTimeoutError instanceof Error ? clickTimeoutError.message : String(clickTimeoutError);
			return buildFallbackResult(ref, siteType, await safeInspectCommentPageWithFrames(page, {
				timeoutMs,
				sleep,
				signal
			}).catch(() => activeInspection), `点击 ${siteLabel} 提交按钮超时 (${detail.slice(0, 140)})，且页面无导航变化、无 #comment-ID 或提交痕迹，确认未完成提交，转交 LLM 核查 (submit_click_timeout)`, "submit_click_timeout");
		}
	}
	if (wafBlock.isWpDieValidation) {
		const validationDetail = postVerify.wpErrorMessage ?? wafBlock.wpDieMessage ?? postSubmitSnippet ?? "WordPress form validation required";
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "needs_llm_fallback",
			siteType,
			title: postTitle,
			finalUrl: postSubmitUrl,
			postSubmitUrl,
			httpStatus: wafBlock.httpStatus ?? 403,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			reason: "wp_die_validation_error",
			evidence: `WordPress wp_die 表单校验拦截 (HTTP ${wafBlock.httpStatus ?? 403}，非 WAF): ${validationDetail.slice(0, 200)}，请返回补填评分/必填项`,
			submitTriggered: false,
			formSummary: activeInspection.formSummary,
			...activeInspection.bottomSnapshot === void 0 ? {} : { bottomSnapshot: activeInspection.bottomSnapshot }
		};
	}
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
	if (siteType === "valine") {
		const leanCloudCreated = capturedResponses.some((c) => c.isValineLeanCloud && (c.status === 201 || c.status === 200));
		const verifyValineFirstVnick = async () => {
			try {
				const vnickFirst = page.locator("a.vnick").first();
				const href = typeof vnickFirst.getAttribute === "function" ? await vnickFirst.getAttribute("href").catch(() => null) ?? "" : "";
				const text = typeof vnickFirst.evaluate === "function" ? await vnickFirst.evaluate((n) => String(n?.textContent ?? "").trim()).catch(() => "") : "";
				if (!href && !text) return { matched: false };
				let targetHost = "";
				if (command.websiteUrl) try {
					targetHost = new URL(command.websiteUrl).hostname.toLowerCase().replace(/^www\./u, "");
				} catch {
					targetHost = command.websiteUrl.toLowerCase();
				}
				const hrefMatches = Boolean(targetHost && href.toLowerCase().includes(targetHost));
				const authorMatches = Boolean(command.authorName && text.toLowerCase().includes(command.authorName.trim().toLowerCase()));
				if (hrefMatches || authorMatches && href.length > 0) return {
					matched: true,
					...href ? { href } : {},
					...text ? { name: text } : {}
				};
				return { matched: false };
			} catch {
				return { matched: false };
			}
		};
		let finalVerify = postVerify;
		let finalUrl = postSubmitUrl || command.url;
		let vnickCheck = await verifyValineFirstVnick();
		if (verifyReload) {
			let reloadTimedOut = false;
			try {
				await navigateCommentPageWithCommit(page, command.url, {
					timeoutMs,
					domReadyWaitMs: Math.min(3e3, timeoutMs),
					sleep,
					signal
				});
			} catch (error) {
				throwIfAborted$2(signal);
				if (!isTimeoutError(error)) throw error;
				reloadTimedOut = true;
			}
			if (!reloadTimedOut) {
				await scrollPageStep(page, 1);
				vnickCheck = await verifyValineFirstVnick();
				const reloadCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
				finalUrl = reloadCheck.currentUrl;
				finalVerify = reloadCheck.verify;
				if (!vnickCheck.matched && !finalVerify.liveLinkFound) {
					await sleep(Math.min(600, timeoutMs), signal);
					vnickCheck = await verifyValineFirstVnick();
					const secondCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
					finalUrl = secondCheck.currentUrl;
					finalVerify = secondCheck.verify;
				}
			}
		}
		const finalTitle = await page.title().catch(() => inspection.title);
		if (vnickCheck.matched || finalVerify.liveLinkFound || leanCloudCreated) {
			const proof = vnickCheck.matched ? `a.vnick=${vnickCheck.name || vnickCheck.href || finalUrl}` : finalVerify.liveLinkFound ? `${finalVerify.matchedAnchor || finalVerify.matchedHref || finalUrl}` : "LeanCloud POST /classes/Comment HTTP 201";
			return {
				kind: "comment_publish",
				page: ref,
				outcome: "live",
				siteType: "valine",
				title: finalTitle,
				finalUrl,
				publicUrl: finalUrl,
				evidence: `Valine 评论核验通过 (${proof}${leanCloudCreated ? ", LeanCloud 201" : ""})`,
				submitTriggered: true
			};
		}
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "uncertain_after_submit",
			siteType: "valine",
			title: finalTitle,
			finalUrl,
			publicUrl: finalUrl,
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: "已点击 Valine 提交但未捕获 LeanCloud 201 且重载未确认 a.vnick 目标链接（严禁自动重试）",
			submitTriggered: true
		};
	}
	if (siteType === "opencart") {
		let ocAjaxSuccess;
		let ocAjaxError;
		for (const resp of capturedResponses) {
			const raw = resp.rawBodySnippet?.trim();
			if (!raw || !raw.startsWith("{") && !raw.startsWith("[")) continue;
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed.error === "string" && parsed.error.trim().length > 0) ocAjaxError = parsed.error.trim().slice(0, 220);
				else if (typeof parsed.success === "string" && parsed.success.trim().length > 0) ocAjaxSuccess = parsed.success.trim().slice(0, 220);
				else if (typeof parsed.status === "string") {
					const st = parsed.status.trim().toLowerCase();
					const msg = typeof parsed.message === "string" && parsed.message.trim() || typeof parsed.response?.message === "string" && parsed.response.message.trim() || "";
					if (st === "success") ocAjaxSuccess = (msg || "Comment submitted").slice(0, 220);
					else if (st === "error") {
						const errObj = parsed.errors ?? parsed.response?.errors;
						const errVals = errObj && typeof errObj === "object" ? Object.values(errObj).filter((v) => typeof v === "string" && v.trim().length > 0).join("; ") : "";
						ocAjaxError = (msg || errVals || "OpenCart comment submission error").slice(0, 220);
					}
				}
			} catch {}
		}
		const effectiveError = ocAjaxError ?? postVerify.openCartErrorNotice;
		const effectiveSuccess = ocAjaxSuccess ?? postVerify.openCartSuccessNotice;
		if (effectiveError && !effectiveSuccess) {
			if (/captcha|verification\s+code|验证码/iu.test(effectiveError)) return {
				kind: "comment_publish",
				page: ref,
				outcome: "blocked_captcha",
				siteType: "opencart",
				title: postTitle,
				finalUrl: postSubmitUrl,
				postSubmitUrl,
				postSubmitSnippet: effectiveError,
				templateSignature: "opencart:captcha_error",
				suggestedTags: ["has_captcha"],
				evidence: `OpenCart 提交返回验证码校验失败: ${effectiveError}`,
				submitTriggered: false
			};
			return {
				kind: "comment_publish",
				page: ref,
				outcome: "uncertain_after_submit",
				siteType: "opencart",
				title: postTitle,
				finalUrl: postSubmitUrl,
				postSubmitUrl,
				postSubmitSnippet: effectiveError,
				evidence: `OpenCart 评论提交返回错误提示: ${effectiveError}`,
				submitTriggered: true
			};
		}
		if (effectiveSuccess) {
			const modNotice = matchModerationNotice(effectiveSuccess) ?? (/webmaster|approval|moderation|pending|review|审核/iu.test(effectiveSuccess) ? effectiveSuccess : void 0);
			if (modNotice) return {
				kind: "comment_publish",
				page: ref,
				outcome: "submitted",
				siteType: "opencart",
				title: postTitle,
				finalUrl: postSubmitUrl || command.url,
				publicUrl: postSubmitUrl || command.url,
				postSubmitUrl,
				postSubmitSnippet: effectiveSuccess,
				evidence: `OpenCart 评论已提交等待审核 (${modNotice})`,
				submitTriggered: true
			};
			let finalOcVerify = postVerify;
			let finalOcUrl = postSubmitUrl || command.url;
			if (verifyReload) try {
				await navigateCommentPageWithCommit(page, command.url, {
					timeoutMs,
					domReadyWaitMs: Math.min(3e3, timeoutMs),
					sleep,
					signal
				});
				await scrollPageStep(page, 1);
				const reloadCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
				finalOcUrl = reloadCheck.currentUrl;
				finalOcVerify = reloadCheck.verify;
			} catch (error) {
				throwIfAborted$2(signal);
				if (!isTimeoutError(error)) throw error;
			}
			const finalOcTitle = await page.title().catch(() => postTitle);
			if (finalOcVerify.liveLinkFound) return {
				kind: "comment_publish",
				page: ref,
				outcome: "live",
				siteType: "opencart",
				title: finalOcTitle,
				finalUrl: finalOcUrl,
				publicUrl: finalOcUrl,
				postSubmitUrl,
				postSubmitSnippet: effectiveSuccess,
				evidence: `OpenCart 评论公开页核验通过: ${finalOcVerify.matchedAnchor || finalOcVerify.matchedHref || finalOcUrl}`,
				submitTriggered: true
			};
			return {
				kind: "comment_publish",
				page: ref,
				outcome: "submitted",
				siteType: "opencart",
				title: finalOcTitle,
				finalUrl: finalOcUrl,
				publicUrl: finalOcUrl,
				postSubmitUrl,
				postSubmitSnippet: effectiveSuccess,
				evidence: `OpenCart 评论提交已收到站方成功回执 (${effectiveSuccess})`,
				submitTriggered: true
			};
		}
	}
	const redirectedLocationWithCommentId = capturedResponses.map((c) => c.headers.location ?? c.headers.Location ?? "").find((loc) => /#comment-\d+\b/iu.test(loc));
	const redirectedModerationUrl = capturedResponses.flatMap((c) => [c.url, c.headers.location ?? c.headers.Location ?? ""]).find((u) => hasWpModerationUrlParams(u));
	const assignedCommentUrl = /#comment-\d+\b/iu.test(postSubmitUrl) ? postSubmitUrl : redirectedLocationWithCommentId ? (() => {
		try {
			return new URL(redirectedLocationWithCommentId, command.url).toString();
		} catch {
			return redirectedLocationWithCommentId;
		}
	})() : void 0;
	const assignedCommentIdNum = extractCommentNumericId(assignedCommentUrl);
	const hasHttpErrorResponse = capturedResponses.some((c) => c.status >= 400 && (c.isWpEndpoint || c.isPost));
	const hasNewCommentIdAssigned = Boolean(siteType === "wordpress" && assignedCommentIdNum !== void 0 && assignedCommentIdNum > maxExistingCommentId && preSubmitCommentIdNum !== assignedCommentIdNum && !hasHttpErrorResponse && !postVerify.wpErrorMessage && !postVerify.captchaDetected);
	const cleanPublicUrl = /wp-comments-post\.php/iu.test(postSubmitUrl) ? assignedCommentUrl ? stripWpModerationParams(assignedCommentUrl) : command.url : stripWpModerationParams(postSubmitUrl);
	const hasModerationUrlParam = hasWpModerationUrlParams(postSubmitUrl) || Boolean(redirectedModerationUrl);
	if (Boolean(postVerify.moderationNotice || hasModerationUrlParam)) {
		const modTitle = await page.title().catch(() => inspection.title);
		const modReason = postVerify.moderationNotice ? void 0 : "wp_unapproved_redirect";
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType,
			title: modTitle,
			finalUrl: cleanPublicUrl,
			publicUrl: cleanPublicUrl,
			...modReason === void 0 ? {} : { reason: modReason },
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: `${siteLabel} 评论已提交等待审核 (${postVerify.moderationNotice ?? "unapproved/moderation-hash redirect"})`,
			submitTriggered: true
		};
	}
	const postHasCommentIdLink = Boolean(postCommentId && (postVerify.commentNodeLinkFound || postVerify.liveLinkFound));
	let finalVerify = postVerify;
	let finalUrl = cleanPublicUrl;
	if (verifyReload) {
		let reloadTimedOut = false;
		try {
			await page.goto(cleanPublicUrl, {
				timeout: timeoutMs,
				waitUntil: "commit"
			});
			if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: Math.min(5e3, timeoutMs) }).catch(() => void 0);
		} catch (error) {
			throwIfAborted$2(signal);
			if (!isTimeoutError(error)) throw error;
			reloadTimedOut = true;
		}
		if (!reloadTimedOut) {
			await scrollPageStep(page, 1);
			const reloadCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
			finalUrl = reloadCheck.currentUrl;
			finalVerify = reloadCheck.verify;
			if (hasNewCommentIdAssigned && !finalVerify.liveLinkFound && !finalVerify.moderationNotice && !finalVerify.escapedHtmlDetected && !finalVerify.wpErrorMessage) try {
				const cacheBustUrl = appendCacheBustParam(cleanPublicUrl);
				await page.goto(cacheBustUrl, {
					timeout: Math.min(8e3, timeoutMs),
					waitUntil: "commit"
				});
				if (typeof page.waitForLoadState === "function") await page.waitForLoadState("domcontentloaded", { timeout: Math.min(4e3, timeoutMs) }).catch(() => void 0);
				await scrollPageStep(page, 1);
				const cbCheck = await safeVerifyResult(page, command, timeoutMs, sleep, signal);
				if (cbCheck.verify.liveLinkFound || cbCheck.verify.moderationNotice) {
					finalVerify = cbCheck.verify;
					finalUrl = cleanPublicUrl;
				}
			} catch (cbError) {
				throwIfAborted$2(signal);
			}
		} else finalVerify = {
			liveLinkFound: false,
			escapedHtmlDetected: postVerify.escapedHtmlDetected,
			...postVerify.moderationNotice === void 0 ? {} : { moderationNotice: postVerify.moderationNotice },
			...postVerify.wpErrorMessage === void 0 ? {} : { wpErrorMessage: postVerify.wpErrorMessage },
			...postVerify.captchaDetected === void 0 ? {} : { captchaDetected: postVerify.captchaDetected },
			...postVerify.snippet === void 0 ? {} : { snippet: postVerify.snippet }
		};
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
	if (finalVerify.moderationNotice || hasWpModerationUrlParams(finalUrl)) {
		const cleanFinalUrl = stripWpModerationParams(finalUrl);
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType,
			title: finalTitle,
			finalUrl: cleanFinalUrl,
			publicUrl: cleanFinalUrl,
			...finalVerify.moderationNotice ? {} : { reason: "wp_unapproved_redirect" },
			postSubmitUrl,
			evidence: `${siteLabel} 评论已提交等待审核 (${finalVerify.moderationNotice ?? "unapproved/moderation-hash redirect"})`,
			submitTriggered: true
		};
	}
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
	if (hasNewCommentIdAssigned && !finalVerify.wpErrorMessage && !finalVerify.captchaDetected) {
		const preservedCommentUrl = assignedCommentUrl ? stripWpModerationParams(assignedCommentUrl) : cleanPublicUrl;
		return {
			kind: "comment_publish",
			page: ref,
			outcome: "submitted",
			siteType,
			title: finalTitle,
			finalUrl: preservedCommentUrl,
			publicUrl: preservedCommentUrl,
			reason: "wp_new_comment_id_assigned",
			postSubmitUrl,
			...postSubmitSnippet === void 0 ? {} : { postSubmitSnippet },
			evidence: `${siteLabel} 已由服务端分配全新评论 ID (#comment-${assignedCommentIdNum} > 提交前最大 ID ${maxExistingCommentId}) 且无报错，公开页暂未显现可能受全页缓存或审核队列影响，回写 submitted (wp_new_comment_id_assigned)`,
			submitTriggered: true
		};
	}
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
	const stepTimeout = (capMs = DEFAULT_COMMENT_STEP_TIMEOUT_MS) => resolveStepTimeoutMs(options.timeoutMs, options.deadlineAt, capMs);
	let activeDetail = detail;
	if (detail.identitySelectSelector && detail.supportsNameUrlIdentity && (command.authorName || command.websiteUrl)) {
		const idLocator = bloggerFrame.locator(detail.identitySelectSelector).first();
		if (typeof idLocator.selectOption === "function") {
			await idLocator.selectOption("NAMEURL", { timeout: stepTimeout() }).catch(() => void 0);
			const refreshed = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
			if (refreshed) activeDetail = refreshed;
		}
	}
	const hasAnonUrl = activeDetail.anonUrlSelector !== void 0;
	const commentLocator = bloggerFrame.locator(activeDetail.commentSelector ?? detail.commentSelector).first();
	if (activeDetail.commentIsContentEditable) {
		const stripped = stripHtmlLinkForRichEditor(command.commentText, command.anchorText, command.websiteUrl);
		const bodyText = !hasAnonUrl && stripped.websiteUrl && !stripped.plainText.toLowerCase().includes(stripped.websiteUrl.toLowerCase()) ? `${stripped.plainText} ${stripped.websiteUrl}`.trim() : stripped.plainText;
		if (typeof commentLocator.click === "function") await commentLocator.click({ timeout: stepTimeout() }).catch(() => void 0);
		await commentLocator.fill(bodyText, { timeout: stepTimeout() });
	} else {
		const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasAnonUrl);
		await commentLocator.fill(body, { timeout: stepTimeout() });
	}
	if (activeDetail.anonNameSelector && command.authorName?.trim()) await bloggerFrame.locator(activeDetail.anonNameSelector).first().fill(command.authorName.trim(), { timeout: stepTimeout() });
	if (activeDetail.anonUrlSelector && command.websiteUrl?.trim()) await bloggerFrame.locator(activeDetail.anonUrlSelector).first().fill(command.websiteUrl.trim(), { timeout: stepTimeout() });
	const refreshedAfterFill = await bloggerFrame.evaluate(INSPECT_BLOGGER_FRAME_SCRIPT).catch(() => null);
	if (refreshedAfterFill?.submitSelector) activeDetail = {
		...activeDetail,
		submitSelector: refreshedAfterFill.submitSelector
	};
	if (!activeDetail.submitSelector) return buildFallbackResult(ref, "blogger", inspection, "Blogger 评论框已填充但未定位到 Publish 按钮，转交 LLM 接管（未触发提交）");
	const bloggerSubmitLocator = bloggerFrame.locator(activeDetail.submitSelector).first();
	if (await isLocatorDisabled(bloggerSubmitLocator, stepTimeout())) return buildFallbackResult(ref, "blogger", inspection, "Blogger 评论 Publish 按钮处于 disabled 状态 (submit_button_disabled)，未点击提交，转交 LLM 核查", "submit_button_disabled");
	await bloggerSubmitLocator.click({ timeout: stepTimeout() });
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
	const deadlineMs = command.deadlineMs ?? options.deadlineMs;
	const deadlineAt = deadlineMs !== void 0 && deadlineMs > 0 ? Date.now() + deadlineMs : void 0;
	const stepTimeout = (capMs = DEFAULT_COMMENT_STEP_TIMEOUT_MS) => resolveStepTimeoutMs(timeoutMs, deadlineAt, capMs);
	const isWixHint = command.siteHint === "wix_blog" || /\.wixsite\.com\b/iu.test(command.url);
	const navTimeoutMs = isWixHint ? Math.max(timeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS) : Math.max(timeoutMs, DEFAULT_COMMENT_NAV_TIMEOUT_MS);
	const verifyReload = command.verifyReload !== false;
	const probeOnly = command.probeOnly === true;
	const autoGoogleSso = command.autoGoogleSso !== false;
	const baseLazyWaitMaxMs = Math.min(options.lazyWaitMaxMs ?? 2500, timeoutMs);
	const wixWaitCeiling = Math.max(timeoutMs, DEFAULT_WIX_LAZY_WAIT_MAX_MS);
	const wixLazyWaitMaxMs = Math.min(options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 2e4, wixWaitCeiling);
	const wixExpandWaitMaxMs = Math.min(options.wixExpandWaitMaxMs ?? 4e3, timeoutMs);
	const wixPostSubmitWaitMs = Math.min(options.wixPostSubmitWaitMs ?? 2500, timeoutMs);
	const sleep = options.sleepImpl ?? defaultSleep$1;
	const routablePage = page;
	const resourceRouteHandler = async (route) => {
		const req = typeof route.request === "function" ? route.request() : void 0;
		if (shouldAbortCommentPublishRequest(typeof req?.url === "function" ? req.url() : "", typeof req?.resourceType === "function" ? req.resourceType() : "")) {
			await route.abort?.().catch(() => void 0);
			return;
		}
		await route.continue?.().catch(() => void 0);
	};
	let resourceRouteInstalled = false;
	if (typeof routablePage.route === "function") try {
		await routablePage.route("**/*", resourceRouteHandler);
		resourceRouteInstalled = true;
	} catch {
		resourceRouteInstalled = false;
	}
	try {
		throwIfAborted$2(options.signal);
		if (isWixHint) await navigateWixWithCommit(page, command.url, {
			timeoutMs: navTimeoutMs,
			...options.wixDomReadyWaitMs === void 0 ? {} : { domReadyWaitMs: options.wixDomReadyWaitMs },
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		else await navigateCommentPageWithCommit(page, command.url, {
			timeoutMs: navTimeoutMs,
			...options.nonWixDomReadyWaitMs === void 0 ? {} : { domReadyWaitMs: options.nonWixDomReadyWaitMs },
			...options.largeWpFormWaitMaxMs === void 0 ? {} : { largeWpFormWaitMaxMs: options.largeWpFormWaitMaxMs },
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		throwIfAborted$2(options.signal);
		const inspectOpts = {
			timeoutMs,
			...options.contextRetryDelayMs === void 0 ? {} : { contextRetryDelayMs: options.contextRetryDelayMs },
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		};
		let inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
		let completedFullLazyWait = false;
		if (!inspection.wordpress.found && inspection.wordpress.reviewsTabSelector) {
			await dismissBlockingOverlays(page, stepTimeout());
			await (await resolveFirstVisibleLocator(page, inspection.wordpress.reviewsTabSelector)).click({ timeout: stepTimeout() }).catch(() => void 0);
			await sleep(Math.min(350, stepTimeout()), options.signal);
			inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
		}
		if (!hasActionableCommentSurface(inspection)) {
			let activeWaitMaxMs = inspection.isWix || isWixHint ? wixLazyWaitMaxMs : baseLazyWaitMaxMs;
			const startAt = Date.now();
			let deadline = startAt + activeWaitMaxMs;
			let maxPolls = activeWaitMaxMs > 0 ? Math.max(1, Math.ceil(activeWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 0;
			let exitedEarly = false;
			let lastScrollHeight = inspection.scrollHeight ?? 0;
			for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
				throwIfAborted$2(options.signal);
				const isWixFlow = inspection.isWix || isWixHint;
				const steps = isWixFlow ? WIX_PROGRESSIVE_SCROLL_STEPS : DEFAULT_PROGRESSIVE_SCROLL_STEPS;
				const fraction = steps[Math.min(poll, steps.length - 1)];
				const observedHeight = await scrollPageStep(page, fraction, isWixFlow);
				const heightGrew = observedHeight > lastScrollHeight;
				if (observedHeight > 0) lastScrollHeight = observedHeight;
				if (isWixFlow && (poll === 0 || heightGrew || poll === steps.length - 1)) {
					if (typeof page.keyboard?.press === "function") await page.keyboard.press("End").catch(() => void 0);
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
				const prevIsWix = inspection.isWix;
				inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
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
		if (!inspection.wordpress.found && inspection.wordpress.reviewsTabSelector) {
			await dismissBlockingOverlays(page, stepTimeout());
			await (await resolveFirstVisibleLocator(page, inspection.wordpress.reviewsTabSelector)).click({ timeout: stepTimeout() }).catch(() => void 0);
			await sleep(Math.min(350, stepTimeout()), options.signal);
			inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
		}
		if (!inspection.wordpress.found && inspection.wordpress.collapsedTriggerSelector) {
			await dismissBlockingOverlays(page, stepTimeout());
			await (await resolveFirstVisibleLocator(page, inspection.wordpress.collapsedTriggerSelector)).click({ timeout: stepTimeout() }).catch(() => void 0);
			await sleep(Math.min(400, stepTimeout()), options.signal);
			inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
		}
		if (inspection.wordpress.found) return await submitAndVerifyStandardForm(page, ref, "wordpress", "WordPress", inspection, inspection.wordpress, command, {
			timeoutMs,
			...deadlineAt === void 0 ? {} : { deadlineAt },
			verifyReload,
			probeOnly,
			sleep,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		if (inspection.genericComment?.found) {
			const gc = inspection.genericComment;
			return await submitAndVerifyStandardForm(page, ref, gc.kind === "valine" ? "valine" : gc.kind === "typecho" ? "typecho" : gc.kind === "opencart" ? "opencart" : "other", gc.kind === "valine" ? "Valine" : gc.kind === "typecho" ? "Typecho" : gc.kind === "opencart" ? "OpenCart" : "博客评论", inspection, gc, command, {
				timeoutMs,
				...deadlineAt === void 0 ? {} : { deadlineAt },
				verifyReload,
				probeOnly,
				sleep,
				...options.signal === void 0 ? {} : { signal: options.signal }
			});
		}
		if (inspection.hasBloggerCommentIframe || inspection.childFrames?.bloggerFrameUrl) {
			const bloggerResult = await executeBloggerCommentIframe(page, ref, inspection, command, {
				timeoutMs,
				...deadlineAt === void 0 ? {} : { deadlineAt },
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
			let wixSsoAttempted = false;
			const tryWixAutoSsoOrNeedsLogin = async (defaultEvidence) => {
				if (inspection.wix.signupRecaptchaAlways) return buildWixSignupRecaptchaBlockedResult(ref, inspection, "Wix 评论区为会员登录模板且页面源码启用 signupRecaptchaOption=\"ALWAYS\" (wix_signup_recaptcha_always)，未登录注册/Google SSO 必遇人机验证，未尝试绕过");
				if (autoGoogleSso && !probeOnly && !wixSsoAttempted) {
					wixSsoAttempted = true;
					const ssoOutcome = await attemptWixAutoGoogleSso(page, ref, inspection, {
						timeoutMs,
						...options.wixSsoPopupTimeoutMs === void 0 ? {} : { wixSsoPopupTimeoutMs: options.wixSsoPopupTimeoutMs },
						...options.wixSsoCompleteWaitMs === void 0 ? {} : { wixSsoCompleteWaitMs: options.wixSsoCompleteWaitMs },
						sleep,
						...options.signal === void 0 ? {} : { signal: options.signal }
					});
					if (ssoOutcome.status === "terminal") return ssoOutcome.result;
					if (ssoOutcome.status === "logged_in") {
						inspection = ssoOutcome.inspection;
						return null;
					}
					inspection = ssoOutcome.inspection;
					const noteSuffix = ssoOutcome.note ? `（自动 Google SSO 未完成: ${ssoOutcome.note}）` : "";
					return buildNeedsLoginResult(ref, "wix", inspection, `${defaultEvidence}${noteSuffix}`);
				}
				return buildNeedsLoginResult(ref, "wix", inspection, defaultEvidence);
			};
			if (inspection.wix.captchaDetected || hasEffectiveWixChildFrameCaptcha(inspection, inspection.childFrames)) return {
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
			if (inspection.wix.loginRequired) {
				const loginHandled = await tryWixAutoSsoOrNeedsLogin("Wix 评论区为会员登录模板（检测到登录按钮且无访客 Name/Email 字段），未触发 Publish，请先登录或走 Google SSO");
				if (loginHandled !== null) return loginHandled;
			}
			const expandWixCommentPlaceholder = async () => {
				if (inspection.wix.loginRequired || inspection.wix.hasGuestEditor || !inspection.wix.triggerSelector) return null;
				await dismissBlockingOverlays(page, timeoutMs);
				const triggerLocator = await resolveFirstVisibleLocator(page, inspection.wix.triggerSelector);
				let clickError;
				try {
					const scrollableTrigger = triggerLocator;
					if (typeof scrollableTrigger.scrollIntoViewIfNeeded === "function") await scrollableTrigger.scrollIntoViewIfNeeded({ timeout: Math.min(3e3, timeoutMs) }).catch(() => void 0);
					await triggerLocator.click({ timeout: stepTimeout() });
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
					inspection = await safeInspectCommentPageWithFrames(page, inspectOpts);
					if (inspection.wix.captchaDetected || hasEffectiveWixChildFrameCaptcha(inspection, inspection.childFrames)) return {
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
						if (inspection.wix.signupRecaptchaAlways) return buildWixSignupRecaptchaBlockedResult(ref, inspection, "展开 Wix 评论区后触发会员登录且页面源码启用 signupRecaptchaOption=\"ALWAYS\" (wix_signup_recaptcha_always)，未登录注册/Google SSO 必遇人机验证，未尝试绕过");
						if (!sawLoginWithoutCaptcha && poll + 1 < expandMaxPolls) {
							sawLoginWithoutCaptcha = true;
							continue;
						}
						const loginHandled = await tryWixAutoSsoOrNeedsLogin("展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish");
						if (loginHandled !== null) return loginHandled;
						break;
					}
					if (inspection.wix.hasGuestEditor && inspection.wix.editorSelector) break;
				}
				if (inspection.wix.captchaDetected || hasEffectiveWixChildFrameCaptcha(inspection, inspection.childFrames)) return {
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
				if (inspection.wix.loginRequired) {
					const loginHandled = await tryWixAutoSsoOrNeedsLogin("展开 Wix 评论区后识别为会员登录模板（存在登录按钮且无访客 Name/Email 输入框，未检测到 CAPTCHA），绝不盲点 Publish");
					if (loginHandled !== null) return loginHandled;
				}
				return null;
			};
			for (let expandPass = 0; expandPass < 2; expandPass++) {
				if (inspection.wix.loginRequired || inspection.wix.hasGuestEditor || !inspection.wix.triggerSelector) break;
				const expandHandled = await expandWixCommentPlaceholder();
				if (expandHandled !== null) return expandHandled;
				if (!wixSsoAttempted) break;
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
				if (inspection.wix.signupRecaptchaAlways && !inspection.wix.isBlogListPage) return buildWixSignupRecaptchaBlockedResult(ref, inspection, "Wix 博客文章页未挂载已登录评论编辑器且页面源码启用 signupRecaptchaOption=\"ALWAYS\" (wix_signup_recaptcha_always)，未登录注册/Google SSO 必遇人机验证，未尝试绕过");
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
				await dismissBlockingOverlays(page, stepTimeout());
				const editorLocator = await resolveFirstVisibleLocator(page, editorSelector);
				if (stripped.websiteUrl && !hasWebsiteField && wix.linkButtonSelector) {
					await editorLocator.click({ timeout: stepTimeout() });
					await editorLocator.fill(stripped.plainText, { timeout: stepTimeout() });
					if (!await selectTextInRichEditor(page, editorSelector, stripped.anchorText ?? stripped.websiteUrl)) return buildFallbackResult(ref, "wix", inspection, "Wix 富文本编辑器内未匹配到待加链锚文本片段，转交 LLM 处理（未触发提交）");
					await page.locator(wix.linkButtonSelector).first().click({ timeout: stepTimeout() });
					if (!await applyWixLinkPopover(page, stripped.websiteUrl, stepTimeout(), wix.submitSelector)) return buildFallbackResult(ref, "wix", inspection, "点击 Wix 链接按钮后未检测到链接 URL 输入框，转交 LLM 处理（未触发提交）");
				} else if (stripped.websiteUrl && !hasWebsiteField) {
					const textWithUrl = stripped.plainText.toLowerCase().includes(stripped.websiteUrl.toLowerCase()) ? stripped.plainText : `${stripped.plainText} ${stripped.websiteUrl}`.trim();
					await editorLocator.click({ timeout: stepTimeout() });
					await editorLocator.fill(textWithUrl, { timeout: stepTimeout() });
					if (typeof editorLocator.press === "function") await editorLocator.press("Space", { timeout: stepTimeout() }).catch(() => void 0);
					else if (typeof page.keyboard?.press === "function") await page.keyboard.press("Space").catch(() => void 0);
					await sleep(Math.min(250, stepTimeout()), options.signal);
					let linked = await checkRichEditorHasLink(page, editorSelector, stripped.websiteUrl);
					if (!linked) {
						const hasAnchorInPlain = Boolean(stripped.anchorText && stripped.plainText.toLowerCase().includes(stripped.anchorText.toLowerCase()));
						let anchorToSelect = stripped.websiteUrl;
						if (hasAnchorInPlain && stripped.anchorText) {
							await editorLocator.fill(stripped.plainText, { timeout: stepTimeout() });
							anchorToSelect = stripped.anchorText;
						}
						if (await selectTextInRichEditor(page, editorSelector, anchorToSelect)) {
							await sleep(Math.min(150, stepTimeout()), options.signal);
							const toolbarProbe = await page.evaluate(FIND_WIX_RCE_TOOLBAR_LINK_SCRIPT).catch(() => ({
								found: false,
								selector: void 0
							}));
							let popoverOpened = false;
							if (toolbarProbe.found && toolbarProbe.selector) {
								await (await resolveFirstVisibleLocator(page, toolbarProbe.selector)).click({ timeout: stepTimeout() }).catch(() => void 0);
								await sleep(Math.min(150, stepTimeout()), options.signal);
								popoverOpened = await resolveWixLinkUrlInputLocator(page) !== void 0;
							}
							if (!popoverOpened) for (const shortcut of ["Control+k", "Meta+k"]) {
								if (typeof editorLocator.press === "function") await editorLocator.press(shortcut, { timeout: stepTimeout() }).catch(() => void 0);
								else if (typeof page.keyboard?.press === "function") await page.keyboard.press(shortcut).catch(() => void 0);
								await sleep(Math.min(150, stepTimeout()), options.signal);
								if (await resolveWixLinkUrlInputLocator(page) !== void 0) {
									popoverOpened = true;
									break;
								}
							}
							if (popoverOpened) {
								if (await applyWixLinkPopover(page, stripped.websiteUrl, stepTimeout(), wix.submitSelector)) {
									await sleep(Math.min(200, stepTimeout()), options.signal);
									linked = await checkRichEditorHasLink(page, editorSelector, stripped.websiteUrl);
								}
							}
						}
					}
					if (!linked) return buildFallbackResult(ref, "wix", inspection, "Wix 富文本评论框输入目标 URL 并补发 Space 及尝试 RCE 工具栏插链后仍未确认 <a href> 超链（避免发布无链评论，未触发提交）", "wix_rce_no_autolink", "wix:rce_no_autolink");
				} else {
					await editorLocator.click({ timeout: stepTimeout() });
					await editorLocator.fill(stripped.plainText, { timeout: stepTimeout() });
				}
			} else {
				const body = buildWpCommentContent(command.commentText, command.websiteUrl, command.anchorText, hasWebsiteField);
				await (await resolveFirstVisibleLocator(page, editorSelector)).fill(body, { timeout: stepTimeout() });
			}
			if (wix.nameSelector && command.authorName?.trim()) await page.locator(wix.nameSelector).first().fill(command.authorName.trim(), { timeout: stepTimeout() });
			if (wix.emailSelector && command.authorEmail?.trim()) await page.locator(wix.emailSelector).first().fill(command.authorEmail.trim(), { timeout: stepTimeout() });
			if (wix.websiteSelector && command.websiteUrl?.trim()) await page.locator(wix.websiteSelector).first().fill(command.websiteUrl.trim(), { timeout: stepTimeout() });
			if (!wix.submitSelector) return buildFallbackResult(ref, "wix", inspection, "Wix 评论框已填充但未定位到 Publish/Submit 按钮，转交 LLM 接管（未触发提交）");
			await dismissBlockingOverlays(page, stepTimeout());
			const wixSubmitLocator = await resolveFirstVisibleLocator(page, wix.submitSelector);
			if (await isLocatorDisabled(wixSubmitLocator, stepTimeout())) {
				const loginProbe = await inspectDisabledSubmitLoginPrompt(page);
				if (loginProbe.hasLoginPrompt) {
					if (inspection.wix.signupRecaptchaAlways) return buildWixSignupRecaptchaBlockedResult(ref, inspection, `Wix 评论提交按钮处于 disabled 状态、页面提示需要登录 (${loginProbe.matchedText ?? "login required"}) 且启用 signupRecaptchaOption="ALWAYS" (wix_signup_recaptcha_always)，未尝试绕过`);
					return buildNeedsLoginResult(ref, "wix", inspection, `Wix 评论提交按钮处于 disabled 状态且页面提示需要登录 (${loginProbe.matchedText ?? "login required"})，未点击提交`, loginProbe.loginInfo);
				}
				return buildFallbackResult(ref, "wix", inspection, "Wix 评论提交按钮处于 disabled 状态 (submit_button_disabled)，未点击提交，转交 LLM 核查", "submit_button_disabled");
			}
			await wixSubmitLocator.click({ timeout: stepTimeout() });
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
				if (postDialog.hasCaptcha || hasEffectiveWixChildFrameCaptcha(inspection, postFrames)) return {
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
				if (postDialog.hasLoginDialog) {
					if (inspection.wix.signupRecaptchaAlways || postDialog.signupRecaptchaAlways) return buildWixSignupRecaptchaBlockedResult(ref, inspection, "点击 Wix Publish 后弹出 Sign Up / Log in 登录窗口且页面启用 signupRecaptchaOption=\"ALWAYS\" (wix_signup_recaptcha_always)，未登录注册/Google SSO 必遇人机验证，未尝试绕过", {
						finalUrl: page.url(),
						title: await page.title().catch(() => inspection.title)
					});
					return buildNeedsLoginResult(ref, "wix", inspection, "点击 Wix Publish 后弹出 Sign Up / Log in 登录窗口，非乐观成功，请先登录后再发表", postDialog.loginInfo, page.url());
				}
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
				await navigateWixWithCommit(page, stripWpModerationParams(command.url), {
					timeoutMs: Math.max(timeoutMs, DEFAULT_WIX_NAV_TIMEOUT_MS),
					...options.wixDomReadyWaitMs === void 0 ? {} : { domReadyWaitMs: options.wixDomReadyWaitMs },
					sleep,
					...options.signal === void 0 ? {} : { signal: options.signal }
				});
				const reloadWaitCeiling = Math.max(timeoutMs, DEFAULT_WIX_RELOAD_VERIFY_WAIT_MS);
				const reloadWaitMaxMs = Math.min(options.wixReloadVerifyWaitMs ?? options.wixLazyWaitMaxMs ?? options.lazyWaitMaxMs ?? 1e4, reloadWaitCeiling);
				const reloadDeadline = Date.now() + reloadWaitMaxMs;
				const reloadMaxPolls = reloadWaitMaxMs > 0 ? Math.max(1, Math.ceil(reloadWaitMaxMs / LAZY_POLL_INTERVAL_MS)) : 1;
				let lastReloadScrollHeight = await scrollPageStep(page, 1, true);
				if (typeof page.keyboard?.press === "function") await page.keyboard.press("End").catch(() => void 0);
				finalVerify = (await safeVerifyResult(page, command, timeoutMs, sleep, options.signal)).verify;
				for (let poll = 0; poll < reloadMaxPolls && Date.now() < reloadDeadline && !finalVerify.liveLinkFound && !finalVerify.moderationNotice && !finalVerify.escapedHtmlDetected; poll++) {
					throwIfAborted$2(options.signal);
					const remaining = reloadDeadline - Date.now();
					if (remaining <= 0) break;
					await sleep(Math.min(LAZY_POLL_INTERVAL_MS, remaining), options.signal);
					const nextReloadHeight = await scrollPageStep(page, 1, true);
					const heightGrew = nextReloadHeight > lastReloadScrollHeight;
					if (nextReloadHeight > 0) lastReloadScrollHeight = nextReloadHeight;
					if ((heightGrew || poll === 0 || poll % 3 === 0) && typeof page.keyboard?.press === "function") await page.keyboard.press("End").catch(() => void 0);
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
	} finally {
		if (resourceRouteInstalled && typeof routablePage.unroute === "function") await routablePage.unroute("**/*", resourceRouteHandler).catch(() => void 0);
	}
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
const DEFAULT_DIRECTORY_STEP_TIMEOUT_MS = 7e3;
const INSPECT_DIRECTORY_AUTOFILL_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));

  const isCaptchaResponseField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const name = String(el.getAttribute('name') || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    return name === 'g-recaptcha-response'
      || name === 'h-captcha-response'
      || name === 'cf-turnstile-response'
      || id === 'g-recaptcha-response'
      || id.startsWith('g-recaptcha-response-')
      || id === 'h-captcha-response'
      || id.startsWith('h-captcha-response-');
  };

  const isElementShown = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return false;
    if (isCaptchaResponseField(el)) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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
const INSPECT_AUTOFILL_CONFIRM_DIALOG_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeCss = value => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(value)
    : String(value).replace(/([^\w-])/g, '\\$1');

  const docRect = document.documentElement && typeof document.documentElement.getBoundingClientRect === 'function'
    ? document.documentElement.getBoundingClientRect()
    : null;
  const hasRealLayout = !!(docRect && (docRect.width > 0 || docRect.height > 0));

  const isShown = (el) => {
    if (!el || el.nodeType !== 1) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hidden) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    if (hasRealLayout && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    }
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
async function resolveFirstVisibleDirectoryLocator(page, selector) {
	const base = page.locator(selector);
	const probe = base;
	if (typeof probe.count === "function" && typeof probe.nth === "function") {
		const total = await probe.count().catch(() => 0);
		if (total > 1) {
			const limit = Math.min(total, 15);
			for (let i = 0; i < limit; i++) {
				const candidate = probe.nth(i);
				const nameAttr = typeof candidate.getAttribute === "function" ? (await candidate.getAttribute("name").catch(() => null))?.toLowerCase() ?? "" : "";
				if (nameAttr === "g-recaptcha-response" || nameAttr === "h-captcha-response" || nameAttr === "cf-turnstile-response") continue;
				if (typeof candidate.isVisible === "function" ? await candidate.isVisible().catch(() => false) : false) return candidate;
			}
		}
	}
	return base.first();
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
	const deadlineMs = command.deadlineMs ?? options.deadlineMs;
	const deadlineAt = deadlineMs !== void 0 && deadlineMs > 0 ? Date.now() + deadlineMs : void 0;
	const stepTimeout = () => {
		let budget = Math.min(timeoutMs, DEFAULT_DIRECTORY_STEP_TIMEOUT_MS);
		if (deadlineAt !== void 0) budget = Math.min(budget, Math.max(1, deadlineAt - Date.now()));
		return Math.max(1, Math.floor(budget));
	};
	const waitAfterFetchMs = Math.min(command.waitAfterFetchMs ?? options.waitAfterFetchMs ?? 4e3, Math.max(timeoutMs, 1e4));
	const sleep = options.sleepImpl ?? defaultSleep;
	throwIfAborted$1(options.signal);
	if (command.url !== void 0) {
		const navTimeout = deadlineAt !== void 0 ? Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())) : timeoutMs;
		await page.goto(command.url, {
			timeout: navTimeout,
			waitUntil: "domcontentloaded"
		});
		throwIfAborted$1(options.signal);
	}
	await dismissBlockingOverlays(page, stepTimeout());
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
	if (inspection.loginRequired) {
		const reasonNote = inspection.loginReason ? ` (${inspection.loginReason})` : "";
		return {
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
			evidence: `目录提交页需要登录${reasonNote}（请使用 snapshot format="interactive" 检查 Google SSO 或邮箱登录）`
		};
	}
	if (inspection.fields.length === 0 && !inspection.autofillButtonSelector) return {
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
	let autofillConfirmClicked = false;
	let autofillConfirmLabel;
	const urlField = inspection.fields.find((f) => f.role === "url");
	if (urlField && command.websiteUrl.trim().length > 0) {
		await (await resolveFirstVisibleDirectoryLocator(page, urlField.selector)).fill(command.websiteUrl.trim(), { timeout: stepTimeout() });
		filledFields.push("url");
		inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
		if (!inspection.autofillButtonSelector && inspection.autofillButtonDisabled) {
			await sleep(Math.min(250, stepTimeout()), options.signal);
			inspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
		}
	}
	const tryClickConfirmDialog = async () => {
		const dialog = await page.evaluate(INSPECT_AUTOFILL_CONFIRM_DIALOG_SCRIPT).catch(() => ({ detected: false }));
		if (!dialog?.detected || !dialog.buttonSelector) return false;
		if (dialog.urlInputSelector && (!dialog.urlInputValue || dialog.urlInputValue.length === 0) && command.websiteUrl.trim().length > 0) {
			await (await resolveFirstVisibleDirectoryLocator(page, dialog.urlInputSelector)).fill(command.websiteUrl.trim(), { timeout: stepTimeout() }).catch(() => void 0);
			if (!filledFields.includes("url")) filledFields.push("url");
		}
		await (await resolveFirstVisibleDirectoryLocator(page, dialog.buttonSelector)).click({ timeout: stepTimeout() });
		autofillConfirmClicked = true;
		autofillConfirmLabel = dialog.buttonLabel || "Confirm";
		return true;
	};
	if (inspection.autofillButtonSelector && (urlField || command.websiteUrl.trim().length > 0)) {
		const preValues = new Map(inspection.fields.filter((f) => f.role === "name" || f.role === "tagline" || f.role === "description").map((f) => [f.role, f.value]));
		await dismissBlockingOverlays(page, stepTimeout());
		await (await resolveFirstVisibleDirectoryLocator(page, inspection.autofillButtonSelector)).click({ timeout: stepTimeout() });
		autofillTriggered = true;
		await tryClickConfirmDialog();
		let deadline = Date.now() + waitAfterFetchMs;
		const maxPolls = waitAfterFetchMs > 0 ? Math.max(1, Math.ceil(waitAfterFetchMs / AUTOFILL_POLL_INTERVAL_MS)) : 1;
		for (let poll = 0; poll < maxPolls + (autofillConfirmClicked ? 1 : 0) && (poll === 0 || Date.now() < deadline); poll++) {
			throwIfAborted$1(options.signal);
			const remaining = deadline - Date.now();
			if (remaining > 0) await sleep(Math.min(AUTOFILL_POLL_INTERVAL_MS, remaining), options.signal);
			if (!autofillConfirmClicked && await tryClickConfirmDialog()) {
				deadline = Date.now() + waitAfterFetchMs;
				continue;
			}
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
			await (await resolveFirstVisibleDirectoryLocator(page, field.selector)).fill(value, { timeout: stepTimeout() });
			filledFields.push(role);
		}
	}
	const finalInspection = await page.evaluate(INSPECT_DIRECTORY_AUTOFILL_SCRIPT);
	const fieldStates = toFieldStates(finalInspection.fields);
	const remainingRequired = [...fieldStates.filter((f) => f.required && !f.filled).map((f) => `${f.role}(${f.selector})`), ...finalInspection.extraRequiredEmpty];
	const outcome = remainingRequired.length === 0 && fieldStates.some((f) => f.filled) ? "ready_to_submit" : "partial_filled";
	const confirmNote = autofillConfirmClicked ? `二次确认:${autofillConfirmLabel ?? "Confirm"}, ` : "";
	const summaryBits = [
		autofillTriggered ? `autofill触发(${confirmNote}回填:${autofilledFields.join(",") || "无"})` : "常规目录填表",
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
		...autofillConfirmClicked ? { autofillConfirmClicked: true } : {},
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
const RECYCLE_PAGE_IO_TIMEOUT_MS = 3e3;
var BrowserDeadlineError = class extends BrowserError {
	action;
	pageRef;
	deadlineMs;
	elapsedMs;
	pageRecycled;
	constructor(params) {
		super(`browser ${params.action} exceeded hard deadline (${params.deadlineMs}ms)`, "BROWSER_TIMEOUT");
		this.name = "BrowserDeadlineError";
		this.action = params.action;
		this.pageRef = params.pageRef;
		this.deadlineMs = params.deadlineMs;
		this.elapsedMs = params.elapsedMs;
		this.pageRecycled = params.pageRecycled;
	}
};
async function settleWithTimeout(promise, timeoutMs, fallback) {
	let timer;
	try {
		return await Promise.race([promise.catch(() => fallback), new Promise((resolve) => {
			timer = setTimeout(() => resolve(fallback), timeoutMs);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
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
const CAPTCHA_RESPONSE_FIELD_PATTERN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/iu;
async function isCaptchaResponseLocator(locator) {
	const probe = locator;
	if (typeof probe.getAttribute !== "function") return false;
	const [nameAttr, idAttr] = await Promise.all([probe.getAttribute("name").catch(() => null), probe.getAttribute("id").catch(() => null)]);
	return Boolean(nameAttr && CAPTCHA_RESPONSE_FIELD_PATTERN.test(nameAttr.trim()) || idAttr && CAPTCHA_RESPONSE_FIELD_PATTERN.test(idAttr.trim()));
}
/**
* Resolve a visible, non-CAPTCHA-response locator when `nth` is omitted so hidden
* modals and hidden `textarea[name="g-recaptcha-response"]` fields never trigger
* strict-mode conflicts while preserving exact unique visible selectors and
* multi-visible strict-mode diagnostics.
*/
async function resolvePreferredVisibleLocator(locator, nth) {
	if (nth !== void 0) return locator;
	const probe = locator;
	if (typeof probe.count !== "function" || typeof probe.nth !== "function") return locator;
	const total = await probe.count().catch(() => 0);
	if (!Number.isFinite(total) || total <= 0) return locator;
	if (total === 1) {
		if (await isCaptchaResponseLocator(probe.nth(0))) throw new BrowserError("skipped hidden captcha response field (g-recaptcha-response / h-captcha-response)", "BROWSER_ACTION_FAILED");
		return locator;
	}
	const limit = Math.min(total, 20);
	const visibleMatches = [];
	for (let index = 0; index < limit; index++) {
		const candidate = probe.nth(index);
		if (await isCaptchaResponseLocator(candidate)) continue;
		if (typeof candidate.isVisible === "function" ? await candidate.isVisible().catch(() => false) : false) visibleMatches.push(candidate);
	}
	if (visibleMatches.length === 1) return visibleMatches[0];
	return locator;
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
		const next = previous.then(() => this.executeWithDeadline(command, signal));
		store(next.catch(() => void 0));
		return next;
	}
	async recyclePage(ref) {
		if (this.closed) return false;
		let targetRef = ref;
		let targetPage = targetRef !== void 0 ? this.pages.get(targetRef) : void 0;
		if (targetPage === void 0 && targetRef === void 0) {
			if (this.lastRef !== void 0) {
				targetRef = this.lastRef;
				targetPage = this.pages.get(this.lastRef);
			}
			if (targetPage === void 0) {
				const fallbackRef = this.findFallbackBusinessRef();
				if (fallbackRef !== void 0) {
					targetRef = fallbackRef;
					targetPage = this.pages.get(fallbackRef);
				}
			}
		}
		if (targetRef === void 0 || targetPage === void 0) return false;
		this.removePageMapping(targetRef, targetPage);
		if (typeof targetPage.isClosed === "function" && targetPage.isClosed()) return true;
		try {
			if (this.context.pages().filter((p) => !p.isClosed()).filter((p) => p !== targetPage).length === 0 && typeof this.context.newPage === "function") {
				const blank = await settleWithTimeout(this.createInternalPage().then((p) => p), RECYCLE_PAGE_IO_TIMEOUT_MS, void 0);
				if (blank !== void 0) {
					this.keeperPage = blank;
					blank.on("close", () => {
						if (this.keeperPage === blank) this.keeperPage = void 0;
					});
				}
			}
		} catch {}
		if (typeof targetPage.close === "function") await settleWithTimeout(targetPage.close().then(() => true), RECYCLE_PAGE_IO_TIMEOUT_MS, false);
		return true;
	}
	async executeWithDeadline(command, signal) {
		const deadlineMs = command.deadlineMs;
		if (deadlineMs === void 0 || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return await this.execute(command, signal);
		const startedAt = Date.now();
		const controller = new AbortController();
		const onExternalAbort = () => {
			controller.abort();
		};
		if (signal?.aborted) controller.abort();
		else if (signal) signal.addEventListener("abort", onExternalAbort, { once: true });
		const execPromise = this.execute(command, controller.signal);
		execPromise.catch(() => void 0);
		let timer;
		const timeoutMarker = Symbol("deadline_exceeded");
		try {
			const raced = await Promise.race([execPromise, new Promise((resolve) => {
				timer = setTimeout(() => resolve(timeoutMarker), deadlineMs);
			})]);
			if (raced !== timeoutMarker) return raced;
			controller.abort();
			const pageRef = command.page ?? this.lastRef ?? "p1";
			const pageRecycled = await this.recyclePage(command.page);
			const elapsedMs = Date.now() - startedAt;
			if (command.kind === "comment_publish") return {
				kind: "comment_publish",
				page: pageRef,
				outcome: "timeout",
				retryable: true,
				reason: "tool_deadline_exceeded",
				siteType: command.siteHint === "wix_blog" ? "wix" : command.siteHint === "wordpress_comment" ? "wordpress" : command.siteHint === "typecho_comment" ? "typecho" : "other",
				title: "",
				finalUrl: command.url,
				submitTriggered: false,
				pageRecycled,
				deadlineMs,
				elapsedMs,
				evidence: `comment_publish 超过硬截止 ${deadlineMs}ms，已自动回收卡死页签 (pageRecycled=${String(pageRecycled)})`
			};
			throw new BrowserDeadlineError({
				action: command.kind,
				pageRef,
				deadlineMs,
				elapsedMs,
				pageRecycled
			});
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onExternalAbort);
		}
	}
	async execute(command, signal) {
		throwIfAborted(signal, command.kind);
		try {
			switch (command.kind) {
				case "navigate": {
					const { page, ref } = await this.resolveForNavigate(command.page);
					const baseTimeout = command.timeoutMs ?? this.defaultTimeoutMs;
					const isWixHint = command.siteHint === "wix_blog";
					const timeout = isWixHint ? Math.max(baseTimeout, DEFAULT_WIX_NAV_TIMEOUT_MS) : baseTimeout;
					const requestedWaitUntil = command.waitUntil;
					if (requestedWaitUntil === void 0 && isWixHint) await navigateWixWithCommit(page, command.url, {
						timeoutMs: timeout,
						...signal === void 0 ? {} : { signal }
					});
					else if (requestedWaitUntil === void 0) await page.goto(command.url, {
						timeout,
						waitUntil: "domcontentloaded"
					});
					else try {
						await page.goto(command.url, {
							timeout,
							waitUntil: requestedWaitUntil
						});
					} catch (error) {
						if (requestedWaitUntil !== "domcontentloaded" && requestedWaitUntil !== "commit" && NAVIGATE_TIMEOUT_PATTERN.test(String(error instanceof Error ? error.message : error))) {
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
						const locator = await resolvePreferredVisibleLocator(elementLocator(page, addressing, command.nth), command.nth);
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
					const locator = await resolvePreferredVisibleLocator(elementLocator(page, parseSelector(command.selector), command.nth), command.nth);
					await this.runLocatorAction("fill", locator, () => locator.fill(command.value, { timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "select": {
					const { page } = await this.requirePage(command.page);
					const locator = await resolvePreferredVisibleLocator(elementLocator(page, parseSelector(command.selector), command.nth), command.nth);
					await this.runLocatorAction("select", locator, () => locator.selectOption(command.value, { timeout: this.defaultTimeoutMs }));
					return { kind: "acked" };
				}
				case "check": {
					const { page } = await this.requirePage(command.page);
					const locator = await resolvePreferredVisibleLocator(elementLocator(page, parseSelector(command.selector), command.nth), command.nth);
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
						...command.deadlineMs === void 0 ? {} : { deadlineMs: command.deadlineMs },
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
						...command.deadlineMs === void 0 ? {} : { deadlineMs: command.deadlineMs },
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
