import { VendureEntity, DeepPartial } from '@vendure/core';
import { Entity, Column } from 'typeorm';

@Entity()
export class CountryTerms extends VendureEntity {
    constructor(input?: DeepPartial<CountryTerms>) {
        super(input);
    }

    @Column({ unique: true })
    countryCode: string;

    @Column('text')
    content: string;
}
