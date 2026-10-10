import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    ID,
    RequestContext,
    TransactionalConnection,
    ForbiddenError,
    EntityNotFoundError,
} from '@vendure/core';
import { NailProfile } from './nail-profile.entity';
import { matchNailSize as matchNailSizeAlgo, NAIL_SHAPES, FINGER_CODES } from './nail-size-data';

/**
 * NailProfileService - 指甲档案服务
 * 
 * 负责：
 * 1. 客户指甲档案的 CRUD 操作
 * 2. 甲片尺寸匹配算法调用
 * 3. 权限检查（客户只能访问自己的档案）
 */
@Injectable()
export class NailProfileService {
    constructor(private connection: TransactionalConnection) { }

    /**
     * 获取当前客户的所有指甲档案
     */
    async findByCustomer(ctx: RequestContext): Promise<NailProfile[]> {
        const customerId = this.getCustomerId(ctx);
        return this.connection.getRepository(ctx, NailProfile).find({
            where: { customerId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * 管理员获取指定客户的指甲档案
     */
    async findByCustomerId(ctx: RequestContext, customerId: ID): Promise<NailProfile[]> {
        return this.connection.getRepository(ctx, NailProfile).find({
            where: { customerId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * 创建新的指甲档案
     */
    async create(
        ctx: RequestContext,
        input: { profileName: string; fingerSizes: Record<string, number> },
    ): Promise<NailProfile> {
        const customerId = this.getCustomerId(ctx);
        this.validateFingerSizes(input.fingerSizes);

        const profile = new NailProfile({
            customerId,
            profileName: input.profileName,
            fingerSizes: input.fingerSizes,
        });

        return this.connection.getRepository(ctx, NailProfile).save(profile);
    }

    /**
     * 更新指定的指甲档案
     */
    async update(
        ctx: RequestContext,
        id: ID,
        input: { profileName?: string; fingerSizes?: Record<string, number> },
    ): Promise<NailProfile> {
        const customerId = this.getCustomerId(ctx);
        const repo = this.connection.getRepository(ctx, NailProfile);

        const profile = await repo.findOne({ where: { id, customerId } });
        if (!profile) {
            throw new EntityNotFoundError('NailProfile', id);
        }

        if (input.profileName !== undefined) {
            profile.profileName = input.profileName;
        }
        if (input.fingerSizes !== undefined) {
            this.validateFingerSizes(input.fingerSizes);
            profile.fingerSizes = input.fingerSizes;
        }

        return repo.save(profile);
    }

    /**
     * 删除指定的指甲档案
     */
    async delete(ctx: RequestContext, id: ID): Promise<{ result: 'DELETED' | 'NOT_DELETED'; message?: string }> {
        const customerId = this.getCustomerId(ctx);
        const repo = this.connection.getRepository(ctx, NailProfile);

        const profile = await repo.findOne({ where: { id, customerId } });
        if (!profile) {
            return { result: 'NOT_DELETED', message: `NailProfile with id ${id} not found` };
        }

        await repo.remove(profile);
        return { result: 'DELETED' };
    }

    /**
     * 匹配甲片尺寸
     */
    matchNailSize(arcLength: number, shapeCode: string) {
        return matchNailSizeAlgo(arcLength, shapeCode);
    }

    /**
     * 获取甲型尺寸表
     */
    getNailSizeChart(shapeCode: string) {
        const shape = NAIL_SHAPES.find(s => s.code === shapeCode);
        return shape?.sizes ?? [];
    }

    /**
     * 获取所有甲型信息
     */
    getAllNailShapes() {
        return NAIL_SHAPES;
    }

    /**
     * 为指定档案中的所有手指匹配甲片型号
     */
    matchAllFingers(
        profile: NailProfile,
        shapeCode: string,
    ): Record<string, { number: string; arcLength: number; exact: boolean } | null> {
        const result: Record<string, ReturnType<typeof matchNailSizeAlgo>> = {};
        for (const finger of FINGER_CODES) {
            const arcLength = profile.fingerSizes[finger];
            if (arcLength && arcLength > 0) {
                result[finger] = this.matchNailSize(arcLength, shapeCode);
            } else {
                result[finger] = null;
            }
        }
        return result;
    }

    // -- 私有方法 --

    /**
     * 从请求上下文获取客户 ID，未登录则抛出错误
     */
    private getCustomerId(ctx: RequestContext): ID {
        const userId = ctx.activeUserId;
        if (!userId) {
            throw new ForbiddenError();
        }
        // Vendure 的 activeUserId 对于 Shop API 就是 Customer 对应的 User ID
        // 我们用它来关联到 Customer
        return userId;
    }

    /**
     * 校验指甲尺寸数据
     * 每个手指的弧长应在 5-25mm 范围内
     */
    private validateFingerSizes(fingerSizes: Record<string, number>): void {
        for (const [finger, size] of Object.entries(fingerSizes)) {
            if (!FINGER_CODES.includes(finger as any)) {
                throw new Error(`Invalid finger code: ${finger}`);
            }
            if (typeof size !== 'number' || size < 5 || size > 25) {
                throw new Error(`Invalid size for ${finger}: ${size}. Must be between 5 and 25 mm.`);
            }
        }
    }
}
