// @ts-nocheck
import { bootstrapWorker, RequestContextService, CollectionService, ChannelService } from '@vendure/core';
import { config } from '../src/vendure-config';

async function run() {
    const { app } = await bootstrapWorker(config);
    const collectionService = app.get(CollectionService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({ apiType: 'admin', channelOrToken: channel });

    const collections = await collectionService.findAll(ctx);
    console.log('--- Collection Analysis ---');
    for (const c of collections.items) {
        if (['germany', 'hungary', 'austria'].includes(c.slug)) {
            const collection = await collectionService.findOne(ctx, c.id);
            console.log(`Collection: ${c.name} (${c.slug})`);
            console.log(` - Filter: ${JSON.stringify(c.filters)}`);
            // Check if it's manual or dynamic
            const products = await collectionService.getCollectionProducts(ctx, c.id);
            console.log(` - Member count: ${products.totalItems}`);
        }
    }

    await app.close();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
