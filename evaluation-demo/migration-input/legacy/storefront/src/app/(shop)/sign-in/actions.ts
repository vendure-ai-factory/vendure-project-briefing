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

            // @ts-ignore - customFields might not be typed yet
            const countryCode = activeCustomer?.customFields?.countryCode;

            if (countryCode) {
                console.log(`[Login] Synced country code to ${countryCode}`);

                // Sync the persistent welcome shield cookie as well
                const cookieStore = await cookies();
                cookieStore.set('country_code', countryCode, {
                    path: '/',
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    maxAge: 60 * 60 * 24 * 365 * 10,
                    sameSite: 'lax',
                });
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
