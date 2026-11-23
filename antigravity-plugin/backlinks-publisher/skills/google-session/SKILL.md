---
name: google-session
description: 在共享持久化 Chrome 浏览器里初始化、检查或重新播种谷歌会话：用户说"初始化谷歌会话/登录谷歌/检查谷歌会话"或输入 /google-session 时使用。登录由用户人工在 Chrome 窗口完成，智能体使用 browser wait_for_login 单次挂起等待，不空转轮询。
---

# 谷歌会话管理（google-session）

完整规则见 `backlink-publish` 技能的 [references/google-session.md](../backlink-publish/references/google-session.md)。本技能只做会话初始化与检查，不执行发布批次：

1. 调用 `browser`（`action: "navigate"`, `url: "https://accounts.google.com"`），然后调用 `snapshot`（`format: "aria"`）检查当前状态。
2. **若已登录**（页面显示账号头像或 Gmail 地址）→ 直接跳到第 4 步复核并汇报。
3. **若未登录**：
   - 先调用 `browser`（`action: "bringToFront"`）确保 Chrome 窗口恢复到屏幕可见区域（兼容 Windows / macOS）。
   - 向用户说明："请在弹出的 Chrome 窗口里亲手完成 Google 登录（含 2FA），账号密码不会经过智能体。"
   - 调用一次 `browser` 工具的 **`wait_for_login`**（不要在对话里循环每 10 秒 `snapshot` 轮询！）：
     - `urlNotContains: "accounts.google.com/v3/signin"`（或结合 `urlContains: "myaccount.google.com"`）
     - `timeoutMs: 300000`（5 分钟，如需更久可适当放宽）
     - `pollIntervalMs: 3000`
     - `bringToFront: true`
   - 若 `wait_for_login` 返回 `timedOut: true` 或 `closed: true`，如实向用户报告未完成并建议重新运行 `/google-session`，不猜测结果。
4. 登录完成后，调用 `browser`（`action: "navigate"`, `url: "https://myaccount.google.com"`）+ `snapshot`（`format: "aria"`）复核已登录状态与邮箱。
5. 向用户报告当前已登录的 Google 账号邮箱，确认"谷歌会话已就绪，后续带 Continue with Google 的外链站将自动复用该会话"。

## 纪律

- 绝不代替用户输入 Google 密码或 2FA 验证码；只做导航、召回窗口、`wait_for_login` 等待与快照复核。
- 遇到超范围 OAuth 授权提示时，调用 `browser screenshot` 并提醒用户核对。
- 会话已就绪时再次调用本技能是无害的幂等检查。
