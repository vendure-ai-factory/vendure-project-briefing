import { OnModuleInit } from '@nestjs/common';
import { EventBus, LoginEvent, PluginCommonModule, VendurePlugin, Logger } from '@vendure/core';
import { onboardingApiExtensions } from './api/api-extensions';
import { OnboardingResolver } from './api/onboarding.resolver';
import { OnboardingService } from './services/onboarding.service';
import { TaxConsistencyService } from './services/tax-consistency.service';
import { CountryConfig } from './entities/country-config.entity';
import { CountryTerms } from './entities/country-terms.entity';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [CountryConfig, CountryTerms],
    providers: [OnboardingService, TaxConsistencyService],
    adminApiExtensions: {
        schema: onboardingApiExtensions,
        resolvers: [OnboardingResolver],
    },
})
export class UniversalOnboardingPlugin implements OnModuleInit {
    constructor(private eventBus: EventBus) {}

    onModuleInit() {
        this.eventBus.ofType(LoginEvent).subscribe(event => {
            const { identifier, strategy } = event;
            // 升级为官方 Logger 确保被捕获
            Logger.info(`[LTS] { "event": "AUTH_ATTEMPT", "identifier": "${identifier}", "strategy": "${strategy}", "status": "CAPTURED" }`, 'LTS-Audit');
        });
    }
}
