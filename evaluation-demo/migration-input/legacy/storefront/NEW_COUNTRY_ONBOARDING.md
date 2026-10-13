# NEW_COUNTRY_ONBOARDING.md (新国家渠道拓展与调试指南)

本指南旨在指导技术人员在系统中通过 Vendure 渠道（Channel）机制快速上线新国家，并确保**钱包资产自动对冲**、**跨币种支付**以及**合规 KYC 生命周期**功能正常运作。

---

## 1. 后台配置流程 (Channel Setup)

1.  **定义区域与国家 (Zone & Country)**: 在 **Settings > Locations > Zones** 创建对应国家的 Zone。
2.  **创建国家渠道 (Create Channel)**: 在 **Settings > Channels** 创建对应 Channel。
3.  **配置币种与税区**: 设置 `Default Currency` 为本币，`Default Tax Zone` 为该 Zone。

---

## 2. 税务合规与 KYC 生命周期 (Compliance & KYC)

系统执行严格的欧盟 DAC7 / GoBD 税务合规逻辑。

### 第一阶段：手动表单 (Manual KycForm)
- **触发条件**：用户首次点击“申请提现”。
- **操作**：引导用户填写《个人信息登记表》（KycForm）。
- **字段**：姓名、详细地址、税务识别号 (Steuernummer)、小微企业声明。
- **存储**：生成 SHA-256 哈希值并存证。提现时 Gutschrift 必须且仅允许从该快照中提取受益人信息。

---

## 3. 钱包货币解耦机制 (Currency Decoupling)

- **显示逻辑**：钱包币种严格跟随 `Customer.customFields.countryCode` (默认国家)，而非 URL `/de/` 或 `/hu/` 路径。
- **汇率逻辑**：
    - `HUF`: 匈牙利。
    - `EUR`: 德国、奥地利、荷兰。
    - `EUR (Default)`: 所有标记为 `OTHER` 的国家。

---

## 4. 核心功能调试清单 (Affiliate Wallet Audit)

### 测试 A：用户身份切换 (Identity & Balance Switch)
- **动作**：变更用户资料中的 `countryCode`。
- **预期结果**：余额按汇率自动折算，记录审计日志。

### 测试 B：货币解耦验证 (Currency Decoupling)
- **动作**：设置用户默认国家为 `HU` (HUF)，但访问 `/de/account/wallet` (德国频道，EUR)。
- **预期结果**：钱包显示币种必须为 `HUF`。

---

## 5. 支付工具清单同步 (Payment Manifest Sync)

> [!IMPORTANT]
> **切记**：系统中的支付页面是基于数据库 `WorldFirstPaymentManifest` 表动态生成的。
> 1.  **开辟新国家渠道的时候，必须先在同步脚本/模拟库（`RegionalPaymentSyncService`）中添加该国家及其支付工具。**
> 2.  执行一次全量同步指令，确保数据库中该国家对应的 `displayName` 和 `logoUrl` 已就绪。
> 3.  **常见症状**：如果前端显示空白或显示旧的“Antom”字样，请第一时间检查数据库清单是否包含该国家的最新对标数据。

---

## 6. 常见故障排除 (Troubleshooting)

- **支付列表为空**: 检查 `WorldFirstPaymentManifest` 表中是否有该国家编码（如 AT）的记录。
- **配置生效延迟**: 检查 `RegionalPaymentSyncService` 的 `getMockDataForRegion` 是否包含新国家。
- **下拉菜单不显示新国家**: 检查 `CurrencyConverter` 缓存。
