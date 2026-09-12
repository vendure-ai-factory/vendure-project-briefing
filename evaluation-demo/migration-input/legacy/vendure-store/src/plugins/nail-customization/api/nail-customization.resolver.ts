import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { NailCustomizationService } from '../services/nail-customization.service';
import { NailProfile } from '../entities/nail-profile.entity';
import gql from 'graphql-tag';

// Define the schema extension
export const localExtensionSchema = gql`
    type NailProfile implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        profileName: String!
        fingerSizes: JSON!
    }

    type NailSizeEntry {
        index: Int!
        number: String!
        arcLength: Float!
        chordLength: Float
    }

    type NailShapeInfo {
        code: String!
        nameZh: String!
        nameDe: String!
        sizes: [NailSizeEntry!]!
    }

    type NailSizeMatch {
        number: String!
        arcLength: Float!
        chordLength: Float
        exact: Boolean!
    }

    input CreateNailProfileInput {
        profileName: String!
        fingerSizes: JSON!
    }

    input UpdateNailProfileInput {
        profileName: String
        fingerSizes: JSON
    }



    extend type Query {
        myNailProfiles: [NailProfile!]!
        allNailShapes: [NailShapeInfo!]!
        matchNailSize(arcLength: Float!, shapeCode: String!): NailSizeMatch
    }

    extend type Mutation {
        createNailProfile(input: CreateNailProfileInput!): NailProfile!
        updateNailProfile(id: ID!, input: UpdateNailProfileInput!): NailProfile!
        deleteNailProfile(id: ID!): DeletionResponse!
    }
`;

@Resolver()
export class NailCustomizationResolver {
    constructor(private nailCustomizationService: NailCustomizationService) { }

    @Query()
    @Allow(Permission.Authenticated)
    async myNailProfiles(@Ctx() ctx: RequestContext) {
        return this.nailCustomizationService.findAll(ctx);
    }

    @Query()
    async allNailShapes() {
        return this.nailCustomizationService.findAllNailShapes();
    }

    @Query()
    async matchNailSize(@Args() args: { arcLength: number; shapeCode: string }) {
        return this.nailCustomizationService.matchNailSize(args.arcLength, args.shapeCode);
    }

    @Mutation()
    @Allow(Permission.Authenticated)
    async createNailProfile(@Ctx() ctx: RequestContext, @Args('input') input: { profileName: string; fingerSizes: any }) {
        return this.nailCustomizationService.create(ctx, input);
    }

    @Mutation()
    @Allow(Permission.Authenticated)
    async updateNailProfile(@Ctx() ctx: RequestContext, @Args() args: { id: string; input: { profileName?: string; fingerSizes?: any } }) {
        return this.nailCustomizationService.update(ctx, args.id, args.input);
    }

    @Mutation()
    @Allow(Permission.Authenticated)
    async deleteNailProfile(@Ctx() ctx: RequestContext, @Args('id') id: string) {
        return this.nailCustomizationService.delete(ctx, id);
    }
}
