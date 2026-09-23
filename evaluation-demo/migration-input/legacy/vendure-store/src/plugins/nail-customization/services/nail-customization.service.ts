import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { RequestContext, TransactionalConnection, ID, UserInputError } from '@vendure/core';
import { NailProfile } from '../entities/nail-profile.entity';

export interface NailSizeEntry {
    index: number;
    number: string;
    arcLength: number;
    chordLength?: number;
}

export interface NailShapeInfo {
    code: string;
    nameZh: string;
    nameDe: string;
    sizes: NailSizeEntry[];
}

@Injectable()
export class NailCustomizationService {
    constructor(@InjectConnection() private connection: Connection, private transactionalConnection: TransactionalConnection) { }

    // Hardcoded nail shape data from provided Markdown
    private readonly nailShapes: NailShapeInfo[] = [
        {
            code: 'short-stiletto',
            nameZh: '短尖',
            nameDe: 'kurz_Spitze_Form',
            sizes: [
                { index: 0, number: '0', arcLength: 18 },
                { index: 1, number: '1', arcLength: 16 },
                { index: 2, number: '2', arcLength: 15 },
                { index: 3, number: '3', arcLength: 14 },
                { index: 4, number: '4', arcLength: 13.5 },
                { index: 5, number: '5', arcLength: 13 },
                { index: 6, number: '6', arcLength: 12.5 },
                { index: 7, number: '7', arcLength: 12.5 },
                { index: 8, number: '8', arcLength: 11 },
                { index: 9, number: '8.5', arcLength: 10.5 },
                { index: 10, number: '9', arcLength: 10 },
                { index: 11, number: '9.5', arcLength: 9 },
                { index: 12, number: '10', arcLength: 9 },
                { index: 13, number: '10.5', arcLength: 8 },
                { index: 14, number: '11', arcLength: 7.5 },
            ]
        },
        {
            code: 'short-oval',
            nameZh: '短圆',
            nameDe: 'kurz_Oval',
            sizes: [
                { index: 0, number: '0', arcLength: 17.5 },
                { index: 1, number: '1', arcLength: 17 },
                { index: 2, number: '2', arcLength: 16.5 },
                { index: 3, number: '3', arcLength: 15 },
                { index: 4, number: '4', arcLength: 14.2 },
                { index: 5, number: '5', arcLength: 14 },
                { index: 6, number: '6', arcLength: 13.3 },
                { index: 7, number: '7', arcLength: 13 },
                { index: 8, number: '8', arcLength: 12.5 },
                { index: 9, number: '8.5', arcLength: 11.5 },
                { index: 10, number: '9', arcLength: 11.5 },
                { index: 11, number: '9.5', arcLength: 11 },
                { index: 12, number: '10', arcLength: 10 },
                { index: 13, number: '10.5', arcLength: 9.5 },
                { index: 14, number: '11', arcLength: 8.5 },
            ]
        },
        {
            code: 'short-coffin', // Or ballerina
            nameZh: '短梯',
            nameDe: 'kurz_Sargform',
            sizes: [
                { index: 0, number: '0', arcLength: 18.5 },
                { index: 1, number: '1', arcLength: 17 },
                { index: 2, number: '2', arcLength: 15.7 },
                { index: 3, number: '3', arcLength: 15 },
                { index: 4, number: '4', arcLength: 14 },
                { index: 5, number: '5', arcLength: 13.5 },
                { index: 6, number: '6', arcLength: 13 },
                { index: 7, number: '7', arcLength: 12.5 },
                { index: 8, number: '8', arcLength: 12.2 },
                { index: 9, number: '8.5', arcLength: 11.8 },
                { index: 10, number: '9', arcLength: 11 },
                { index: 11, number: '9.5', arcLength: 10.2 },
                { index: 12, number: '10', arcLength: 9.5 },
                { index: 13, number: '10.5', arcLength: 9 },
                { index: 14, number: '11', arcLength: 8.5 },
            ]
        },
        {
            code: 'short-squoval',
            nameZh: '短方圆',
            nameDe: 'kurz_Squoval',
            sizes: [
                { index: 0, number: '0', arcLength: 17 },
                { index: 1, number: '1', arcLength: 16 },
                { index: 2, number: '2', arcLength: 15 },
                { index: 3, number: '3', arcLength: 14.5 },
                { index: 4, number: '4', arcLength: 13.8 },
                { index: 5, number: '5', arcLength: 13 },
                { index: 6, number: '6', arcLength: 12 },
                { index: 7, number: '7', arcLength: 11.7 },
                { index: 8, number: '8', arcLength: 11.3 },
                { index: 9, number: '8.5', arcLength: 11 },
                { index: 10, number: '9', arcLength: 10.5 },
                { index: 11, number: '9.5', arcLength: 10.2 },
                { index: 12, number: '10', arcLength: 9.5 },
                { index: 13, number: '10.5', arcLength: 9.5 },
                { index: 14, number: '11', arcLength: 9 },
            ]
        }
    ];

    findAllNailShapes(): NailShapeInfo[] {
        return this.nailShapes;
    }

    matchNailSize(arcLength: number, shapeCode: string) {
        const shape = this.nailShapes.find(s => s.code === shapeCode);
        if (!shape) {
            throw new UserInputError(`Unknown nail shape code: ${shapeCode}`);
        }

        // Sort sizes descending to ensure order: Large -> Small
        const sortedSizes = [...shape.sizes].sort((a, b) => b.arcLength - a.arcLength);

        // Logic: Find the first size that is SMALLER or EQUAL to the customer's size.
        // Example: Sizes [16, 15], Customer 15.5. Matches 15.
        let bestMatch = sortedSizes.find(s => s.arcLength <= arcLength);

        // Fallback: If customer is smaller than ALL sizes, pick the smallest.
        if (!bestMatch) {
            bestMatch = sortedSizes[sortedSizes.length - 1];
        }

        const diff = Math.abs(bestMatch.arcLength - arcLength);

        return {
            number: bestMatch.number,
            arcLength: bestMatch.arcLength,
            chordLength: bestMatch.chordLength,
            exact: diff < 0.2 // Tolerance 0.2mm
        };
    }

    async findAll(ctx: RequestContext): Promise<NailProfile[]> {
        if (!ctx.activeUserId) return [];

        return this.transactionalConnection.getRepository(ctx, NailProfile).find({
            where: {
                customer: { id: ctx.activeUserId },
            },
            order: {
                updatedAt: 'DESC',
            }
        });
    }

    async findOne(ctx: RequestContext, id: ID): Promise<NailProfile | undefined> {
        if (!ctx.activeUserId) return undefined;
        const profile = await this.transactionalConnection.getRepository(ctx, NailProfile).findOne({
            where: {
                id,
                customer: { id: ctx.activeUserId }
            }
        });
        return profile ?? undefined;
    }

    async create(ctx: RequestContext, input: { profileName: string; fingerSizes: any }): Promise<NailProfile> {
        if (!ctx.activeUserId) {
            throw new UserInputError('You must be logged in to create a nail profile');
        }

        const customer = await this.transactionalConnection.getRepository(ctx, 'Customer').findOne({ where: { id: ctx.activeUserId } });
        if (!customer) {
            throw new UserInputError('Customer not found');
        }

        const profile = new NailProfile({
            profileName: input.profileName,
            fingerSizes: input.fingerSizes,
            customer: customer as any,
        });

        return this.transactionalConnection.getRepository(ctx, NailProfile).save(profile);
    }

    async update(ctx: RequestContext, id: ID, input: { profileName?: string; fingerSizes?: any }): Promise<NailProfile> {
        const profile = await this.findOne(ctx, id);
        if (!profile) {
            throw new UserInputError('Nail profile not found');
        }

        if (input.profileName) profile.profileName = input.profileName;
        if (input.fingerSizes) profile.fingerSizes = input.fingerSizes;

        return this.transactionalConnection.getRepository(ctx, NailProfile).save(profile);
    }

    async delete(ctx: RequestContext, id: ID): Promise<{ result: string, message?: string }> {
        const profile = await this.findOne(ctx, id);
        if (!profile) {
            throw new UserInputError('Nail profile not found');
        }

        await this.transactionalConnection.getRepository(ctx, NailProfile).remove(profile);
        return { result: 'DELETED' };
    }
}
