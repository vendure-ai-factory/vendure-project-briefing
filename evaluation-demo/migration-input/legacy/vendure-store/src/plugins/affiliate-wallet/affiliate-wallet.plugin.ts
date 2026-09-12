import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AffiliateService } from './affiliate.service';
import { AffiliateSubscriber } from './affiliate.subscriber';
import { AffiliateResolver } from './affiliate.resolver';
import { shopApiExtensions } from './api-extensions';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [AffiliateService, AffiliateSubscriber, AffiliateResolver],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [AffiliateResolver],
    },
    compatibility: '^3.0.0',
})
export class AffiliateWalletPlugin { }
