import { CurrencyCode } from '@vendure/core';

export const COUNTRY_CURRENCY_MAP: Record<string, CurrencyCode> = {
    'DE': CurrencyCode.EUR,
    'AT': CurrencyCode.EUR,
    'FR': CurrencyCode.EUR,
    'NL': CurrencyCode.EUR,
    'ES': CurrencyCode.EUR,
    'IT': CurrencyCode.EUR,
    'US': CurrencyCode.USD,
    'GB': CurrencyCode.GBP,
    'CN': CurrencyCode.CNY,
    'HU': CurrencyCode.HUF,
    // Add more as needed
};
