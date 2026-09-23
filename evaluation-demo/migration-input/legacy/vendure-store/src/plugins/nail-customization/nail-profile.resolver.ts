import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Allow, Permission, Transaction } from '@vendure/core';
import { NailProfileService } from './nail-profile.service';

/**
 * Shop API Resolver - 指甲档案
 * 
 * 所有操作都需要登录（Shop API 自动带 Customer 身份）
 */
@Resolver()
export class NailProfileShopResolver {
    constructor(private nailProfileService: NailProfileService) { }

    @Query()
    async myNailProfiles(@Ctx() ctx: RequestContext) {
        return this.nailProfileService.findByCustomer(ctx);
    }

    @Query()
    async nailSizeChart(
        @Ctx() ctx: RequestContext,
        @Args() args: { shapeCode: string },
    ) {
        return this.nailProfileService.getNailSizeChart(args.shapeCode);
    }

    @Query()
    async allNailShapes(@Ctx() ctx: RequestContext) {
        return this.nailProfileService.getAllNailShapes();
    }

    @Query()
    async matchNailSize(
        @Ctx() ctx: RequestContext,
        @Args() args: { arcLength: number; shapeCode: string },
    ) {
        return this.nailProfileService.matchNailSize(args.arcLength, args.shapeCode);
    }

    @Transaction()
    @Mutation()
    async createNailProfile(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { profileName: string; fingerSizes: Record<string, number> } },
    ) {
        return this.nailProfileService.create(ctx, args.input);
    }

    @Transaction()
    @Mutation()
    async updateNailProfile(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string; input: { profileName?: string; fingerSizes?: Record<string, number> } },
    ) {
        return this.nailProfileService.update(ctx, args.id, args.input);
    }

    @Transaction()
    @Mutation()
    async deleteNailProfile(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string },
    ) {
        return this.nailProfileService.delete(ctx, args.id);
    }
}

/**
 * Admin API Resolver - 管理员查看客户的指甲档案
 */
@Resolver()
export class NailProfileAdminResolver {
    constructor(private nailProfileService: NailProfileService) { }

    @Query()
    @Allow(Permission.ReadCustomer)
    async customerNailProfiles(
        @Ctx() ctx: RequestContext,
        @Args() args: { customerId: string },
    ) {
        return this.nailProfileService.findByCustomerId(ctx, args.customerId);
    }
}
