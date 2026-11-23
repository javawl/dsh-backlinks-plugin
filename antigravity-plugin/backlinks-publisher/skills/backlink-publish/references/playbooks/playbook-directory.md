# 目录站 / 导航站（category: 导航站）

最常见的类型：把自己网站提交到 AI 导航/网站目录。

## 流程
1. 入口：`submitUrl`（没有就找页面里的 Submit/Add site/提交链接）。
2. 勘察表单：字段通常是 网站名/URL/一句话描述/长描述/分类/Logo/邮箱。
3. 描述分层：按字段长度选短（<80 字符）/中（<160）/长（<400）三档里最合适的一档；内容围绕网站真实功能写，不堆关键词。
4. 分类：选最贴近的真实分类，宁缺勿错。
5. 邮箱：用 `mailbox_create` 生成一次性邮箱；若需邮箱验证链接，`mail_wait` 后点击或粘贴 `link`。
6. 填表推荐用 `browser action="batch_fill"` 一次填入多个字段并复查；提交前可用 `snapshot` 核对 URL/分类无误 → 提交 → 记录服务器回执文本。

## 常见坑
- 要求互挂徽标（"需要反链"）：**提交前**先走徽标流程——`backlinks badge_add` 入库 → 再调用 `backlinks action="badge_verify"`（传入 `siteUrl`、`expectedTarget`、可选 `refreshUrl` 如 `https://<我方host>/footer/refresh`）直接触发刷新并验证首页 HTML 出现对方域名 → 确认 `verified: true` 后才去对方站点 Verify/提交（禁止依赖 `bash`/`curl`）。
- 要求 meta 标签验证：无法在对方站验证我方标签 → `manual_required`，告诉用户需要在自己网站加什么标签。
- 收费目录（$ 提示/Stripe）→ `skipped`（付费）。
