import { Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection, Order, ProductVariant, FacetValue, OrderLine, Product, Customer } from '@vendure/core';

@Injectable()
export class VendorService {
    constructor(private connection: TransactionalConnection) { }

    async getVendorOverview(ctx: RequestContext) {
        // Fix: Use activeUserId to find customer if activeUser is not populated
        if (!ctx.activeUserId) {
            // No user logged in
            return {
                totalSales: 0,
                activeProductCount: 0,
                pendingOrderCount: 0
            };
        }

        // Fetch customer with custom fields
        const customer = await this.connection.getRepository(ctx, Customer).findOne({
            where: { user: { id: ctx.activeUserId } },
            relations: ['customFields']
        });

        if (!customer) {
            throw new Error('No active customer found for user');
        }

        const vendorFacetValueId = (customer.customFields as any).vendorFacetValueId;

        if (!vendorFacetValueId) {
            return {
                totalSales: 0,
                activeProductCount: 0,
                pendingOrderCount: 0
            };
        }

        // 1. Get Variant IDs belonging to this Vendor
        const variants = await this.connection.getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoin('variant.product', 'product')
            .leftJoin('product.facetValues', 'facetValue')
            .where('facetValue.id = :id', { id: vendorFacetValueId })
            .select('variant.id')
            .getMany();

        const variantIds = variants.map(v => v.id);

        if (variantIds.length === 0) {
            return { totalSales: 0, activeProductCount: 0, pendingOrderCount: 0 };
        }

        // 2. Active Products Count
        const activeProductCount = await this.connection.getRepository(ctx, Product)
            .createQueryBuilder('product')
            .leftJoin('product.facetValues', 'facetValue')
            .where('facetValue.id = :id', { id: vendorFacetValueId })
            .andWhere('product.enabled = :enabled', { enabled: true })
            .getCount();

        // 3. Total Sales
        const salesStats = await this.connection.getRepository(ctx, OrderLine)
            .createQueryBuilder('line')
            .leftJoin('line.order', 'order')
            .where('line.productVariantId IN (:...ids)', { ids: variantIds })
            .andWhere('order.state IN (:...states)', { states: ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'Delivered'] })
            .select('SUM(line.linePriceWithTax)', 'total')
            .getRawOne();

        const totalSales = salesStats && salesStats.total ? parseInt(salesStats.total) : 0;

        // 4. Pending Orders Count
        const pendingOrderCount = await this.connection.getRepository(ctx, Order)
            .createQueryBuilder('order')
            .leftJoin('order.lines', 'line')
            .where('line.productVariantId IN (:...ids)', { ids: variantIds })
            .andWhere('order.state IN (:...states)', { states: ['PaymentSettled', 'PartiallyShipped'] })
            .getCount();

        return {
            totalSales,
            activeProductCount,
            pendingOrderCount
        };
    }
}
