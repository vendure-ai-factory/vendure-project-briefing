import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { TermsService } from './services/terms.service';
import gql from 'graphql-tag';

const schema = gql`
    type CountryTerms implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        countryCode: String!
        content: String!
    }

    extend type Query {
        countryTerms(countryCode: String!): CountryTerms
    }

    extend type Mutation {
        updateCountryTerms(countryCode: String!, content: String!): CountryTerms
    }
`;

@Resolver()
export class TermsResolver {
    constructor(private termsService: TermsService) { }

    @Query()
    async countryTerms(@Ctx() ctx: RequestContext, @Args('countryCode') countryCode: string) {
        return this.termsService.getTerms(ctx, countryCode);
    }

    @Mutation()
    @Allow(Permission.UpdateSettings)
    async updateCountryTerms(
        @Ctx() ctx: RequestContext,
        @Args('countryCode') countryCode: string,
        @Args('content') content: string
    ) {
        return this.termsService.updateTerms(ctx, countryCode, content);
    }
}

export const termsSchema = schema;
