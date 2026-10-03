
import { bootstrap, JobQueueService, ProductService, ProductVariantService, RequestContext, ChannelService, TaxCategoryService, AssetService, LanguageCode } from '@vendure/core';
import { config } from '../src/vendure-config';

(async () => {
    try {
        const app = await bootstrap(config);
        const productService = app.get(ProductService);
        const productVariantService = app.get(ProductVariantService); // Correct Service
        const channelService = app.get(ChannelService);

        console.log('>>> [Seed] Creating Mock Products...');

        const defaultChannel = await channelService.getDefaultChannel();

        const ctx = new RequestContext({
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            channel: defaultChannel,
            languageCode: LanguageCode.en,
        });

        const products = [
            { name: 'Aurora Borealis Nails', price: 2500, description: 'Shimmering northern lights design' },
            { name: 'Gothic Rose Set', price: 3000, description: 'Dark romantic floral patterns' },
            { name: 'Summer Ocean Vibes', price: 1800, description: 'Blue waves and sandy textures' },
        ];

        for (const p of products) {
            console.log(`Creating: ${p.name}`);
            const product = await productService.create(ctx, {
                translations: [{
                    languageCode: LanguageCode.en,
                    name: p.name,
                    slug: p.name.replace(/\s+/g, '-').toLowerCase(),
                    description: p.description,
                }],
            });

            // Create Variant
            await productVariantService.create(ctx, [{
                productId: product.id,
                sku: p.name.substring(0, 3).toUpperCase() + '-001',
                price: p.price,
                translations: [{ languageCode: LanguageCode.en, name: p.name + ' Standard' }],
                stockOnHand: 100,
            }]);

            console.log(`✅ Created Product: ${p.name} (ID: ${product.id})`);
        }

        console.log('✅ [Seed] Products Created.');
        process.exit(0);
    } catch (e: any) {
        console.error('❌ Expected Error during seed:', e.message);
        process.exit(1);
    }
})();
