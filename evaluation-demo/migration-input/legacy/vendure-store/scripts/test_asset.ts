import { bootstrap, AssetService, RequestContextService, ChannelService } from '@vendure/core';
import { config } from '../src/vendure-config';
// @ts-ignore
import fs from 'fs-extra';
import path from 'path';

// Modify config
config.apiOptions.port = 3003;
(config.dbConnectionOptions as any).synchronize = false;

async function test() {
    console.log('🧪 Testing Asset Creation...');
    const app = await bootstrap(config);
    const assetService = app.get(AssetService);
    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    const imagePath = process.env.TEST_ASSET_PATH || path.resolve(__dirname, '../../../fixtures/美甲图案/1/1.jpg');
    if (!fs.existsSync(imagePath)) {
        console.error('Test image not found at ' + imagePath);
        process.exit(1);
    }

    // Test 1: Stream directly
    try {
        console.log('Test 1: Stream directly');
        const stream = fs.createReadStream(imagePath);
        const asset = await assetService.create(ctx, {
            file: stream as any,
        });
        console.log('Test 1 Result:', (asset as any).id ? 'SUCCESS' : asset);
    } catch (e: any) {
        console.log('Test 1 Failed:', e.message);
    }

    // Test 2: Promise of Mock Object
    try {
        console.log('Test 2: Promise of Mock Object');
        const mock = {
            createReadStream: () => fs.createReadStream(imagePath),
            filename: '1.jpg',
            mimetype: 'image/jpeg',
            encoding: '7bit'
        };
        const asset = await assetService.create(ctx, {
            file: Promise.resolve(mock) as any,
        });
        console.log('Test 2 Result:', (asset as any).id ? 'SUCCESS' : asset);
    } catch (e: any) {
        console.log('Test 2 Failed:', e.message);
    }

    // Test 3: Mock Object (Retry V6)
    try {
        console.log('Test 3: Mock Object (V6)');
        const mock = {
            createReadStream: () => fs.createReadStream(imagePath),
            filename: '1.jpg',
            mimetype: 'image/jpeg',
            encoding: '7bit'
        };
        const asset = await assetService.create(ctx, {
            file: mock as any,
        });
        console.log('Test 3 Result:', (asset as any).id ? 'SUCCESS' : asset);
    } catch (e: any) {
        console.log('Test 3 Failed:', e.message);
    }

    process.exit(0);
}

test().catch(console.error);
