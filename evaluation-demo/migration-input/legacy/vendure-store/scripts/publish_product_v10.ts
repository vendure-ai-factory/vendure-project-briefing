// @ts-nocheck
/**
 * publish_product_v10.ts
 *
 * 用法：
 *   npx ts-node scripts/publish_product_v10.ts [--country=DE]
 *
 * 参数：
 *   --country=XX   国家代码（ISO 3166-1 alpha-2），默认 DE
 *
 * 文件结构约定：
 *   ./fixtures/美甲图案\
 *   ├── product_info.json     商品信息（name, price 等）
 *   ├── 1.jpg                 设计图（文件名=设计编号，不对外展示）
 *   └── 1\                    效果图目录（固定名"1"）
 *       ├── 0.jpg             总效果大图 → 商品列表主图（featuredAsset）
 *       └── 1.jpg             对应设计图的效果图 → 详情页幻灯片
 *
 * 注意：
 *   - 0.jpg 只作为列表主图，不进入详情页幻灯片
 *   - 设计图不上传为公开资产（仅内部存档）
 *   - 归档后 ./fixtures/美甲图案 只保留 product_info.json
 */

import {
    bootstrapWorker, RequestContext, ProductService, ProductVariantService,
    AssetService, ChannelService, RequestContextService, LanguageCode,
    CollectionService, FacetService, FacetValueService, Logger
} from '@vendure/core';
import { config } from '../src/vendure-config';
import fs from 'fs-extra';
import path from 'path';
import { productTemplate, getCurrencyCode, getPrice } from './templates/product_template';

// ─── 配置 ──────────────────────────────────────────────────────────────────
const INPUT_DIR = process.env.INPUT_DIR || path.resolve(__dirname, '../../../fixtures/美甲图案');
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || path.resolve(__dirname, '../../../artifacts/archive');
const EFFECT_SUBDIR = '1'; // 效果图固定子目录名

// 从命令行读取国家参数，默认 DE
const countryArg = process.argv.find(a => a.startsWith('--country='));
const COUNTRY = countryArg ? countryArg.split('=')[1].toUpperCase() : 'DE';

// 生成本次发布的唯一 SKU（精确到秒）
const PUBLISH_TIMESTAMP = Math.floor(Date.now() / 1000);
const SESSION_SKU = `SKU-${PUBLISH_TIMESTAMP}`;

const PRODUCT_INFO_FILE = path.join(INPUT_DIR, 'product_info.json');
const EFFECT_DIR = path.join(INPUT_DIR, EFFECT_SUBDIR);

// 日志文件路径（临时，最终移到归档目录）
interface PublishLog {
    sku: string;
    productId: string;
    variantId: string;
    productSlug: string;
    country: string;
    publishedAt: string;
    assets: { main: string; slides: string[] };
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isImage(filename: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(
        path.extname(filename).toLowerCase()
    );
}

async function withRetry<T>(fn: () => Promise<T>, retries = 5, interval = 2000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries > 0 && (err.code === 'SQLITE_BUSY' || err.message?.includes('database is locked'))) {
            console.warn(`⚠️  DB locked, retrying in ${interval}ms... (${retries} left)`);
            await delay(interval);
            return withRetry(fn, retries - 1, interval * 1.5);
        }
        throw err;
    }
}

async function uploadAsset(assetService: any, ctx: any, filePath: string, filename: string) {
    return assetService.create(ctx, {
        file: {
            createReadStream: () => fs.createReadStream(filePath),
            filename,
            mimetype: filePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
            encoding: '7bit',
        } as any,
    });
}

/** 确保 Facet「国家」存在，并返回指定国家的 FacetValue */
async function ensureCountryFacetValue(
    ctx: RequestContext,
    facetService: any,
    facetValueService: any,
    countryCode: string
) {
    const FACET_CODE = 'country';
    // 获取所有 facet
    const allFacets = await facetService.findAll(ctx, { filter: { code: { eq: FACET_CODE } } });
    let facet = allFacets.items[0];

    if (!facet) {
        console.log(`[Facet] 创建 Facet "国家"...`);
        facet = await facetService.create(ctx, {
            isPrivate: false,
            code: FACET_CODE,
            translations: [
                { languageCode: LanguageCode.zh, name: '国家' },
                { languageCode: LanguageCode.en, name: 'Country' },
            ],
        });
    }

    // 查找对应 FacetValue
    const allValues = await facetValueService.findByFacetId(ctx, facet.id);
    let facetValue = allValues.find((v: any) => v.code === countryCode.toLowerCase());

    if (!facetValue) {
        console.log(`[Facet] 创建 FacetValue "${countryCode}"...`);
        facetValue = await facetValueService.create(ctx, facet, {
            code: countryCode.toLowerCase(),
            translations: [
                { languageCode: LanguageCode.zh, name: countryCode },
                { languageCode: LanguageCode.en, name: countryCode },
            ],
        });
    }

    return facetValue;
}

/** 确保归档目录存在并归档文件，保留 product_info.json */
async function archiveFiles(sku: string, log: PublishLog) {
    const archiveDir = path.join(ARCHIVE_ROOT, sku);
    await fs.ensureDir(archiveDir);

    // 移动 effect 子目录
    if (await fs.pathExists(EFFECT_DIR)) {
        await fs.move(EFFECT_DIR, path.join(archiveDir, EFFECT_SUBDIR), { overwrite: true });
        console.log(`📦 已归档效果图目录 → ${path.join(archiveDir, EFFECT_SUBDIR)}`);
    }

    // 移动所有设计图（根目录图片，非 json）
    const entries = await fs.readdir(INPUT_DIR);
    for (const entry of entries) {
        const fullPath = path.join(INPUT_DIR, entry);
        if ((await fs.stat(fullPath)).isFile() && isImage(entry)) {
            await fs.move(fullPath, path.join(archiveDir, entry), { overwrite: true });
        }
    }
    console.log(`📦 已归档设计图 → ${archiveDir}`);

    // 保留 product_info.json 拷贝在 ./fixtures/美甲图案
    if (await fs.pathExists(PRODUCT_INFO_FILE)) {
        await fs.copy(PRODUCT_INFO_FILE, path.join(INPUT_DIR, 'product_info.json'));
        // 移动原文件到归档（拷贝已完成，原文件也归档）
        await fs.move(PRODUCT_INFO_FILE, path.join(archiveDir, 'product_info.json'), { overwrite: true });
        // 再写回一份到 ./fixtures/美甲图案
        await fs.writeJSON(path.join(INPUT_DIR, 'product_info.json'), await fs.readJSON(path.join(archiveDir, 'product_info.json')), { spaces: 2 });
    }

    // 写入 publish_log.json
    const logPath = path.join(archiveDir, 'publish_log.json');
    await fs.writeJSON(logPath, log, { spaces: 2 });
    console.log(`📋 发布日志已写入 → ${logPath}`);
    console.log(JSON.stringify(log, null, 2));
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
async function run() {
    console.log(`🚀 发布脚本 v10 启动`);
    console.log(`   国家: ${COUNTRY} | SKU: ${SESSION_SKU}`);
    console.log(`   输入目录: ${INPUT_DIR}`);

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

    // ── 1. 读取目录结构 ──────────────────────────────────────────────────────
    if (!(await fs.pathExists(INPUT_DIR))) {
        console.error(`❌ 输入目录不存在: ${INPUT_DIR}`);
        process.exit(1);
    }
    if (!(await fs.pathExists(EFFECT_DIR))) {
        console.error(`❌ 效果图目录不存在: ${EFFECT_DIR}`);
        process.exit(1);
    }

    // 读取 product_info.json
    let productName: string | undefined;
    let productPrice: number = getPrice(COUNTRY);
    if (await fs.pathExists(PRODUCT_INFO_FILE)) {
        try {
            const info = await fs.readJSON(PRODUCT_INFO_FILE);
            if (info.name) productName = info.name;
            if (info.price) productPrice = info.price;
        } catch (e) {
            console.warn('⚠️  无法解析 product_info.json，使用默认值');
        }
    }
    console.log(`   商品名: ${productName || '(使用模板默认)'} | 价格: ${productPrice}`);

    // 读取设计图列表（根目录图片）
    const allEntries = await fs.readdir(INPUT_DIR);
    const designFiles = allEntries.filter(f => {
        try {
            return fs.statSync(path.join(INPUT_DIR, f)).isFile() && isImage(f);
        } catch (e) { return false; }
    });

    if (designFiles.length === 0) {
        console.error('❌ 没有找到设计图，请检查目录');
        process.exit(1);
    }

    // 读取效果图列表
    const effectEntries = await fs.readdir(EFFECT_DIR);
    const mainEffectFile = effectEntries.find(f => path.parse(f).name === '0' && isImage(f));
    if (!mainEffectFile) {
        console.error('❌ 效果图目录中找不到主图 0.jpg（命名为"0"的图片）');
        process.exit(1);
    }

    // ── 2. 上传主图（0.jpg）──────────────────────────────────────────────────
    console.log(`\n📸 上传主效果图（列表主图）: ${mainEffectFile}`);
    const mainEffectAsset = await uploadAsset(assetService, ctx, path.join(EFFECT_DIR, mainEffectFile), mainEffectFile);
    console.log(`   ✅ 主图 Asset ID: ${mainEffectAsset.id}`);

    // ── 3. 上传详情页幻灯片效果图（排除 0.jpg）──────────────────────────────
    const slideEffectFiles = effectEntries.filter(f => path.parse(f).name !== '0' && isImage(f));
    const slideAssets: any[] = [];
    for (const eff of slideEffectFiles) {
        console.log(`📸 上传幻灯片效果图: ${eff}`);
        const asset = await uploadAsset(assetService, ctx, path.join(EFFECT_DIR, eff), eff);
        slideAssets.push(asset);
        await delay(100);
    }
    console.log(`   ✅ 幻灯片共 ${slideAssets.length} 张`);

    // ── 4. 确保国家 Facet 存在 ────────────────────────────────────────────────
    const countryFacetValue = await ensureCountryFacetValue(ctx, facetService, facetValueService, COUNTRY);
    console.log(`\n🏷️  Facet 国家 "${COUNTRY}" ID: ${countryFacetValue.id}`);

    // 确保同名 Collection 存在（方便 Dashboard 管理）
    const countryCollectionName = COUNTRY === 'DE' ? 'Germany' : COUNTRY === 'HU' ? 'Hungary' : COUNTRY === 'AT' ? 'Austria' : COUNTRY;
    const allCollections = await collectionService.findAll(ctx);
    let collection = allCollections.items.find((c: any) => c.name === countryCollectionName);
    if (!collection) {
        console.log(`[Collection] 创建集合 "${countryCollectionName}"...`);
        collection = await collectionService.create(ctx, {
            translations: [
                { languageCode: LanguageCode.zh, name: countryCollectionName, slug: countryCollectionName.toLowerCase(), description: '' },
                { languageCode: LanguageCode.en, name: countryCollectionName, slug: countryCollectionName.toLowerCase(), description: '' },
            ],
            filters: [],
        });
    }

    // ── 5. 创建 Product ──────────────────────────────────────────────────────
    console.log(`\n🛍️  创建产品...`);
    const productSlugBase = productName
        ? productName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        : `nail-design`;
    const productSlug = `${productSlugBase}-${SESSION_SKU.toLowerCase()}`;

    const product = await withRetry(() => productService.create(ctx, {
        translations: productTemplate.translations.map(t => ({
            languageCode: t.languageCode,
            name: productName ? `${productName}` : t.name(SESSION_SKU),
            slug: productSlug,
            description: t.description,
        })),
        featuredAssetId: mainEffectAsset.id,                             // 列表主图 = 0.jpg
        assetIds: slideAssets.map((a: any) => a.id),              // 详情页幻灯片（无 0.jpg）
        facetValueIds: [countryFacetValue.id],
        customFields: {
            countryCode: COUNTRY,
            masterProductId: SESSION_SKU,
        },
    }));
    console.log(`   ✅ Product 创建成功 | ID: ${product.id} | Slug: ${product.slug}`);

    // ── 6. 更新默认 Variant（SKU + 价格）──────────────────────────────────────
    const variantsResult = await productVariantService.getVariantsByProductId(ctx, product.id);
    let variantId = '';
    if (variantsResult.items.length > 0) {
        const variant = variantsResult.items[0];
        variantId = String(variant.id);
        await withRetry(() => productVariantService.update(ctx, [{
            id: variant.id,
            sku: SESSION_SKU,
            price: productPrice,
            trackInventory: 'FALSE' as any,
        }]));
        console.log(`   ✅ Variant 更新 | ID: ${variantId} | SKU: ${SESSION_SKU} | Price: ${productPrice}`);
    }

    // ── 7. 加入 Collection ───────────────────────────────────────────────────
    try {
        await collectionService.addProductVariants(ctx, collection.id, variantsResult.items.map((v: any) => v.id));
        console.log(`   ✅ 已加入集合 "${countryCollectionName}"`);
    } catch {
        try {
            await collectionService.addProducts(ctx, collection.id, [product.id]);
            console.log(`   ✅ 已加入集合（addProducts）`);
        } catch (e2) {
            console.warn(`   ⚠️  加入集合失败（非致命），继续...`);
        }
    }

    // ── 8. 归档文件 + 写入日志 ──────────────────────────────────────────────
    const publishLog: PublishLog = {
        sku: SESSION_SKU,
        productId: String(product.id),
        variantId,
        productSlug: product.slug,
        country: COUNTRY,
        publishedAt: new Date().toISOString(),
        assets: {
            main: mainEffectFile,
            slides: slideEffectFiles,
        },
    };

    await archiveFiles(SESSION_SKU, publishLog);

    console.log(`\n🎉 发布完成！`);
    console.log(`   商品ID:   ${product.id}`);
    console.log(`   SKU:      ${SESSION_SKU}`);
    console.log(`   Slug:     ${product.slug}`);
    console.log(`   归档目录: ${path.join(ARCHIVE_ROOT, SESSION_SKU)}`);

    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error('❌ 发布失败:', err.message || err);
    console.error(err.stack);
    process.exit(1);
});
