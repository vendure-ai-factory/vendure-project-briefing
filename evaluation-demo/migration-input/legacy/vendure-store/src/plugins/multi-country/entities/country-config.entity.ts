import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity } from 'typeorm';

@Entity()
export class CountryConfig extends VendureEntity {
    constructor(input?: DeepPartial<CountryConfig>) {
        super(input);
    }

    @Column({ unique: true })
    countryCode: string;

    @Column('decimal', { precision: 5, scale: 2, default: 1.0 })
    priceMultiplier: number;
}
