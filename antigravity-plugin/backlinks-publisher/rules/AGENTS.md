# Backlinks Publisher MCP Rules

You operate the `backlinks` and `browser` MCP tools provided by `backlinks-publisher`.

## Credential Isolation & Safety

- Always use a dedicated `smag_` Supermanager agent token scoped to Antigravity; never copy or share a DeepSeek Harness runtime token across environments.
- Never print, echo, or store tokens or site account passwords in tool arguments, evidence notes, or user-visible summaries.
- `CLOUDMAIL_TOKEN` is checked lazily: Supermanager batch actions (`batch_list`, `batch_get`, `batch_preflight`, `batch_claim`, `lease_heartbeat`, `lease_release`, `item_result`, `badge_add`, `badge_deactivate`, `source_tags`) and `badge_verify` work without it; only `mailbox_create` and `mail_wait` require it.

## Pre-flight, Global Tag Filtering & Session Hygiene

- **Mandatory Step 0 (`batch_preflight`)**: Before claiming any slice (`batch_claim`), always run `backlinks action="batch_preflight"` with `batchId`, `autoSkip: true`, `autoSkipTagged: true` (default `timeoutMs: 5000`, `concurrency: 6`). This probes pending URLs via lightweight HTTP without starting Chrome or spending LLM tokens, auto-skips & tags `dead_site` on definitive `404`/`410`/persistent `5xx`/DNS/TLS/paused-or-parked pages (`Vercel Deployment Paused`, `suspendedpage.cgi`, `Account Suspended`, `Domain for Sale`), flags CloudFront/WAF `403` as `waf_403` (never misclassified as `dead_site`), and auto-skips items already carrying hard blocking tags.
- **Standard blocking tags**: Use these exact canonical tag names in `source_tags` immediately after `item_result`:
  - Hard-skip tags (auto-skipped at preflight when `autoSkipTagged: true`): `paid_only`, `no_form`, `dead_site`, `comments_closed`.
  - Caution/soft tags: `has_captcha` (reCAPTCHA / SecureImg / Turnstile / math captcha), `waf_403` (CloudFront / Cloudflare 403), `submitmatic_verify_fail`.
  - Descriptive tags remain allowed alongside them (`免徽章`, `要徽章`, `可复用`).
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
- **Reciprocal badge rollback iron rule**: After calling `badge_add` and `badge_verify`, if the target site's `Verify Badge` check fails and you abandon submission, **you MUST immediately call `backlinks action="badge_deactivate"`** (`websiteId`, `badgeId`, optional `refreshUrl`) so no invalid/orphaned badge remains on the promoted homepage.
- **Same-template circuit breaker (2 consecutive failures)**: When 2 consecutive items in a batch fail with the same template/failure pattern (e.g. `@submitmatic` Verify Badge failures, or blog `SecureImg + reCAPTCHA`), `item_result` / `batch_claim` surfaces `circuitBreaker.tripped: true`. Immediately stop calling `badge_add` or deep-probing remaining matching items in the batch — fast-verify or mark `failed(manual_required)` / `skipped` with reason and standard tag (`submitmatic_verify_fail`, `has_captcha`, etc.).
- **Honest status reporting**: Only report `live` after opening the public (non-preview) URL and confirming a clickable link (`role:link` in `aria` snapshot) with matching anchor text or `targetUrl`. Bare/escaped `<a href=...>` text is not live; report `failed` with `failureMode: "manual_required"` and never re-submit. Unknown submission outcomes must also be reported as `failed` + `manual_required`, never retried blindly.
- **Standard tagging**: Immediately after every blocked/completed `item_result`, call `source_tags` with the applicable standard blocking tags (`paid_only`, `no_form`, `dead_site`, `has_captcha`, `waf_403`, `submitmatic_verify_fail`, `comments_closed`) plus descriptive tags (`免徽章`, `要徽章`, `可复用`).

## Persistent Chrome Browser & Tightened Timeout Rules

- **Fast-fail navigation & timeouts**: `browser navigate` defaults to **10,000ms** (recommend passing `timeoutMs: 8000`–`10000` to fail fast on slow sites). `backlinks mail_wait` defaults to **30,000ms** — if no verification mail arrives within 30s, immediately report `failed(manual_required)` instead of stalling the shard. If login or OAuth hangs for **>15–20s**, stop immediately and report `failed(manual_required)` with no repeated click loops.

- **Tab refs**: `navigate` returns `[page pN]`. Pass `page` on every subsequent call for that tab; omit `page` only for single-tab serial work.
- **Compact reads**: `navigate` returns a concise 3,000-char text summary; `snapshot` (`text`/`aria`/`interactive`) defaults to 8,000 chars (below `agy`'s ~10 KB spillover threshold). Pass explicit `maxChars` up to 16,000 only when a tricky page genuinely requires a larger snapshot.
- **Selectors & strict-mode avoidance**: Prefer exact `role:button|<exact name>` / `role:link|<exact name>` over broad `text:<substring>` for common buttons (`Submit`, `Sign in`, `Send Code`, `申请入驻`, `发送验证码`), as well as `label:<text>` / `placeholder:<text>`. Prefix `frame(<iframe css>)>>` for iframes; use `xy:<x>,<y>` for icon-only controls when CSS is absent. If Playwright reports a `strict mode violation`, inspect the `[0]`, `[1]`… candidates returned in the error and either pass `nth` (0-based, supported on `click`/`fill`/`select`/`upload`/`waitFor` and `batch_fill` `fields[].nth`/`submitNth`) or switch to an exact `role:` selector.
- **Login walls**: Open the sign-in/register panel and run `snapshot` with `format: "interactive"`. Judge OAuth/Google availability strictly from the complete `sign-in candidates:` line (`signin=google?` counts as a Google candidate too). Never conclude there is no Google sign-in from `text` or `aria` alone or from a truncated snapshot.
- **Window recovery**: Whenever a human must solve a CAPTCHA or sign in manually, call `bringToFront` (or `wait_for_login` with `bringToFront: true`) so Chrome restores into the visible screen area on Windows and macOS.
- **Closing**: Use `closePage` to close finished tabs and `closeBrowser` when wrapping up if the user chose to close the browser on completion (cookies/logins stay persisted in `DSH_BACKLINK_BROWSER_PROFILE`).
