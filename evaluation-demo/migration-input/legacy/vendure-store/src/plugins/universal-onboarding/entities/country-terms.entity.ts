import { Entity, Column } from 'typeorm';
import { VendureEntity, DeepPartial } from '@vendure/core';

@Entity()
export class CountryTerms extends VendureEntity {
    constructor(input?: DeepPartial<CountryTerms>) {
        super(input);
    }

    @Column({ unique: true })
    countryCode: string;

    @Column({ type: 'simple-json' })
    content: any;
}
