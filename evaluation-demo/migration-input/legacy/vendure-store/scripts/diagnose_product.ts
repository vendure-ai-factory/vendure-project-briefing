
import { bootstrap, ProductService, AssetService, ChannelService, RequestContextService } from '@vendure/core';
import { config } from '../src/vendure-config';

async function diagnose() {
    console.log('Diagnosing Product nail-design-1...');
    config.apiOptions.port = 3004; // Use different port
    (config.dbConnectionOptions as any).synchronize = false;

    const app = await bootstrap(config);
    const productService = app.get(ProductService);
    const ctxService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await ctxService.create({ apiType: 'admin', channelOrToken: channel });

    const product = await productService.findOneBySlug(ctx, 'nail-design-1', ['assets', 'featuredAsset']);

    if (!product) {
        console.error('ERROR: Product nail-design-1 NOT FOUND!');
    } else {
        console.log(`Product ID: ${product.id}`);
        console.log(`Featured Asset: ${product.featuredAsset ? product.featuredAsset.name : 'NONE'}`);
        console.log(`Assets Count: ${product.assets.length}`);
        product.assets.forEach(a => console.log(` - Asset: ${a.name} (Source: ${a.source}) (Preview: ${a.preview})`));
    }

    process.exit(0);
}

diagnose();
