/**
 * 全量修复脚本：当TypeORM synchronize: true 导致 ProductVariantPrice 被意外清空时，
 * 此脚本将为所有的 ProductVariant 重建基础的 EUR 价格链接，
 * 然后触发多国价格同步。
 */
import { bootstrap, RequestContextService, ChannelService, CurrencyCode, TransactionalConnection, ProductVariantService } from '@vendure/core';
import { config } from '../src/vendure-config';
import { PriceUpdaterService } from '../src/plugins/multi-country/services/price-updater.service';

async function forceRepairPrices() {
    console.log('🚀 Starting Full Price Repair...');

    // 设置临时端口防止和主进程冲突
    config.apiOptions.port = 3056; // 换一个没被占用的端口
    (config.dbConnectionOptions as any).synchronize = false;

    const app = await bootstrap(config);
    const requestContextService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);
    const variantService = app.get(ProductVariantService);
    const connection = app.get(TransactionalConnection);

    const defaultChannel = await channelService.getDefaultChannel();
    console.log(`[1/3] Default Channel found: ${defaultChannel.code}`);

    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: defaultChannel,
    });

    console.log('[2/3] Rebuilding Base EUR Prices for ALL Variants...');
    try {
        const allVariants = await variantService.findAll(ctx);
        console.log(`      Found ${allVariants.items.length} variants to repair.`);

        for (const variant of allVariants.items) {
            const existingRow = await connection.rawConnection.query(
                `SELECT * FROM product_variant_price WHERE variantId = ? AND currencyCode = ?`,
                [variant.id, 'EUR']
            );

            if (existingRow.length === 0) {
                console.log(`      ⚠️ Variant ${variant.id} (${variant.sku}) is missing EUR price. Rebuilding default 19.99 EUR.`);
                // SQLite requires string for datetime
                const now = new Date().toISOString();
                await connection.rawConnection.query(
                    `INSERT INTO product_variant_price (createdAt, updatedAt, price, channelId, variantId, currencyCode) VALUES (?, ?, ?, ?, ?, ?)`,
                    [now, now, 1999, defaultChannel.id, variant.id, 'EUR']
                );
            }
        }
        console.log('      ✅ Base prices validated and repaired.');
    } catch (err: any) {
        console.log(`      ⚠️ Failed to patch base prices: ${err.message}`);
    }

    console.log('[3/3] Forcing Product Price Synchronization with full Context...');
    const priceUpdaterService = app.get(PriceUpdaterService);
    try {
        await priceUpdaterService.updateAllProductPrices(ctx);
        console.log('      ✅ Multi-country product prices successfully updated.');
    } catch (err: any) {
        console.error(`      ❌ Failed to synchronize product prices: ${err.message}`);
    }

    console.log('🎉 Full Repair complete! Shutting down script context.');
    await app.close();
    process.exit(0);
}

forceRepairPrices().catch(err => {
    console.error('❌ FATAL SCRIPT ERROR:', err);
    process.exit(1);
});
