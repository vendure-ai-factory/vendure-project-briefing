/**
 * 修复 Vendure Channel 默认货币为 EUR (V2 - 使用正确的 API)
 * 
 * Vendure 的 Channel 和产品价格使用 product_variant_price 表。
 * 此脚本使用 Vendure API 正确更新 Channel 默认货币。
 */
import { bootstrap, TransactionalConnection, ChannelService, CurrencyCode, RequestContext, RequestContextService } from '@vendure/core';
import { config } from '../src/vendure-config';

async function fixChannelCurrency() {
    console.log('🚀 Starting Channel Currency Fix V2...');

    config.apiOptions.port = 3050;
    (config.dbConnectionOptions as any).synchronize = true;

    const app = await bootstrap(config);
    const connection = app.get(TransactionalConnection);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);

    const defaultChannel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: defaultChannel,
    });

    console.log(`Current Channel: ID=${defaultChannel.id}, Currency=${defaultChannel.defaultCurrencyCode}`);

    if (defaultChannel.defaultCurrencyCode === CurrencyCode.EUR) {
        console.log('✅ Channel already uses EUR. No changes needed.');
        await app.close();
        process.exit(0);
        return;
    }

    // 使用 Vendure 的 ChannelService.update API 更新 Channel
    try {
        await channelService.update(ctx, {
            id: defaultChannel.id,
            defaultCurrencyCode: CurrencyCode.EUR,
            availableCurrencyCodes: [CurrencyCode.EUR, CurrencyCode.USD, CurrencyCode.HUF, CurrencyCode.GBP, CurrencyCode.CNY],
        });
        console.log('✅ Channel default currency updated to EUR via API.');
    } catch (apiError: any) {
        console.log(`API update failed: ${apiError.message}. Trying raw SQL...`);
        // Fallback: 直接更新 channel 表
        try {
            await connection.rawConnection.query(`
                UPDATE channel SET defaultCurrencyCode = 'EUR' WHERE id = ?
            `, [defaultChannel.id]);
            console.log('✅ Channel updated via raw SQL.');
        } catch (sqlError: any) {
            console.error('❌ Both API and SQL failed:', sqlError.message);
        }
    }

    // 更新 product_variant_price 表中的 currencyCode
    try {
        const result = await connection.rawConnection.query(`
            UPDATE product_variant_price SET currencyCode = 'EUR' WHERE currencyCode = 'USD'
        `);
        console.log(`Updated product_variant_price: ${JSON.stringify(result)}`);
    } catch (e: any) {
        console.warn(`product_variant_price update note: ${e.message}`);
    }

    // 验证
    const updatedChannel = await channelService.getDefaultChannel();
    console.log(`Verified Channel Currency: ${updatedChannel.defaultCurrencyCode}`);

    console.log('✅ Channel currency fix complete!');
    await app.close();
    process.exit(0);
}

fixChannelCurrency().catch(err => {
    console.error('❌ ERROR:', err);
    process.exit(1);
});
