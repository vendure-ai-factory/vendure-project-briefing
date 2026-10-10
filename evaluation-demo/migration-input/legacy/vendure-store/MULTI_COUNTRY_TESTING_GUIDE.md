# 多国业务功能测试指南 (Multi-Country Testing Guide)

本指南帮助您验证多国业务功能的正确性，包括价格乘数、汇率更新、自动产品发布及前端排序功能。

## 1. 准备工作

确保您的开发环境已启动 (Backend, Storefront, Worker)。

```bash
# 检查 Worker 状态（日志默认写入当前工作区的 artifacts）
tail -n 200 ./artifacts/logs/worker.log
```

## 2. 验证价格乘数与汇率 (Backend)

### 设置价格乘数
运行脚本为特定国家设置价格乘数。例如，将奥地利 (AT) 的价格设为基础价格的 1.2 倍。

```bash
npx ts-node scripts/set_country_multiplier.ts AT 1.2
```

### 触发价格更新
您可以手动触发 `update-prices` Job (如果配置了 Cron)，或者等待定时任务。
或者，您可以再次运行发布脚本，它会触发 `PriceUpdaterService` 的逻辑（如果有相关钩子）。
**注意**: `PriceUpdaterService` 主要是作为定时任务运行，或在汇率变化时触发。

要手动测试 `PriceUpdaterService`，可以在 `publish_product.ts` 运行后检查数据库中的 `product_variant_price` 表。

## 3. 验证自动产品发布 (Publish Script)

此脚本将：
1. 创建/获取 "Country" Facet 和 "Germany", "Austria", "Hungary" FacetValues。
2. 创建主产品 (Master Product)，归类为 "Germany"。
3. 自动创建子产品 (Child Product) for AT (Austria) 和 HU (Hungary)。
4. 自动设置子产品的 `customFields` (masterProductId, countryCode)。
5. 自动根据汇率和乘数计算价格 (EUR Base + Target Currency Price)。

### 运行脚本
请确保 `./fixtures/美甲图案` 目录下有测试图片和文件夹结构。也可以通过
`INPUT_DIR` 环境变量指定另一份本地测试输入。

```bash
# 在仓库根目录下
cd ./legacy/vendure-store
npx ts-node scripts/publish_product.ts
```

### 验证结果
1. 进入 Vendure Admin 后台。
2. 检查 **Products** 列表。应该看到 "Product Name [AT]", "Product Name [HU]" 等。
3. 检查 **Facets**。应该有 "Country" Facet。
4. 检查 **Collections**。应该有 "Germany", "Austria", "Hungary" 集合，并且包含对应产品。

## 4. 验证前端排序 (Storefront)

1. 打开店铺前端 `/search` 页面。
2. 在右上角查看是否有 "Sort by" 下拉菜单。
3. 选择 "Newest Arrivals" (最新发布)。
4. 验证产品是否按 `createdAt` 倒序排列。

## 5. 验证地址与货币映射

1. 在前端切换到 "Hungary" (如果实现了 Shield)。
2. 将 "Product [HU]" 加入购物车。
3. 检查价格显示是否为 HUF (如果已切换货币)。
4. 检查结算流程中，地址选择是否限制为 Hungary。

## 6. 常见问题排查

- **报错 `addProductsToCollection` not found**: 脚本已更新为使用 `Facet` 和 `CollectionFilter` 逻辑，请确保代码已同步。
- **价格未更新**: 检查 `ExchangeRate` 表是否有数据。如果没有，运行 `ExchangeRateService` 的更新逻辑或手动插入数据。
- **Frontend 500 Error**: 检查 `vendure-config.ts` 中的 `indexDate: true` 是否生效，并重新构建索引 (`SearchIndexService.reindex(ctx)`).

---
**说明**：本指南中的默认路径均为仓库相对路径。涉及测试账号、管理员账号、数据库、归档目录或外部工具时，请先按仓库根目录的 `PUBLICATION_SANITIZATION_REPORT.md` 配置环境变量；不要把密码写回脚本或提交到 Git。
