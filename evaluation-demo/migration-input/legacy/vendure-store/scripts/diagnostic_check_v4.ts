// @ts-nocheck
import { bootstrapWorker, RequestContextService, ProductService, CollectionService, ChannelService, ProductVariantService, LanguageCode } from '@vendure/core';
import { config } from '../src/vendure-config';

async function run() {
    const { app } = await bootstrapWorker(config);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const collectionService = app.get(CollectionService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    console.log('--- Hierarchy and Asset Audit ---');
    const products = await productService.findAll(ctx, { filter: { name: { contains: '测试多国商品（新思路）1' } } });
    for (const p of products.items) {
        // We need to fetch the product with relations
        const fullProduct = await productService.findOne(ctx, p.id, ['assets', 'variants', 'variants.assets', 'channels']);
        console.log(`Product: ${fullProduct.name} (ID: ${fullProduct.id})`);

        // Check for "Parent" product in Vendure 2.x terms (usually collections or facets)
        // But the user might mean the "Master" product.
        console.log(`  Country: ${fullProduct.customFields.countryCode}`);
        console.log(`  MasterID: ${fullProduct.customFields.masterProductId}`);

        // Check for parent (some custom fields might be used)
        console.log(`  Asset Count: ${fullProduct.assets.length}`);
        for (const asset of fullProduct.assets) {
            console.log(`    Asset: ${asset.name} (ID: ${asset.id})`);
        }

        const collections = await collectionService.getCollectionsByProductId(ctx, p.id);
        console.log(`  Collections: ${collections.map(c => c.name).join(', ')}`);

        // Multi-country specific: Check if this is a "child" in the user's eyes
        if (fullProduct.name.includes('[AT]') || fullProduct.name.includes('[HU]')) {
            // Look for the "parent" (the one without [AT]/[HU] and same MasterID)
            const parent = products.items.find(op => op.customFields.masterProductId === fullProduct.customFields.masterProductId && !op.name.includes('['));
            if (parent) {
                console.log(`  Relates to Master Product: ${parent.name} (ID: ${parent.id})`);
            }
        }
    }

    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
