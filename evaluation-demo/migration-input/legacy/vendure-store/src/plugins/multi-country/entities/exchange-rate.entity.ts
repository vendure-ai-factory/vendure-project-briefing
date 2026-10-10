import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity } from 'typeorm';

@Entity()
export class ExchangeRate extends VendureEntity {
    constructor(input?: DeepPartial<ExchangeRate>) {
        super(input);
    }

    @Column()
    currencyCode: string;

    @Column('decimal', { precision: 10, scale: 5 })
    rate: number;

    @Column()
    date: Date; // The date of the rate (e.g. 2023-10-27)

    @Column({ default: 'ECB' })
    source: string;
}
