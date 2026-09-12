/**
 * Product Publishing Script V9
 * 
 * 功能：
 * 1. 读取 ./fixtures/美甲图案 下的设计图(.png)和效果图(1\*.jpg)
 * 2. 创建主产品（默认德国）并添加 Germany Facet 标签
 * 3. 自动为 Austria、Hungary 创建子产品
 * 4. 归档文件到 ./artifacts/archive\SKU-xxx
 * 5. 使用 bootstrapWorker 避免端口冲突
 */
import {
    bootstrapWorker, RequestContext, ProductService, ProductVariantService,
    AssetService, ChannelService, RequestContextService,
    LanguageCode, CurrencyCode, CollectionService,
    FacetService, FacetValueService
} from '@vendure/core';
import { CreateProductInput } from '@vendure/common/lib/generated-types';
import { config } from '../src/vendure-config';
// @ts-ignore
import fs from 'fs-extra';
import path from 'path';

// --- Configuration ---
const INPUT_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');
const PRODUCT_INFO_FILE = path.join(INPUT_DIR, 'product_info.json');

// 国家配置
const MASTER_COUNTRY = 'DE';
const CHILD_COUNTRIES = [
    { code: 'AT', name: 'Austria', facetName: '奥地利' },
    { code: 'HU', name: 'Hungary', facetName: '匈牙利' },
];

// Product Template
const PRODUCT_TEMPLATE = {
    price: 1990, // Default price in cents (19.90 EUR)
    translations: [
        {
            languageCode: LanguageCode.en,
            name: "Custom Nail Design",
            description: "Hand-crafted custom nail design. Select your preferred style and size."
        },
        {
            languageCode: LanguageCode.zh,
            name: "定制穿戴甲",
            description: "纯手工定制穿戴甲，请选择您喜欢的款式和尺寸。"
        }
    ]
};

function isImage(filename: string): boolean {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    return validExtensions.includes(path.extname(filename).toLowerCase());
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// Facet & Collection Helper Functions (from v7)
// ==========================================

async function ensureFacet(ctx: RequestContext, facetService: any, code: string, name: string) {
    const facets = await facetService.findAll(ctx);
    let facet = facets.items.find((f: any) => f.code === code);
    if (!facet) {
        facet = await facetService.create(ctx, {
            code,
            isPrivate: false,
            translations: [
                { languageCode: LanguageCode.en, name },
                { languageCode: LanguageCode.zh, name }
            ]
        });
        console.log(`   Created Facet: ${name} (ID: ${facet.id})`);
    }
    return facet;
}

async function ensureFacetValue(ctx: RequestContext, facetValueService: any, facetService: any, facetId: string, code: string, name: string) {
    const facet = await facetService.findOne(ctx, facetId);
    let value = facet.values.find((v: any) => v.code === code);
    if (!value) {
        value = await facetValueService.create(ctx, facet, {
            code,
            translations: [
                { languageCode: LanguageCode.en, name: code },
                { languageCode: LanguageCode.zh, name }
            ]
        });
        console.log(`   Created FacetValue: ${code} / ${name} (ID: ${value.id})`);
    }
    return value;
}

async function ensureCollectionWithFilter(ctx: RequestContext, collectionService: any, name: string, facetValueIds: string[]) {
    const allCollections = await collectionService.findAll(ctx);
    let collection = allCollections.items.find((c: any) => c.name === name);

    if (!collection) {
        collection = await collectionService.create(ctx, {
            translations: [
                { languageCode: LanguageCode.zh, name, slug: name.toLowerCase(), description: '' },
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
        console.log(`   Created Collection: ${name} (ID: ${collection.id})`);
    }
    return collection;
}

// ==========================================
// Main Script
// ==========================================

async function run() {
    console.log('🚀 Starting Product Publishing Script (V9.0 - Multi-Country)...');

    // 0. Config: Use Worker to avoid port conflicts
    (config.dbConnectionOptions as any).synchronize = true;

    // 1. Initialize Vendure Worker
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

    console.log(`Channel Default Currency: ${channel.defaultCurrencyCode}`);

    // 3. Prepare Folders
    await fs.ensureDir(ARCHIVE_ROOT);

    // 4. Check for Main Image (0.jpg in subdirectory 1/)
    const subDirPath = path.join(INPUT_DIR, '1');
    if (!await fs.pathExists(subDirPath)) {
        console.error('ERROR: Level 1 subdirectory (1/) not found!');
        process.exit(1);
    }

    // Main Image (0.jpg)
    const mainImagePath = path.join(subDirPath, '0.jpg');
    let mainAsset: any = null;
    if (await fs.pathExists(mainImagePath)) {
        mainAsset = await assetService.create(ctx, {
            file: {
                createReadStream: () => fs.createReadStream(mainImagePath),
                filename: '0.jpg',
                mimetype: 'image/jpeg',
                encoding: '7bit'
            } as any,
        });
        if ((mainAsset as any).message) {
            console.error('Failed to create main image asset:', (mainAsset as any).message);
            mainAsset = null;
        } else {
            console.log(`Found Main Image: ${mainImagePath}`);
        }
    }

    // 5. Scan Design Files
    const allEntries = await fs.readdir(INPUT_DIR);
    const designFiles = allEntries.filter((f: string) => {
        const fullPath = path.join(INPUT_DIR, f);
        return fs.statSync(fullPath).isFile() && isImage(f);
    });
    console.log(`Found ${designFiles.length} design files to process.`);

    // 6. Read Product Info
    let productName = PRODUCT_TEMPLATE.translations[0].name;
    let productPrice = PRODUCT_TEMPLATE.price;
    if (fs.existsSync(PRODUCT_INFO_FILE)) {
        try {
            const info = fs.readJSONSync(PRODUCT_INFO_FILE);
            if (info.name) productName = info.name;
            if (info.price) productPrice = info.price;
            console.log(`Loaded Product Info: Name=${productName}, Price=${productPrice}`);
        } catch (e) {
            console.warn('Failed to read product_info.json:', e);
        }
    }

    // ==========================================
    // 7. Setup Country Facets & Collections
    // ==========================================
    console.log('\n--- Setting up Country Facets & Collections ---');
    const countryFacet = await ensureFacet(ctx, facetService, 'Country', 'Country');
    const deFacetValue = await ensureFacetValue(ctx, facetValueService, facetService, countryFacet.id, 'Germany', '德国');

    // Ensure child country facet values
    const childFacetValues: Record<string, any> = {};
    for (const child of CHILD_COUNTRIES) {
        childFacetValues[child.code] = await ensureFacetValue(ctx, facetValueService, facetService, countryFacet.id, child.name, child.facetName);
    }

    // Ensure Collections
    await ensureCollectionWithFilter(ctx, collectionService, 'Germany', [deFacetValue.id]);
    for (const child of CHILD_COUNTRIES) {
        await ensureCollectionWithFilter(ctx, collectionService, child.name, [childFacetValues[child.code].id]);
    }
    console.log('--- Country setup complete ---\n');

    // ==========================================
    // 8. Create Master Product (Germany)
    // ==========================================
    const productSku = `SKU-${Date.now()}`;

    const productInput: any = {
        enabled: true,
        translations: [
            {
                languageCode: LanguageCode.en,
                name: productName,
                slug: productName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
                description: PRODUCT_TEMPLATE.translations[0].description,
            },
            {
                languageCode: LanguageCode.zh,
                name: productName,
                slug: productName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now() + '-zh',
                description: PRODUCT_TEMPLATE.translations[1].description,
            }
        ],
        featuredAssetId: mainAsset ? (mainAsset as any).id : undefined,
        assets: [],
        facetValueIds: [(deFacetValue as any).id], // ← KEY: Add Germany Facet!
        customFields: {
            countryCode: MASTER_COUNTRY,
        },
    };

    const product = await productService.create(ctx, productInput);
    if ((product as any).message) {
        throw new Error('Failed to create product: ' + (product as any).message);
    }
    console.log(`✅ Created Master Product: ${productName} (ID: ${(product as any).id}) [${MASTER_COUNTRY}]`);

    // 9. Process Designs and Add as Assets
    const productAssetIds: string[] = [];
    for (const designFile of designFiles) {
        const designName = path.parse(designFile).name;
        console.log(`Processing Design: ${designName}...`);

        const effectFileName = `${designName}.jpg`;
        const effectPath = path.join(subDirPath, effectFileName);

        if (!fs.existsSync(effectPath)) {
            console.warn(`[SKIP] Missing effect image for design ${designName} at ${effectPath}`);
            continue;
        }

        const effectAsset = await assetService.create(ctx, {
            file: {
                createReadStream: () => fs.createReadStream(effectPath),
                filename: effectFileName,
                mimetype: 'image/jpeg',
                encoding: '7bit'
            } as any,
        });

        if ((effectAsset as any).message) {
            console.error(`Failed to create asset for ${designName}:`, (effectAsset as any).message);
            continue;
        }

        // Force update asset name
        await assetService.update(ctx, {
            id: (effectAsset as any).id,
            name: designName
        });

        productAssetIds.push((effectAsset as any).id);
        console.log(`   Added Asset: ${designName} (ID: ${(effectAsset as any).id})`);
    }

    // Update Product with all assets
    await productService.update(ctx, {
        id: (product as any).id,
        assetIds: productAssetIds,
    });

    // Create Master Variant
    await productVariantService.create(ctx, [{
        productId: (product as any).id,
        sku: productSku,
        price: productPrice,
        translations: [
            { languageCode: LanguageCode.en, name: productName },
            { languageCode: LanguageCode.zh, name: productName }
        ],
        trackInventory: 'FALSE' as any
    }]);

    console.log(`Updated Product Assets. Total Assets: ${productAssetIds.length}`);

    // ==========================================
    // 10. Create Child Products (AT, HU)
    // ==========================================
    console.log('\n--- Creating Child Products ---');
    for (const childConfig of CHILD_COUNTRIES) {
        try {
            const childInput: any = {
                enabled: true,
                translations: productInput.translations.map((t: any) => ({
                    ...t,
                    name: `${t.name} [${childConfig.code}]`,
                    slug: `${t.slug}-${childConfig.code.toLowerCase()}`
                })),
                featuredAssetId: productInput.featuredAssetId,
                assets: productAssetIds, // Share same assets
                facetValueIds: [childFacetValues[childConfig.code].id],
                customFields: {
                    masterProductId: (product as any).id.toString(),
                    countryCode: childConfig.code,
                },
            };

            const childProduct = await productService.create(ctx, childInput);
            if ((childProduct as any).message) {
                console.error(`Failed to create child product for ${childConfig.code}:`, (childProduct as any).message);
                continue;
            }

            // Create child variant with SAME SKU
            await productVariantService.create(ctx, [{
                productId: (childProduct as any).id,
                sku: productSku, // Same SKU as master
                price: productPrice, // Will be updated by PriceUpdaterService
                translations: [
                    { languageCode: LanguageCode.en, name: `${productName} [${childConfig.code}]` },
                    { languageCode: LanguageCode.zh, name: `${productName} [${childConfig.code}]` }
                ],
                trackInventory: 'FALSE' as any
            }]);

            console.log(`   ✅ Created Child Product for ${childConfig.code}: ${(childProduct as any).name} (ID: ${(childProduct as any).id})`);
        } catch (err: any) {
            console.error(`Error creating child for ${childConfig.code}:`, err.message);
        }
    }
    console.log('--- Child products complete ---\n');

    // ==========================================
    // 11. Archival Process
    // ==========================================
    console.log('Archiving files...');
    const archiveDir = path.join(ARCHIVE_ROOT, productSku);
    const archiveSubDir = path.join(archiveDir, '1');

    await fs.ensureDir(archiveDir);
    await fs.ensureDir(archiveSubDir);

    // Move Design Files (.png)
    for (const designFile of designFiles) {
        const src = path.join(INPUT_DIR, designFile);
        const dest = path.join(archiveDir, designFile);
        await fs.move(src, dest, { overwrite: true });
    }

    // Move Effect Files (.jpg + 0.jpg) from 1/
    const level1Files = await fs.readdir(subDirPath);
    for (const file of level1Files) {
        const src = path.join(subDirPath, file);
        const dest = path.join(archiveSubDir, file);
        if (fs.statSync(src).isFile()) {
            await fs.move(src, dest, { overwrite: true });
        }
    }

    // Copy product_info.json (keep original)
    if (fs.existsSync(PRODUCT_INFO_FILE)) {
        await fs.copy(PRODUCT_INFO_FILE, path.join(archiveDir, 'product_info.json'));
    }

    // Cleanup empty 1/ dir
    try {
        if ((await fs.readdir(subDirPath)).length === 0) {
            await fs.rmdir(subDirPath);
        }
    } catch (e) {
        console.warn('Could not remove empty subdir 1:', e);
    }

    console.log(`✅ Success! Product ${productName} created with SKU ${productSku}.`);
    console.log(`   Master: Germany [${MASTER_COUNTRY}]`);
    console.log(`   Children: ${CHILD_COUNTRIES.map(c => c.code).join(', ')}`);
    console.log(`   Archived to: ${archiveDir}`);

    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
