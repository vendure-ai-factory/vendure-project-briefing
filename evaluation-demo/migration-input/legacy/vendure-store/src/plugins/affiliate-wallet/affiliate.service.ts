import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestContext, TransactionalConnection, ID, CustomerService, Customer, PromotionService, Promotion, LanguageCode } from '@vendure/core';
import { StoreCredit } from '@avendure/vendure-plugin-store-credit/dist/entity/store-credit.entity';

@Injectable()
export class AffiliateService {
    private readonly REFERRAL_PROMOTION_CODE = 'REFERRAL_PROGRAM';

    constructor(
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private promotionService: PromotionService,
    ) { }

    async ensureReferralPromotionExists(ctx: RequestContext): Promise<Promotion> {
        const promotionRepo = this.connection.getRepository(ctx, Promotion);
        const existing = await promotionRepo.findOne({
            where: { couponCode: 'REF-GENERIC-PLACEHOLDER' } as any
        });

        if (existing) {
            return existing;
        }

        console.log('[Affiliate] Creating default Referral Promotion...');

        // Fix: Use DeepPartial strictness workaround or simplified object
        const promotion = new Promotion({
            name: 'Referral Program',
            code: this.REFERRAL_PROMOTION_CODE,
            enabled: true,
            couponCode: 'REF-GENERIC-PLACEHOLDER',
            perCustomerUsageLimit: 1,
            translations: [
                { languageCode: LanguageCode.en, name: 'Referral Program', description: 'Referral Reward' }
            ]
        } as any);

        // Note: conditions and actions are relations, often better to save generic empty arrays or not assign if empty in constructor

        return promotionRepo.save(promotion);
    }

    async createReferralCoupon(ctx: RequestContext, customerId: ID): Promise<any> {
        const promotion = await this.ensureReferralPromotionExists(ctx);
        const code = `REF-${customerId}`;

        // Use string repository name to avoid needing CouponCode entity import
        const couponRepo = this.connection.getRepository(ctx, 'CouponCode');

        const existing = await couponRepo.findOne({ where: { code } });
        if (existing) {
            return existing;
        }

        // Use create() to handle entity creation dynamically
        const coupon = await couponRepo.save(
            couponRepo.create({
                code,
                promotion,
                usageLimit: 1000,
                perCustomerUsageLimit: 1,
            })
        );

        return coupon;
    }

    async rewardReferrer(ctx: RequestContext, customerId: ID, amount: number) {
        const customer = await this.customerService.findOne(ctx, customerId);
        if (!customer) {
            throw new Error(`Customer with ID ${customerId} not found`);
        }

        const credit = new StoreCredit({
            perUserLimit: 1,
            value: amount,
            key: `REF-REWARD-${customerId}-${Date.now()}`,
            customer: customer
        });

        await this.connection.getRepository(ctx, StoreCredit).save(credit);

        const currentBalance = (customer.customFields as any).balanceBonus || 0;
        await this.customerService.update(ctx, {
            id: customerId,
            customFields: {
                balanceBonus: currentBalance + amount,
            },
        });

        console.log(`[Affiliate] Rewarded Customer ${customerId} with ${amount} credits.`);
        return credit;
    }

    async transferBalance(ctx: RequestContext, senderUserId: ID, receiverId: ID, amount: number) {
        // 注意：积分单位为「分」（整数），与货币最小单位对应。
        // 例：100 积分 = 1 欧元（EUR）或约 37 福林（HUF），禁止前台传入浮点数。
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new Error('Amount must be a positive integer (in cents/points)');
        }

        // 🔴 安全修复：用数据库事务包裹全部操作。
        // 若任意一步失败，两步操作都会自动回滚，资金不会凭空消失。
        return this.connection.withTransaction(ctx, async (transactionalCtx) => {
            const sender = await this.connection.getRepository(transactionalCtx, Customer).findOne({
                where: { user: { id: senderUserId } },
                relations: ['user']
            });

            if (!sender) {
                throw new Error('Sender not found');
            }

            const receiver = await this.customerService.findOne(transactionalCtx, receiverId);
            if (!receiver) {
                throw new Error('Receiver not found');
            }

            if (sender.id === receiver.id) {
                throw new Error('Cannot transfer to yourself');
            }

            const senderBalance = (sender.customFields as any).balanceWithdrawable || 0;
            if (senderBalance < amount) {
                throw new Error(`Insufficient balance: has ${senderBalance}, needs ${amount}`);
            }

            // Step 1: 扣减发送方余额（可提现积分）
            await this.customerService.update(transactionalCtx, {
                id: sender.id,
                customFields: {
                    balanceWithdrawable: senderBalance - amount,
                },
            });

            // Step 2: 增加接收方余额（站内赠金积分）
            const receiverBalance = (receiver.customFields as any).balanceBonus || 0;
            await this.customerService.update(transactionalCtx, {
                id: receiver.id,
                customFields: {
                    balanceBonus: receiverBalance + amount,
                },
            });

            console.log(`[Affiliate] Transfer OK: ${sender.id} -> ${receiver.id}, amount=${amount} pts (in atomic transaction)`);

            return {
                success: true,
                message: `Successfully transferred ${amount} points to ${receiver.firstName} ${receiver.lastName}`,
                newBalance: senderBalance - amount
            };
        });
    }
}
