// @ts-nocheck
import { bootstrapWorker, RequestContextService, ProductService, CollectionService, ChannelService } from '@vendure/core';
import { config } from '../src/vendure-config';

async function run() {
    const { app } = await bootstrapWorker(config);
    const productService = app.get(ProductService);
    const requestContextService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({ apiType: 'admin', channelOrToken: channel });

    console.log('🔍 Comprehensive System-Wide Audit (V5.2 - Robust Guards)');
    console.log('----------------------------------------');

    const allProducts = await productService.findAll(ctx, {
        relations: ['variants', 'assets', 'collections']
    });

    console.log(`Total Products in Database: ${allProducts.items.length}`);

    const countries = ['DE', 'HU', 'AT'];
    for (const code of countries) {
        console.log(`\n🌍 Auditing Country: ${code}`);

        // DE products might just have Design ID suffix if published by V9.2
        const countryProducts = allProducts.items.filter(p => {
            if (code === 'DE') {
                return p.name.includes('测试多国商品（新思路）1') && !p.name.includes('[HU]') && !p.name.includes('[AT]');
            }
            return p.name.includes(`[${code}]`);
        });

        console.log(`Found ${countryProducts.length} matching products.`);

        for (const p of countryProducts) {
            const variant = p.variants?.[0];
            const price = variant ? variant.price : 'N/A';
            const sku = variant ? variant.sku : 'N/A';
            const countryField = p.customFields?.countryCode || 'N/A';
            const masterId = p.customFields?.masterProductId || 'N/A';
            const collections = p.collections?.map(c => c.name).join(', ') || 'None';

            console.log(` - [${p.id}] ${p.name}`);
            console.log(`   - Price: ${price} | SKU: ${sku}`);
            console.log(`   - Collections: ${collections}`);
            console.log(`   - CustomField: countryCode=${countryField}, masterProductId=${masterId}`);
            console.log(`   - Assets Count: ${p.assets?.length || 0}`);
        }
    }

    await app.close();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
