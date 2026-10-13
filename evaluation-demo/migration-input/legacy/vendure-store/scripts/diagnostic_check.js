const { bootstrapWorker, RequestContextService, ProductService, CollectionService, ChannelService, ProductVariantService } = require('@vendure/core');
const { config } = require('../src/vendure-config');
const fs = require('fs-extra');
const path = require('path');

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

    console.log('--- Product Audit ---');
    const products = await productService.findAll(ctx, { filter: { name: { contains: '测试多国商品（新思路）1' } } });
    for (const p of products.items) {
        console.log(`Product: ${p.name} (ID: ${p.id})`);
        const cf = p.customFields || {};
        console.log(`  CountryCode: ${cf.countryCode}`);
        console.log(`  MasterID: ${cf.masterProductId}`);

        // Assets check
        const variants = await productVariantService.getVariantsByProductId(ctx, p.id);
        console.log(`  Variant Count: ${variants.items.length}`);
        for (const v of variants.items) {
            console.log(`    Variant: ${v.name} (SKU: ${v.sku})`);
            console.log(`    Currency: ${v.currencyCode}`);
            console.log(`    Price: ${v.price}`);
        }

        // Check assets directly on product
        const pWithAssets = await productService.findOne(ctx, p.id, ['assets']);
        console.log(`  Asset Count: ${pWithAssets?.assets?.length || 0}`);

        // Check collections
        const collections = await collectionService.getCollectionsByProductId(ctx, p.id);
        console.log(`  Collections: ${collections.map(c => c.name).join(', ')}`);
    }

    console.log('\n--- Filesystem Audit ---');
    const NEW_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
    const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');

    if (fs.existsSync(NEW_DIR)) {
        console.log(`Contents of ${NEW_DIR}:`);
        try {
            const entries = fs.readdirSync(NEW_DIR);
            for (const entry of entries) {
                const stat = fs.statSync(path.join(NEW_DIR, entry));
                console.log(`  ${entry} (${stat.isDirectory() ? 'DIR' : 'FILE'})`);
            }
        } catch (e) {
            console.log(`  Error accessing ${NEW_DIR}: ${e.message}`);
        }
    }

    if (fs.existsSync(ARCHIVE_ROOT)) {
        console.log(`Latest SKU folders in ${ARCHIVE_ROOT}:`);
        try {
            const skuFolders = fs.readdirSync(ARCHIVE_ROOT)
                .filter(f => f.startsWith('SKU-'))
                .sort()
                .reverse()
                .slice(0, 5);
            for (const folder of skuFolders) {
                console.log(`Folder: ${folder}`);
                const folderPath = path.join(ARCHIVE_ROOT, folder);
                const subEntries = fs.readdirSync(folderPath);
                console.log(`  Contents: ${subEntries.join(', ')}`);
            }
        } catch (e) {
            console.log(`  Error accessing ${ARCHIVE_ROOT}: ${e.message}`);
        }
    }

    console.log('\n--- Channels Audit ---');
    const allChannels = await channelService.findAll(ctx);
    for (const c of allChannels.items) {
        console.log(`Channel: ${c.code} (ID: ${c.id}, Currency: ${c.defaultCurrencyCode})`);
    }

    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
