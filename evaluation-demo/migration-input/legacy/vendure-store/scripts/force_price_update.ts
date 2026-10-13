/**
 * 一次性修复脚本：通过 API 补全频道可用货币，并通过具有完全上下文的权限强制刷新所有国家产品的法定汇率定价。
 */
import { bootstrap, RequestContextService, ChannelService, CurrencyCode, TransactionalConnection } from '@vendure/core';
import { config } from '../src/vendure-config';
import { PriceUpdaterService } from '../src/plugins/multi-country/services/price-updater.service';

async function forceUpdatePrices() {
    console.log('🚀 Starting Force Price Update for Statutory Currencies...');

    // 设置临时端口防止和主进程冲突，因为我们要唤起完整的 app
    config.apiOptions.port = 3055;
    (config.dbConnectionOptions as any).synchronize = false;

    const app = await bootstrap(config);
    const requestContextService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);
    const priceUpdaterService = app.get(PriceUpdaterService);

    const defaultChannel = await channelService.getDefaultChannel();
    console.log(`[1/3] Default Channel found: ${defaultChannel.code}`);

    // Create a fully-authorized admin context matching the default channel
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: defaultChannel,
    });

    // 1. Ensure the Channel has the statutory currencies available
    console.log('[2/3] Patching availableCurrencyCodes on default channel...');
    try {
        await channelService.update(ctx, {
            id: defaultChannel.id,
            availableCurrencyCodes: [
                CurrencyCode.EUR,
                CurrencyCode.USD,
                CurrencyCode.HUF,
                CurrencyCode.GBP,
                CurrencyCode.CNY
            ]
        });
        console.log('      ✅ Channel currencies successfully patched.');
    } catch (err: any) {
        console.log(`      ⚠️  Failed to patch channel currencies: ${err.message}`);
    }

    // 2. Trigger the PriceUpdaterService with the proper context!
    // Previously, onApplicationBootstrap was using RequestContext.empty(), causing Vendure to reject saving prices.
    console.log('[3/3] Forcing Product Price Synchronization with full Context...');
    try {
        await priceUpdaterService.updateAllProductPrices(ctx);
        console.log('      ✅ All product prices successfully updated.');
    } catch (err: any) {
        console.error(`      ❌ Failed to synchronize product prices: ${err.message}`);
    }

    // Clean up
    console.log('🎉 Force update complete! Shutting down script context.');
    await app.close();
    process.exit(0);
}

forceUpdatePrices().catch(err => {
    console.error('❌ FATAL SCRIPT ERROR:', err);
    process.exit(1);
});
