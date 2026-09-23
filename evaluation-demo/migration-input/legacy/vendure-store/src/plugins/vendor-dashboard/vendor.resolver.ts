import { Args, Query, Resolver, Context } from '@nestjs/graphql';
import { RequestContext, Ctx } from '@vendure/core';
import { VendorService } from './vendor.service';

@Resolver()
export class VendorResolver {
    constructor(private vendorService: VendorService) { }

    @Query()
    async vendorOverview(@Ctx() ctx: RequestContext) {
        return this.vendorService.getVendorOverview(ctx);
    }
}
