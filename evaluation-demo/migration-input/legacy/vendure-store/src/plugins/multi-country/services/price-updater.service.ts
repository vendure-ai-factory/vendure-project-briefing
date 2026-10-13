import { Injectable } from '@nestjs/common';
import {
    Logger,
    Product,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    ChannelService,
    InternalServerError,
    ID
} from '@vendure/core';
import { ExchangeRateService } from './exchange-rate.service';
import { COUNTRY_CURRENCY_MAP } from '../constants';
import { CountryConfig } from '../entities/country-config.entity';

@Injectable()
export class PriceUpdaterService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private exchangeRateService: ExchangeRateService,
        private channelService: ChannelService,
    ) { }

    async updateAllProductPrices(ctx: RequestContext) {
        Logger.info('Starting Product Price Synchronization...', 'MultiCountryPlugin');

        // 1. Get Base Currency (from default channel)
        const defaultChannel = await this.channelService.getDefaultChannel();
        const baseCurrency = defaultChannel.defaultCurrencyCode;

        // 2. Find all Products with masterProductId
        // Note: Querying by customField requires alias
        const childProducts = await this.connection.getRepository(ctx, Product)
            .createQueryBuilder('product')
            // .leftJoinAndSelect('product.customFields', 'product_custom_fields') // customFields are embedded columns 
            // Actually, custom fields are columns on the entity table in v2 default strategy
            // But let's check if 'masterProductId' is a column or translation-based?
            // Product custom fields are on Product (or ProductTranslation if localized).
            // 'masterProductId' is string, usually not localized? defined as: type: 'string'.
            // If checking vendure-config, 'masterProductId' was added to 'Product', not 'ProductTranslation' explicitly?
            // Wait, configuration was: Product: [ { name: 'masterProductId' ... } ]
            // Vendure puts string fields on Product entity by default unless typed as 'localeString'.
            .where("product.customFieldsMasterProductId != ''")
            .andWhere("product.customFieldsMasterProductId IS NOT NULL")
            .getMany();

        Logger.info(`Found ${childProducts.length} child products to update.`, 'MultiCountryPlugin');

        for (const childProduct of childProducts) {
            try {
                await this.updateProductPrice(ctx, childProduct, baseCurrency);
            } catch (err: any) {
                Logger.error(`Failed to update product ${childProduct.id}: ${err.message}`, 'MultiCountryPlugin');
            }
        }
    }

    private async updateProductPrice(ctx: RequestContext, childProduct: Product, baseCurrency: string) {
        // Get Child Country
        const countryCode = (childProduct.customFields as any).countryCode;
        if (!countryCode) {
            return;
        }

        // Get Target Currency
        const targetCurrency = COUNTRY_CURRENCY_MAP[countryCode];
        if (!targetCurrency || targetCurrency === baseCurrency) {
            return; // No need to sync statutory prices if it matches base currency (e.g., DE -> EUR)
        }

        // Get Exchange Rate (Base -> Target)
        const rate = await this.getCrossRate(baseCurrency, targetCurrency);

        const childVariantsList = await this.productVariantService.getVariantsByProductId(ctx, childProduct.id);
        const childVariants = childVariantsList.items;

        for (const childVariant of childVariants) {
            // Target Price (e.g., HUF) = Local Base Price (e.g., 3.19 EUR) * Exchange Rate
            const targetPrice = Math.round(childVariant.price * rate);

            const updateInput: any = {
                id: childVariant.id,
                prices: [{
                    currencyCode: targetCurrency,
                    price: targetPrice
                }]
            };

            await this.productVariantService.update(ctx, [updateInput]);
            Logger.verbose(`Updated Variant ${childVariant.sku}: Base=${childVariant.price} ${baseCurrency}, Target=${targetPrice} ${targetCurrency}`, 'MultiCountryPlugin');
        }
    }

    private async getCrossRate(base: string, target: string): Promise<number> {
        // Rate(EUR->Target)
        const rateToTarget = await this.exchangeRateService.getRate(target);
        // Rate(EUR->Base)
        const rateToBase = await this.exchangeRateService.getRate(base);

        return rateToTarget / rateToBase;
    }

    private findMatchingVariant(child: ProductVariant, masters: ProductVariant[]): ProductVariant | undefined {
        // Matching Logic:
        // 1. If both have 1 variant, match them.
        if (masters.length === 1 && child) {
            return masters[0];
        }

        // 2. Match by Name/Option? 
        // Since we created child from master, they might share option names but have different IDs.
        // Let's rely on index if options are sorted.
        // Or simplistic: match by SKU suffix?

        // For now, if counts match, we assume index matching (risky but works for simple cases).
        // TODO: Improve this with precise option code matching.

        // Return first as fallback for now
        return masters[0];
    }
}
