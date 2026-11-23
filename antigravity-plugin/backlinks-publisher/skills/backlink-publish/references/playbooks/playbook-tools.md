# 工具站 / AI 工具目录（category: 工具站）

Product Hunt 类、AI 工具导航。目录站的强化版。

## 流程
1. submitUrl 或 Submit tool 入口。
2. 表单常见：工具名/URL/一句话 pitch/功能标签/定价档(Free/Freemium/Paid)/Logo/截图/Twitter 链接。
3. 定价档如实选；pitch 一句话讲清"解决什么问题"。
4. 可能要求邮箱验证（`mail_wait` 默认 30s，超时即标 `failed + manual_required`）或 Twitter/账号绑定（→ `manual_required`）。
5. 提交后：即时上架 → 核验 live；进入审核队列 → submitted。

## 常见坑
- "Claim your listing"型：先查该站是否已收录目标网站（搜索站内）；已存在 → 走 claim 流程而不是重复提交。
- 要求反向链接才收录：先 `badge_add` + `badge_verify`，成功后再提交，提交成功回写 `submitted`（备注等对方审核）。**若 `Verify Badge` 失败且放弃提交，必须立即调用 `backlinks action="badge_deactivate"` 回滚停用/删除该徽标，并同步打标（如 `submitmatic_verify_fail`）；同批同模板连续失败 2 次即触发熔断，不再对剩余匹配站挂徽标。**
- 遇强制收费 → `skipped` + `source_tags: ["paid_only"]`；遇无免费提交入口 → `source_tags: ["no_form"]`；遇 CloudFront 403 → `source_tags: ["waf_403"]`。
