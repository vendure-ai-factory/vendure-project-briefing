
import { bootstrap, RequestContext, ProductService, ProductVariantService, AssetService, ChannelService, RequestContextService, LanguageCode, CurrencyCode } from '@vendure/core';
import { config } from '../src/vendure-config';
import fs from 'fs';
import path from 'path';

// ensure dummy image exists
const DUMMY_IMAGE = path.join(__dirname, 'dummy_design.jpg');
if (!fs.existsSync(DUMMY_IMAGE)) {
    // Create a simple blank file or copy if possible. 
    // Since we can't easily generate valid JPG binary here without deps, 
    // we will try to copy from an existing asset if found, OR just rely on User having SOME image.
    // Actually, let's just use a text file masquerading as jpg? No, Vendure validates.
    // Let's assume there is a file or just warn.
    // Better: write a base64 image.
    const b64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    fs.writeFileSync(DUMMY_IMAGE, Buffer.from(b64, 'base64'));
}

async function run() {
    console.log('Ensure Test Product (nail-design-1)...');

    // config setup
    config.apiOptions.port = 3002;
    (config.dbConnectionOptions as any).synchronize = false;

    const app = await bootstrap(config);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const assetService = app.get(AssetService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    const slug = 'nail-design-1';

    // Check if exists
    const existing = await productService.findOneBySlug(ctx, slug);
    if (existing) {
        console.log('Product exists. checking assets...');
        if (existing.assets.length === 0) {
            console.log('Product has no assets. Updating...');
            // Attach assets
            const asset = await assetService.create(ctx, {
                file: {
                    createReadStream: () => fs.createReadStream(DUMMY_IMAGE),
                    filename: 'nail-design-1.jpg',
                    mimetype: 'image/jpeg',
                    encoding: '7bit'
                } as any,
            });
            await productService.update(ctx, {
                id: existing.id,
                featuredAssetId: (asset as any).id,
                assets: [(asset as any).id]
            });
            console.log('Assets updated.');
        } else {
            console.log('Product already has assets.');
        }
    } else {
        console.log('Product not found. Creating...');
        const asset = await assetService.create(ctx, {
            file: {
                createReadStream: () => fs.createReadStream(DUMMY_IMAGE),
                filename: 'nail-design-1.jpg',
                mimetype: 'image/jpeg',
                encoding: '7bit'
            } as any,
        });

        const product = await productService.create(ctx, {
            translations: [{
                languageCode: LanguageCode.en,
                name: 'Nail Design 1',
                slug: slug,
                description: 'Test Product for Verification',
            }],
            featuredAssetId: (asset as any).id,
            assets: [(asset as any).id],
            facetValueIds: [],
        });

        // Create variant
        await productVariantService.create(ctx, [{
            productId: (product as any).id,
            sku: 'SKU-ND1',
            price: 1800,
            translations: [{ languageCode: LanguageCode.en, name: 'Nail Design 1' }],
            trackInventory: 'FALSE' as any
        }]);
        console.log('Product Created.');
    }

    await app.close();
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
