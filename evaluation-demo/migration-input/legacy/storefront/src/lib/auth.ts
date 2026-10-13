import { AUTH_TOKEN_COOKIE } from './auth-shared';

export async function setAuthToken(token: string) {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    cookieStore.set(AUTH_TOKEN_COOKIE, token, {
        path: '/',
        httpOnly: false, // 允许客户端 JS 读取以用于发布设计
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL?.startsWith('http://'),
    });
}

export async function getAuthToken(): Promise<string | undefined> {
    try {
        if (typeof window === 'undefined') {
            try {
                const { cookies } = await import('next/headers');
                const cookieStore = await cookies();
                return cookieStore.get(AUTH_TOKEN_COOKIE)?.value;
            } catch (e) {
                // Ignore error when called inside Next.js 15 'use cache' or other restricted contexts
                return undefined;
            }
        }
        return undefined;
    } catch {
        return undefined; // Fallback for when called in a context where cookies() is not available
    }
}

export async function removeAuthToken() {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    cookieStore.delete(AUTH_TOKEN_COOKIE);
}
