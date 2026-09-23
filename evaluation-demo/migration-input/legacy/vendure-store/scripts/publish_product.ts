import { bootstrapWorker, RequestContext, ProductService, ProductVariantService, AssetService, ChannelService, RequestContextService, LanguageCode, CurrencyCode, Transaction, CollectionService, Collection, FacetService, FacetValueService } from '@vendure/core';
import { CreateProductInput, ConfigurableOperationInput } from '@vendure/common/lib/generated-types';
import { config } from '../src/vendure-config';
// @ts-ignore
import fs from 'fs-extra';
import path from 'path';
import { productTemplate } from './templates/product_template';

// --- Configuration ---
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

async function withRetry<T>(fn: () => Promise<T>, retries = 3, interval = 2000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries > 0 && (err.code === 'SQLITE_BUSY' || err.message?.includes('database is locked'))) {
            console.warn(`⚠️ Database is locked. Retrying in ${interval}ms... (${retries} retries left)`);
            await delay(interval);
            return withRetry(fn, retries - 1, interval * 2);
        }
        throw err;
    }
}

// Helper to update Lookup Table
function updateLookupTable(designId: string, sku: string, productName: string, archiveLocation: string) {
    const header = 'DesignID,SKU,ProductName,ArchiveLocation\n';
    if (!fs.existsSync(LOOKUP_TABLE)) {
        fs.writeFileSync(LOOKUP_TABLE, header);
    }
    // Check if entry exists to avoid duplicates (simple check)
    const content = fs.readFileSync(LOOKUP_TABLE, 'utf-8');
    if (!content.includes(`${designId},${sku}`)) {
        const line = `${designId},${sku},${productName},"${archiveLocation}"\n`;
        fs.appendFileSync(LOOKUP_TABLE, line);
    }
}

// Helper to check if file is an image
function isImage(filename: string): boolean {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    return validExtensions.includes(path.extname(filename).toLowerCase());
}

async function run() {
    console.log('🚀 Starting Product Publishing Script (V7.2 - Nested)...');

    // 0. Modify Config for Script Execution (Enable sync for new surcharges)
    (config.dbConnectionOptions as any).synchronize = true;

    // 1. Initialize Vendure (Worker mode avoids port conflicts)
    const { app } = await bootstrapWorker(config);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const assetService = app.get(AssetService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);
    const collectionService = app.get(CollectionService);
    const facetService = app.get(FacetService);
    const facetValueService = app.get(FacetValueService);

    // 2. Setup Context
    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    // 3. Prepare Folders
    await fs.ensureDir(ARCHIVE_ROOT);
    await fs.ensureDir(INPUT_DIR);

    // 4. Scan for Design Files (Level 1)
    let allEntries: string[] = [];
    try {
        allEntries = await fs.readdir(INPUT_DIR);
    } catch (e: any) {
        console.error(`Error reading directory ${INPUT_DIR}:`, e.message);
        process.exit(1);
    }

    // Filter for image files only (Designs)
    const designFiles = allEntries.filter(f => {
        const fullPath = path.join(INPUT_DIR, f);
        return fs.statSync(fullPath).isFile() && isImage(f);
    });


    // 4.1 Read Product Info JSON (Optional)
    let productInfoName: string | undefined;
    if (fs.existsSync(PRODUCT_INFO_FILE)) {
        try {
            const info = fs.readJSONSync(PRODUCT_INFO_FILE);
            if (info.name) {
                productInfoName = info.name;
                console.log(`Loaded Product Name Override: ${productInfoName}`);
            }
        } catch (e) {
            console.warn('Failed to read product_info.json:', e);
        }
    }

    // 5. Process Loop
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
                const subDirName = designId; // Expect subdirectory to have same name as design file
                const subDirPath = path.join(INPUT_DIR, subDirName);

                // Check for Level 2 Directory (Effect Map)
                if (!await fs.pathExists(subDirPath) || !(await fs.stat(subDirPath)).isDirectory()) {
                    result.status = 'SKIPPED';
                    result.message = `Missing Level 2 directory (${subDirName}/) for design (${designFile})`;
                    console.log(`[SKIP] ${result.message}`);
                    logResult(result);
                    return;
                }

                // Find Effect File in Level 2 Directory
                const subDirEntries = await fs.readdir(subDirPath);
                const effectFile = subDirEntries.find((f: string) => isImage(f)); // Take first valid image

                if (!effectFile) {
                    result.status = 'SKIPPED';
                    result.message = `No effect image found in Level 2 directory (${subDirName}/)`;
                    console.log(`[SKIP] ${result.message}`);
                    logResult(result);
                    return;
                }

                const effectPath = path.join(subDirPath, effectFile);
                console.log(`   Design: ${designFile}`);
                console.log(`   Effect: ${subDirName}/${effectFile}`);

                // A. Create Assets
                // 1. Design Asset (Primary)
                const designAsset = await assetService.create(ctx, {
                    file: {
                        createReadStream: () => fs.createReadStream(designPath),
                        filename: designFile,
                        mimetype: 'image/' + path.extname(designFile).substring(1).replace('jpg', 'jpeg'),
                        encoding: '7bit'
                    } as any,
                });

                if ((designAsset as any).message) throw new Error('Failed to create Design asset: ' + (designAsset as any).message);

                // 2. Effect Asset (Secondary)
                const effectAsset = await assetService.create(ctx, {
                    file: {
                        createReadStream: () => fs.createReadStream(effectPath),
                        filename: effectFile,
                        mimetype: 'image/' + path.extname(effectFile).substring(1).replace('jpg', 'jpeg'),
                        encoding: '7bit'
                    } as any,
                });

                if ((effectAsset as any).message) throw new Error('Failed to create Effect asset: ' + (effectAsset as any).message);


                // B. Create Product
                const productInput = {
                    translations: productTemplate.translations.map(t => ({
                        languageCode: t.languageCode,
                        name: productInfoName ? `${productInfoName} [${designId}]` : t.name(designId),
                        slug: productTemplate.slug(designId),
                        description: t.description,
                    })),
                    featuredAssetId: (designAsset as any).id,
                    assets: [(designAsset as any).id, (effectAsset as any).id],
                    facetValueIds: [],
                    customFields: {
                        countryCode: 'DE',
                        masterProductId: '', // For the first one (DE), this is the "master"
                    }
                };

                const product = await productService.create(ctx, productInput);

                if ((product as any).message) {
                    throw new Error('Failed to create product: ' + (product as any).message);
                }

                // C. Create/Update Variant (Accurate SKU to the second)
                const now = new Date();
                const pad = (n: number) => n.toString().padStart(2, '0');
                const timestamp = now.getFullYear().toString() +
                    pad(now.getMonth() + 1) +
                    pad(now.getDate()) + '-' +
                    pad(now.getHours()) +
                    pad(now.getMinutes()) +
                    pad(now.getSeconds());
                const sku = `SKU-${timestamp}`;

                // Use masterProductId as SKU reference for future linkage
                await productService.update(ctx, {
                    id: (product as any).id,
                    customFields: {
                        masterProductId: sku
                    }
                });

                const variants = await productVariantService.getVariantsByProductId(ctx, (product as any).id);
                if (variants.items.length > 0) {
                    const defaultVariant = variants.items[0];
                    await productVariantService.update(ctx, [{
                        id: defaultVariant.id,
                        sku: sku, // Main SKU for DE
                        price: productTemplate.price,
                        trackInventory: 'FALSE' as any,
                        translations: productTemplate.translations.map(t => ({
                            languageCode: t.languageCode,
                            name: productInfoName ? `${productInfoName} [${designId}]` : t.name(designId)
                        }))
                    }]);
                } else {
                    await productVariantService.create(ctx, [{
                        productId: (product as any).id,
                        sku: sku,
                        price: productTemplate.price,
                        translations: productTemplate.translations.map(t => ({
                            languageCode: t.languageCode,
                            name: productInfoName ? `${productInfoName} [${designId}]` : t.name(designId)
                        })),
                        trackInventory: 'FALSE' as any
                    }]);
                }

                // D. Archival (Move images to SKU folder)
                const archiveDir = path.join(ARCHIVE_ROOT, sku);
                await fs.ensureDir(archiveDir);

                const archiveDesignPath = path.join(archiveDir, designFile);
                if (await fs.pathExists(designPath)) {
                    await fs.move(designPath, archiveDesignPath, { overwrite: true });
                }

                const archiveSubDirPath = path.join(archiveDir, subDirName);
                if (await fs.pathExists(subDirPath)) {
                    await fs.move(subDirPath, archiveSubDirPath, { overwrite: true });
                }

                if (await fs.pathExists(PRODUCT_INFO_FILE)) {
                    await fs.copy(PRODUCT_INFO_FILE, path.join(archiveDir, 'product_info.json'), { overwrite: true });
                }

                // E. Update Lookup Table
                updateLookupTable(designId, sku, (product as any).name, archiveDir);

                result.status = 'SUCCESS';
                result.productId = (product as any).id.toString();
                result.productName = (product as any).name;
                result.sku = sku;
                result.message = 'Published and archived.';
                console.log(`   -> Archived to: ${archiveDir}`);
                console.log(`[SUCCESS] Created ${(product as any).name} (SKU: ${sku})`);

                // --- Multi-Country Logic (Adjusted: Only Add to Germany Collection) ---
                await ensureCollection(ctx, collectionService, 'Germany');

                // Actually add to the collection (Vendure collections usually use filters, 
                // but for simple grouping we can use facets if the filter is set up, 
                // or just rely on the countryCode custom field if the storefront filters by it.)
                // Given ENVIRONMENT.md says storefront filters by countryCode, 
                // we just need to make sure the product exists with customFields.countryCode = 'DE'.

            } catch (e: any) {
                if (e.code === 'SQLITE_BUSY' || e.message?.includes('database is locked')) {
                    throw e; // Re-throw for withRetry
                }
                console.error(`[ERROR] Processing ${designId}:`, e.message);
                result.status = 'ERROR';
                result.message = e.message;
            }

            logResult(result);
        });

        await delay(500); // 500ms breather
    }

    console.log('✅ Processing complete. Closing app...');
    await app.close();
    process.exit(0);
}


async function ensureCollection(ctx: RequestContext, collectionService: any, name: string) {
    const allCollections = await collectionService.findAll(ctx);
    let collection = allCollections.items.find((c: any) => c.name === name);
    if (!collection) {
        collection = await collectionService.create(ctx, {
            translations: [
                { languageCode: LanguageCode.zh, name, slug: name.toLowerCase().replace(/ /g, '-'), description: '' },
                { languageCode: LanguageCode.en, name, slug: name.toLowerCase().replace(/ /g, '-'), description: '' }
            ],
            filters: [], // No filters for simple manual collections
        });
    }
    return collection;
}

async function ensureFacet(ctx: RequestContext, facetService: any, code: string, name: string) {
    const facets = await facetService.findAll(ctx);
    let facet = facets.items.find((f: any) => f.code === code);
    if (!facet) {
        facet = await facetService.create(ctx, {
            code,
            isPrivate: false,
            translations: [{ languageCode: LanguageCode.en, name }, { languageCode: LanguageCode.zh, name }]
        });
    }
    return facet;
}

async function ensureFacetValue(ctx: RequestContext, facetValueService: any, facetService: any, facetId: string, code: string, name: string) {
    // There is no filtered findAll for FacetValue easily exposed by service usually? 
    // We can use facetService.findOne to get values.
    const facet = await facetService.findOne(ctx, facetId);
    let value = facet.values.find((v: any) => v.code === code);
    if (!value) {
        value = await facetValueService.create(ctx, facet, {
            code,
            translations: [{ languageCode: LanguageCode.en, name }, { languageCode: LanguageCode.zh, name }]
        });
    }
    return value;
}

async function ensureCollectionWithFilter(ctx: RequestContext, collectionService: any, name: string, facetValueIds: string[]) {
    const allCollections = await collectionService.findAll(ctx);
    let collection = allCollections.items.find((c: any) => c.name === name);

    if (!collection) {
        collection = await collectionService.create(ctx, {
            translations: [
                { languageCode: LanguageCode.zh, name, slug: name, description: '' },
                { languageCode: LanguageCode.en, name, slug: name.toLowerCase().replace(/ /g, '-'), description: '' }
            ],
            filters: [{
                code: 'facet-value-filter',
                arguments: [
                    { name: 'facetValueIds', value: JSON.stringify(facetValueIds) },
                    { name: 'containsAny', value: 'false' }
                ]
            }],
        });
    }
    return collection;
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
