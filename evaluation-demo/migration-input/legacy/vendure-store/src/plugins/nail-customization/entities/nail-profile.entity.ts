import { DeepPartial, VendureEntity, Customer, ID } from '@vendure/core';
import { Column, Entity, ManyToOne } from 'typeorm';

@Entity()
export class NailProfile extends VendureEntity {
    constructor(input?: DeepPartial<NailProfile>) {
        super(input);
    }

    @Column()
    profileName: string;

    @Column({ type: 'simple-json' })
    fingerSizes: Record<string, number>;

    @ManyToOne(type => Customer)
    customer: Customer;

    @Column()
    customerId: ID;
}
