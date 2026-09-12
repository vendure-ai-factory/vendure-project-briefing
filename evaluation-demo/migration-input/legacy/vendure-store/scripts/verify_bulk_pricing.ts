import { bootstrap, OrderService, ProductVariantService, RequestContext, ChannelService, LanguageCode } from '@vendure/core';
import { config } from '../src/vendure-config';

/**
 * 自动化验证脚本 (多币种增强版)：
 * 1. 找到一个主商品变体，设置 pearlSurcharge = 100 (1.00 EUR)
 * 2. 触发 PriceUpdaterService 进行同步
 * 3. 提示在日志或数据库中检查子商品 (如 HU) 是否已自动换算加价
 */
async function runVerification() {
    const app = await bootstrap(config);
    const ctx = await app.get(ChannelService).getDefaultChannel().then(c => new RequestContext({
        channel: c,
        apiType: 'admin',
        isAuthorized: true,
        authorizedPermissions: [],
        languageCode: LanguageCode.zh,
    }));

    const variantService = app.get(ProductVariantService);
    const priceUpdater = app.get('PriceUpdaterService' as any);

    console.log('--- 步骤 1: 设置主变体加价信息 (欧元) ---');
    const variants = await variantService.findAll(ctx, { take: 10 });
    // 找到一个 masterProductId 不为空的变体作为目标（或者直接修改第一个作为 Master）
    const targetVariant = variants.items[0];

    if (!targetVariant) {
        console.error('未找到任何商品变体');
        process.exit(1);
    }

    await variantService.update(ctx, [{
        id: targetVariant.id,
        customFields: {
            pearlSurcharge: 100, // 1.00 EUR
            silverSurcharge: 200, // 2.00 EUR
        }
    }]);
    console.log(`✅ 主变体 [${targetVariant.name}] 已设加价: 珠光 +1.00, 银闪 +2.00`);

    console.log('\n--- 步骤 2: 触发多国同步 ---');
    if (priceUpdater) {
        await priceUpdater.updateAllProductPrices(ctx);
        console.log('✅ 已手动触发各子国家的汇率与加价换算。');
    }

    console.log('\n--- 验证完成 ---');
    console.log('请重启服务后在后台检查匈牙利等国家的商品，加价金额应已按汇率换算。');

    await app.close();
}

runVerification().catch(err => {
    console.error(err);
    process.exit(1);
});
