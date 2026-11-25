# Backlinks Publisher MCP Rules

You operate the `backlinks` and `browser` MCP tools provided by `backlinks-publisher`.

## One-Page High-Efficiency Execution Cheat Sheet (v2.3 Fast-Path)

> **Zero-Startup-Bloat Directive**: Do **NOT** run `ls` / `find` on workspace/plugin directories and do **NOT** call `read_file` on large schema JSONs or `references/*` playbooks on startup. Use the minimal parameter quick-reference below directly; inspect `references/*` only for unusual auth/edge failures.

### Minimal Tool Parameter Quick-Reference

| Tool & Action | Key Parameters |
| --- | --- |
| `backlinks batch_list` | `onlyPending: true`, `compact: true`, `websiteId?`, `limit: 20` |
| `backlinks batch_preflight` | `batchId`, `autoSkip: true`, `autoSkipTagged: true`, `autoSkipToxic: true` (default), `autoFailWaf: true` |
| `backlinks batch_get` | `batchId`, `compact: true`, `pendingOnly: true` |
| `backlinks batch_claim` | `batchId`, `itemIds: [...]` (5–6 surviving IDs) |
| `backlinks item_result` | `itemId`, `status` (`live`/`submitted`/`failed`/`skipped`), `publicUrl?`, `anchorText?`, `targetUrl?`, `failureMode?`, `failureReason?`, `skipReason?`, `templateSignature?`, `evidence` |
| `backlinks source_tags` | `sourceId`, `tags: [...]` |
| `browser comment_publish` | `url`, `commentText`, `authorName?`, `authorEmail?`, `websiteUrl?`, `anchorText?`, `siteHint?`, `autoGoogleSso?: true`, `verifyReload?: true`, `page?` |
| `browser directory_autofill` | `url?`, `websiteUrl`, `name?`, `tagline?`, `description?`, `email?`, `page?` |
| `browser batch_fill` | `fields: [{ target, op?, value?, nth? }]`, `submitTarget?`, `submitNth?`, `page?` |

1. **Zero-LLM Preflight**: `backlinks action="batch_preflight"` (`batchId`, `autoSkip: true`, `autoSkipTagged: true`, `autoSkipToxic: true`, `autoFailWaf: true`).
   - **Toxic Backlink Pre-Filter (`autoSkipToxic: true` by default)**: detects high-confidence adult/gambling domains, URL paths, and `<title>` (strict word boundaries; safe on `vue slot` / `essex`), reports `toxicBlocked`, auto-skips with `toxic_site: ...`, and non-fatally tags `low_quality`.
   - Sniffs full page (≤128KB) or head 32KB + tail 64KB; detects `/go/` redirects (`rootSubmitHint`), HTTP 507 dead sites, `wixSignupRecaptchaAlways`, and path-prefix + mid-slug n-gram `timeoutClusters`.
   - `waf_403`-tagged items are held out by default (`heldForManual`); `autoFailWaf: true` marks new + held `waf_403` items `failed(manual_required)`.
   - Read `runnableItems: [{ itemId, domain, siteHint, rootSubmitHint?, wixSignupRecaptchaAlways? }]`.
2. **Fetch Batch Once & Low-Runnable Multi-Batch Relay**: `batch_list` (`websiteId` filter) + `batch_get` (`compact: true`, `pendingOnly: true`) once per batch for `website` profile, `anchors`, and `publishedSourceIds`.
   - **Low `runnable <= 5` Relay Rule**: when a batch's `batch_preflight` yields `runnable <= 5`, finish those surviving items, call `lease_release`, and relay directly into the next pending batch within the same 10–12 item session budget (never end a session after just 1–3 items if more pending batches exist).
3. **Sharded Claim**: `backlinks action="batch_claim"` ONLY from `runnableItemIds` (5–6 items/slice, serial per `sourceHost`; 10–12 items / 2 slices per session across 1 or relayed small batches).
4. **Deterministic Fast-Paths (`comment_publish` & `directory_autofill`)**:
   - Blogs (`wordpress_comment` / `typecho_comment` / `wix_blog` / `comments_closed_hint` / Valine / Blogger / custom blogs): call **`browser action="comment_publish"`** in **1 call**.
     - **Non-Wix `commit` Nav + Resource Blocking**: non-Wix sites use `waitUntil: 'commit'` (15s default, respects higher `timeoutMs`) + lightweight blocking of `image`/`media`/`font`/ads (never blocks `document`/`stylesheet`/`xhr`/`fetch` or Wix/OAuth/CAPTCHA domains), always unrouted in `finally`. Automatically waits 2000ms and retries once on `Execution context was destroyed`.
     - **WordPress New `#comment-ID` & `wp_die` 403**: records pre-submit max `#comment-ID`; post-submit redirect to a brand-new `#comment-<newId>` without error (even behind full-page cache) returns `submitted` (`wp_new_comment_id_assigned`) with `#comment-<newId>` preserved, alongside expanded multilingual moderation (EN/FR/ES/DE/IT/PT/TR/RU/JA/ZH/FA/TH) and a lightweight cache-bust recheck. HTTP 403 WordPress `wp_die` validation errors (e.g. missing rating) return `needs_llm_fallback` (`wp_die_validation_error`), cleanly separated from WAF 403 `blocked_waf`.
     - **Wix One-Click Google SSO (`autoGoogleSso: true` default)**: on Wix `needs_login` without CAPTCHA/`signupRecaptchaOption=ALWAYS`, internally clicks login → re-checks CAPTCHA → clicks multilingual Google SSO → drives Account Chooser / Consent popup → resumes commenting & reload verification. Immediately aborts on `"Looks like there was a technical issue"` as `manual_required` (`templateSignature: "wix:google_sso_technical_issue"`, never retry).
     - **Valine & Multilingual Submit**: recognizes Valine (`input.vnick`/`vmail`/`vlink`, `textarea.veditor`, `button.vsubmit`, verifying LeanCloud `POST .../classes/Comment` 201 or reload `.first()` `a.vnick`) and multilingual buttons (TR `GÖNDER`, ES, FR, DE, IT, PT, RU, JA, ZH).
   - Map `comment_publish.outcome` directly:
     - `live` → `item_result(live, publicUrl)`
     - `submitted` → `item_result(submitted, publicUrl)` (incl. `wp_new_comment_id_assigned`, `post_submit_comment_id_cached` & multilingual moderation)
     - `comments_closed` → `item_result(skipped, skipReason)` + `source_tags(["评论关闭"])`
     - `no_form` → `item_result(skipped, skipReason)` + `source_tags(["no_form"])`
     - `blocked_captcha` → `bringToFront`, `item_result(failed, manual_required, templateSignature)` + `source_tags(["has_captcha"])` (never bypass CAPTCHA!)
     - `blocked_waf` → `item_result(failed, manual_required, templateSignature)` + `source_tags(["waf_403"])` (HTTP 403/406/429 WAF block on submit; NEVER retry submit!)
     - `manual_required` → `item_result(failed, manual_required, templateSignature)` (e.g. `wix:google_sso_technical_issue` fast circuit breaker — NEVER retry!)
     - `needs_login` → Wix/Blogger member wall when auto Google SSO is unavailable/stopped (e.g. password/MFA); inspect `loginInfo` + `snapshot format="interactive"`.
     - `uncertain_after_submit` → **`item_result(failed, manual_required)` (IDEMPOTENT: NEVER retry submit! Check `reason`/`postSubmitUrl`/`postSubmitSnippet`)**
     - `needs_llm_fallback` → tab is already at `finalUrl` with `formSummary` + `bottomSnapshot` (check `reason`, e.g. `wp_die_validation_error` or `submit_button_disabled`); continue without re-navigating!
   - Directories (MkDirs / AI-Autofill submit pages): call **`browser action="directory_autofill"`** (`url`, `websiteUrl`, `name`, `tagline`, `description`, `email`) — automatically filters `:visible` elements & skips hidden modals/CAPTCHA fields.
5. **Fallback Form Flow, `:visible` Safety, OAuth Popups & Compact Snapshots**:
   - `batch_fill` automatically skips hidden elements & `g-recaptcha-response`/`h-captcha-response` when `nth` is omitted, and captures `submitFeedback` when `submitTarget` is passed.
   - `snapshot` defaults to **compact mode (4,500 chars)**: collapses `<select>` >15 options, exempts status/success/error keywords, and shows `input[type=url]` + distinct `#id`/`[name=]` selectors. Pass `full: true` (up to 16,000) only when needed.
   - OAuth popups (`window.open`): `click` returns `popupPageRef` / `openedPages`; use `listPages` to inspect open tabs & popups. Closing a popup (`closePage`) never invalidates your original named tab ref.
   - `navigate` defaults to `domcontentloaded` (or `commit` 20s when `siteHint: "wix_blog"`). Use `wait_for_login` for manual logins.
6. **Closeout**: `source_tags` maps `comments_closed` → `评论关闭` automatically and degrades 5xx non-fatally. Heartbeat every 1–2 items and always `lease_release` when done.

## Credential Isolation & Safety

- Always use a dedicated `smag_` Supermanager agent token scoped to Antigravity; never copy or share a DeepSeek Harness runtime token across environments.
- Never print, echo, or store tokens or site account passwords in tool arguments, evidence notes, or user-visible summaries.
- `CLOUDMAIL_TOKEN` is checked lazily: Supermanager batch actions (`batch_list`, `batch_get`, `batch_preflight`, `batch_claim`, `lease_heartbeat`, `lease_release`, `item_result`, `badge_add`, `badge_deactivate`, `source_tags`) and `badge_verify` work without it; only `mailbox_create` and `mail_wait` require it.

## Pre-flight, Global Tag Filtering & Session Hygiene

- **Mandatory Step 0 (`batch_preflight`)**: Before claiming any slice (`batch_claim`), always run `backlinks action="batch_preflight"` with `batchId`, `autoSkip: true`, `autoSkipTagged: true`, `autoFailWaf: true` (default `timeoutMs: 5000`, `concurrency: 6`). This probes pending URLs via lightweight HTTP without starting Chrome or spending LLM tokens, reads server-computed `sourceTags`/`blockingTags`, extracts `runnableItems[].siteHint` (`wordpress_comment` / `wix_blog` / `comments_closed_hint` / `directory_or_form` / `other`), auto-skips & tags `dead_site` on definitive `404`/`410`/persistent `5xx`/DNS/TLS/paused-or-parked pages via lease-safe `POST /api/agent/batches/{batchId}/preflight-skip`, holds out `waf_403`-tagged items by default (`heldForManual`, pass `skipSoftTagged: true` to also hold `has_captcha`/`submitmatic_verify_fail` or `false` to re-probe), marks new/held `waf_403` items `failed(manual_required)` when `autoFailWaf: true`, and auto-skips hard-blocked sources.
- **Standard blocking tags**: Use these exact canonical tag names in `source_tags` immediately after `item_result`:
  - Hard-skip tags (auto-skipped at preflight when `autoSkipTagged: true`): `paid_only`, `no_form`, `dead_site`, `comments_closed` (mapped outbound to `评论关闭` for live Supermanager compatibility).
  - Caution/soft tags: `has_captcha` (reCAPTCHA / SecureImg / Turnstile / math captcha), `waf_403` (CloudFront / Cloudflare 403), `submitmatic_verify_fail`.
  - Descriptive tags remain allowed alongside them (`免徽章`, `要徽章`, `可复用`).
  - Live Supermanager 5xx tolerance: `source_tags` automatically falls back to safe Chinese aliases on 5xx and degrades non-fatally with a warning if 5xx persists, never interrupting `item_result`.
- **`batch_list` filtering & pagination**: Defaults to `onlyPending: true`, `compact: true`, `limit: 20`, `offset: 0` (keeps output ~2–5 KB). Pass `onlyPending: false` or `offset` only when you specifically need completed/historical batches.
- **`batch_get` compact mode & pagination**: Keep `compact: true` (default) to read `website` profile & `anchors` once per batch; pass `pendingOnly: true` for large batches (`publishedSourceIds` is always computed across the full batch). Never re-run `batch_get` or re-read unchanged reference files mid-session.
- **Session item budget**: Process **10–12 items (2 shards × 5–6 items, hard cap 15 items)** per `agy` conversation. If pending items remain after 10–12 items, finish the active shard, call `lease_release`, summarize completed vs remaining counts, and advise starting a fresh `agy` session.
- **Sharded claiming**: Pass explicit surviving `itemIds` (5–6 items per slice, from `batch_preflight.runnableItemIds`) to `batch_claim`. Keep same-domain (`sourceHost`) items serial.
- **Lease lifecycle**: Call `lease_heartbeat` every 1–2 items (~30–60s) while working, and always call `lease_release` when a slice finishes or pauses.
- **Multi-field forms**: Use `browser` with `action: "batch_fill"` (`fields` + optional `submitTarget`) to fill an entire form in one round-trip instead of separate `fill`/`select`/`click` calls.
- **Human login waiting**: Never loop `snapshot` calls from the LLM to wait for a human login. Call `browser` with `action: "wait_for_login"` (which automatically brings the Chrome window into view and polls inside Node.js until `urlContains`, `urlNotContains`, or `selector` matches).
- **Reciprocal badge verification & rollback**: Never shell out to `bash`, `powershell`, `curl`, or `grep` for footer badge refresh/verification. Use `backlinks` with `action: "badge_verify"` (`siteUrl`, `expectedTarget`, optional `refreshUrl`).

## Backlinks Integrity, Badge Rollback & Circuit Breaker Rules

- **Verify before publishing**: Never claim or re-submit an item whose `publishStatus` is `submitted`/`live` or whose `publishedUrl` is non-empty, or any other item sharing the same `sourceId` as an already-published item in the batch. If an existing link to the promoted site is found on the target site during inspection, report `item_result` `skipped`.
- **Reciprocal badge rollback iron rule**: After calling `badge_add` and `badge_verify`, if the target site's `Verify Badge` check fails and you abandon submission, **you MUST immediately call `backlinks action="badge_deactivate"`** (`badgeId`, optional `websiteId`, optional `refreshUrl`; uses idempotent `PATCH/DELETE /api/agent/badges/{badgeId}` which also fires the refresh callback) so no invalid/orphaned badge remains on the promoted homepage.
- **Same-template circuit breaker (2 consecutive failures)**: When 2 consecutive items in a batch fail with the same template/failure pattern (e.g. `@submitmatic` Verify Badge failures, or blog `SecureImg + reCAPTCHA`), `item_result` / `batch_claim` surfaces `circuitBreaker.tripped: true`. Immediately stop calling `badge_add` or deep-probing remaining matching items in the batch — fast-verify or mark `failed(manual_required)` / `skipped` with reason and standard tag (`submitmatic_verify_fail`, `has_captcha`, etc.).
- **Honest status reporting**: Only report `live` after opening the public (non-preview) URL and confirming a clickable link (`role:link` in `aria` snapshot) with matching anchor text or `targetUrl`. Bare/escaped `<a href=...>` text is not live; report `failed` with `failureMode: "manual_required"` and never re-submit. Unknown submission outcomes must also be reported as `failed` + `manual_required`, never retried blindly.
- **Standard tagging**: Immediately after every blocked/completed `item_result`, call `source_tags` with the applicable standard blocking tags (`paid_only`, `no_form`, `dead_site`, `has_captcha`, `waf_403`, `submitmatic_verify_fail`, `comments_closed`) plus descriptive tags (`免徽章`, `要徽章`, `可复用`).

## Persistent Chrome Browser & Tightened Timeout Rules

- **Fast-fail navigation & timeouts**: `browser navigate` defaults to **10,000ms** (recommend passing `timeoutMs: 8000`–`10000` to fail fast on slow sites). `backlinks mail_wait` defaults to **30,000ms** — if no verification mail arrives within 30s, immediately report `failed(manual_required)` instead of stalling the shard. If login or OAuth hangs for **>15–20s**, stop immediately and report `failed(manual_required)` with no repeated click loops.

- **Tab refs**: `navigate` returns `[page pN]`. Pass `page` on every subsequent call for that tab; omit `page` only for single-tab serial work.
- **Compact reads**: `navigate` returns a concise 3,000-char text summary; `snapshot` (`text`/`aria`/`interactive`) uses **compact mode by default at 4,500 chars** (pruning boilerplate header/nav/footer/SVG bloat while retaining forms, inputs, buttons, comments, auth, and alerts). Pass `full: true` (or explicit `maxChars` up to 16,000) only when a tricky page genuinely requires unpruned DOM details.
- **Selectors & strict-mode avoidance**: Prefer exact `role:button|<exact name>` / `role:link|<exact name>` over broad `text:<substring>` for common buttons (`Submit`, `Sign in`, `Send Code`, `申请入驻`, `发送验证码`), as well as `label:<text>` / `placeholder:<text>`. Prefix `frame(<iframe css>)>>` for iframes; use `xy:<x>,<y>` for icon-only controls when CSS is absent. If Playwright reports a `strict mode violation`, inspect the `[0]`, `[1]`… candidates returned in the error and either pass `nth` (0-based, supported on `click`/`fill`/`select`/`upload`/`waitFor` and `batch_fill` `fields[].nth`/`submitNth`) or switch to an exact `role:` selector.
- **Login walls**: Open the sign-in/register panel and run `snapshot` with `format: "interactive"`. Judge OAuth/Google availability strictly from the complete `sign-in candidates:` line (`signin=google?` counts as a Google candidate too). Never conclude there is no Google sign-in from `text` or `aria` alone or from a truncated snapshot.
- **Window recovery**: Whenever a human must solve a CAPTCHA or sign in manually, call `bringToFront` (or `wait_for_login` with `bringToFront: true`) so Chrome restores into the visible screen area on Windows and macOS.
- **Closing**: Use `closePage` to close finished tabs and `closeBrowser` when wrapping up if the user chose to close the browser on completion (cookies/logins stay persisted in `DSH_BACKLINK_BROWSER_PROFILE`).
