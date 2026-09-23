import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { shopApiExtensions } from './api-extensions';
import { VendorResolver } from './vendor.resolver';
import { VendorService } from './vendor.service';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [VendorService, VendorResolver],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [VendorResolver],
    },
    configuration: config => {
        const customerFields = config.customFields.Customer ?? [];
        const alreadyDefined = customerFields.some(f => f.name === 'vendorFacetValueId');
        if (!alreadyDefined) {
            config.customFields.Customer.push({
                name: 'vendorFacetValueId',
                type: 'string',
                public: false, // Internal use only for now
                nullable: true,
            });
        }
        return config;
    },
})
export class VendorDashboardPlugin { }
