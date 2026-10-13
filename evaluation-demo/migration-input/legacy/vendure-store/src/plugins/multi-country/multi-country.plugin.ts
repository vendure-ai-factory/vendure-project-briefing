import { PluginCommonModule, VendurePlugin, RequestContext, Logger } from '@vendure/core';
import { OnApplicationBootstrap } from '@nestjs/common';
import { CountryGuardSubscriber } from './country-guard.subscriber';
import { ExchangeRate } from './entities/exchange-rate.entity';
import { CountryTerms } from './entities/country-terms.entity';
import { CountryConfig } from './entities/country-config.entity';
import { ExchangeRateService } from './services/exchange-rate.service';
import { PriceUpdaterService } from './services/price-updater.service';
import { TermsService } from './services/terms.service';
import { TermsResolver, termsSchema } from './terms.resolver';

/**
 * Plugin to handle Multi-Country constraints:
 * 1. User can only have addresses in their registered country.
 * 2. User can only buy products available in their registered country.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [ExchangeRate, CountryTerms, CountryConfig],
    providers: [ExchangeRateService, PriceUpdaterService, TermsService, TermsResolver],
    adminApiExtensions: {
        schema: termsSchema,
        resolvers: [TermsResolver],
    },
    shopApiExtensions: {
        schema: termsSchema,
        resolvers: [TermsResolver],
    },
    configuration: config => {
        const dbOptions = config.dbConnectionOptions as any;
        if (!dbOptions.subscribers) {
            dbOptions.subscribers = [];
        }
        dbOptions.subscribers.push(CountryGuardSubscriber);

        return config;
    },
})
export class MultiCountryPlugin implements OnApplicationBootstrap {
    constructor(
        private exchangeRateService: ExchangeRateService,
        private priceUpdaterService: PriceUpdaterService
    ) { }

    async onApplicationBootstrap() {
        // Trigger generic update on startup
        await this.runUpdates();

        // Schedule daily update (every 24 hours)
        setInterval(() => {
            this.runUpdates().catch(err => Logger.error(`Daily Update Failed: ${err.message}`, 'MultiCountryPlugin'));
        }, 24 * 60 * 60 * 1000);
    }

    private async runUpdates() {
        try {
            await this.exchangeRateService.updateRates();
            // Call price updater with empty context or specific one
            await this.priceUpdaterService.updateAllProductPrices(RequestContext.empty());
        } catch (error) {
            // console.error('Failed to update exchange rates on startup:', error);
        }
    }
}
