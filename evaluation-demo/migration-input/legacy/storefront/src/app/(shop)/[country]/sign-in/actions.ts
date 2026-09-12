'use server';

import { mutate, query } from '@/lib/vendure/api';
import { LoginMutation, LogoutMutation, SetSessionCurrencyCodeMutation } from '@/lib/vendure/mutations';
import { GetActiveCustomerQuery } from '@/lib/vendure/queries';
import { removeAuthToken, setAuthToken } from '@/lib/auth';
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from 'next/headers';

const COUNTRY_CURRENCY_MAP: Record<string, string> = {
    'DE': 'EUR', 'AT': 'EUR', 'FR': 'EUR', 'NL': 'EUR', 'ES': 'EUR', 'IT': 'EUR',
    'US': 'USD', 'GB': 'GBP', 'CN': 'CNY', 'HU': 'HUF',
};

export async function loginAction(prevState: { error?: string } | undefined, formData: FormData) {
    const username = formData.get('username') as string;
    const password = formData.get('password') as string;
    const redirectTo = formData.get('redirectTo') as string | null;
    const currentChannelCountry = formData.get('country') as string | null;

    const result = await mutate(LoginMutation, {
        username,
        password,
    }, { useAuthToken: true });

    const loginResult = result.data.login;

    if (loginResult.__typename !== 'CurrentUser') {
        if (loginResult.__typename === 'NotVerifiedError') {
            return { error: 'Please verify your email address before signing in.' };
        }
        return { error: 'Invalid email or password.' };
    }

    // Store the token in a cookie if returned
    console.log('[Login] result.token:', result.token ? 'received' : 'MISSING');
    if (result.token) {
        await setAuthToken(result.token);
        console.log('[Login] Auth token saved to cookie successfully.');

        // Sync session currency based on user country code
        try {
            const customerResult = await query(GetActiveCustomerQuery, undefined, { token: result.token });
            const activeCustomer = customerResult.data.activeCustomer;

            console.log('[Login Debug] Full activeCustomer Object:', JSON.stringify(activeCustomer, null, 2));

            // --- UPDATED IDENTITY DETECTION (USER RE-ARCHITECTURE) ---
            const profileCountryCode = activeCustomer?.customFields?.countryCode;
            
            // Fallback to cookie if profile is empty (user might have selected in welcome page as guest)
            const cookieStore = await cookies();
            const cookieCountryCode = cookieStore.get('country_code')?.value;

            const countryCode = (profileCountryCode || cookieCountryCode)?.toUpperCase();
            // ------------------------------------------------------------
            
            console.log('[Login Debug] Final Resolved countryCode:', countryCode || 'UNDEFINED');

            if (countryCode) {
                console.log(`[Login] Synced country code to ${countryCode}`);

                // Sync the persistent welcome shield cookies
                const cookieStore = await cookies();
                const cookieOptions = {
                    path: '/',
                    httpOnly: false, // Must be false so nail-api.ts/api.ts can read it on client
                    secure: process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL?.startsWith('http://'),
                    maxAge: 60 * 60 * 24 * 365 * 10,
                    sameSite: 'lax' as const,
                };
                
                cookieStore.set('country_code', countryCode, cookieOptions);
                cookieStore.set('home_country', countryCode, cookieOptions);
                console.log(`[Login] Cookies 'country_code' and 'home_country' set to ${countryCode}`);

                // 🔴 关键修复：切换币种以对齐国家
                const currencyCode = COUNTRY_CURRENCY_MAP[countryCode] || 'EUR';
                await mutate(SetSessionCurrencyCodeMutation, { currencyCode }, { token: result.token });
                console.log(`[Login] Synced session currency to ${currencyCode}`);
            }
        } catch (err) {
            console.error('[Login] Failed to sync session currency', err);
        }
    } else {
        console.warn('[Login] No token received from Vendure. User state may not persist.');
    }

    revalidatePath('/', 'layout');

    // Validate redirectTo is a safe internal path
    const safeRedirect = redirectTo?.startsWith('/') && !redirectTo.startsWith('//')
        ? redirectTo
        : '/';

    redirect(safeRedirect);

}

export async function logoutAction() {
    await mutate(LogoutMutation);
    await removeAuthToken();

    redirect('/')
}
