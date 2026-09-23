import { Injectable } from '@nestjs/common';
import { 
    ChannelService, 
    ZoneService, 
    CountryService, 
    StockLocationService, 
    ShippingMethodService,
    RequestContext,
    LanguageCode,
    CurrencyCode,
    TransactionalConnection,
    Logger,
    Country
} from '@vendure/core';
import { TaxConsistencyService } from './tax-consistency.service';
import { CountryConfig } from '../entities/country-config.entity';
import { CountryTerms } from '../entities/country-terms.entity';

export interface OnboardCountryInput {
    countryCode: string;
    countryName: string;
    currencyCode: string;
    continent?: string;
    worldFirstId?: string;
    shippingCalculatorCode?: string;
}

@Injectable()
export class OnboardingService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private zoneService: ZoneService,
        private countryService: CountryService,
        private stockLocationService: StockLocationService,
        private shippingMethodService: ShippingMethodService,
        private taxConsistencyService: TaxConsistencyService,
    ) {}

    async onboardCountry(ctx: RequestContext, input: OnboardCountryInput): Promise<boolean> {
        return this.connection.withTransaction(ctx, async (transactionalCtx) => {
            try {
                Logger.info(`Starting onboarding for country: ${input.countryName} (${input.countryCode})`, 'OnboardingService');

                // 1. Create or Find Channel
                const channelToken = `${input.countryCode.toLowerCase()}-token`;
                const channelCode = `${input.countryCode.toLowerCase()}-channel`;
                
                const channels = await this.channelService.findAll(transactionalCtx);
                let channel = channels.items.find(c => c.token === channelToken);

                if (!channel) {
                    const zones = await this.zoneService.findAll(transactionalCtx);
                    let targetZoneId;

                    if (zones.items.length === 0) {
                        Logger.info('No zones found. Creating Global Zone...', 'OnboardingService');
                        const globalZone = await this.zoneService.create(transactionalCtx, { name: 'Global' });
                        targetZoneId = globalZone.id;
                    } else {
                        targetZoneId = zones.items[0].id;
                    }

                    const channelResult = await this.channelService.create(transactionalCtx, {
                        code: channelCode,
                        token: channelToken,
                        defaultLanguageCode: LanguageCode.zh,
                        currencyCode: input.currencyCode as CurrencyCode,
                        pricesIncludeTax: true,
                        defaultShippingZoneId: targetZoneId,
                        defaultTaxZoneId: targetZoneId,
                    });

                    if (channelResult && 'id' in channelResult) {
                        channel = channelResult;
                    } else {
                        throw new Error('Failed to create channel');
                    }
                    Logger.info(`✅ Created Channel: ${channel.code}`, 'OnboardingService');
                }

                // 2. Create or Find Zone for the Country
                const allZones = await this.zoneService.findAll(transactionalCtx);
                const zoneName = input.continent || input.countryName;
                let countryZone = allZones.items.find(z => z.name === zoneName);

                if (!countryZone) {
                    countryZone = await this.zoneService.create(transactionalCtx, { name: zoneName });
                    Logger.info(`✅ Created Zone: ${countryZone.name}`, 'OnboardingService');
                }

                const country = await this.countryService.findOneByCode(transactionalCtx, input.countryCode);
                if (country) {
                    await this.zoneService.addMembersToZone(transactionalCtx, {
                        zoneId: countryZone.id,
                        memberIds: [country.id],
                    });
                    Logger.info(`✅ Linked ${input.countryCode} to Zone ${countryZone.name}`, 'OnboardingService');
                }

                // 3. Register Tax Guard Mapping
                await this.taxConsistencyService.registerMapping(transactionalCtx, channelToken, zoneName);

                // 4. Initialize Multi-Country Config Spaces (Entities)
                const configRepo = this.connection.getRepository(transactionalCtx, CountryConfig);
                let countryConfig = await configRepo.findOne({ where: { countryCode: input.countryCode } });
                if (!countryConfig) {
                    await configRepo.save(new CountryConfig({
                        countryCode: input.countryCode,
                        active: true,
                        worldFirstId: input.worldFirstId || '',
                        commissionTiers: { default: 20 } as any,
                    }));
                } else {
                    countryConfig.worldFirstId = input.worldFirstId || countryConfig.worldFirstId;
                    await configRepo.save(countryConfig);
                }
                Logger.info(`✅ Synced CountryConfig for ${input.countryCode}`, 'OnboardingService');

                const termsRepo = this.connection.getRepository(transactionalCtx, CountryTerms);
                let countryTerms = await termsRepo.findOne({ where: { countryCode: input.countryCode } });
                if (!countryTerms) {
                    await termsRepo.save(new CountryTerms({
                        countryCode: input.countryCode,
                        content: { paymentMethods: [], fees: [] } as any
                    }));
                    Logger.info(`✅ Initialized CountryTerms for ${input.countryCode}`, 'OnboardingService');
                }

                // 5. Create Stock Location
                const stockLocationName = `${input.countryCode.toUpperCase()} Warehouse`;
                const stockLocations = await this.stockLocationService.findAll(transactionalCtx);
                let stockLocation = stockLocations.items.find(sl => sl.name === stockLocationName);

                if (!stockLocation) {
                    stockLocation = await this.stockLocationService.create(transactionalCtx, {
                        name: stockLocationName,
                    });
                    Logger.info(`✅ Created StockLocation: ${stockLocationName}`, 'OnboardingService');
                }

                // 6. Create Shipping Method
                const shippingMethodCode = `${input.countryCode.toLowerCase()}-shipping`;
                const shippingMethods = await this.shippingMethodService.findAll(transactionalCtx);
                let shippingMethod = shippingMethods.items.find(sm => sm.code === shippingMethodCode);

                if (!shippingMethod) {
                    const calculatorCode = input.shippingCalculatorCode || 'default-shipping-calculator';
                    await this.shippingMethodService.create(transactionalCtx, {
                        code: shippingMethodCode,
                        checker: {
                            code: 'default-shipping-eligibility-checker',
                            arguments: [],
                        },
                        calculator: {
                            code: calculatorCode,
                            arguments: calculatorCode === 'german-post-calculator' ? [] : [
                                { name: 'rate', value: '1000' },
                                { name: 'taxCategoryId', value: '1' }
                            ]
                        },
                        fulfillmentHandler: 'manual-fulfillment-handler',
                        translations: [
                            { languageCode: LanguageCode.zh, name: `${input.countryName} 标准物流`, description: `${input.countryName} 官方配送服务` },
                        ]
                    });
                    Logger.info(`✅ Created ShippingMethod with calculator: ${calculatorCode}`, 'OnboardingService');
                }

                return true;
            } catch (error: any) {
                Logger.error(`Onboarding failed: ${error.message}`, 'OnboardingService');
                throw error;
            }
        });
    }
}
