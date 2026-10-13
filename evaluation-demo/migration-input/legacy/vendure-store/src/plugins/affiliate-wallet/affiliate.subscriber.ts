import { EventSubscriber, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { Order, OrderPlacedEvent, EventBus, CustomerEvent, Customer } from '@vendure/core';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { filter } from 'rxjs/operators';

@Injectable()
export class AffiliateSubscriber implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private affiliateService: AffiliateService,
    ) { }

    onModuleInit() {
        // 1. Listen for Order Placed (Reward Referee)
        this.eventBus.ofType(OrderPlacedEvent).subscribe(async (event) => {
            const order = event.order;
            // Check if ANY coupon code starts with REF-
            const referralCode = order.couponCodes?.find(code => code.startsWith('REF-'));

            if (referralCode) {
                // Parse Referrer ID from "REF-{ID}"
                const parts = referralCode.split('-');
                if (parts.length >= 2) {
                    const referrerId = parts[1];
                    const rewardAmount = 10; // Fixed 10 credits for now, configurable later

                    // 🟡 安全修复：禁止自我推荐刷积分
                    if (referrerId === order.customer?.id?.toString()) {
                        console.warn(`[Affiliate] Self-referral blocked for customer ${referrerId}`);
                        return;
                    }

                    try {
                        await this.affiliateService.rewardReferrer(event.ctx, referrerId, rewardAmount);
                    } catch (e) {
                        console.error('[Affiliate] Failed to reward referrer:', e);
                    }
                }
            }
        });

        // 2. Listen for Customer Created (Generate Code)
        this.eventBus.ofType(CustomerEvent).pipe(
            filter(event => event.type === 'created')
        ).subscribe(async (event) => {
            const customer = event.customer;
            try {
                // We need a request context, checking if event has it (usually yes)
                await this.affiliateService.createReferralCoupon(event.ctx, customer.id);
                console.log(`[Affiliate] Generated referral code for Customer ${customer.id}`);
            } catch (e) {
                console.error('[Affiliate] Failed to generate referral code:', e);
            }
        });
    }
}
