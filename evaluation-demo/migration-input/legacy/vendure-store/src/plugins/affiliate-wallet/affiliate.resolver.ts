import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, ID } from '@vendure/core';
import { AffiliateService } from './affiliate.service';

@Resolver()
export class AffiliateResolver {
    constructor(private affiliateService: AffiliateService) { }

    @Mutation()
    @Allow(Permission.Authenticated)
    async transferBalance(
        @Ctx() ctx: RequestContext,
        @Args() args: { receiverId: ID; amount: number },
    ) {
        if (!ctx.activeUserId) {
            throw new Error('Not authenticated');
        }

        // 这里的逻辑可以放在 Service 中
        return this.affiliateService.transferBalance(ctx, ctx.activeUserId, args.receiverId, args.amount);
    }
}
