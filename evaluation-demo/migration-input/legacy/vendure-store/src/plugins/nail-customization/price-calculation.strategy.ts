import { OrderItemPriceCalculationStrategy, PriceCalculationResult, RequestContext, ProductVariant, Order } from '@vendure/core';

/**
 * 穿戴甲价格计算策略
 * 实现逻辑：最终价格 = 变体基础价 + (珠光/银闪 阶梯加价)
 */
export class NailPriceCalculationStrategy implements OrderItemPriceCalculationStrategy {
    calculateUnitPrice(
        ctx: RequestContext,
        productVariant: ProductVariant,
        orderLineCustomFields: { [key: string]: any; },
        order: Order,
        quantity: number,
    ): PriceCalculationResult | Promise<PriceCalculationResult> {
        console.log(`--- NailPriceCalculationStrategy Executing (V2 Signature) for variant: ${productVariant.sku} ---`);
        let price = productVariant.price;

        // 获取该变体设置的加价配置 (单位：分)
        const pearlSurcharge = (productVariant.customFields as any).pearlSurcharge || 0;
        const silverSurcharge = (productVariant.customFields as any).silverSurcharge || 0;

        // 获取客户选中的定制项 (从 orderLineCustomFields 直接读取)
        const selectedEffect = orderLineCustomFields.specialEffect;

        // 根据选择动态加价
        if (selectedEffect === 'pearl') {
            price += pearlSurcharge;
        } else if (selectedEffect === 'silver') {
            price += silverSurcharge;
        }

        return {
            price,
            priceIncludesTax: productVariant.listPriceIncludesTax,
        };
    }
}
