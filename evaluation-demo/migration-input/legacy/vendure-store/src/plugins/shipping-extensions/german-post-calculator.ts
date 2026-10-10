import { LanguageCode, ShippingCalculator } from '@vendure/core';

export const germanPostCalculator = new ShippingCalculator({
    code: 'german-post-calculator',
    description: [
        { languageCode: LanguageCode.en, value: 'German Post (Brief/Maxi Brief) based on total weight' },
        { languageCode: LanguageCode.zh, value: '德国邮政 (Brief/Maxi Brief) 基于总重量计算' },
    ],
    args: {
        taxRate: {
            type: 'int',
            defaultValue: 19,
            ui: { component: 'number-form-input', suffix: '%' },
            label: [{ languageCode: LanguageCode.en, value: 'Tax rate' }, { languageCode: LanguageCode.zh, value: '税率' }],
        },
    },
    calculate: (ctx, order, args) => {
        let totalWeight = 0;
        for (const line of order.lines) {
            // 假设商品有一个自定义字段 'weight' (单位：克)
            const weight = (line.productVariant.customFields as any).weight || 0;
            totalWeight += weight * line.quantity;
        }

        let price = 0;
        if (totalWeight <= 20) {
            price = 85; // Standardbrief
        } else if (totalWeight <= 50) {
            price = 100; // Kompaktbrief
        } else if (totalWeight <= 500) {
            price = 160; // Grossbrief
        } else if (totalWeight <= 1000) {
            price = 275; // Maxibrief
        } else {
            // 超过 1kg 则此计算器不可用（应退回到 DHL Paket）
            return;
        }

        return {
            price,
            taxRate: args.taxRate,
            priceIncludesTax: ctx.channel.pricesIncludeTax,
        };
    },
});
