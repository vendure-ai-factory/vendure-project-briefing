// @ts-nocheck
import { bootstrapWorker, RequestContextService, ProductService, ProductVariantService, AssetService, ChannelService, LanguageCode, CollectionService, FacetService, FacetValueService } from '@vendure/core';
import { CreateProductInput } from '@vendure/common/lib/generated-types';
import { config } from '../src/vendure-config';
import fs from 'fs-extra';
import path from 'path';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 5, interval = 2000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries > 0 && (err.code?.includes('SQLITE_BUSY') || err.message?.includes('database is locked'))) {
            console.warn(`⚠️ Database is locked. Retrying in ${interval}ms... (${retries} retries left)`);
            await delay(interval);
            return withRetry(fn, retries - 1, interval * 1.5);
        }
        throw err;
    }
}

async function run() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        process.exit(1);
    }

    const targetCountryCode = args[0].toUpperCase();
    const multiplier = parseFloat(args[1]);
    const batchFolder = args[2];

    const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');
    const batchPath = path.join(ARCHIVE_ROOT, batchFolder);

    const { app } = await bootstrapWorker(config);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const assetService = app.get(AssetService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);
    const collectionService = app.get(CollectionService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({ apiType: 'admin', channelOrToken: channel });

    const countryNames: Record<string, string> = { 'HU': 'Hungary', 'AT': 'Austria', 'DE': 'Germany' };
    const countryName = countryNames[targetCountryCode] || targetCountryCode;

    const allEntries = await fs.readdir(batchPath);
    const designFiles = allEntries.filter(f => f.match(/\.(png|jpg|jpeg)$/i));
    const effectDirName = allEntries.find(f => fs.statSync(path.join(batchPath, f)).isDirectory());
    const EFFECT_DIR = path.join(batchPath, effectDirName);

    for (const designFile of designFiles) {
        const designId = path.parse(designFile).name;
        console.log(`Processing Design: ${designId}...`);

        await withRetry(async () => {
            const effectEntries = await fs.readdir(EFFECT_DIR);
            const effectFile = effectEntries.find(f => path.parse(f).name === designId);
            if (!effectFile) return;

            const designAsset = await assetService.create(ctx, {
                file: {
                    createReadStream: () => fs.createReadStream(path.join(batchPath, designFile)),
                    filename: `${targetCountryCode}-design-${designFile}`,
                    mimetype: 'image/jpeg',
                    encoding: '7bit'
                } as any,
            });

            const effectAsset = await assetService.create(ctx, {
                file: {
                    createReadStream: () => fs.createReadStream(path.join(EFFECT_DIR, effectFile)),
                    filename: `${targetCountryCode}-effect-${effectFile}`,
                    mimetype: 'image/jpeg',
                    encoding: '7bit'
                } as any,
            });

            const newPrice = Math.round(299 * multiplier);
            const productName = `测试多国商品（新思路）1 [${targetCountryCode}] [${designId}]`;
            const slug = `independent-${targetCountryCode.toLowerCase()}-${designId}-${Math.random().toString(36).substring(7)}`;

            const product = await productService.create(ctx, {
                translations: [{ languageCode: LanguageCode.zh, name: productName, slug: slug, description: '' }],
                featuredAssetId: designAsset.id,
                assetIds: [designAsset.id, effectAsset.id],
                customFields: { countryCode: targetCountryCode, masterProductId: `${batchFolder}-${designId}` }
            });

            const variants = await productVariantService.getVariantsByProductId(ctx, product.id);
            if (variants.items.length > 0) {
                await productVariantService.update(ctx, [{
                    id: variants.items[0].id,
                    sku: `SKU-${targetCountryCode}-${designId}-${new Date().getTime()}`,
                    price: newPrice,
                    trackInventory: 'FALSE' as any
                }]);
            }

            const collection = await ensureCollection(ctx, collectionService, countryName);
            try {
                await collectionService.addProductVariants(ctx, collection.id, [variants.items[0].id]);
            } catch (e) {
                // Fallback for different Vendure versions
                try {
                    await collectionService.addProducts(ctx, collection.id, [product.id]);
                } catch (e2) { }
            }
            console.log(`   [SUCCESS] Published ${designId} to ${targetCountryCode}`);
        });
        await delay(500);
    }

    await app.close();
}

async function ensureCollection(ctx: any, collectionService: any, name: string) {
    const all = await collectionService.findAll(ctx);
    let c = all.items.find(i => i.name === name);
    if (!c) {
        c = await collectionService.create(ctx, {
            translations: [{ languageCode: LanguageCode.zh, name, slug: name.toLowerCase(), description: '' }],
            filters: [],
        });
    }
    return c;
}

run().catch(e => { console.error(e); process.exit(1); });
