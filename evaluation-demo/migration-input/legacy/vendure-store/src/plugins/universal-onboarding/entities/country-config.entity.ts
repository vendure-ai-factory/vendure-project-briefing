import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { VendureEntity, DeepPartial, Channel } from '@vendure/core';

@Entity()
export class CountryConfig extends VendureEntity {
    constructor(input?: DeepPartial<CountryConfig>) {
        super(input);
    }

    @Column({ unique: true })
    countryCode: string;

    @Column({ default: '' })
    worldFirstId: string;

    @Column({ type: 'simple-json', nullable: true })
    commissionTiers: any;

    @Column({ default: true })
    active: boolean;
}
