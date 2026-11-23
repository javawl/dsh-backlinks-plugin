# 状态模型与回写映射

## 细状态 → 回写

| 情形 | item_result 回写 | 必打标准标签 (`source_tags`) |
|---|---|---|
| 公开页已核验含目标链接 | `live` + `publicUrl`/`anchorText`/`targetUrl`/`evidence` | `免徽章` / `要徽章` / `可复用` |
| 已提交、明确待审/收录 | `submitted` | `免徽章` / `要徽章` |
| 发布记录已存在（本条或同源条目 `publishStatus=submitted/live`、`publishedUrl` 非空） | `skipped` + `skipReason`（"发布记录已存在：<状态>，跳过重复发布"） | — |
| 目标站已能找到本站链接（勘察时检索命中） | `skipped` + `skipReason`（"目标站已存在本站链接，跳过重复发布"） | — |
| 付费墙 / 收费提交 | `skipped` + `skipReason` | `paid_only` |
| 无提交入口 / 无表单 | `skipped` + `skipReason` | `no_form` |
| 评论区已关闭 | `skipped` + `skipReason` | `comments_closed` |
| 死链 / 404 / 410 / 持续 5xx / DNS / TLS / 停服占位页 | `skipped` + `skipReason`（`batch_preflight autoSkip=true` 自动处理） | `dead_site` |
| CloudFront / WAF 403 硬拦截 | `failed(manual_required)` 或 `skipped`（勿删为死链） | `waf_403` |
| 人机验证码（reCAPTCHA / SecureImg / Turnstile / 数学题） | `failed` + `manual_required` | `has_captcha` |
| `@submitmatic` 等同模板 `Verify Badge` 校验失败（先 `badge_deactivate` 回滚！） | `failed` + `manual_required`（带 `templateSignature`） | `submitmatic_verify_fail` |
| 同模板熔断触发后剩余匹配条目 | `failed(manual_required)` 或 `skipped`（不再挂徽标/深挖） | 对应标准标签（如 `submitmatic_verify_fail` / `has_captcha`） |
| `mail_wait` 30s 未收到验证邮件 / 登录 OAuth 挂起 >15–20s | `failed` + `manual_required` | 按实际需要补打 |
| 网络/超时/后端瞬时错误（或单站导航 10s 超时） | `failed` + `retryable` | — |
| 提交了但拿不到回执（结果未知） | `failed` + `manual_required`（铁律：绝不重试） | — |

## 租约纪律

- 认领后每 1-2 个条目 `lease_heartbeat` 一次；租约被拒（LEASE_NOT_ACTIVE）立即停止，重新 claim。
- 并发冲突（LEASE_CONFLICT）按 Retry-After 等待，不硬抢。

## 证据写法（evidence）

一句话中文，含两个事实：核验方式 + 关键内容。例："公开列表页已抓取，包含锚文本'X'与目标链接"。
禁止把"按钮变灰/跳转成功/表单清空"当作 live 证据——那些都只是 submitted 级别。
