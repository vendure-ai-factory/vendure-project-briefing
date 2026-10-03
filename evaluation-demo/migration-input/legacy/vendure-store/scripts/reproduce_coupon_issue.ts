import { SimpleGraphQLClient } from '@vendure/testing';
import { bootstrap, DefaultLogger, LogLevel } from '@vendure/core';
import { config } from '../src/vendure-config';

// Reduce logging for clarity
config.logger = new DefaultLogger({ level: LogLevel.Error });

(async () => {
    console.log('>>> Bootstrapping Vendure for Coupon Test...');
    const app = await bootstrap(config);
    const { ShopService, OrderService, RequestContextService } = app.get(ShopService); // Wait, this injection might be wrong in script context, using app.get

    const shopApiService = app.get('ShopApiService'); // Internal API service usually? 
    // Actually, simpler to use internal services directly if we are inside the app context.

    // But better to use Graphql to simulate real client.
    // However, setting up a client needs a running server port. 
    // bootstrap(config) starts the server.

    console.log('>>> Server started. Creating anonymous session...');

    // We will use internal services for speed/simplicity in this script
    const orderService = app.get('OrderService');
    const channelService = app.get('ChannelService');
    const requestContextService = app.get('RequestContextService');

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({ apiType: 'shop', channelOrToken: channel });

    console.log('>>> Creating Order...');
    let order = await orderService.create(ctx);

    console.log('>>> Adding Item to Order...');
    // We need a productVariantId. Let's list one.
    const productVariantService = app.get('ProductVariantService');
    const variants = await productVariantService.findAll(ctx);
    if (variants.items.length === 0) {
        console.error('!!! No variants found. Cannot test add item.');
        process.exit(1);
    }
    const variantId = variants.items[0].id;

    order = await orderService.addItemToOrder(ctx, order.id, variantId, 1);

    const testCode = 'REF-TEST-INVALID';
    console.log(`>>> Attempting to apply coupon: ${testCode}`);

    const result = await orderService.applyCouponCode(ctx, order.id, testCode);

    if ((result as any).errorCode) {
        console.log(`>>> Result Error Code: ${(result as any).errorCode}`);
        console.log(`>>> Result Message: ${(result as any).message}`);
        console.log('>>> CONCLUSION: Random tokens are REJECTED.');
    } else {
        console.log('>>> Result: Success?');
        console.log(JSON.stringify(result, null, 2));
        console.log('>>> CONCLUSION: Random tokens are ACCEPTED (Unexpected).');
    }

    await app.close();
    process.exit(0);
})();
