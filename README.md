# @javawl/dsh-backlinks-bundle

面向官方 **DeepSeek Harness（CLI / Web / Desktop `>= 0.2.1`）** 的全栈独立外链自动发布插件包（Bundle）。

无需修改官方仓库任何源码，下载官方原版 DeepSeek Harness 后直接安装本插件，即可完整获得：

1. **左侧栏「发布批次」控制台（Web / Desktop）**：30 秒自动刷新批次列表、按批次号/域名搜索、展开查看条目状态、单条或多批次勾选（按批次号倒序）一键创建专属 `backlink-operator` 会话并自动下发 `/backlink-publish`。
2. **「插件」页面可视化配置卡片**：在左侧栏 **插件（Plugins）** 页内置 `Supermanager`（后端地址 + Agent 令牌）与 `Cloud-mail`（接口地址 + API 令牌）加密配置表单，保存后即时生效，无需重启。
3. **持久化真机 Chrome 浏览器（`browser` 工具）**：默认使用 `$DSH_HOME/backlink-browser-profile`（`~/.dsh/backlink-browser-profile`）跨目录、跨会话保留 Google OAuth 登录态与站点 Cookie；默认离屏静默运行（`-32000,-32000`），遇到人机验证自动 `bringToFront` 召回窗口，支持按标签页 `page` 并发隔离及 `closeBrowser` 释放内存。
4. **外链业务与接码工具（`backlinks` 工具）**：批次拉取、租约认领与心跳、防重复发布核验、诚实状态回写、互换徽标入库、自动打标（`免徽章`/`要徽章`/`可复用`/`有盾`/`付费`）及邮箱自动接码。
5. **随包内置完整作业技能（无工作目录依赖）**：内置 `/backlink-publish`（含 4 份规范与 6 大站点类型 Playbook）和 `/google-session`，在电脑任意项目目录下启动官方 Harness 均可直接使用。
6. **专属「外链发布专员」预设（`backlink-operator`）**：控制台发起发布时自动使用外链专员人设，不影响日常编程使用的官方默认 `standard` 预设。

---

## 一、打入官方原版 DeepSeek Harness

仓库已包含预构建产物 `lib/`，支持**直接从 GitHub 一行命令安装**，无需在目标机器先手动编译。

### 方式 1：官方 CLI / Web 版

```bash
# 1. 全局安装官方原版 DeepSeek Harness
pnpm add -g @deepseek-ai/dsh

# 2. 将本插件安装到官方 web profile（二选一）：
#   A. 从 GitHub 直接安装（推荐生产或多机分发）：
dsh plugin --profile web add git+https://github.com/javawl/dsh-backlinks-plugin.git
#   B. 本地克隆目录链接安装（适合本机开发调试，改代码重跑 pnpm run build 后重启 dsh 即可）：
# dsh plugin --profile web add /path/to/dsh-backlinks-plugin

# （可选）若你还需要命令行无头跑批次，同步装入 headless profile：
dsh plugin --profile headless add git+https://github.com/javawl/dsh-backlinks-plugin.git

# 3. 任意目录启动官方 Web 界面
dsh web --port 8787
```

### 方式 2：官方 Desktop 桌面客户端（macOS `.dmg` / Windows `.exe`）

1. 打开官方 DeepSeek Harness 桌面客户端。
2. 点击左侧导航栏 **Plugins（插件）** → **添加插件（Add plugin）**。
3. 输入 `git+https://github.com/javawl/dsh-backlinks-plugin.git`（或本地克隆目录绝对路径）确认安装即可。

---

## 二、配置密钥与迁移已有 Google 登录态

### 1. 配置 Supermanager 与 Cloud-mail 令牌（二选一）
- **界面配置（推荐）**：启动官方 Web 或 Desktop 后，点击左侧栏 **插件（Plugins）**，在 **Supermanager** 和 **Cloud-mail** 配置项中填写后端地址与令牌并点击保存，立即生效。
- **环境变量配置**：也可在 `~/.dsh/.env` 中写入：
  ```dotenv
  SUPERMANAGER_BASE_URL=https://你的外链后台域名
  SUPERMANAGER_TOKEN=你的_agent_token
  CLOUDMAIL_TOKEN=你的_cloudmail_token
  NEWAPI_API_KEY=你的模型网关密钥
  ```

### 2. （可选）一键写入预置的 NewAPI 模型网关路由
你可以在官方界面 **设置 → 模型** 中手动添加模型供应商，也可以在插件目录运行增量初始化脚本（只补充缺失项，绝不覆盖已有设置）：

```bash
# 写入 web profile（~/.dsh/profiles/web/cordis.patch.yml）
pnpm run init-models web

# 或写入桌面端 desktop profile
pnpm run init-models desktop
```

### 3. （可选）无缝复用旧仓库已登录的 Google Chrome 会话
插件默认将持久化浏览器目录固定在 `~/.dsh/backlink-browser-profile`（也可通过环境变量 `DSH_BACKLINK_BROWSER_PROFILE` 指定路径）。如果你此前已有登录好的 `.backlink-browser-profile`，直接复制过来即可免重新登录：

```bash
cp -R /path/to/.backlink-browser-profile ~/.dsh/backlink-browser-profile
```

---

## 三、本地二次开发与构建

环境要求：`Node.js >= 24`（或 `^22.19.0`）、`pnpm`。

```bash
git clone https://github.com/javawl/dsh-backlinks-plugin.git
cd dsh-backlinks-plugin
pnpm install
pnpm run build
pnpm run test
```
