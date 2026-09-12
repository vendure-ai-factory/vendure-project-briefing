
import { bootstrap, OrderService, RequestContextCacheService, InternalServerError } from '@vendure/core';
import { config } from '../src/vendure-config';

async function run() {
    config.apiOptions.port = 3102;
    const app = await bootstrap(config);
    const orderService = app.get(OrderService);

    console.log('OrderService.addItemToOrder.length:', orderService.addItemToOrder.length);
    console.log('OrderService.addItemToOrder source:', orderService.addItemToOrder.toString().substring(0, 100)); // First 100 chars

    // Check RequestContext properties if possible (it's a class)
    // We can't easily check constructor signature at runtime easily without creating one.

    await app.close();
    process.exit(0);
}

run().catch(console.error);
