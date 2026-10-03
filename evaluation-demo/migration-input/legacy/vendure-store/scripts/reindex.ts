import { bootstrap, ChannelService, RequestContextService } from '@vendure/core';
import { SearchIndexService } from '@vendure/core/dist/plugin/default-search-plugin/indexer/search-index.service';
import { config } from '../src/vendure-config';

// Use port 3050 to avoid conflict if needed, or just run distinct
config.apiOptions.port = 3055;
(config.dbConnectionOptions as any).synchronize = false;

async function run() {
    console.log('Bootstrapping Vendure for Reindexing...');
    const app = await bootstrap(config);

    const channelService = app.get(ChannelService);
    const requestContextService = app.get(RequestContextService);
    const searchIndexService = app.get(SearchIndexService);

    const channel = await channelService.getDefaultChannel();
    const ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    console.log('Reindexing...');
    await searchIndexService.reindex(ctx);

    console.log('✅ Reindexing Complete.');
    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
