'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { mutate, getSession } from '@/lib/vendure/api';
import { SetSessionCurrencyCodeMutation, SwitchCustomerCountryMutation } from '@/lib/vendure/mutations';

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

export async function setCountryAndLanguage(formData: FormData) {
  const country = formData.get('country') as string;
  const language = formData.get('language') as string;

  if (!country || !language) {
    throw new Error('Country and Language are required');
  }

  const cookieStore = await cookies();

  // Set country cookie (accessible via JS to resolve channel token)
  // This is the "Hard" country that determines technical backend channel.
  cookieStore.set('country_code', country, {
    path: '/',
    httpOnly: false, // Must be false so nail-api.ts/api.ts can read it on client
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365 * 10,
    sameSite: 'lax',
  });

  // Set display country cookie (UI preference)
  // This is the "Soft" country that determines UI language and display preferences.
  cookieStore.set('display_country', country, {
    path: '/',
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365 * 10,
    sameSite: 'lax',
  });

  // Set language cookie (preference)
  cookieStore.set('language_code', language, {
    path: '/',
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365 * 10,
    sameSite: 'lax',
  });

  // --- BACK-FILL PROFILE LOGIC (USER RE-ARCHITECTURE) ---
  // If the user is already logged in, automatically save the selected country to their profile.
  try {
    const session = await getSession();
    if (session?.activeCustomer) {
      console.log(`[Welcome] Authenticated user detected. Syncing countryCode ${country} to profile...`);
      await mutate(SwitchCustomerCountryMutation, { newCountryCode: country });
    }
  } catch (err) {
    console.error('[Welcome] Failed to back-fill profile countryCode', err);
  }
  // ------------------------------------------------------------


  redirect(`/${country.toLowerCase()}`);
}
