// @ts-nocheck
import { bootstrapWorker, RequestContextService, ProductService, CollectionService, ChannelService, ProductVariantService, LanguageCode } from '@vendure/core';
import { config } from '../src/vendure-config';
import * as fs from 'fs-extra';
import * as path from 'path';

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
        console.log(`  CountryCode: ${p.customFields.countryCode}`);
        console.log(`  MasterID: ${p.customFields.masterProductId}`);

        // Find variants to see currency and price
        const variants = await productVariantService.getVariantsByProductId(ctx, p.id);
        console.log(`  Variant Count: ${variants.items.length}`);
        for (const v of variants.items) {
            console.log(`    Variant: ${v.name} (SKU: ${v.sku})`);
            console.log(`    Currency: ${v.currencyCode}`);
            console.log(`    Price: ${v.price}`);
        }

        // Check assets
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
        const entries = fs.readdirSync(NEW_DIR);
        for (const entry of entries) {
            const stat = fs.statSync(path.join(NEW_DIR, entry));
            console.log(`  ${entry} (${stat.isDirectory() ? 'DIR' : 'FILE'})`);
        }
    }

    if (fs.existsSync(ARCHIVE_ROOT)) {
        console.log(`Latest folders in ${ARCHIVE_ROOT}:`);
        const folders = fs.readdirSync(ARCHIVE_ROOT).sort().reverse().slice(0, 5);
        for (const folder of folders) {
            console.log(`Folder: ${folder}`);
            const folderPath = path.join(ARCHIVE_ROOT, folder);
            if (fs.statSync(folderPath).isDirectory()) {
                const subEntries = fs.readdirSync(folderPath);
                console.log(`  Contents: ${subEntries.join(', ')}`);
            }
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
