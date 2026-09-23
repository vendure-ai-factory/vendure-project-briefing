import { Injectable } from '@nestjs/common';
import { TransactionalConnection, RequestContext } from '@vendure/core';
import { CountryTerms } from '../entities/country-terms.entity';

@Injectable()
export class TermsService {
    constructor(private connection: TransactionalConnection) { }

    async getTerms(ctx: RequestContext, countryCode: string): Promise<CountryTerms | null> {
        return this.connection.getRepository(ctx, CountryTerms).findOne({ where: { countryCode } });
    }

    async updateTerms(ctx: RequestContext, countryCode: string, content: string): Promise<CountryTerms> {
        const repo = this.connection.getRepository(ctx, CountryTerms);
        const existing = await repo.findOne({ where: { countryCode } });
        if (existing) {
            existing.content = content;
            return repo.save(existing);
        } else {
            return repo.save(new CountryTerms({ countryCode, content }));
        }
    }
}
