import { DeepPartial, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, JoinColumn } from 'typeorm';

/**
 * 指甲尺寸档案实体 (Nail Profile Entity)
 * 
 * 用于存储客户的指甲尺寸信息。
 * 一个客户可以有多套档案（如"我的指甲"、"女儿的指甲"）。
 */
@Entity()
export class NailProfile extends VendureEntity {
    constructor(input?: DeepPartial<NailProfile>) {
        super(input);
    }

    /** 关联的客户 ID */
    @Column({ type: 'varchar' })
    customerId: ID;

    /** 档案名称（如"我的指甲"、"女儿的指甲"） */
    @Column({ default: '' })
    profileName: string;

    /**
     * 10 个手指的弧长值 (mm)，存为 JSON
     * 
     * 格式：
     * {
     *   "leftThumb": 15.0, "leftIndex": 12.5, "leftMiddle": 13.0,
     *   "leftRing": 11.5, "leftPinky": 10.0,
     *   "rightThumb": 15.2, "rightIndex": 12.8, "rightMiddle": 13.2,
     *   "rightRing": 11.8, "rightPinky": 10.2
     * }
     */
    @Column('simple-json', { default: '{}' })
    fingerSizes: Record<string, number>;
}
