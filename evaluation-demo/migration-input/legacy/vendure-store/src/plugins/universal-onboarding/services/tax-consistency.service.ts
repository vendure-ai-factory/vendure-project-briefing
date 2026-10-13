import { Injectable } from '@nestjs/common';
import { 
    ChannelService, 
    ZoneService, 
    TaxRateService,
    RequestContext,
    Logger,
    TransactionalConnection,
    ID
} from '@vendure/core';

@Injectable()
export class TaxConsistencyService {
    // This map will store derived mappings from database configs and manual overrides
    private channelToZoneMap: Map<string, string> = new Map();

    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private zoneService: ZoneService,
    ) {}

    /**
     * Registers a mapping between a channel token and its authoritative tax zone name.
     */
    async registerMapping(ctx: RequestContext, channelToken: string, zoneName: string): Promise<void> {
        this.channelToZoneMap.set(channelToken, zoneName);
        Logger.info(`[TaxGuard] Registered mapping: ${channelToken} -> ${zoneName}`, 'TaxConsistencyService');
        
        await this.enforceIsolation(ctx, channelToken, zoneName);
    }

    /**
     * Ensures the channel's defaultTaxZone matches our authoritative guard zone.
     * This prevents "Tax Drift" where one channel uses another's tax rates.
     */
    private async enforceIsolation(ctx: RequestContext, channelToken: string, zoneName: string): Promise<void> {
        const channel = await this.channelService.findAll(ctx).then(res => 
            res.items.find(c => c.token === channelToken)
        );
        const zone = await this.zoneService.findAll(ctx).then(res => 
            res.items.find(z => z.name === zoneName)
        );

        if (channel && zone) {
            // Check if isolation is already set
            if (channel.defaultTaxZone?.id !== zone.id) {
                // Update channel default tax zone
                await this.channelService.update(ctx, {
                    id: channel.id,
                    defaultTaxZoneId: zone.id,
                });
                Logger.info(`[TaxGuard] Isolated Channel ${channel.code} to Zone ${zoneName}`, 'TaxConsistencyService');
            }
        }
    }
}
