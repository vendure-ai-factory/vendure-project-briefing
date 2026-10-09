'use server';

import { mutate, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { RegisterCustomerAccountMutation, SetSessionCurrencyCodeMutation } from '@/lib/vendure/mutations';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';



export async function registerAction(prevState: { error?: string } | undefined, formData: FormData) {
    const emailAddress = formData.get('emailAddress') as string;
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const phoneNumber = formData.get('phoneNumber') as string;
    const password = formData.get('password') as string;
    const countryCode = formData.get('countryCode') as string;
    const redirectTo = formData.get('redirectTo') as string | null;

    if (!emailAddress || !password || !countryCode) {
        return { error: 'Email, password, and country select are required' };
    }

    const channelToken = COUNTRY_CHANNEL_MAP[countryCode];
    if (!channelToken) {
        return { error: 'Invalid country selected' };
    }

    const result = await mutate(RegisterCustomerAccountMutation, {
        input: {
            emailAddress,
            firstName,
            lastName,
            phoneNumber: phoneNumber || undefined,
            password,
        }
    }, { channelToken });

    // Set statutory localized cookie to ensure future browsing binds to this channel
    const cookieStore = await cookies();
    cookieStore.set('country_code', countryCode, {
        httpOnly: false, // Frontend might need to read it
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365, // 1 year
    });

    const registerResult = result.data.registerCustomerAccount;

    if (registerResult.__typename !== 'Success') {
        return { error: (registerResult as any).message || 'Registration failed' };
    }

    // Redirect to verification pending page, preserving redirectTo if present
    const verifyUrl = redirectTo
        ? `/verify-pending?redirectTo=${encodeURIComponent(redirectTo)}`
        : '/verify-pending';

    redirect(verifyUrl);
}
