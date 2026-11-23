# Backlinks Publisher MCP Rules

You operate the `backlinks` and `browser` MCP tools provided by `backlinks-publisher`.

## One-Page High-Efficiency Execution Cheat Sheet (v2 Fast-Path)

> **Zero-`read_file` Directive**: This cheat sheet + `SKILL.md` contain everything needed for standard blogs, directories, and forms. **Do NOT call `read_file` on `references/*` playbooks** for normal runs; inspect `references/*` only for unusual auth/edge failures.

1. **Zero-LLM Preflight**: `backlinks action="batch_preflight"` (`batchId`, `autoSkip: true`, `autoSkipTagged: true`, `autoFailWaf: true`).
   - `waf_403`-tagged items are held out by default (`heldForManual` / `skippedByTag.softItemIds`); `autoFailWaf: true` marks new + held `waf_403` items `failed(manual_required)` so pending queues never loop.
   - Read `runnableItems: [{ itemId, domain, siteHint }]` (`wordpress_comment` / `wix_blog` / `comments_closed_hint` / `directory_or_form` / `other`).
2. **Fetch Batch Once**: `backlinks action="batch_get"` (`batchId`, `compact: true`, `pendingOnly: true`) once per batch for `website` profile, `anchors`, and `publishedSourceIds`. Never re-fetch or re-read reference docs mid-session.
3. **Sharded Claim**: `backlinks action="batch_claim"` ONLY from `runnableItemIds` (5–6 items/slice, serial per `sourceHost`; 10–12 items / 2 slices per session).
4. **Deterministic Fast-Path (`comment_publish`)**:
   - For `siteHint` in `["wordpress_comment", "wix_blog", "comments_closed_hint"]` (or any blog post), call **`browser action="comment_publish"`** directly in **1 call** (`url`, `commentText`, `authorName`, `authorEmail`, `websiteUrl`, `anchorText`, optional `page`).
   - Map `comment_publish.outcome` directly:
     - `live` → `item_result(live, publicUrl)`
     - `submitted` → `item_result(submitted, publicUrl)`
     - `comments_closed` → `item_result(skipped, skipReason)` + `source_tags(["评论关闭"])`
     - `no_form` → `item_result(skipped, skipReason)` + `source_tags(["no_form"])`
     - `blocked_captcha` → `bringToFront`, `item_result(failed, manual_required, templateSignature)` + `source_tags(["has_captcha"])` (never bypass CAPTCHA!)
     - `uncertain_after_submit` → **`item_result(failed, manual_required)` (IDEMPOTENT: NEVER retry submit!)**
     - `needs_llm_fallback` → tab is already at `finalUrl` with `formSummary` and compact `bottomSnapshot` (Wix complex/list pages, unexpanded `comment-box-placeholder`, child-frame widgets, or `Log in to publish as a member` without CAPTCHA never auto-tag `no_form`); inspect `bottomSnapshot` first (open a recent `/post/` article if on a blog index, or run `snapshot format="interactive"` on login modal for Google SSO) and continue without re-navigating!
5. **Fallback Form Flow & Compact Snapshots**:
   - `snapshot` defaults to **compact mode (4,500 chars)** pruning nav/header/footer/SVG bloat while preserving forms/inputs/buttons/alerts. Pass `full: true` (up to 16,000 chars) only when essential controls are missing.
   - Use `batch_fill` for multi-field forms and `wait_for_login` for manual logins.
6. **Closeout**: `source_tags` maps `comments_closed` → `评论关闭` automatically for live Supermanager compatibility and degrades 5xx non-fatally (never blocks `item_result`). Heartbeat every 1–2 items and always `lease_release` when done.

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
