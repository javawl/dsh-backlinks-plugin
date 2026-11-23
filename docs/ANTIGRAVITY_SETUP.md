# Antigravity 接入指南（Windows + macOS 跨平台）

本文说明如何在 **Antigravity Desktop App**（经典版全局配置布局）、**Antigravity CLI / Orca**（原生插件目录布局）中部署 `backlinks-publisher` Stdio MCP Server 与外链发布技能。

---

## 一、目录布局与双模式兼容说明

| 运行环境 | 配置与插件路径 | 加载内容 |
| --- | --- | --- |
| **Antigravity Desktop App（常见于 Windows / macOS 桌面客户端）** | `~/.gemini/antigravity/mcp_config.json` + `~/.gemini/antigravity/skills/` | MCP 工具 + 技能（已把核心纪律内联进 `SKILL.md`） |
| **Antigravity CLI / Orca（新版插件布局）** | `~/.gemini/config/plugins/backlinks-publisher/` | `plugin.json` + `mcp_config.json` + `rules/AGENTS.md` + `skills/` |

仓库内置跨平台安装脚本 [install-antigravity.mjs](../scripts/install-antigravity.mjs)，支持自动探测并安全升级两种布局，且**绝不覆盖你已填写的非占位符令牌**或其他 MCP 服务配置。

---

## 二、环境前置要求

1. **Node.js `>= 22.19`（推荐 24+）** 与 **`pnpm`**。
2. 本机已安装 **Google Chrome**（默认 `channel: 'chrome'`，Windows 标准路径 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。
3. 如需复用已有登录态，确认目录 `~/.dsh/backlink-browser-profile` 已存在：
   - **Windows**：`C:\Users\<用户名>\.dsh\backlink-browser-profile`
   - **macOS / Linux**：`~/.dsh/backlink-browser-profile`

---

## 三、构建与一键安装

### 1. 拉取代码并构建产物

在项目根目录执行：

```bash
pnpm install
pnpm run build
```

构建完成后会生成自包含 Stdio MCP 入口 [mcp-server.mjs](../lib/mcp-server.mjs)（`lib/mcp-server.mjs`）。

### 2. 运行安装脚本

按目标机器环境选择对应模式：

```bash
# 自动探测（若同时存在 ~/.gemini/antigravity 与 ~/.gemini/config 则双端安装）
pnpm run install:antigravity

# 仅安装到经典 Antigravity Desktop App（如 Windows 192.168.1.110 主机）
node scripts/install-antigravity.mjs --target app

# 仅安装到新版 Antigravity 插件目录（CLI / Orca）
node scripts/install-antigravity.mjs --target plugin

# 同时安装到两个布局
node scripts/install-antigravity.mjs --target both

# 预览写入路径而不改动磁盘
node scripts/install-antigravity.mjs --target auto --dry-run
```

> 重复运行升级插件或更新仓库路径时，脚本仅更新 `args` 指向新的 `lib/mcp-server.mjs`，并保留 `mcp_config.json` 中所有已填写的真实密钥、自定义环境变量及其他 MCP 服务条目。

---

## 四、签发独立 `smag_` 令牌与配置环境变量

### 1. 在 Supermanager 签发专用 Agent 令牌

为避免与 DeepSeek Harness（DSH）会话发生租约冲突或混淆审计日志，请登录 **Supermanager** 后台为 Antigravity **单独签发一枚 `smag_` 开头的 Agent Token**（禁止与 DSH 共享同一枚令牌）。

### 2. 编辑 `mcp_config.json`

打开对应布局的配置文件：

- **Antigravity App**：`C:\Users\<用户名>\.gemini\antigravity\mcp_config.json`（Windows）或 `~/.gemini/antigravity/mcp_config.json`（macOS）
- **Plugin 模式**：`~/.gemini/config/plugins/backlinks-publisher/mcp_config.json`

找到 `mcpServers.backlinks-publisher.env`，将占位符替换为真实值：

```json
{
  "mcpServers": {
    "backlinks-publisher": {
      "command": "node",
      "args": [
        "C:\\path\\to\\dsh-backlinks-plugin\\lib\\mcp-server.mjs"
      ],
      "env": {
        "SUPERMANAGER_BASE_URL": "https://你的-supermanager-域名",
        "SUPERMANAGER_TOKEN": "smag_你的专用令牌",
        "CLOUDMAIL_BASE_URL": "https://mail.screwdom.org/api",
        "CLOUDMAIL_TOKEN": "<OPTIONAL_CLOUDMAIL_TOKEN>",
        "DSH_BACKLINK_BROWSER_PROFILE": "~/.dsh/backlink-browser-profile",
        "BACKLINKS_MAX_OUTPUT_CHARS": "16000"
      }
    }
  }
}
```

关键环境变量说明：

| 变量名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `SUPERMANAGER_BASE_URL` | 是（用批次工具时） | 无 | Supermanager 后端根地址（http/https） |
| `SUPERMANAGER_TOKEN` | 是（用批次工具时） | 无 | 专为 Antigravity 签发的 `smag_` 令牌 |
| `CLOUDMAIL_BASE_URL` | 否 | `https://mail.screwdom.org/api` | Cloud-mail 接口根地址 |
| `CLOUDMAIL_TOKEN` | 懒加载（仅接码时需要） | 无 | 未配置时仍可正常执行 Supermanager 批次与 `badge_verify`，仅在 `mailbox_create`/`mail_wait` 时提示补充 |
| `DSH_BACKLINK_BROWSER_PROFILE` | 否 | `~/.dsh/backlink-browser-profile` | 支持 `~` 跨平台展开（Windows/macOS），直接复用现有 Chrome 登录态 |
| `BACKLINKS_MAX_OUTPUT_CHARS` | 否 | `16000` | 显式传入 `maxChars` 时的服务端硬上限（clamp）；未传 `maxChars` 时受下方快照/导航默认值限制 |
| `BACKLINKS_SNAPSHOT_MAX_CHARS` | 否 | `4500` | `browser snapshot` 紧凑模式默认输出字符上限（自动裁剪页头/导航/页脚/SVG 并保留表单/评论；传 `full: true` 可展开至 `maxOutputChars`） |
| `BACKLINKS_NAVIGATE_MAX_CHARS` | 否 | `3000` | `browser navigate` 默认文本摘要字符上限 |
| `BACKLINKS_BROWSER_TIMEOUT_MS` | 否 | `10000` | 浏览器导航与操作默认超时（毫秒，单次 `navigate` 可通过 `timeoutMs` 覆盖，推荐 8000–10000） |
| `BACKLINKS_MAIL_WAIT_TIMEOUT_MS` | 否 | `30000` | `backlinks mail_wait` 默认等待验证邮件上限（毫秒，超时直接标 `manual_required`） |
| `BACKLINKS_BROWSER_EXECUTABLE_PATH` | 否 | 自动按 `chrome` channel 查找 | 如需指定自定义 Chrome 可执行路径（如 Windows 非标准安装目录） |
| `BACKLINKS_BROWSER_WINDOW_POSITION` | 否 | 可见默认位置 | 设为 `-32000,-32000` 可默认离屏启动；遇到 `bringToFront` 或 `wait_for_login` 时会自动拉回主屏可见区域 |

---

## 五、`agy` CLI 推荐启动姿势（工作目录、模型与单会话规模）

为避免无关仓库规则污染上下文或长会话导致 >300k token 延迟退化，建议按以下方式启动 `agy`：

1. **从独立干净空目录启动**：专门建一个空工作目录运行 `agy`（避免自动加载其他代码仓库的 `AGENTS.md` 与无关 skills）：
   - **Windows**：`mkdir C:\Users\zlb\backlinks-work && cd C:\Users\zlb\backlinks-work`
   - **macOS**：`mkdir -p ~/backlinks-work && cd ~/backlinks-work`
2. **选用轻快高性价比模型**：日常批量外链发布推荐使用 `--model gemini-4-neon-medium`（或 `gemini-3.8-flash-high`），避免使用过重的 `Neon (High)` / `Orchestrator`。
3. **控制单会话条数（10–12 条，上限 15 条）**：先调用 `batch_preflight` 完成零 LLM 预检与标签过滤，随后每次对话处理 **2 个分片（每片 5–6 条，合计 10–12 条，硬上限 15 条）**。若批次仍有待发条目，完成当前分片并 `lease_release` 后新开一次 `agy` 会话继续下一段。

---

## 六、只读冒烟验证（Antigravity App / Orca）

重启 Antigravity App（或重新加载 MCP Server）后，先执行只读检查确认工具与浏览器状态：

1. **验证 MCP 工具与 Supermanager 连通性（只读）**：
   - 在对话中让智能体调用 `backlinks` 工具执行 `action: "batch_list"`，确认返回批次列表（不会认领或修改任何数据）。
2. **验证本地 Chrome 持久化会话（只读）**：
   - 执行 `/google-session` 或让智能体对 `https://accounts.google.com` 执行 `browser navigate` + `snapshot`，确认能复用 `~/.dsh/backlink-browser-profile` 里原有的 Google 登录态；如未登录，`wait_for_login` 会把 Chrome 窗口拉回屏幕前台等待你人工完成一次登录。
3. **验证 Node 内置互换徽标探测（只读）**：
   - 可调用 `backlinks` 的 `action: "badge_verify"` 测试任意公开网站连通性（不依赖 `bash` / `curl` / Supermanager Token）。

---

## 七、内置降 Token 与防冲突优化清单

1. **零 LLM 前置 HTTP 预检 (`batch_preflight`)**：开跑前并发轻量 HTTP 探测（默认 5s 超时、6 并发），读取前 64KB HTML 提取 `runnableItems[].siteHint`（`wordpress_comment` / `wix_blog` / `comments_closed_hint` / `directory_or_form` / `other`），结合服务端 `sourceTags`/`blockingTags` 直接过滤死链与已带硬阻断标签源，区分 `waf_403` 与 `dead_site`；默认隔离已带 `waf_403` 条目到 `heldForManual`（支持 `skipSoftTagged` 与 `autoFailWaf: true` 一键标 `failed(manual_required)` 防队列死循环）；传 `autoSkip: true, autoSkipTagged: true` 优先调用 `POST /api/agent/batches/{batchId}/preflight-skip` 租约安全地一键跳过并打 `dead_site` 标签（遇旧版 404 自动降级）。
2. **WordPress / Wix 博客评论 1-Call 快路径 (`comment_publish`)**：Playwright 侧直接完成导航、滚底懒加载等待、关评/CAPTCHA/Wix 登录墙拦截、WordPress/Wix 访客评论填表提交与重载公开页核验（严守幂等边界，未确认仅返回 `uncertain_after_submit`；非标准站点返回 `needs_llm_fallback` + `formSummary` 直接无缝接管）。
3. **全局标准阻断标签与现网兼容**：统一使用 `paid_only`、`no_form`、`dead_site`、`has_captcha`、`waf_403`、`submitmatic_verify_fail`、`comments_closed`（发送给 Supermanager 时自动映射为现网稳定的 `评论关闭`，并在 5xx 时自动中文别名回退与非致命降级）。
4. **同模板熔断与徽标自动回滚 (`badge_deactivate`)**：同批次同模板特征（如 `@submitmatic` Verify Badge 失败、`SecureImg + reCAPTCHA`）连续失败 2 次自动触发熔断告警；若 Verify Badge 失败放弃提交，通过 `badge_deactivate`（`PATCH/DELETE /api/agent/badges/{badgeId}`，支持直接传 `badgeId` 且自动触发刷新回调）立即停用/删除残留徽标。
5. **超时与慢等阈值收紧**：`browser navigate` / `comment_publish` 默认 `10,000ms`（支持单次 `timeoutMs` 覆盖），`mail_wait` 默认收紧至 `30,000ms`，OAuth 挂起 >15–20s 快速熔断。
6. **`batch_list` 默认精简与分页**：默认 `onlyPending: true, compact: true, limit: 20, offset: 0`，过滤掉已完结批次并返回 `{ total, matched, offset, limit, hasMore, batches }`（典型体积约 2–5 KB，避免触发 `agy` >10 KB 落盘）。
7. **`batch_get` 默认精简、分页与安全不变量**：`compact` 默认为 `true`，支持可选 `pendingOnly: true` 与 `limit`/`offset` 分页；无论是否过滤或分页，始终基于全批次条目计算并返回 `publishedSourceIds` 与汇总计数，绝不因分页丢失已发布 `sourceId` 校验。
8. **极简 DOM 快照压缩与速查卡**：`snapshot` 默认开启紧凑模式且上限降至 `4,500` 字符（附带 `compactSummary`），避开 `agy` 截断落盘与反复 `read_file`，复杂页面可传 `full: true` 或 `maxChars`（最高至 `16,000`）；`navigate` 默认只回传 `3,000` 字符页面摘要；`AGENTS.md` 与 `SKILL.md` 顶部提供一页式高效执行速查卡。
9. **`nth` / `submitNth` 与 strict mode 候选诊断**：`click` / `fill` / `select` / `upload` / `waitFor` 与 `batch_fill`（`fields[].nth`、`submitNth`）支持 0-based `nth`；触发 Playwright `strict mode violation` 时自动采集前 5 个匹配元素的 tag/role/text/aria-label/name/visible 与推荐 `role:`/`nth` 提示。
10. **整表合并提交 `batch_fill`**：支持一次传入 `fields`（`fill` / `select` / `click` / `check`）与可选 `submitTarget` / `submitNth`，单轮完成表单填写（若任意字段失败则跳过 `submitTarget`）。
11. **进程内等待登录 `wait_for_login`**：彻底替代多轮 LLM 空转轮询，自动 `bringToFront` 并在 Node.js 内轮询 URL 或元素状态。
12. **分片认领与单会话上限**：单会话控制在 **10–12 条（2 片 × 5–6 条，硬上限 15 条）**，减少重复读文件与长上下文膨胀。

---

## 八、常见坑点与排查

- **Windows Chrome Profile 占用锁（`SingletonLock` / `ProcessSingleton`）**：同一个 `backlink-browser-profile` 目录同一时刻只能被一个 Chrome 进程打开。如果 DSH、手动 Chrome 或残留进程正在占用该目录，先关闭已有实例或通过 `browser closeBrowser` 释放后再启动。
- **Windows GUI 下 `node` 不在系统 PATH**：如果 Antigravity Desktop App 提示 `spawn node ENOENT`，将 `mcp_config.json` 中 `"command": "node"` 改为绝对路径（如 `"C:\\Program Files\\nodejs\\node.exe"`，macOS 如 `"/Users/<name>/.nvm/versions/node/v24.x.x/bin/node"`）。安装脚本在升级时会保留你已自定义的 `command` 路径。
- **Windows JSON 路径反斜杠转义**：手动编辑 `mcp_config.json` 时，Windows 路径里的 `\` 必须写成双反斜杠 `\\`（例如 `"C:\\Users\\zlb\\.dsh\\backlink-browser-profile"`），或使用 `scripts/install-antigravity.mjs` 自动写入合法 JSON；波浪号 `~/.dsh/backlink-browser-profile` 也会由服务端在 Windows/macOS 上自动展开。
- **Chrome 窗口跑到屏幕外或被最小化**：若设置了离屏启动或上次关闭时窗口在副屏/最小化，调用 `browser bringToFront` 或 `wait_for_login` 会自动通过 CDP 恢复窗口状态并把位置拉回主屏 `(80, 80)`。
- **提示未构建 `lib/mcp-server.mjs`**：在仓库根目录先执行 `pnpm install && pnpm run build`，再执行 `pnpm run install:antigravity`。
