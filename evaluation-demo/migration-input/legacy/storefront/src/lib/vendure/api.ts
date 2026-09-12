import type { TadaDocumentNode } from 'gql.tada';
import { graphql } from '@/graphql';
import { print } from 'graphql';

let VENDURE_API_URL = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL || 'http://127.0.0.1:54321/shop-api';

// [Handshake Fix] If on client-side and VENDURE_API_URL is 127.0.0.1, try to use the current hostname to avoid CORS/Security issues
if (typeof window !== 'undefined' && VENDURE_API_URL.includes('127.0.0.1') && window.location.hostname !== '127.0.0.1') {
    VENDURE_API_URL = VENDURE_API_URL.replace('127.0.0.1', window.location.hostname);
}

const VENDURE_CHANNEL_TOKEN = process.env.VENDURE_CHANNEL_TOKEN || process.env.NEXT_PUBLIC_VENDURE_CHANNEL_TOKEN || 'germany-channel';
const VENDURE_AUTH_TOKEN_HEADER = process.env.VENDURE_AUTH_TOKEN_HEADER || 'vendure-auth-token';
const VENDURE_CHANNEL_TOKEN_HEADER = process.env.VENDURE_CHANNEL_TOKEN_HEADER || 'vendure-token';

export const COUNTRY_CHANNEL_MAP: Record<string, string> = {
    'DE': 'germany-channel',
    'AT': 'austria-channel',
    'HU': 'hungary-channel',
    'NL': 'netherlands-channel',
    'FR': 'france-channel',
    'ES': 'spain-channel',
    'IT': 'italy-channel',
    'de': 'germany-channel',
    'at': 'austria-channel',
    'hu': 'hungary-channel',
    'nl': 'netherlands-channel',
    'fr': 'france-channel',
    'es': 'spain-channel',
    'it': 'italy-channel',
    'Germany': 'germany-channel',
    'Austria': 'austria-channel',
    'Hungary': 'hungary-channel',
    'Netherlands': 'netherlands-channel',
    'France': 'france-channel',
    'Spain': 'spain-channel',
    'Italy': 'italy-channel',
};

export const AVAILABLE_COUNTRIES_QUERY = graphql(`
    query GetAvailableCountries {
        affiliateAvailableCountries
    }
`);

export const AVAILABLE_COUNTRIES = [
    { code: 'DE', name: 'Germany', flag: '🇩🇪', currency: 'EUR' },
    { code: 'AT', name: 'Austria', flag: '🇦🇹', currency: 'EUR' },
    { code: 'HU', name: 'Hungary', flag: '🇭🇺', currency: 'HUF' },
    { code: 'NL', name: 'Netherlands', flag: '🇳🇱', currency: 'EUR' },
    { code: 'FR', name: 'France', flag: '🇫🇷', currency: 'EUR' },
    { code: 'ES', name: 'Spain', flag: '🇪🇸', currency: 'EUR' },
    { code: 'IT', name: 'Italy', flag: '🇮🇹', currency: 'EUR' },
];


/**
 * [Consistency Guard 2.0] Centralized Exchange Rates
 * Based on project requirements where EUR:HUF is roughly 1:4 (at integer level)
 */
export const EXCHANGE_RATES: Record<string, number> = {
    'EUR_HUF': 4,
    'HUF_EUR': 0.25,
};

/**
 * Get exchange rate between two currencies
 */
export function getExchangeRate(from: string, to: string): number {
    if (from === to) return 1;
    const key = `${from.toUpperCase()}_${to.toUpperCase()}`;
    return EXCHANGE_RATES[key] || 1;
}

/**
 * Convert currency using centralized rates
 */
export function convertCurrency(amount: number, from: string, to: string): number {
    const rate = getExchangeRate(from, to);
    return Math.round(amount * rate);
}

/**
 * Strictly derive the channel token from a country code (HUF/DE/AT/etc.)
 * This is a pure function that does NOT rely on cookies or dynamic state.
 */
export function getStrictChannelToken(countryCode: string | undefined): string | null {
    if (!countryCode) return null;
    return COUNTRY_CHANNEL_MAP[countryCode.toUpperCase()] || COUNTRY_CHANNEL_MAP[countryCode.toLowerCase()] || null;
}




interface VendureRequestOptions {
    token?: string;
    useAuthToken?: boolean;
    channelToken?: string;
    countryCode?: string;
    fetch?: RequestInit;
    tags?: string[];
    suppressDynamics?: boolean; // 新增：禁止访问动态数据（如 cookies），用于 'use cache' 环境
    traceId?: string; // [LTS] Unique ID for full-stack tracking
}

interface VendureResponse<T> {
    data?: T;
    errors?: Array<{ message: string; [key: string]: unknown }>;
}

import { lts } from '@/lib/tracking-manager';

/**
 * [Diagnostic] Global switch to enable full-trace logging for all requests
 */
const ENABLE_GLOBAL_TRACE = process.env.NEXT_PUBLIC_DEBUG_TRACE === 'true';

/**
 * Extract the Vendure auth token from response headers
 */
function extractAuthToken(headers: Headers): string | null {
    return headers.get(VENDURE_AUTH_TOKEN_HEADER);
}


/**
 * Execute a GraphQL query against the Vendure API
 */
export async function query<TResult, TVariables>(
    gqlDocument: TadaDocumentNode<TResult, TVariables>,
    ...[variables, options]: TVariables extends Record<string, never>
        ? [variables?: TVariables, options?: VendureRequestOptions]
        : [variables: TVariables, options?: VendureRequestOptions]
): Promise<{ data: TResult; token?: string }> {
    const {
        token,
        useAuthToken,
        channelToken,
        fetch: fetchOptions,
        tags,
        suppressDynamics = false,
        traceId,
    } = options || {};

    const finalTraceId = traceId || (ENABLE_GLOBAL_TRACE ? lts.startTrace() : undefined);

    if (finalTraceId) {
        lts.checkpoint('API', 'Query Request', {
            channelToken,
            variables,
            traceId: finalTraceId
        });
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(fetchOptions?.headers as Record<string, string>),
    };

    if (finalTraceId) {
        headers['x-trace-id'] = finalTraceId;
    }

    // Use the explicitly provided token, or fetch from cookies if useAuthToken is true
    let authToken = token;
    if (useAuthToken && !authToken && !suppressDynamics) {
        if (typeof window === 'undefined') {
            const { getAuthToken } = await import('@/lib/auth');
            authToken = await getAuthToken();
        } else {
            const { getAuthTokenClient } = await import('@/lib/auth-client');
            authToken = getAuthTokenClient();
        }
    }

    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
        headers[VENDURE_AUTH_TOKEN_HEADER] = authToken;
    }

    // Set the channel token header (use provided channelToken or default)
    let finalChannelToken = channelToken;

    // Consistency Guard: If channelToken is not provided, try to derive it strictly from path
    // in a way that ignores the 'vendure_channel_token' cookie if possible.
    if (!finalChannelToken && !suppressDynamics) {
        if (typeof window === 'undefined') {
            try {
                const { cookies, headers } = await import('next/headers');
                const cookieStore = await cookies();
                const headersList = await headers();

                // 1. Priority: URL Path-based detection (Server Side)
                // We extract the country from the current URL path segments
                // Use x-invoke-path (internal) or referer
                const pathname = headersList.get('x-invoke-path') || ''; 
                const referer = headersList.get('referer') || '';
                if (pathname || referer) {
                    console.log(`[API] DEBUG: x-invoke-path="${pathname}", referer="${referer}"`);
                }
                
                const validCountries = ['de', 'at', 'hu', 'nl', 'fr', 'es', 'it'];
                let countryFromPath: string | undefined;

                if (pathname) {
                    const segments = pathname.split('/');
                    countryFromPath = segments[1]?.toLowerCase();
                } else if (referer) {
                    try {
                        const url = new URL(referer);
                        const segments = url.pathname.split('/');
                        countryFromPath = segments[1]?.toLowerCase();
                    } catch (e) {
                         // Ignore invalid referer URL
                    }
                }

                if (countryFromPath && validCountries.includes(countryFromPath)) {
                    finalChannelToken = COUNTRY_CHANNEL_MAP[countryFromPath];
                    if (finalChannelToken) console.log(`[API] Derived channel from path segment "${countryFromPath}": ${finalChannelToken}`);
                }

                // 2. Fallback: Explicitly set channel token cookie
                if (!finalChannelToken) {
                    finalChannelToken = cookieStore.get('vendure_channel_token')?.value;
                }

                // 3. Fallback: Resolve via country_code cookie
                if (!finalChannelToken) {
                    const countryCode = cookieStore.get('country_code')?.value;
                    if (countryCode) {
                        const normalizedCode = countryCode.toUpperCase();
                        finalChannelToken = COUNTRY_CHANNEL_MAP[normalizedCode];
                    }
                }
            } catch (e) {
                // Ignore dynamic access errors
            }
        } else {
            // Client-side: Read from URL first, then document.cookie
            try {
                const pathname = window.location.pathname;
                const segments = pathname.split('/');
                const countryFromPath = segments[1]?.toLowerCase();
                const validCountries = ['de', 'at', 'hu', 'nl', 'fr', 'es', 'it'];

                if (countryFromPath && validCountries.includes(countryFromPath)) {
                    finalChannelToken = COUNTRY_CHANNEL_MAP[countryFromPath];
                }

                if (!finalChannelToken) {
                    const tokenMatch = document.cookie.match(/vendure_channel_token=([^;]+)/);
                    finalChannelToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : undefined;
                }

                if (!finalChannelToken) {
                    const countryMatch = document.cookie.match(/country_code=([^;]+)/);
                    const countryCode = countryMatch ? decodeURIComponent(countryMatch[1]) : null;
                    if (countryCode) {
                        const normalizedCode = countryCode.toUpperCase();
                        finalChannelToken = COUNTRY_CHANNEL_MAP[normalizedCode];
                    }
                }
            } catch (e) {}
        }
    }

    // Fallback to default channel
    if (!finalChannelToken) {
        console.log(`[API] WARNING: Could not derive channel from path or cookies. Falling back to default: ${VENDURE_CHANNEL_TOKEN}`);
        finalChannelToken = VENDURE_CHANNEL_TOKEN;
    }

    headers[VENDURE_CHANNEL_TOKEN_HEADER] = finalChannelToken;

    const apiUrl = VENDURE_API_URL!;
    console.log(`[DEBUG-API] query calling fetch: url=${apiUrl}, channel=${finalChannelToken}`);

    const body = JSON.stringify({
        query: print(gqlDocument),
        variables: variables || {},
    });

    try {
        console.log(`[DEBUG-API] Request Headers:`, JSON.stringify(headers));
        console.log(`[DEBUG-API] Request Body:`, body);

        const response = await fetch(apiUrl, {
            ...fetchOptions,
            method: 'POST',
            headers,
            body,
            ...(tags && { next: { tags } }),
        });

        console.log(`[DEBUG-API] query fetch response: status=${response.status}`);
        console.log(`[DEBUG-API] Response Headers:`, Array.from(response.headers.entries()).map(([k, v]) => `${k}=${v}`).join(', '));

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`[DEBUG-API] [${new Date().toISOString()}] query fetch FAILED (status ${response.status}):`, errorBody);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result: VendureResponse<TResult> = await response.json();

        // [DEBUG-MONITOR] Track specific order values to diagnose shipping discrepancies
        if (result.data && (result.data as any).activeOrder) {
            const ao = (result.data as any).activeOrder;
            if (ao.shippingWithTax !== undefined || ao.totalWithTax !== undefined) {
                console.log(`[DEBUG-PAYLOAD] [${new Date().toISOString()}] Order ${ao.code || 'ACTIVE'}: Shipping=${ao.shippingWithTax}, Total=${ao.totalWithTax}, Currency=${ao.currencyCode}`);
            }
        }

        if (result.errors) {
            const isForbidden = result.errors.some(e => (e.extensions as any)?.code === 'FORBIDDEN');
            if (isForbidden) {
                console.warn(`[DEBUG-API] [${new Date().toISOString()}] Vendure Access Denied (FORBIDDEN). User is likely not authenticated for this specific resource.`);
            } else {
                console.error(`[DEBUG-API] [${new Date().toISOString()}] query Vendure ERRORS: ${JSON.stringify(result.errors)}`);
            }
            throw new Error(result.errors.map(e => e.message).join(', '));
        }

        if (!result.data) {
            throw new Error('No data returned from Vendure API');
        }

        const newToken = extractAuthToken(response.headers);

        if (newToken && typeof document !== 'undefined') {
            // [Handshake Fix] Prevent anonymous tokens from overwriting the authenticated token if on a non-home channel
            const homeCountryMatch = document.cookie.match(/home_country=([^;]+)/);
            const homeCountry = homeCountryMatch ? decodeURIComponent(homeCountryMatch[1]).toUpperCase() : null;
            const homeChannelToken = homeCountry ? COUNTRY_CHANNEL_MAP[homeCountry] : null;

            const isHandshake = print(gqlDocument).includes('setActiveChannel');
            
            let shouldBlockUpdate = false;
            if (homeChannelToken && finalChannelToken !== homeChannelToken && !isHandshake) {
                shouldBlockUpdate = true;
            }

            if (!shouldBlockUpdate) {
                document.cookie = `vendure-auth-token=${newToken}; path=/; max-age=31536000; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
            }
        }

        return {
            data: result.data,
            ...(newToken && { token: newToken }),
        };
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        const isAuthError = errorMessage.includes('authorized') || errorMessage.includes('FORBIDDEN');
        
        if (e instanceof Error && e.name === "AbortError") {
            console.warn("[DEBUG-API] Fetch aborted (normal during navigation)");
        } else if (isAuthError) {
            console.warn(`[DEBUG-API] query fetch AUTH-WARN: ${errorMessage}`);
        } else {
            console.error(`[DEBUG-API] query fetch FATAL: ${errorMessage}`);
        }
        throw e;
    }
}

/**
 * Execute a GraphQL mutation against the Vendure API
 */
export async function mutate<TResult, TVariables>(
    document: TadaDocumentNode<TResult, TVariables>,
    ...[variables, options]: TVariables extends Record<string, never>
        ? [variables?: TVariables, options?: VendureRequestOptions]
        : [variables: TVariables, options?: VendureRequestOptions]
): Promise<{ data: TResult; token?: string }> {
    // Mutations use the same underlying implementation as queries in GraphQL
    // @ts-expect-error - Complex conditional type inference
    return query(document, variables, options);
}

/**
 * Get the current active session information
 */
export async function getSession(options?: VendureRequestOptions) {
    const GET_SESSION = graphql(`
        query GetSession {
            activeCustomer {
                id
                emailAddress
                firstName
                lastName
                customFields {
                    countryCode
                }
            }
            activeChannel {
                id
                token
                code
            }
            activeSessionChannelToken
        }
    `);

    try {
        const { data } = await query(GET_SESSION, {}, { ...options, useAuthToken: true });
        return data;
    } catch (e) {
        return null;
    }
}

export async function updateActiveChannel(channelToken: string, authToken?: string) {
    const SET_ACTIVE_CHANNEL = graphql(`
        mutation SetActiveChannel($channelToken: String!, $authToken: String) {
            setActiveChannel(channelToken: $channelToken, authToken: $authToken)
        }
    `);

    return mutate(SET_ACTIVE_CHANNEL, { channelToken, authToken }, { useAuthToken: true });
}
