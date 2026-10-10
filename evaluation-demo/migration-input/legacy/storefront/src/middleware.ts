import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // 1. Exclude static assets, API routes, and Next.js internals
    if (
        pathname.startsWith('/_next') ||
        pathname.startsWith('/api') ||
        pathname.startsWith('/static') ||
        pathname.includes('.') // Exclude files like favicon.ico, .png, etc.
    ) {
        return NextResponse.next();
    }

    // 2. Check for country in URL path (e.g., /at/product/...)
    const segments = pathname.split('/');
    const countryInPath = segments[1]?.toLowerCase();
    
    // Valid country codes supported by our mapping
    const validCountries = ['de', 'at', 'hu', 'nl', 'fr', 'es', 'it'];
    const isPathLocalized = validCountries.includes(countryInPath);

    // 获取 Cookie 状态
    // home_country: 用户物理归属地（身份锁定）
    // country_code: 当前查看的分站（显示切换）
    const homeCountry = request.cookies.get('home_country')?.value?.toLowerCase();
    const currentViewCountry = request.cookies.get('country_code')?.value?.toLowerCase();

    // 3. Logic for /welcome page
    if (pathname === '/welcome') {
        const targetCountry = currentViewCountry || homeCountry;
        if (targetCountry && validCountries.includes(targetCountry)) {
            const url = new URL(`/${targetCountry}`, request.url);
            url.search = request.nextUrl.search;
            return NextResponse.redirect(url);
        }
        return NextResponse.next();
    }

    // 4. 处理设计师后台路由 (/vendor)
    // 强制根据身份或当前前缀补全，避免 404
    if (pathname.includes('/vendor')) {
        if (isPathLocalized) {
             return NextResponse.next();
        }
        const target = homeCountry || currentViewCountry || 'de';
        const url = new URL(`/${target}${pathname}`, request.url);
        url.search = request.nextUrl.search;
        return NextResponse.redirect(url);
    }

    // 5. If path is NOT localized, redirect to localized version
    if (!isPathLocalized) {
        const target = currentViewCountry || homeCountry;
        if (target && validCountries.includes(target)) {
            const localizedPath = `/${target}${pathname === '/' ? '' : pathname}`;
            const url = new URL(localizedPath, request.url);
            url.search = request.nextUrl.search;
            return NextResponse.redirect(url);
        } else {
            const url = new URL('/welcome', request.url);
            url.search = request.nextUrl.search;
            return NextResponse.redirect(url);
        }
    }

    // 6. If path is localized, ensure Cookie is updated to match path (for session continuity)
    // IMPORTANT: Only update if there is NO mismatch with the home_country identity
    const response = NextResponse.next();
    if (isPathLocalized) {
        const currentCookie = request.cookies.get('country_code')?.value?.toUpperCase();
        
        // Handshake protection: If user has a home_country and it doesn't match the path, 
        // we DON'T update the country_code cookie yet (stay in "Visitor" and Trigger Handshake).
        const existingIdentity = homeCountry || currentViewCountry; 
        const isMismatchedVisitor = existingIdentity && countryInPath.toLowerCase() !== existingIdentity.toLowerCase();

        if (currentCookie !== countryInPath.toUpperCase() && !isMismatchedVisitor) {
            response.cookies.set('country_code', countryInPath.toUpperCase(), {
                path: '/',
                maxAge: 31536000, // 1 year
                sameSite: 'lax',
            });
        }
    }

    return response;
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api (API routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         */
        '/((?!api|_next/static|_next/image|favicon.ico).*)',
    ],
};
