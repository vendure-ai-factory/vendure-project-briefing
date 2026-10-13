// @ts-nocheck
import { bootstrapWorker, RequestContext, ProductService, ProductVariantService, AssetService, ChannelService, RequestContextService, LanguageCode, CurrencyCode, Transaction, CollectionService, Collection, FacetService, FacetValueService, Logger } from '@vendure/core';
import { CreateProductInput, ConfigurableOperationInput } from '@vendure/common/lib/generated-types';
import { config } from '../src/vendure-config';
import fs from 'fs-extra';
import path from 'path';
import { productTemplate } from './templates/product_template';

// --- Configuration ---
const INPUT_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');
const LOG_FILE = process.env.LOG_FILE || path.resolve(process.cwd(), 'artifacts', 'product_import_log.csv');
const LOOKUP_TABLE = process.env.LOOKUP_TABLE || path.resolve(process.cwd(), 'artifacts', 'design_lookup_table.csv');
const PRODUCT_INFO_FILE = path.join(INPUT_DIR, 'product_info.json');

// Interface for Import Result
interface ImportResult {
    file: string;
    designId: string;
    status: 'SUCCESS' | 'SKIPPED' | 'ERROR';
    productId?: string;
    productName?: string;
    sku?: string;
    message?: string;
    timestamp: string;
}

// Helper to write CSV line
function logResult(result: ImportResult) {
    const header = 'Timestamp,File,DesignID,Status,ProductID,ProductName,SKU,Message\n';
    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, header);
    }
    const line = `${result.timestamp},${result.file},${result.designId},${result.status},${result.productId || ''},${result.productName || ''},${result.sku || ''},"${result.message || ''}"\n`;
    fs.appendFileSync(LOG_FILE, line);
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 5, interval = 2000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries > 0 && (err.code === 'SQLITE_BUSY' || err.message?.includes('database is locked'))) {
            console.warn(`⚠️ Database is locked. Retrying in ${interval}ms... (${retries} retries left)`);
            await delay(interval);
            return withRetry(fn, retries - 1, interval * 1.5);
        }
        throw err;
    }
}

// Helper to check if file is an image
function isImage(filename: string): boolean {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    return validExtensions.includes(path.extname(filename).toLowerCase());
}

async function run() {
    console.log('🚀 Starting Product Publishing Script (V9.2 - Final Fixed Collection & DB Retry)...');

    (config.dbConnectionOptions as any).synchronize = true;

    const { app } = await bootstrapWorker(config);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const assetService = app.get(AssetService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);
    const collectionService = app.get(CollectionService);
    const facetService = app.get(FacetService);
    const facetValueService = app.get(FacetValueService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    await fs.ensureDir(ARCHIVE_ROOT);
    await fs.ensureDir(INPUT_DIR);

    let allEntries: string[] = [];
    try {
        allEntries = await fs.readdir(INPUT_DIR);
    } catch (e: any) {
        console.error(`Error reading directory ${INPUT_DIR}:`, e.message);
        process.exit(1);
    }

    const effectDirName = allEntries.find(f => {
        try {
            return fs.statSync(path.join(INPUT_DIR, f)).isDirectory();
        } catch (e) { return false; }
    });

    if (!effectDirName) {
        console.error('❌ Error: No effect directory found in', INPUT_DIR);
        process.exit(1);
    }
    const EFFECT_DIR = path.join(INPUT_DIR, effectDirName);

    const designFiles = allEntries.filter(f => {
        try {
            const fullPath = path.join(INPUT_DIR, f);
            return fs.statSync(fullPath).isFile() && isImage(f);
        } catch (e) { return false; }
    });

    let productInfoName: string | undefined;
    if (fs.existsSync(PRODUCT_INFO_FILE)) {
        try {
            const info = fs.readJSONSync(PRODUCT_INFO_FILE);
            if (info.name) productInfoName = info.name;
        } catch (e) { }
    }

    const processedFiles: string[] = [];

    for (const designFile of designFiles) {
        const designId = path.parse(designFile).name;
        console.log(`Processing Design ID: ${designId}...`);

        await withRetry(async () => {
            const result: ImportResult = {
                file: designFile,
                designId,
                status: 'ERROR',
                timestamp: new Date().toISOString()
            };

            try {
                const designPath = path.join(INPUT_DIR, designFile);
                const effectEntries = await fs.readdir(EFFECT_DIR);
                const effectFile = effectEntries.find((f: string) => path.parse(f).name === designId && isImage(f));

                if (!effectFile) {
                    result.status = 'SKIPPED';
                    result.message = `No effect Matching image found.`;
                    logResult(result);
                    return;
                }

                const effectPath = path.join(EFFECT_DIR, effectFile);

                const designAsset = await assetService.create(ctx, {
                    file: {
                        createReadStream: () => fs.createReadStream(designPath),
                        filename: designFile,
                        mimetype: 'image/jpeg',
                        encoding: '7bit'
                    } as any,
                });

                const effectAsset = await assetService.create(ctx, {
                    file: {
                        createReadStream: () => fs.createReadStream(effectPath),
                        filename: effectFile,
                        mimetype: 'image/jpeg',
                        encoding: '7bit'
                    } as any,
                });

                const product = await productService.create(ctx, {
                    translations: productTemplate.translations.map(t => ({
                        languageCode: t.languageCode,
                        name: productInfoName ? `${productInfoName} [${designId}]` : t.name(designId),
                        slug: t.name(designId).toLowerCase().replace(/ /g, '-') + '-' + Math.random().toString(36).substring(7),
                        description: t.description,
                    })),
                    featuredAssetId: (designAsset as any).id,
                    assetIds: [(designAsset as any).id, (effectAsset as any).id],
                    customFields: { countryCode: 'DE' }
                });

                const sku = `SKU-${new Date().getTime()}-${designId}`;
                await productService.update(ctx, { id: product.id, customFields: { masterProductId: sku } });

                const variants = await productVariantService.getVariantsByProductId(ctx, product.id);
                if (variants.items.length > 0) {
                    await productVariantService.update(ctx, [{
                        id: variants.items[0].id,
                        sku: sku,
                        price: productTemplate.price,
                        trackInventory: 'FALSE' as any
                    }]);
                }

                // Collection Logic Fallback
                const collection = await ensureCollection(ctx, collectionService, 'Germany');
                try {
                    // Try standard 2.x method
                    await collectionService.addProductVariants(ctx, collection.id, variants.items.map(v => v.id));
                } catch (e) {
                    console.log('addProductVariants failed, trying addProducts...');
                    try {
                        await collectionService.addProducts(ctx, collection.id, [product.id]);
                    } catch (e2) {
                        console.error('All collection assignment methods failed.');
                    }
                }

                result.status = 'SUCCESS';
                console.log(`[SUCCESS] Created ${product.name}`);
                processedFiles.push(designFile);

            } catch (e: any) {
                console.error(`[ERROR] ${designId}:`, e.message);
                throw e; // Retry
            }

            logResult(result);
        });

        await delay(300);
    }

    // ARCHIVE
    if (processedFiles.length > 0) {
        const sessionSku = `BATCH-${new Date().getTime()}`;
        const archiveDir = path.join(ARCHIVE_ROOT, sessionSku);
        await fs.ensureDir(archiveDir);
        for (const file of processedFiles) {
            await fs.move(path.join(INPUT_DIR, file), path.join(archiveDir, file), { overwrite: true });
        }
        await fs.move(EFFECT_DIR, path.join(archiveDir, effectDirName), { overwrite: true });
        console.log(`✅ Archived to ${archiveDir}`);
    }

    await app.close();
    process.exit(0);
}

async function ensureCollection(ctx: RequestContext, collectionService: any, name: string) {
    const allCollections = await collectionService.findAll(ctx);
    let collection = allCollections.items.find((c: any) => c.name === name);
    if (!collection) {
        collection = await collectionService.create(ctx, {
            translations: [{ languageCode: LanguageCode.zh, name, slug: name.toLowerCase(), description: '' }],
            filters: [],
        });
    }
    return collection;
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
