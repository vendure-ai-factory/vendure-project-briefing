import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { OnboardingService, OnboardCountryInput } from '../services/onboarding.service';

@Resolver()
export class OnboardingResolver {
    constructor(private onboardingService: OnboardingService) {}

    @Mutation()
    @Allow(Permission.SuperAdmin)
    async onboardCountry(@Ctx() ctx: RequestContext, @Args('input') input: OnboardCountryInput): Promise<boolean> {
        return this.onboardingService.onboardCountry(ctx, input);
    }
}
