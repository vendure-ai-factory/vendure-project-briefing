/**
 * 穿戴甲定制 API 客户端
 * 
 * 由于 NailProfile 是自定义类型（不在 gql.tada 自动生成的 schema 中），
 * 这里使用原始 GraphQL 请求来调用 NailCustomizationPlugin 的 API。
 */

// Auth is imported dynamically inside nailApiRequest to avoid build-time next/headers errors in client components

const VENDURE_API_URL = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL || 'http://127.0.0.1:54321/shop-api';
const VENDURE_CHANNEL_TOKEN = process.env.VENDURE_CHANNEL_TOKEN || process.env.NEXT_PUBLIC_VENDURE_CHANNEL_TOKEN || 'germany-channel';

async function nailApiRequest(query: string, variables?: Record<string, unknown>) {
    const V_API_URL = VENDURE_API_URL!;
    
    // Resolve Auth Token
    let authToken: string | undefined;
    if (typeof window === 'undefined') {
        const { getAuthToken } = await import('@/lib/auth');
        authToken = await getAuthToken();
    } else {
        const { getAuthTokenClient } = await import('@/lib/auth-client');
        authToken = getAuthTokenClient();
    }

    // Resolve Current Channel Token (for context-aware pricing/data)
    let channelToken: string | undefined;
    if (typeof window === 'undefined') {
        try {
            const { cookies } = await import('next/headers');
            const cookieStore = await cookies();
            channelToken = cookieStore.get('vendure_channel_token')?.value;
            if (!channelToken) {
                const countryCode = cookieStore.get('country_code')?.value;
                if (countryCode) {
                    const { COUNTRY_CHANNEL_MAP } = await import('./api');
                    channelToken = COUNTRY_CHANNEL_MAP[countryCode.toUpperCase()];
                }
            }
        } catch (e) {}
    } else {
        const tokenMatch = document.cookie.match(/vendure_channel_token=([^;]+)/);
        channelToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : undefined;
        if (!channelToken) {
            const countryMatch = document.cookie.match(/country_code=([^;]+)/);
            const countryCode = countryMatch ? decodeURIComponent(countryMatch[1]) : null;
            if (countryCode) {
                const { COUNTRY_CHANNEL_MAP } = await import('./api');
                channelToken = COUNTRY_CHANNEL_MAP[countryCode.toUpperCase()];
            }
        }
    }

    const currentChannelToken = channelToken || VENDURE_CHANNEL_TOKEN;

    const makeRequest = async (token: string) => {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'vendure-token': token,
        };
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            headers['vendure-auth-token'] = authToken;
        }
        
        console.log(`[DEBUG-NAIL] [${new Date().toISOString()}] nailApiRequest calling fetch: url=${V_API_URL}, channel=${token}`);
        
        try {
            const res = await fetch(V_API_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query, variables }),
                cache: 'no-store',
                credentials: 'include',
            });

            console.log(`[DEBUG-NAIL] [${new Date().toISOString()}] nailApiRequest fetch response: status=${res.status}`);

            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }

            // 捕获并持久化 Auth Token (用于访客 Session 持久化)
            const newToken = res.headers.get('vendure-auth-token');
            if (newToken && newToken !== authToken) {
                console.log(`[nailApiRequest] New auth token detected, persisting...`);
                if (typeof window === 'undefined') {
                    try {
                        const { setAuthToken } = await import('@/lib/auth');
                        await setAuthToken(newToken);
                    } catch (e) {
                        console.warn('[nailApiRequest] Failed to set cookie on server, possibly in render phase:', e);
                    }
                } else {
                    try {
                        const { AUTH_TOKEN_COOKIE } = await import('@/lib/auth-shared');
                        document.cookie = `${AUTH_TOKEN_COOKIE}=${newToken}; path=/; samesite=lax`;
                    } catch (e) {
                        console.error('[nailApiRequest] Failed to set cookie on client:', e);
                    }
                }
            }

            const result: any = await res.json();
            if (result.errors) {
                console.error(`[DEBUG-NAIL] [${new Date().toISOString()}] nailApiRequest Vendure ERRORS: ${JSON.stringify(result.errors)}`);
                throw new Error(result.errors.map((e: any) => e.message).join(', '));
            }

            return result.data;
        } catch (e) {
            console.error(`[DEBUG-NAIL] [${new Date().toISOString()}] nailApiRequest fetch FATAL: ${e instanceof Error ? e.message : e}`);
            throw e;
        }
    };

    return await makeRequest(currentChannelToken);
}




// ==== 类型定义 ====

export interface NailProfile {
    id: string;
    profileName: string;
    fingerSizes: Record<string, number>;
    createdAt: string;
    updatedAt: string;
}

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

export interface NailSizeMatch {
    number: string;
    arcLength: number;
    chordLength?: number;
    exact: boolean;
}

// ==== 查询操作 ====

/** 获取当前用户的所有指甲档案 */
export async function fetchNailProfiles(): Promise<NailProfile[]> {
    try {
        const data = await nailApiRequest(`
            query {
                myNailProfiles {
                    id
                    profileName
                    fingerSizes
                    createdAt
                    updatedAt
                }
            }
        `);
        return data.myNailProfiles ?? [];
    } catch (error: any) {
        if (error.message?.includes('authorized') || error.message?.includes('FORBIDDEN')) {
            return [];
        }
        console.error('Failed to fetch nail profiles:', error);
        return [];
    }
}

/** 获取所有甲型信息 */
export async function fetchAllNailShapes(): Promise<NailShapeInfo[]> {
    const data = await nailApiRequest(`
        query {
            allNailShapes {
                code
                nameZh
                nameDe
                sizes {
                    index
                    number
                    arcLength
                    chordLength
                }
            }
        }
    `);
    return data.allNailShapes ?? [];
}

/** 匹配甲片尺寸 */
export async function fetchMatchNailSize(arcLength: number, shapeCode: string): Promise<NailSizeMatch | null> {
    const data = await nailApiRequest(`
        query MatchNailSize($arcLength: Float!, $shapeCode: String!) {
            matchNailSize(arcLength: $arcLength, shapeCode: $shapeCode) {
                number
                arcLength
                chordLength
                exact
            }
        }
    `, { arcLength, shapeCode });
    return data.matchNailSize;
}

// ==== 变更操作 ====

/** 创建指甲档案 */
export async function createNailProfile(
    profileName: string,
    fingerSizes: Record<string, number>,
): Promise<NailProfile> {
    const data = await nailApiRequest(`
        mutation CreateNailProfile($input: CreateNailProfileInput!) {
            createNailProfile(input: $input) {
                id
                profileName
                fingerSizes
                createdAt
                updatedAt
            }
        }
    `, { input: { profileName, fingerSizes } });
    return data.createNailProfile;
}

/** 更新指甲档案 */
export async function updateNailProfile(
    id: string,
    input: { profileName?: string; fingerSizes?: Record<string, number> },
): Promise<NailProfile> {
    const data = await nailApiRequest(`
        mutation UpdateNailProfile($id: ID!, $input: UpdateNailProfileInput!) {
            updateNailProfile(id: $id, input: $input) {
                id
                profileName
                fingerSizes
                createdAt
                updatedAt
            }
        }
    `, { id, input });
    return data.updateNailProfile;
}

/** 删除指甲档案 */
export async function deleteNailProfile(id: string): Promise<{ result: string }> {
    const data = await nailApiRequest(`
        mutation DeleteNailProfile($id: ID!) {
            deleteNailProfile(id: $id) {
                result
                message
            }
        }
    `, { id });
    return data.deleteNailProfile;
}
