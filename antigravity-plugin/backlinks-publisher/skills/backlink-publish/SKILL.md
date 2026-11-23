---
name: backlink-publish
description: 本工作区所有"发外链/发布外链/发布批次/跑批次/继续批次"请求的首选且唯一入口：通过 backlinks-publisher MCP 工具（backlinks + browser）从 Supermanager 拉取批次、分片认领租约、在持久化 Chrome 浏览器中自动发布、使用 Cloud-mail 收取验证码、跨平台校验互换徽标，并逐条诚实回写结果与标签。
---

# 外链自动发布（backlink-publish）

你运行的是一套**有纪律的发布流水线**，不是随手发帖。两条铁律高于一切：

1. **幂等**：一个条目只允许一次"最终提交"动作，一个来源对一个网站只发一次——发布前先验证发布记录和状态（见单条目循环第 1 步），已提交/已上线的条目自己跳过，绝不重复发布。提交后拿不到明确回执（结果未知）时，回写 `failed + manual_required`，**绝不自动重试**。
2. **诚实回写**：`live` 必须是你亲自抓取公开页面并确认包含可点击目标链接后的结论；"提交成功但待审核"只能回写 `submitted`。

## 工具纪律与降 Token 规范（适用于所有 Antigravity 客户端）

> 注意：经典版 Antigravity Desktop App 仅加载 `skills/` 与 `mcp_config.json`，不一定自动注入插件 `rules/AGENTS.md`。执行本技能时**必须严格遵守以下内置工具规范**：

1. **`backlinks` 降 Token 与防并发**：
   - `batch_list` 默认 `onlyPending: true`、`compact: true`、`limit: 20`、`offset: 0`（输出约 2–5 KB，避免超长落盘）；仅在确需查看历史已完成批次时传 `onlyPending: false` 或 `offset`。
   - `batch_get` 默认 `compact: true`，保留 `batch`、网站 6 字段资料包、`anchors` 及精简条目字段；大批量批次可传 `pendingOnly: true`（及 `limit`/`offset` 分页），服务端仍会基于全批次返回 `publishedSourceIds` 以严防同 `sourceId` 重复发布；仅在确需原始大字段时传 `compact: false`。
   - **单会话条目预算**：单次 `agy` 对话建议最多处理 **15–20 条（3–4 个 5 条分片）**。若仍有待发条目，完成当前分片后务必 `lease_release`，汇总已完成与剩余条数并提示新开 `agy` 会话续跑，防止上下文膨胀到 >300k token 拖慢响应。
   - **分片认领**：不要整批几十条一次 `batch_claim`，按 `itemIds` 每次认领 **1–5 条**（同域名 `sourceHost` 必须同片串行），每完成 1–2 条调 `lease_heartbeat`，片尾务必 `lease_release`。
   - **互换徽标免 `curl`**：需要触发站点刷新并验证首页是否出现目标链接时，直接调用 `backlinks action="badge_verify"`（Node.js 原生 `fetch()` 实现，Windows 与 macOS 通用，禁止调用 `bash`/`powershell` 跑 `curl`/`grep`）。
   - **懒加载鉴权**：`CLOUDMAIL_TOKEN` 仅在调用 `mailbox_create` / `mail_wait` 时检查；未配置接码令牌时其余 Supermanager 批次动作照常可用。
2. **`browser` 降 Token 与真机持久化 Chrome**：
   - `navigate` 默认只返回精简文本摘要（3,000 字符）；`snapshot`（`text`/`aria`/`interactive`）默认上限 **8,000 字符**（避免触发 `agy` >10 KB 落盘）。仅在复杂页面确需完整内容时，显式传 `maxChars`（最高至服务端硬上限 `16,000`）。
   - **多字段表单优先 `batch_fill`**：整张填表 + 可选提交尽量合并为一次 `browser action="batch_fill"`（传 `fields` 数组与可选 `submitTarget` / `submitNth`），大幅减少往返轮次。
   - **等待人工登录用 `wait_for_login`**：遇到首次 Google 登录或需要人工介入的登录墙，先 `bringToFront`（或直接调 `wait_for_login`，内置自动拉回窗口到可见屏幕并轮询），**禁止 LLM 自己循环每 10 秒 `snapshot` 轮询**。
   - **防 `strict mode violation` 与标签隔离**：`navigate` 返回 `[page pN]`，后续同一标签命令都传 `page`。点击 Submit / Sign in / Send Code / 申请入驻 / 发送验证码 等高频按钮时，**优先使用精确 `role:button|<精确名称>` / `role:link|<精确名称>`**，避免宽泛 `text:<子串>` 匹配到多处；如发生多元素匹配，按错误返回的 `[0]`、`[1]`… 候选列表传 `nth`（0-based，支持 `click`/`fill`/`select`/`upload`/`waitFor` 与 `batch_fill` 的 `fields[].nth`/`submitNth`）或改用精确 `role:` 选择器。iframe 加 `frame(<css>)>>` 前缀，无名控件用 `interactive` 快照给出的 `css` 或 `xy:<x>,<y>`。

## 执行流程

收到"发外链"（或输入 `/backlink-publish [批次号]`）后：消息里已带具体批次号时跳过第 1 步直接拉取详情并分片认领。

1. `backlinks action="batch_list"`（默认 `onlyPending: true, compact: true, limit: 20`）→ 若支持交互提问工具（如 `ask_question`）则渲染选项卡让用户选择，否则清晰列出最近待发批次请用户回复确认批次号：**用户确认后才继续；若取消或未获明确答复，立即停止，绝不自行认领任何批次。**
2. `backlinks action="batch_get"`（默认 `compact: true`，大批量可带 `pendingOnly: true` + `limit`/`offset`）→ 展示条目并结合返回的 `publishedSourceIds` 先做**已发布分区**：条目 `publishStatus` 为 `submitted`/`live` 或 `publishedUrl` 非空 = 已发布；`sourceId` 在 `publishedSourceIds` 中或同批次内同 `sourceId` 的其余条目同样视为已发布。已发布条目本次**不认领、不执行**，汇总时单列"已发布跳过"。随后向用户确认三项设置（可通过 `ask_question` 或简洁文本选项确认）：
   a. **范围**：全部待发布 / 仅待发布（不含失败重试） / 指定 `itemIds`；
   b. **执行模式**（本次运行生效）：
      - `智能匹配（推荐）`：只发布勘察后能匹配六类剧本之一的条目；类型不识别回写 `skipped`（原因写"类型不识别，智能匹配模式下跳过"）。
      - `全部尝试`：不做类型筛选，未知类型走通用主循环（勘察→注册→提交→核验→回写），绝不因类型跳过。
      未明确指定时默认 `智能匹配`。
   c. **停靠模式**（本次运行生效）：
      - `保留停靠页`：遇到 CAPTCHA/需人工介入的标签页保持开启（并 `bringToFront`），其余工作标签 `closePage` 关闭。
      - `结束即关浏览器`：本轮结束后调 `browser action="closeBrowser"` 关闭整个浏览器（登录态和 Cookie 仍保存在持久 profile 中）。
      未明确指定时默认 `保留停靠页`。
3. **分片认领执行**：
   - 每次从待处理列表按同域名归组挑选 **1–5 条 `itemIds`**，调用 `backlinks action="batch_claim"` 获得 `leaseId`。
   - 若环境支持多工作器并发且跨域名条目 ≥ 3，可按 `sourceHost` 分组并确保同域串行（每组 1–5 条独立认领或在协调租约下保持心跳，且必须遵守下面单条目循环与 5 条硬纪律）。
   - 单 Agent 会话中按分片顺序执行完当前切片，每 1–2 条调 `lease_heartbeat`，切片完成后调 `lease_release`，再决定是否认领下一片；单次对话处理达到 **15–20 条（3–4 片）** 后及时收尾交接，提示用户新开会话续跑剩余条目。

## 单条目循环

对切片内的每个 item（顺序执行，同域连续操作之间自然停顿）：

1. **发布前验证（防重复发布）**：
   - 条目 `publishStatus` 为 `submitted`/`live` 或 `publishedUrl` 非空，或同批次同 `sourceId` 条目已发布 → 已发布，**不要打开目标站提交**：已认领的回写 `skipped`（skipReason："发布记录已存在：<publishStatus 或 publishedUrl>，跳过重复发布"），继续下一条。
   - 勘察目标站时检索本站域名/目标 URL：能找到本站可点击链接 → 同样回写 `skipped`（"目标站已存在本站链接，跳过重复发布"）。已提交待审来源优先复核公开页，确认已上线可直接回写 `live`，仍未见则维持跳过，**绝不再提交一次**。
2. **选择 playbook**：先 `navigate` + `snapshot format="aria"` 勘察实貌，按特征匹配剧本（导航/博客/论坛/内容站/游戏站/工具站）；`submitUrl` 优先于 `sourceUrl`。
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
   - 有邮箱注册表单 → 先 `backlinks action="mailbox_create"`（`localPart`=随机前缀、`domain`="screwdom.org"，**缺 `domain` 会报错**）→ 用 `batch_fill` 填表注册 → `backlinks action="mail_wait"`（默认等 120 秒）拿 `code`/`link` → 完成验证 → 登录。**"要求登录"本身不是人工事件**。
   - 只有 CAPTCHA/人机验证 → 调用 `browser action="bringToFront"` 将窗口拉回可见屏幕，回写 `manual_required` 并保留停靠标签页。
6. **填写与提交**：
   - 锚文本与目标 URL 从批次 `anchors` 选取（优先第一项）；资料优先复用 `website` 6 字段资料包（evidence 注明"使用后台资料包"），缺失项才自获取并注明"该项自获取"。
   - 带链方式：有 Website 字段则填字段、正文不带链；`contenteditable` 富文本/带工具栏禁止把 `<a>` 当纯文本输入（会被转义），须先输入观点句、选中锚文本、点工具栏链接按钮填 `targetUrl`；真纯文本框才直写 `<a href="targetUrl">anchorText</a>`；BBCode 框用 `[url=targetUrl]anchorText[/url]`；一段只嵌 1 个链接。
   - 多字段表单优先用 `browser action="batch_fill"`（可附带 `submitTarget`），提交前必要时 `snapshot` 复查。
7. **核验**：提交后 `browser navigate` 到公开列表页（非预览）+ `snapshot format="aria"`，确认出现 `role:link` 且名称含锚文本或指向 `targetUrl`。裸 URL 字符串或被转义的 `<a href=...>` 不算上线；正文嵌链被转义 → 回写 `failed + manual_required`，绝不重发。
8. **回写与打标**：
   - 调用 `backlinks action="item_result"`（带 `itemId` 与对应结果字段）。
   - 立即调用 `backlinks action="source_tags"`（`sourceId` + 本次观察标签：`免徽章` / `要徽章` / `可复用` / `有盾` / `付费`），并将所打标签记入 evidence。
9. **互换徽标（仅当对方要求先挂反链时在提交前执行）**：
   a. 从对方站点获取徽标 HTML → `backlinks action="badge_add"`（`websiteId`、`name`、`html`）。
   b. 调用 `backlinks action="badge_verify"`：传入 `siteUrl`（我方站首页，如 `https://<我方host>/`）、`expectedTarget`（对方域名）、`refreshUrl`（若需触发回调，如 `https://<我方host>/footer/refresh`）、`retries: 3`、`retryDelayMs: 5000`。
   c. 返回 `verified: true` 后再回对方站点点击 Verify Backlink / 提交；若 `verified: false` → 回写 `failed + manual_required`（原因写"徽标已入库但站点未刷新"）。若此前已在线上可查到徽标，跳过 `badge_add` 直接进入提交。

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
