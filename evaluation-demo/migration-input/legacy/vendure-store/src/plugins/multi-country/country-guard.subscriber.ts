import {
    EntitySubscriberInterface,
    EventSubscriber,
    InsertEvent,
    UpdateEvent,
} from 'typeorm';
import { Address, Customer, OrderLine, ProductVariant, Order, Country } from '@vendure/core';

@EventSubscriber()
export class CountryGuardSubscriber implements EntitySubscriberInterface {

    constructor() {
        console.log('✅ [CountryGuard] Subscriber Instantiated!');
    }

    /**
     * Enforce Address Country Match
     */
    async beforeInsert(event: InsertEvent<any>) {
        if (event.entity instanceof Address) {
            await this.checkAddressCountry(event.entity, event as any);
        }
    }

    async afterInsert(event: InsertEvent<any>) {
        if (event.entity instanceof OrderLine) {
            await this.checkOrderLine(event.entity, event as any);
        }
    }

    async beforeUpdate(event: UpdateEvent<any>) {
        if (event.entity instanceof Address) {
            await this.checkAddressCountry(event.entity, event);
        }
        if (event.entity instanceof Order) {
            await this.checkOrder(event.entity, event);
        }
    }

    async afterUpdate(event: UpdateEvent<any>) {
        if (event.entity instanceof OrderLine) {
            await this.checkOrderLine(event.entity, event as any);
        }
    }

    private async checkAddressCountry(address: Address, event: InsertEvent<any> | UpdateEvent<any>) {
        let customer = address.customer;
        if (!customer && (event.entity as any).customerId) {
            customer = await event.manager.findOne(Customer, { where: { id: (event.entity as any).customerId } }) as any;
        }

        if (customer) {
            const fullCustomer = await event.manager.findOne(Customer, {
                where: { id: customer.id },
                relations: [],
            });

            let customerCountryCode = (fullCustomer as any)?.customFields?.countryCode;

            let countryCode = '';
            if (address.country && address.country.code) {
                countryCode = address.country.code;
            } else if (address.country) {
                const countryId = (address.country as any).id || address.country;
                const country = await event.manager.findOne(Country, { where: { id: countryId } });
                if (country) {
                    countryCode = country.code;
                }
            }

            if (!customerCountryCode && countryCode && fullCustomer) {
                // Self-healing: Update Customer's countryCode
                fullCustomer.customFields = fullCustomer.customFields || {};
                (fullCustomer.customFields as any).countryCode = countryCode;
                await event.manager.save(Customer, fullCustomer);
                console.log(`[CountryGuard] Auto-healed customer ${fullCustomer.id} setting country to ${countryCode}`);
                customerCountryCode = countryCode;
            }

            if (customerCountryCode) {
                if (countryCode && countryCode !== customerCountryCode) {
                    throw new Error(`Address Country (${countryCode}) does not match Customer Registered Country (${customerCountryCode}).`);
                }
            }
        }
    }

    private async checkOrderLine(orderLine: OrderLine, event: InsertEvent<OrderLine> | UpdateEvent<OrderLine>) {
        const id = orderLine.id;
        if (!id) return;

        // Fetch the line with all relations needed for isolation check
        const fullLine = await event.manager.findOne(OrderLine, {
            where: { id },
            relations: ['order', 'order.customer', 'productVariant', 'productVariant.product']
        });

        if (!fullLine) return;

        const customer = fullLine.order?.customer;
        if (!customer) return;

        const fullCustomer = await event.manager.findOne(Customer, {
            where: { id: customer.id },
            relations: [],
        });
        const customerCountryCode = (fullCustomer as any)?.customFields?.countryCode;

        const variant = fullLine.productVariant;
        if (variant && variant.product) {
            const productCountryCode = (variant.product as any).customFields?.countryCode;

            if (customerCountryCode && productCountryCode && productCountryCode !== customerCountryCode) {
                console.log(`[CountryGuard] BLOCKING LINE! Product ${productCountryCode} !== Customer ${customerCountryCode}`);
                throw new Error(`Product Country (${productCountryCode}) does not match User Country (${customerCountryCode}).`);
            }
        }
    }

    private async checkOrder(orderEntity: Order, event: UpdateEvent<any>) {
        const order = await event.manager.findOne(Order, {
            where: { id: orderEntity.id },
            relations: ['lines', 'lines.productVariant', 'lines.productVariant.product', 'customer']
        });

        // Resilient check for simulation: if DB has no customer but entity being saved has one, use it.
        let customer = order?.customer || (orderEntity as any).customer;

        if (!customer) {
            return;
        }

        const fullCustomer = await event.manager.findOne(Customer, {
            where: { id: (customer as any).id || customer },
            relations: [],
        });
        const customerCountryCode = (fullCustomer as any)?.customFields?.countryCode;

        if (!customerCountryCode) {
            return;
        }

        const lines = order?.lines || (orderEntity as any).lines || [];
        for (const line of lines) {
            const variant = (line as any).productVariant;
            if (variant && variant.product) {
                const productCountryCode = (variant.product as any).customFields?.countryCode;
                if (productCountryCode && productCountryCode !== customerCountryCode) {
                    console.log(`[CountryGuard] BLOCKING ORDER! Product ${productCountryCode} !== Customer ${customerCountryCode}`);
                    throw new Error(`Product Country (${productCountryCode}) does not match User Country (${customerCountryCode}).`);
                }
            }
        }
    }
}
