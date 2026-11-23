# Backlinks Publisher MCP Rules

You operate the `backlinks` and `browser` MCP tools provided by `backlinks-publisher`.

## Credential Isolation & Safety

- Always use a dedicated `smag_` Supermanager agent token scoped to Antigravity; never copy or share a DeepSeek Harness runtime token across environments.
- Never print, echo, or store tokens or site account passwords in tool arguments, evidence notes, or user-visible summaries.
- `CLOUDMAIL_TOKEN` is checked lazily: Supermanager batch actions (`batch_list`, `batch_get`, `batch_claim`, `lease_heartbeat`, `lease_release`, `item_result`, `badge_add`, `source_tags`) and `badge_verify` work without it; only `mailbox_create` and `mail_wait` require it.

## Token-Saving & Batch Execution Discipline

- **`batch_get` compact mode**: Keep `compact: true` (default) to avoid redundant payload bloat; pass `compact: false` only if raw uncompacted fields are specifically required.
- **Sharded claiming**: When executing a batch, pass explicit `itemIds` (1–5 items per slice) to `batch_claim` rather than locking an entire large batch at once. Keep same-domain (`sourceHost`) items serial.
- **Lease lifecycle**: Call `lease_heartbeat` every 1–2 items (~30–60s) while working, and always call `lease_release` when a slice finishes or pauses.
- **Multi-field forms**: Use `browser` with `action: "batch_fill"` (`fields` + optional `submitTarget`) to fill an entire form in one round-trip instead of separate `fill`/`select`/`click` calls.
- **Human login waiting**: Never loop `snapshot` calls from the LLM to wait for a human login. Call `browser` with `action: "wait_for_login"` (which automatically brings the Chrome window into view and polls inside Node.js until `urlContains`, `urlNotContains`, or `selector` matches).
- **Reciprocal badge verification**: Never shell out to `bash`, `powershell`, `curl`, or `grep` for footer badge refresh/verification. Use `backlinks` with `action: "badge_verify"` (`siteUrl`, `expectedTarget`, optional `refreshUrl`).

## Backlinks Integrity Rules

- **Verify before publishing**: Never claim or re-submit an item whose `publishStatus` is `submitted`/`live` or whose `publishedUrl` is non-empty, or any other item sharing the same `sourceId` as an already-published item in the batch. If an existing link to the promoted site is found on the target site during inspection, report `item_result` `skipped`.
- **Honest status reporting**: Only report `live` after opening the public (non-preview) URL and confirming a clickable link (`role:link` in `aria` snapshot) with matching anchor text or `targetUrl`. Bare/escaped `<a href=...>` text is not live; report `failed` with `failureMode: "manual_required"` and never re-submit. Unknown submission outcomes must also be reported as `failed` + `manual_required`, never retried blindly.
- **Tagging**: After `item_result`, call `source_tags` with observed tags (`免徽章`, `要徽章`, `可复用`, `有盾`, `付费`).

## Persistent Chrome Browser Rules

- **Tab refs**: `navigate` returns `[page pN]`. Pass `page` on every subsequent call for that tab; omit `page` only for single-tab serial work.
- **Compact reads**: `navigate` returns a concise 3,000-char text summary; use `snapshot` (`format: "aria"`, default 16,000 chars) when you need full element structure.
- **Selectors**: Prefer semantic addressing (`role:<role>|<name>`, `label:<text>`, `placeholder:<text>`, `text:<text>`) over bare CSS; prefix `frame(<iframe css>)>>` for iframes; use `xy:<x>,<y>` for icon-only controls when CSS is absent.
- **Login walls**: Open the sign-in/register panel and run `snapshot` with `format: "interactive"`. Judge OAuth/Google availability strictly from the complete `sign-in candidates:` line (`signin=google?` counts as a Google candidate too). Never conclude there is no Google sign-in from `text` or `aria` alone or from a truncated snapshot.
- **Window recovery**: Whenever a human must solve a CAPTCHA or sign in manually, call `bringToFront` (or `wait_for_login` with `bringToFront: true`) so Chrome restores into the visible screen area on Windows and macOS.
- **Closing**: Use `closePage` to close finished tabs and `closeBrowser` when wrapping up if the user chose to close the browser on completion (cookies/logins stay persisted in `DSH_BACKLINK_BROWSER_PROFILE`).
