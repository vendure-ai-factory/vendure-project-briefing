import { PaymentMethodHandler, CreatePaymentResult, SettlePaymentResult, LanguageCode } from '@vendure/core';

export const stripeConnectPaymentHandler = new PaymentMethodHandler({
    code: 'stripe-connect',
    description: [{ languageCode: LanguageCode.en, value: 'Stripe Connect Payment' }],
    args: {
        apiKey: { type: 'string', label: [{ languageCode: LanguageCode.en, value: 'API Key' }] },
        webhookSecret: { type: 'string', label: [{ languageCode: LanguageCode.en, value: 'Webhook Secret' }] },
    },
    createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
        // TODO: Implement Stripe Connect Payment Intent creation with transfer_data
        return {
            amount: order.totalWithTax,
            state: 'Authorized',
            transactionId: 'mock-stripe-connect-id',
            metadata: {
                ...metadata,
            },
        };
    },
    settlePayment: async (ctx, order, payment, args): Promise<SettlePaymentResult> => {
        return { success: true };
    },
});
