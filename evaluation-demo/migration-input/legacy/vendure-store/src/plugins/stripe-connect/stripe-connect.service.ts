import { Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection, Customer, ExternalAuthenticationService, User } from '@vendure/core';

@Injectable()
export class StripeConnectService {
    constructor(
        private connection: TransactionalConnection,
        private externalAuthService: ExternalAuthenticationService,
    ) { }

    /**
     * Link a Stripe Account ID to a Vendure Customer.
     * This is called after a successful OAuth flow.
     */
    async setStripeAccountId(ctx: RequestContext, stripeAccountId: string) {
        if (!ctx.activeUserId) {
            throw new Error('No active user');
        }

        const customer = await this.connection.getRepository(ctx, Customer).findOne({
            where: { user: { id: ctx.activeUserId } }
        });

        if (!customer) {
            throw new Error('Customer not found for active user');
        }

        (customer.customFields as any).stripeAccountId = stripeAccountId;
        await this.connection.getRepository(ctx, Customer).save(customer);

        console.log(`[StripeConnect] Linked Account ${stripeAccountId} to Customer ${customer.id}`);
    }

    /**
     * Mock OAuth Token Exchange
     * In prod, this exchanges auth_code for stripe_user_id via Stripe API.
     */
    async onboardVendor(authCode: string): Promise<string> {
        console.log(`[StripeConnect] Exchanging auth code ${authCode} for Account ID...`);
        // Mock response
        return `acct_mock_${Math.random().toString(36).substring(7)}`;
    }
}
