'use server';

import { mutate } from '@/lib/vendure/api';
import { RegisterCustomerAccountMutation, SetSessionCurrencyCodeMutation } from '@/lib/vendure/mutations';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

const COUNTRY_CURRENCY_MAP: Record<string, string> = {
    'DE': 'EUR',
    'AT': 'EUR',
    'FR': 'EUR',
    'NL': 'EUR',
    'ES': 'EUR',
    'IT': 'EUR',
    'US': 'USD',
    'GB': 'GBP',
    'CN': 'CNY',
    'HU': 'HUF',
};

export async function registerAction(prevState: { error?: string } | undefined, formData: FormData) {
    const emailAddress = formData.get('emailAddress') as string;
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const phoneNumber = formData.get('phoneNumber') as string;
    const password = formData.get('password') as string;
    const countryCode = formData.get('countryCode') as string;
    const redirectTo = formData.get('redirectTo') as string | null;

    if (!emailAddress || !password) {
        return { error: 'Email address and password are required' };
    }

    const result = await mutate(RegisterCustomerAccountMutation, {
        input: {
            emailAddress,
            firstName,
            lastName,
            phoneNumber: phoneNumber || undefined,
            password,
            // @ts-ignore - customFields might not be typed yet without codegen
            customFields: {
                countryCode,
            },
        }
    });

    const registerResult = result.data.registerCustomerAccount;

    if (registerResult.__typename !== 'Success') {
        return { error: (registerResult as any).message || 'Registration failed' };
    }

    // Lock in statutory currency for the new session
    if (countryCode) {

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

    // Redirect to verification pending page, preserving redirectTo if present
    const verifyUrl = redirectTo
        ? `/verify-pending?redirectTo=${encodeURIComponent(redirectTo)}`
        : '/verify-pending';

    redirect(verifyUrl);
}
