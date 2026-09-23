import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { StripeConnectService } from './stripe-connect.service';
import { StripeConnectController } from './stripe-connect.controller';
import { customConnectPaymentHandler } from './custom-payment-handler';

@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [StripeConnectController],
    providers: [StripeConnectService],
    configuration: config => {
        config.paymentOptions.paymentMethodHandlers.push(customConnectPaymentHandler);
        // Prevent duplicate field addition
        const customerFields = config.customFields.Customer ?? [];
        const alreadyDefined = customerFields.some(f => f.name === 'stripeAccountId');
        if (!alreadyDefined) {
            config.customFields.Customer = [
                ...customerFields,
                {
                    name: 'stripeAccountId',
                    type: 'string',
                    public: false,
                    nullable: true,
                },
            ];
        }
        return config;
    },
})
export class StripeConnectPlugin { }
