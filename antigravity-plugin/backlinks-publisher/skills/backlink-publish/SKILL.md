---
name: backlink-publish
description: 本工作区所有"发外链/发布外链/发布批次/跑批次/继续批次"请求的首选且唯一入口：通过 backlinks-publisher MCP 工具（backlinks + browser）从 Supermanager 拉取批次、分片认领租约、在持久化 Chrome 浏览器中自动发布、使用 Cloud-mail 收取验证码、跨平台校验互换徽标，并逐条诚实回写结果与标签。
---

# 外链自动发布（backlink-publish）

你运行的是一套**有纪律的发布流水线**，不是随手发帖。两条铁律高于一切：

1. **幂等**：一个条目只允许一次"最终提交"动作，一个来源对一个网站只发一次——发布前先验证发布记录和状态（见单条目循环第 1 步），已提交/已上线的条目自己跳过，绝不重复发布。提交后拿不到明确回执（结果未知 / `uncertain_after_submit`）时，回写 `failed + manual_required`，**绝不自动重试**。
2. **诚实回写**：`live` 必须是你亲自抓取公开页面并确认包含可点击目标链接后的结论；"提交成功但待审核"只能回写 `submitted`。

## 一页式高效执行速查卡（v2.3 快路径 · 启动严禁 `ls` 扫目录或全量 `read_file`）

> **零启动冗余原则**：本速查卡与下方主流程已覆盖全部常规目录、博客、表单规则与参数。**启动时禁止反复 `ls` 目录，也禁止 `read_file` 庞大的 schema JSON 或 `references/*` 参考手册**，直接按下方极简参数表调用工具；仅在遇到异常登录态或特殊模板问题时按需查阅参考文档。

### 极简参数速查

| 工具动作 | 核心参数 |
| --- | --- |
| `backlinks batch_list` | `onlyPending: true`, `compact: true`, `websiteId?`, `limit: 20` |
| `backlinks batch_preflight` | `batchId`, `autoSkip: true`, `autoSkipTagged: true`, `autoSkipToxic: true`（默认开启）, `autoFailWaf: true` |
| `backlinks batch_get` | `batchId`, `compact: true`, `pendingOnly: true` |
| `backlinks batch_claim` | `batchId`, `itemIds: [...]`（5–6 条存活 ID） |
| `backlinks item_result` | `itemId`, `status` (`live`/`submitted`/`failed`/`skipped`), `publicUrl?`, `anchorText?`, `targetUrl?`, `failureMode?`, `failureReason?`, `skipReason?`, `templateSignature?`, `evidence` |
| `backlinks source_tags` | `sourceId`, `tags: [...]` |
| `browser comment_publish` | `url`, `commentText`, `authorName?`, `authorEmail?`, `websiteUrl?`, `anchorText?`, `siteHint?`, `autoGoogleSso?: true`, `verifyReload?: true`, `page?` |
| `browser directory_autofill` | `url?`, `websiteUrl`, `name?`, `tagline?`, `description?`, `email?`, `page?` |
| `browser batch_fill` | `fields: [{ target, op?, value?, nth? }]`, `submitTarget?`, `submitNth?`, `page?` |

1. **前置预检（1 次）**：`backlinks action="batch_preflight"`（`batchId`、`autoSkip: true`、`autoSkipTagged: true`、`autoSkipToxic: true`、`autoFailWaf: true`）。
   - **毒性外链与付费 PBN 跳转前置拦截**：`autoSkipToxic: true`（默认开启）拦截高危成人/赌博站（`toxicBlocked` + 容错打标 `low_quality`）；已知付费卖链/PBN 跳转目标域（`cvgorilla.com`、`rankwithdaniel.com` 及子域，覆盖原始 URL、`finalUrl`、`<meta http-equiv="refresh">` 与 JS 跳转）归入 `paidRedirectBlocked`，默认自动 `skipped(paid_redirect: <targetHost>)` + 容错打标 `paid_only`（传 `autoSkip: false` 可关闭自动跳过）。
   - HTML 嗅探全读 ≤128KB 或首 32KB + 尾 64KB；识别 `/go/` 外跳（`rootSubmitHint`）、HTTP 507 死站、`wixSignupRecaptchaAlways` 与同路径前缀/中段 slug 词元超时聚类（`timeoutClusters`）。
   - 默认隔离已带 `waf_403` 条目（`heldForManual`），`autoFailWaf: true` 自动标新老 `waf_403` 为 `failed(manual_required)`。
   - 拿到存活清单 `runnableItems: [{ itemId, domain, siteHint, rootSubmitHint?, wixSignupRecaptchaAlways? }]`。
2. **读取批次（仅 1 次）与低存活多批接力**：`batch_list` 支持 `websiteId` 过滤；`batch_get`（`compact: true`, `pendingOnly: true`）一次拿齐 `website` 6 字段、`anchors` 与 `publishedSourceIds`。
   - **低 `runnable <= 5` 多批接力规则**：若当前批次预检后 `runnable <= 5`，跑完这几条并 `lease_release` 后，可在同一会话（10–12 条预算内）直接接力预检并认领下一个待发批次，避免只发 1–3 条就结束会话。
3. **分片认领**：仅从 `runnableItemIds` 挑 **5–6 条** `batch_claim`（同域 `sourceHost` 串行；单会话 10–12 条 / 2 片，允许低存活小批接力）。
4. **博客与目录确定性快路径（`comment_publish` / `directory_autofill`）**：
   - 博客评论（`wordpress_comment` / `typecho_comment` / `wix_blog` / `comments_closed_hint` / Valine / Blogger / 自定义博客）：**直接调用 `browser action="comment_publish"`**。
     - **非 Wix `commit` 导航 + 万级评论 WP 流式容错 + 轻量资源拦截**：非 Wix 站使用 `waitUntil: 'commit'`（默认 15s，尊重更高 `timeoutMs`）并拦截 `image`/`media`/`font`/广告统计域（严禁拦截 `document`/`stylesheet`/`xhr`/`fetch` 与 Wix/OAuth/CAPTCHA 域，`finally` 自动解除）。检测到流式加载或高评论 WP 大页（`readyState === 'loading'` 且 DOM 增长，或 `wp-content`/`.comment-list`/>30 个 `#comment-*`）时动态延长表单等待至最多 15s，一旦 `#commentform`/`#comment` 挂载立刻 `scrollIntoViewIfNeeded()` 进入填表（普通无表单页仍快速早退）。首探遇 `Execution context was destroyed` 自动等 2000ms 重试 1 次。
     - **WordPress 新 `#comment-ID` 判定与 `wp_die` 403 区分**：提交前采集页面最大 `#comment-ID`，提交后若分配全新更大 `#comment-<newId>` 且无报错（即便受全页缓存或审核队列影响），返回 `submitted`（`wp_new_comment_id_assigned`，保留 `#comment-<newId>` 链接），并扩展英/法/西/德/意/葡/土/俄/日/中/波斯/泰语待审词库与轻量 cache-bust 复检。若 HTTP 403 为 `wp_die` 表单校验（如缺评分），返回 `needs_llm_fallback`（`wp_die_validation_error`）而非 `blocked_waf`。
     - **Wix 一键 Google SSO（`autoGoogleSso: true` 默认开启）与已登录占位展开**：无 CAPTCHA / `signupRecaptchaOption=ALWAYS` 的 Wix `needs_login` 自动点击登录 → 复检 CAPTCHA → 点多语言 Google SSO（含韩语 `Google 로그인` 及英/日/中/西/法/德/意/葡/俄）→ 自动接管账号选择/授权同意弹窗 → 登录成功后自动填评发布与重载核验。已登录态（无可见 `login-as-member-text-button`）遇折叠 `[data-hook="comment-box-placeholder"]` 自动先点开展开编辑器再填评（若点开弹出登录墙则立刻转未登录分支，严守未登录禁填红线）。遇 `"Looks like there was a technical issue"` 立即返回 `manual_required`（`templateSignature: "wix:google_sso_technical_issue"`，快速熔断严禁重试）。
     - **Valine 与多语言提交按钮**：支持 Valine（`input.vnick`/`vmail`/`vlink`、`textarea.veditor`、`button.vsubmit`，捕获 LeanCloud `POST .../classes/Comment` 201 或重载 `.first()` 核验 `a.vnick`）及土/西/法/德/意/葡/俄/日/中提交按钮（如 `GÖNDER`）。
   - 返回 `outcome` 映射：
     - `live` → `item_result(live, publicUrl)`
     - `submitted` → `item_result(submitted, publicUrl)`（含 `wp_new_comment_id_assigned`、`post_submit_comment_id_cached` 与多语种待审）
     - `comments_closed` → `item_result(skipped, skipReason)` + `source_tags(["评论关闭"])`
     - `no_form` → `item_result(skipped, skipReason)` + `source_tags(["no_form"])`
     - `blocked_captcha` → `bringToFront`，`item_result(failed, manual_required, templateSignature)` + `source_tags(["has_captcha"])`（绝不绕过验证码）
     - `blocked_waf` → `item_result(failed, manual_required, templateSignature)` + `source_tags(["waf_403"])`（提交被 HTTP 403/406/429 WAF 拦截，绝不重试提交）
     - `manual_required` → `item_result(failed, manual_required, templateSignature)`（如 `wix:google_sso_technical_issue` 快速熔断，严禁重试）
     - `needs_login` → Wix/Blogger 会员墙（未自动登录或遇密码/MFA）；按 `loginInfo` + `snapshot format="interactive"` 处理
     - `uncertain_after_submit` → **`item_result(failed, manual_required)`（严守幂等，绝不重发；查看 `reason`/`postSubmitUrl`/`postSubmitSnippet`）**
     - `needs_llm_fallback` → 页面已打开且附 `formSummary` + `bottomSnapshot`（留意 `reason` 如 `wp_die_validation_error` / `submit_button_disabled`），直接接着操作勿重复 `navigate`！
   - 目录站（MkDirs / AI-Autofill 提交页）：先调 **`browser action="directory_autofill"`**（自动过滤 `:visible` 元素，避开隐藏弹窗与验证码隐藏域）。
5. **非博客/`:visible` 安全/弹窗/回退站点**：
   - `batch_fill` 默认跳过不可见元素与 `g-recaptcha-response`/`h-captcha-response`，传 `submitTarget` 自动返回 `submitFeedback`。
   - `snapshot` 默认**紧凑模式（4,500 字符）**：`>15` 项 `<select>` 自动折叠，状态/成功/错误文案豁免裁剪，`interactive` 补齐 `input[type=url]`；按需传 `full: true`。
   - OAuth 弹窗（`window.open`）：`click` 返回 `popupPageRef` / `openedPages`，`listPages` 列出所有页签与弹窗；关闭弹窗不影响原页签。人工登录用 `wait_for_login`。
6. **回写与打标**：调用 `item_result` + `source_tags`（自动映射 `comments_closed` → `评论关闭` 且 5xx 非致命降级）。每 1–2 条 `lease_heartbeat`，片尾 `lease_release`。

## 工具纪律与降 Token 规范（适用于所有 Antigravity 客户端）

> 注意：经典版 Antigravity Desktop App 仅加载 `skills/` 与 `mcp_config.json`，不一定自动注入插件 `rules/AGENTS.md`。执行本技能时**必须严格遵守以下内置工具规范**：

1. **`backlinks` 零 LLM 预检、全局标签过滤与防并发**：
   - **开跑必选第一步 `batch_preflight`**：在任何 `batch_claim` 之前，必须先调 `backlinks action="batch_preflight"`（传 `batchId`、`autoSkip: true`、`autoSkipTagged: true`、`autoFailWaf: true`、默认 `timeoutMs: 5000`、`concurrency: 6`）。工具不启动 Chrome、不耗 LLM，读取服务端透出的 `sourceTags`/`blockingTags` 并并发完成 HTTP 轻量预检与前 64KB `siteHint` 探测（`wordpress_comment`/`wix_blog`/`comments_closed_hint`/`directory_or_form`/`other`）：自动识别死链/停服占位页并原子跳过打 `dead_site`；默认将已带 `waf_403` 标签条目隔离到 `heldForManual`（传 `skipSoftTagged: true` 可同时隔离 `has_captcha`/`submitmatic_verify_fail`，`false` 可放行重探），配合 `autoFailWaf: true` 自动将新老 `waf_403` 标为 `failed(manual_required)` 防重复入队；已带硬阻断标签的来源零请求直接跳过。
   - **标准阻断标签常量集合**（遇到对应阻断时必须在 `item_result` 同步调用 `source_tags` 打标；服务端会自动把 `comments_closed` 映射为现网稳定的 `评论关闭`，且遇 5xx 自动中文回退/非致命降级）：
     - 硬阻断标签（预检 `autoSkipTagged: true` 直接跳过）：`paid_only`（强制收费）、`no_form`（无提交入口）、`dead_site`（死链/停服/占位）、`comments_closed`（/ `评论关闭`）。
     - 软阻断/警示标签：`has_captcha`（reCAPTCHA/SecureImg/Turnstile/数学题验证码）、`waf_403`（CloudFront/WAF 403 拦截）、`submitmatic_verify_fail`（`@submitmatic` 模板 Verify Badge 校验失败）。
     - 描述性标签可并存：`免徽章`、`要徽章`、`可复用`。
   - `batch_list` 默认 `onlyPending: true`、`compact: true`、`limit: 20`、`offset: 0`（输出约 2–5 KB，避免超长落盘）；仅在确需查看历史已完成批次时传 `onlyPending: false` 或 `offset`。
   - `batch_get` 默认 `compact: true`，单批次仅拉取一次用于获取 `website` 6 字段资料包与 `anchors`（大批量传 `pendingOnly: true` + `limit`/`offset`，服务端始终基于全批次返回 `publishedSourceIds`）；禁止在单会话内反复重调 `batch_get` 或重复 `read_file` 已读文档。
   - **单会话条目预算（10–12 条）**：单次 `agy` 对话推荐只处理 **10–12 条（2 片 × 5–6 条，硬上限 15 条）**。完成当前片后务必 `lease_release`，精简输出已完成与剩余条数并提示新开 `agy` 会话续跑，防止上下文膨胀与冗余回执。
   - **分片认领**：按 `batch_preflight.runnableItemIds` 每次认领 **5–6 条**（同域名 `sourceHost` 必须同片串行），每完成 1–2 条调 `lease_heartbeat`，片尾务必 `lease_release`。
   - **互换徽标校验与回滚**：需要触发站点刷新并验证首页是否出现目标链接时，直接调用 `backlinks action="badge_verify"`（禁止 `bash`/`powershell` 跑 `curl`/`grep`）。**铁律：挂载互换徽标并 `badge_verify` 后，如果对方 `Verify Badge` 校验失败且放弃提交，必须立即调用 `backlinks action="badge_deactivate"`（支持直接传 `badgeId`，可选 `websiteId` / `remove` / `refreshUrl`，幂等停用并触发站点刷新回调）停用/删除该徽标，绝不在推广站首页残留无效徽标。**
   - **懒加载鉴权**：`CLOUDMAIL_TOKEN` 仅在调用 `mailbox_create` / `mail_wait` 时检查；未配置接码令牌时其余 Supermanager 批次动作照常可用。
2. **`browser` 降 Token 与快速失败阈值**：
   - **导航与慢等收紧**：`browser navigate` 默认超时已下调为 **10,000ms**（推荐显式传 `timeoutMs: 8000`–`10000` 快速失败，不再死等慢站）；`backlinks mail_wait` 默认上限已收紧至 **30,000ms**（30 秒未收到验证邮件直接回写 `failed + manual_required`，不卡死整片）；登录/OAuth 挂起超过 **15–20s** 直接判定阻塞并回写 `failed + manual_required`，禁止死循环重复点击。
   - `navigate` 默认只返回精简文本摘要（3,000 字符）；`snapshot`（`text`/`aria`/`interactive`）默认开启**紧凑压缩模式（上限 4,500 字符**，避免触发 `agy` >10 KB 落盘及 `read_file` 重读）。仅在复杂页面确需完整未裁剪内容时，传 `full: true`（上限 16,000）或显式 `maxChars`，且不要保留超大 snapshot 或冗余重试。
   - **WP/Wix 博客评论优先 `comment_publish`**：命中 `siteHint` 为 `wordpress_comment` / `wix_blog` / `comments_closed_hint` 时，用 `browser action="comment_publish"` 一次完成探测、填表、提交与重载核验，禁止走 12+ 步手动 `navigate/snapshot/click/fill`。
   - **多字段表单优先 `batch_fill`**：整张填表 + 可选提交尽量合并为一次 `browser action="batch_fill"`（传 `fields` 数组与可选 `submitTarget` / `submitNth`），大幅减少往返轮次。
   - **等待人工登录用 `wait_for_login`**：遇到首次 Google 登录或需要人工介入的登录墙，先 `bringToFront`（或直接调 `wait_for_login`，内置自动拉回窗口到可见屏幕并轮询），**禁止 LLM 自己循环每 10 秒 `snapshot` 轮询**。
   - **防 `strict mode violation` 与标签隔离**：`navigate` 返回 `[page pN]`，后续同一标签命令都传 `page`。点击 Submit / Sign in / Send Code / 申请入驻 / 发送验证码 等高频按钮时，**优先使用精确 `role:button|<精确名称>` / `role:link|<精确名称>`**，避免宽泛 `text:<子串>` 匹配到多处；如发生多元素匹配，按错误返回的 `[0]`、`[1]`… 候选列表传 `nth`（0-based，支持 `click`/`fill`/`select`/`upload`/`waitFor` 与 `batch_fill` 的 `fields[].nth`/`submitNth`）或改用精确 `role:` 选择器。iframe 加 `frame(<css>)>>` 前缀，无名控件用 `interactive` 快照给出的 `css` 或 `xy:<x>,<y>`。

## 执行流程

收到"发外链"（或输入 `/backlink-publish [批次号]`）后：消息里已带具体批次号时跳过第 1 步直接执行第 2 步预检。

1. `backlinks action="batch_list"`（默认 `onlyPending: true, compact: true, limit: 20`）→ 若支持交互提问工具（如 `ask_question`）则渲染选项卡让用户选择，否则清晰列出最近待发批次请用户回复确认批次号：**用户确认后才继续；若取消或未获明确答复，立即停止，绝不自行认领任何批次。**
2. **前置零 LLM 预检与读取批次**：
   - 先调 `backlinks action="batch_preflight"`（`batchId`、`autoSkip: true`、`autoSkipTagged: true`、`autoFailWaf: true`），一次性完成死链/停服/占位页预检跳过、硬阻断标签过滤、`waf_403` 自动防重复入队与 `siteHint` 识别，拿到 `runnableItemIds`、`runnableItems`、`cautionItems`、`heldForManual`、`wafBlocked` 与 `publishedSourceIds`。
   - 随后调一次 `backlinks action="batch_get"`（`compact: true, pendingOnly: true`）读取 `website` 6 字段资料包与 `anchors`（已发布条目与预检已跳过的条目本次**不认领、不执行**，汇总时单列）。向用户确认三项设置（可通过 `ask_question` 或简洁文本选项确认）：
   a. **范围**：全部存活待发布（`runnableItemIds`） / 指定 `itemIds`；
   b. **执行模式**（本次运行生效）：
      - `智能匹配（推荐）`：只发布勘察后能匹配六类剧本之一的条目；类型不识别回写 `skipped`（原因写"类型不识别，智能匹配模式下跳过"）。
      - `全部尝试`：不做类型筛选，未知类型走通用主循环（勘察→注册→提交→核验→回写），绝不因类型跳过。
      未明确指定时默认 `智能匹配`。
   c. **停靠模式**（本次运行生效）：
      - `保留停靠页`：遇到 CAPTCHA/需人工介入的标签页保持开启（并 `bringToFront`），其余工作标签 `closePage` 关闭。
      - `结束即关浏览器`：本轮结束后调 `browser action="closeBrowser"` 关闭整个浏览器（登录态和 Cookie 仍保存在持久 profile 中）。
      未明确指定时默认 `保留停靠页`。
3. **分片认领执行（单会话 10–12 条，2 片 × 5–6 条）**：
   - 每次从 `runnableItemIds` 按同域名归组挑选 **5–6 条 `itemIds`**，调用 `backlinks action="batch_claim"` 获得 `leaseId`（若返回 `circuitBreakerAlerts`，立即按同模板熔断规则处理，不再深挖或挂徽标）。
   - 若环境支持多工作器并发且跨域名条目 ≥ 3，可按 `sourceHost` 分组并确保同域串行（每组 5–6 条独立认领或在协调租约下保持心跳，且必须遵守下面单条目循环纪律）。
   - 单 Agent 会话中按分片顺序执行完当前切片，每 1–2 条调 `lease_heartbeat`，切片完成后调 `lease_release`；单次对话处理 **10–12 条（2 片 × 5–6 条，硬上限 15 条）** 后及时收尾交接，提示用户新开会话续跑剩余条目。

## 单条目循环

对切片内的每个 item（顺序执行，同域连续操作之间自然停顿）：

1. **发布前验证（防重复发布）**：
   - 条目 `publishStatus` 为 `submitted`/`live` 或 `publishedUrl` 非空，或同批次同 `sourceId` 条目已发布 → 已发布，**不要打开目标站提交**：已认领的回写 `skipped`（skipReason："发布记录已存在：<publishStatus 或 publishedUrl>，跳过重复发布"），继续下一条。
   - 勘察目标站时检索本站域名/目标 URL：能找到本站可点击链接 → 同样回写 `skipped`（"目标站已存在本站链接，跳过重复发布"）。已提交待审来源优先复核公开页，确认已上线可直接回写 `live`，仍未见则维持跳过，**绝不再提交一次**。
2. **优先快路径与选择 playbook**：`submitUrl` 优先于 `sourceUrl`。
   - 若 `runnableItems` 的 `siteHint` 为 `wordpress_comment` / `wix_blog` / `comments_closed_hint`（或已知为博客评论站），**先直接调用 `browser action="comment_publish"`**（仅返回 `needs_llm_fallback` 时才接着用紧凑 `snapshot` 接管）。
   - 其他站点按 `navigate` + 紧凑 `snapshot format="aria"` 勘察实貌，匹配剧本（导航/博客/论坛/内容站/游戏站/工具站）。
   - **智能匹配模式**：勘察后六类都不匹配 → 回写 `skipped`（"类型不识别，智能匹配模式下跳过"）。
   - **全部尝试模式**：不匹配 → 走通用主循环，绝不因类型跳过。
   登录墙挡住表单时先走第 5 步，别因此跳过条目。
3. **勘察优先**：判"无评论区/无入口"前必须依次：`waitFor` 常见锚点（`#comments`/`#respond`/`[id*='comment']`/`iframe`）或等待挂载再 `snapshot` → `press key="End"` 滚到页底再 `snapshot` → 见「Load comments」类按钮先点击再 `snapshot` → 快照里的 iframe 用 `frame(<css>)>>` 进入 → 兜底 `navigate` 到 `URL#comments`。全走完仍无才回写 `skipped`（措辞固定："评论区延迟加载探测后仍不存在"），禁止凭首屏快照下"静态页面无入口"的结论。
4. **语义寻址与防多元素冲突**：提交/登录/发码按钮优先用精确 `role:button|<精确名称>` / `role:link|<精确名称>`，表单用 `label:` / `placeholder:`，宽泛 `text:<子串>` 与 bare CSS 只作兜底；触发 strict mode 多匹配时用报错候选里的 `nth`（0-based）或精确 `role:`；无名控件用 `interactive` 快照给出的 `css` 或 `xy:<x>,<y>`；标 `(scroll first)` 时先滚动再取快照。
5. **需要注册/登录？** → 打开实际登录/注册面板后，**必须跑 `browser action="snapshot" format="interactive"`**。只按完整快照的 `sign-in candidates:` 判断有无可识别的 Google 入口；`signin=google?` 也走 Google 分支。text/aria 名称缺失不能作为判无入口的依据；输出截断或存在匿名图标时先复查（见 [登录决策树](references/google-session.md)）。
   - `sign-in candidates:` 包含 `google` → 先 `browser navigate` 到 `https://accounts.google.com` 确认谷歌会话（检查完回到站点登录页）：
     - 已登录（显示账号头像/邮箱）→ 回到站点点 Google 按钮 → 选账号 → Allow/Continue → 跳回站点继续发布。
     - 未登录 → 有邮箱注册时走邮箱分支；仅有 Google 登录时回写 `failed + manual_required`，原因写"谷歌会话未初始化或已过期，请对智能体说『初始化谷歌会话』"。
     - Google 弹"确认是你本人"/二次验证 → 回写 `manual_required` 并 `bringToFront` 保留标签页等待人工一次处理。
   - 有邮箱注册表单 → 先 `backlinks action="mailbox_create"`（`localPart`=随机前缀、`domain`="screwdom.org"，**缺 `domain` 会报错**）→ 用 `batch_fill` 填表注册 → `backlinks action="mail_wait"`（**默认上限 30 秒 / 30000ms**；30 秒未收到验证邮件直接回写 `failed + manual_required`，绝不卡死整片）拿 `code`/`link` → 完成验证 → 登录。**"要求登录"本身不是人工事件**。
   - **OAuth / 登录挂起熔断**：Google/OAuth 跳转或登录提交挂起超过 **15–20 秒**无进展，直接判定阻塞并回写 `failed + manual_required`，禁止重复死循环点击。
   - 只有 CAPTCHA/人机验证（reCAPTCHA / SecureImg / Turnstile / 数学题）→ 调用 `browser action="bringToFront"` 将窗口拉回可见屏幕，回写 `failed + manual_required` 并同步打 `has_captcha`，保留停靠标签页。
6. **填写与提交**：
   - 锚文本与目标 URL 从批次 `anchors` 选取（优先第一项）；资料优先复用 `website` 6 字段资料包（evidence 注明"使用后台资料包"），缺失项才自获取并注明"该项自获取"。
   - 带链方式：有 Website 字段则填字段、正文不带链；`contenteditable` 富文本/带工具栏禁止把 `<a>` 当纯文本输入（会被转义），须先输入观点句、选中锚文本、点工具栏链接按钮填 `targetUrl`；真纯文本框才直写 `<a href="targetUrl">anchorText</a>`；BBCode 框用 `[url=targetUrl]anchorText[/url]`；一段只嵌 1 个链接。
   - 多字段表单优先用 `browser action="batch_fill"`（可附带 `submitTarget`），提交前必要时 `snapshot` 复查。
7. **核验**：提交后 `browser navigate` 到公开列表页（非预览，建议 `timeoutMs: 8000`–`10000`）+ `snapshot format="aria"`，确认出现 `role:link` 且名称含锚文本或指向 `targetUrl`。裸 URL 字符串或被转义的 `<a href=...>` 不算上线；正文嵌链被转义 → 回写 `failed + manual_required`，绝不重发。
8. **回写、打标与同模板 2 次熔断**：
   - 调用 `backlinks action="item_result"`（带 `itemId` 与对应结果字段；同模板失败时可传 `templateSignature`，如 `submitmatic:verify_badge_fail` 或 `blog:secureimg_captcha`）。
   - **标准阻断标签强制同步打标**：遇到对应情况必须立即调用 `backlinks action="source_tags"` 补打标准标签（`paid_only` 强制收费、`no_form` 无提交入口、`comments_closed` 关评、`dead_site` 死链/停服、`has_captcha` 验证码、`waf_403` CloudFront/WAF 403、`submitmatic_verify_fail` Submitmatic 校验失败；可叠加 `免徽章`/`要徽章`/`可复用`），并将所打标签写进单行 `evidence`。
   - **同模板站 2 次熔断机制**：当同一批内同模板/同源特征（如 `@submitmatic` 模板站 Verify Badge 失败、同模板博客站 `SecureImg + reCAPTCHA`）连续失败 **2 次**，或 MCP 返回 `circuitBreaker.tripped: true` 时，**立即触发熔断**：同批剩余匹配同模板特征的条目不再调用 `badge_add`、不再逐个深挖，直接快速核验或回写 `failed(manual_required)` / `skipped` 并写清原因与标准标签。
9. **互换徽标与校验失败自动回滚（仅当对方要求先挂反链时在提交前执行）**：
   a. 从对方站点获取徽标 HTML → `backlinks action="badge_add"`（`websiteId`、`name`、`html`，记住返回的 `backlinkId`）。
   b. 调用 `backlinks action="badge_verify"`：传入 `siteUrl`（我方站首页，如 `https://<我方host>/`）、`expectedTarget`（对方域名）、`refreshUrl`（若需触发回调，如 `https://<我方host>/footer/refresh`）、`retries: 3`、`retryDelayMs: 5000`。
   c. 返回 `verified: true` 后再回对方站点点击 `Verify Badge` / `Verify Backlink` / 提交；若 `verified: false` → 立即调用 `backlinks action="badge_deactivate"` 回滚，并回写 `failed + manual_required`（原因写"徽标已入库但站点未刷新且已回滚"）。
   d. **自动回滚铁律**：挂载互换徽标并通过 `badge_verify` 后，如果目标站 `Verify Badge` 校验失败且放弃提交，**必须立即调用 `backlinks action="badge_deactivate"`**（传 `websiteId`、`badgeId` 与可选 `refreshUrl`）将刚挂载的徽标停用或删除，**绝不允许在推广站首页残留无效徽标**。若此前已在线上可查到徽标，跳过 `badge_add` 直接进入提交。

## 人工兜底与收尾

- 遇 CAPTCHA/人工登录：`bringToFront` 拉回窗口，回写 `manual_required`，保留当前停靠标签页，并用新 `page` 参数新开标签继续后续条目。
- 切片完成：`lease_release` 释放租约，输出本轮汇总表（含 `live` / `submitted` / `failed` / `skipped` 与"已发布跳过"清单）。
- 按停靠模式收尾：`保留停靠页` 时只对工作标签调用 `closePage`；`结束即关浏览器` 时调用 `closeBrowser` 释放内存。

## 参考规范与站点剧本

- [状态模型与回写映射](references/status-model.md)
- [什么算已发布（live 口径）](references/evidence.md)
- [频控、授权与安全](references/safety.md)
- [谷歌会话与登录决策树](references/google-session.md)
- 六类站点操作手册：
  [目录/导航](references/playbooks/playbook-directory.md) ·
  [博客评论](references/playbooks/playbook-blog.md) ·
  [论坛](references/playbooks/playbook-forum.md) ·
  [内容站](references/playbooks/playbook-article.md) ·
  [游戏站](references/playbooks/playbook-gaming.md) ·
  [工具站](references/playbooks/playbook-tools.md)
