import { Controller, Get, Query, Res, Req } from '@nestjs/common';
import { Ctx, RequestContext, RequestContextService } from '@vendure/core';
import { StripeConnectService } from './stripe-connect.service';
import { Response } from 'express';

@Controller('connect')
export class StripeConnectController {
    constructor(
        private stripeConnectService: StripeConnectService,
        private requestContextService: RequestContextService
    ) { }

    @Get('oauth')
    async handleOAuthCallback(
        @Query('code') code: string,
        @Query('state') state: string, // CSRF token usually
        @Ctx() ctx: RequestContext,
        @Res() res: Response,
    ) {
        // Logic:
        // 1. Verify state (skipped for mock)
        // 2. Exchange code for Stripe Account ID
        // 3. Save to Customer

        try {
            const stripeAccountId = await this.stripeConnectService.onboardVendor(code);

            // We need a valid RequestContext. 
            // If this is a redirect from Stripe, standard auth headers might be missing.
            // We usually rely on a session cookie or the 'state' param containing a compiled context token.
            // For MVP, we assume the user is logged in and cookie is present.

            await this.stripeConnectService.setStripeAccountId(ctx, stripeAccountId);

            res.redirect('/vendor/settings?connected=true');
        } catch (e) {
            console.error('[StripeConnect] OAuth failed:', e);
            res.redirect('/vendor/settings?error=oauth_failed');
        }
    }

    @Get('mock-connect')
    async mockConnect(@Ctx() ctx: RequestContext, @Res() res: Response) {
        try {
            const mockId = `acct_manual_${Math.random().toString(36).substring(7)}`;
            await this.stripeConnectService.setStripeAccountId(ctx, mockId);
            res.send(`Mock Connect Successful! Account ID: ${mockId}`);
        } catch (e) {
            res.status(500).send(`Mock Failed: ${e}`);
        }
    }
}
