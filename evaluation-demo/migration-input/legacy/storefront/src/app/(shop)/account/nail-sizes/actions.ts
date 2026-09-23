'use server';

import {
    fetchNailProfiles,
    createNailProfile,
    updateNailProfile,
    deleteNailProfile,
    fetchAllNailShapes,
    fetchMatchNailSize,
} from '@/lib/vendure/nail-api';

/**
 * 获取用户的所有指甲档案
 */
export async function getNailProfiles() {
    try {
        const profiles = await fetchNailProfiles();
        return { success: true, profiles };
    } catch (error: any) {
        return { success: false, error: error.message, profiles: [] };
    }
}

/**
 * 获取所有甲型信息
 */
export async function getAllNailShapes() {
    try {
        const shapes = await fetchAllNailShapes();
        return { success: true, shapes };
    } catch (error: any) {
        return { success: false, error: error.message, shapes: [] };
    }
}

/**
 * 创建指甲档案
 */
export async function createProfile(profileName: string, fingerSizes: Record<string, number>) {
    try {
        const profile = await createNailProfile(profileName, fingerSizes);
        return { success: true, profile };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

/**
 * 更新指甲档案
 */
export async function updateProfile(
    id: string,
    input: { profileName?: string; fingerSizes?: Record<string, number> },
) {
    try {
        const profile = await updateNailProfile(id, input);
        return { success: true, profile };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

/**
 * 删除指甲档案
 */
export async function deleteProfile(id: string) {
    try {
        const result = await deleteNailProfile(id);
        return { success: true, result: result.result };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

/**
 * 批量匹配所有手指的甲片型号
 */
export async function matchFingerSizes(fingerSizes: Record<string, number>, shapeCode: string) {
    try {
        const results: Record<string, any> = {};
        for (const [finger, arcLength] of Object.entries(fingerSizes)) {
            if (arcLength && arcLength > 0) {
                results[finger] = await fetchMatchNailSize(arcLength, shapeCode);
            }
        }
        return { success: true, results };
    } catch (error: any) {
        return { success: false, error: error.message, results: {} };
    }
}
