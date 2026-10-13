'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { mutate } from '@/lib/vendure/api';
import { UpdateCustomerMutation, RequestUpdateCustomerEmailAddressMutation, UpdateCustomerPasswordMutation } from '@/lib/vendure/mutations';
import { getActiveCustomer } from '@/lib/vendure/actions';

export async function updatePreferences(formData: FormData) {
    const country = formData.get('country') as string;
    const language = formData.get('language') as string;

    if (!country || !language) {
        return { error: 'Country and Language are required' };
    }

    const customer = await getActiveCustomer().catch(() => null);
    if (!customer) {
        return { error: 'You must be logged in to update preferences' };
    }

    const lastSwitch = (customer.customFields as any)?.lastCountrySwitchAt;
    const currentCountry = (customer.customFields as any)?.countryCode;

    // --- 30-Second Cooldown Check (Shortened for testing) ---
    if (currentCountry && currentCountry !== country && lastSwitch) {
        const lastSwitchDate = new Date(lastSwitch);
        const now = new Date();
        const diffSeconds = Math.ceil((now.getTime() - lastSwitchDate.getTime()) / 1000);

        if (diffSeconds < 30) {
            return {
                error: `You can only change your default country once every 30 seconds. Please wait ${30 - diffSeconds} more seconds.`
            };
        }
    }

    try {
        console.log(`[UpdatePreferences] Starting: country=${country}, language=${language}`);

        // 1. ⚡️ 执行国家切换及余额汇率对冲
        const { SwitchCustomerCountryMutation } = await import('@/lib/vendure/mutations');
        const switchResult = await mutate(SwitchCustomerCountryMutation, { 
            newCountryCode: country 
        }, { useAuthToken: true });
        
        console.log(`[UpdatePreferences] switchResult:`, JSON.stringify(switchResult));

        const result = switchResult.data?.switchCustomerCountry;
        if (!result || !result.success) {
            console.error(`[UpdatePreferences] Mutation unsuccessful:`, result?.message);
            return { error: result?.message || 'Failed to switch country' };
        }

        // 2. 🔴 同步 Session 币种 (Synced via cookie + channel token in api.ts)
        // No longer need SetSessionCurrencyCodeMutation as it is redundant and causing 400 error on some backends.

        // 4. Update cookies
        const cookieStore = await cookies();

        cookieStore.set('country_code', country, {
            path: '/',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 365 * 10,
            sameSite: 'lax',
        });

        cookieStore.set('display_country', country, {
            path: '/',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 365 * 10,
            sameSite: 'lax',
        });

        cookieStore.set('language_code', language, {
            path: '/',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 365 * 10,
            sameSite: 'lax',
        });

        console.log(`[UpdatePreferences] Revalidating paths...`);
        revalidatePath('/account/profile');
        revalidatePath('/');
        
        return { success: true };
    } catch (error: any) {
        console.error('[UpdatePreferences] Unexpected Error:', error);
        return { error: error.message || 'An unexpected error occurred' };
    }
}

export async function updateCustomerAction(prevState: any, formData: FormData) {
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;

    try {
        await mutate(UpdateCustomerMutation, {
            input: {
                firstName,
                lastName,
            },
        }, { useAuthToken: true });

        revalidatePath('/account/profile');
        return { success: true };
    } catch (error: any) {
        return { error: error.message };
    }
}

export async function requestEmailUpdateAction(prevState: any, formData: FormData) {
    const newEmailAddress = formData.get('newEmailAddress') as string;
    const password = formData.get('password') as string;

    try {
        const { data } = await mutate(RequestUpdateCustomerEmailAddressMutation, {
            newEmailAddress,
            password,
        }, { useAuthToken: true });

        const result = data.requestUpdateCustomerEmailAddress;
        if (result.__typename === 'Success') {
            return { success: true };
        } else {
            return { error: (result as any).message || 'Failed to request email update' };
        }
    } catch (error: any) {
        return { error: error.message };
    }
}

export async function updatePasswordAction(prevState: any, formData: FormData) {
    const currentPassword = formData.get('currentPassword') as string;
    const newPassword = formData.get('newPassword') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (newPassword !== confirmPassword) {
        return { error: 'Passwords do not match' };
    }

    try {
        const { data } = await mutate(UpdateCustomerPasswordMutation, {
            currentPassword,
            newPassword,
        }, { useAuthToken: true });

        const result = data.updateCustomerPassword;
        if (result.__typename === 'Success') {
            return { success: true };
        } else {
            return { error: (result as any).message || 'Failed to update password' };
        }
    } catch (error: any) {
        return { error: error.message };
    }
}
