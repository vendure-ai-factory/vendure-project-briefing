# 网站二开功能：区域身份（Regional Identity）逻辑说明

## 1. 区域身份的获取流转
本系统的区域身份锚定遵循以下双阶段逻辑：

### A. 游客阶段 (Pre-registration)
*   **入口**：全新用户进入网站时，如果检测到国家 Cookie 为空，系统必须弹出 **【欢迎页面】 (/welcome)**。
*   **存储**：用户在欢迎页面选择国家后，该信息将存储在浏览器 Cookie (`country_code`) 中。
*   **作用**：此 Cookie 用于确定前端加载的默认频道 (Channel)、价格货币和税率。

### B. 账户同步阶段 (Post-registration / Payment)
*   **Stripe 集成**：用户在完成第一次支付后，系统会从 Stripe 接口获取用户的 **CUZ (Customer ID)** 和 **Email**。
*   **自动开户**：利用 Stripe 返回的信息自动作为 Vendure 账户的基础资料。
*   **身份回填**：在开户或关联过程中，系统必须将当前 Cookie 中的默认国家（`country_code`）自动写入 Vendure 客户资料中的自定义字段 **`countryCode`**。
*   **持久性**：一旦 `countryCode` 被回填，该用户的“家乡身份”即被固化在服务端，无论用户更换何种设备登录，都能保持一致。

## 2. 身份缺失的处理逻辑
*   **强制引导**：如果系统发现用户的 `countryCode` 为空且 Cookie 分发也失效，系统**严禁**从 Native Address (原生地址库) 降级猜测。
*   **唯一补救**：必须重新弹出 【欢迎页面】 让客户手动选择。
*   **反向回填**：如果当前客户已登录且其 `countryCode` 为空，用户在欢迎页面选定国家后，系统应自动将此选择更新到服务端的 `countryCode` 字段中。

---
*记录日期：2026-03-18*
*维护者：Antigravity AI*
