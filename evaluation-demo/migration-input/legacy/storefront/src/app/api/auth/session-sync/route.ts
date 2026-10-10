import { NextResponse } from 'next/server';
import { getActiveCustomer } from '@/lib/vendure/actions';

/**
 * API 路由：用于同步会话状态到 Cookie
 * 
 * 当客户端发现 country_code 丢失时，调用此接口。
 * 它会检查当前已登录用户的国家，并回写 Cookie。
 */
export async function GET() {
    try {
        const customer = await getActiveCustomer();
        // 强制转换为 string 避免 lint 错误
        const countryCode = (customer?.customFields as any)?.countryCode as string | undefined;
        
        if (countryCode && typeof countryCode === 'string') {
            const response = NextResponse.json({ countryCode });
            
            // 回写 Cookie
            response.cookies.set('country_code', countryCode, {
                path: '/',
                maxAge: 60 * 60 * 24 * 365, // 1 year
                httpOnly: false,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
            });
            
            return response;
        }
    } catch (e) {
        // 可能未登录
        return NextResponse.json({ countryCode: null, error: 'Not logged in' }, { status: 401 });
    }
    
    return NextResponse.json({ countryCode: null });
}
