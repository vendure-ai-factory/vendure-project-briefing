'use server';

import { graphql } from '@/graphql';
import { query, mutate, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { HasMergeableOrderQuery, GetMergeableOrdersQuery, MergeCartWithUnexportedOrderMutation } from '@/lib/vendure/merge-operations';
import { revalidateTag } from 'next/cache';

export async function checkHasMergeableOrder(): Promise<boolean> {
    console.log('[Merge Action] Checking for mergeable order...');
    const { getAuthToken } = await import('@/lib/auth');
    const token = await getAuthToken();

    if (!token) {
        return false;
    }

    try {
        const result = await query(HasMergeableOrderQuery, {}, { token }) as any;
        console.log('[Merge Action] result:', JSON.stringify(result));
        const hasMergeable = result?.data?.hasMergeableOrder === true;
        console.log('[Merge Action] hasMergeableOrder:', hasMergeable);
        return hasMergeable;
    } catch (e: any) {
        console.error('[Merge Action] Failed to check mergeable order', e);
        throw new Error(e.message || '系统繁忙，请稍后再试');
    }
}

export async function getMergeableOrders(countryCode?: string): Promise<any[]> {
    const { getAuthToken } = await import('@/lib/auth');
    const token = await getAuthToken();
    if (!token) return [];

    try {
        console.log(`[Merge Action] Fetching mergeable orders for country: ${countryCode}...`);

        let channelToken: string | undefined;
        if (countryCode) {
            channelToken = COUNTRY_CHANNEL_MAP[countryCode.toUpperCase()] || COUNTRY_CHANNEL_MAP[countryCode.toLowerCase()];
        }

        // Fetch mergeable orders with explicit channelToken if available
        const GetMergeableOrdersWithChannel = graphql(`
            query GetMergeableOrdersWithChannel {
                activeChannel {
                    code
                    token
                }
                getMergeableOrders {
                    id
                    code
                    totalWithTax
                    currencyCode
                    state
                    orderPlacedAt
                    shippingAddress {
                        fullName
                        streetLine1
                        city
                        postalCode
                        country
                        countryCode
                    }
                    shippingMethodId
                    shippingMethodName
                }
            }
        `);

        // We pass channelToken to the query to ensure we get orders for the intended channel
        const result = await query(GetMergeableOrdersWithChannel, {}, { 
            useAuthToken: true, 
            token,
            channelToken 
        }) as any;

        if (result?.errors) {
            console.error('[Merge Action] GraphQL Errors:', result.errors);
        }

        const orders = (result?.data?.getMergeableOrders || []) as any[];
        const detectedChannelToken = result?.data?.activeChannel?.token;
        const detectedChannelCode = result?.data?.activeChannel?.code;
        
        console.log(`[Merge Action] Requested Channel: ${channelToken}, Detected: ${detectedChannelCode} (${detectedChannelToken}), Found Total: ${orders.length}`);

        // IMPORTANT: Determine the strictly required country code for filtering
        let targetCountryCode: string | undefined;
        if (countryCode) {
            targetCountryCode = countryCode.toUpperCase();
        } else if (channelToken) {
            for (const [code, t] of Object.entries(COUNTRY_CHANNEL_MAP)) {
                if (t === channelToken) {
                    targetCountryCode = code.toUpperCase();
                    break;
                }
            }
        }

        if (!targetCountryCode) {
            console.log(`[Merge Action] No specific target country code identified, returning all ${orders.length} orders.`);
            return orders;
        }

        console.log(`[Merge Action] Enforcing filter for country: ${targetCountryCode}`);

        const filteredOrders = orders.filter((order: any) => {
            const orderCountryCode = order.shippingAddress?.countryCode?.toUpperCase();
            // If the order belongs to the target country OR (as fallback) the currency matches and no address
            const isMatch = orderCountryCode === targetCountryCode;
            
            if (!isMatch) {
                console.log(`[Merge Action] Filtering out order ${order.code} (Country: ${orderCountryCode} != ${targetCountryCode})`);
            }
            return isMatch;
        });

        console.log(`[Merge Action] Final Result: ${filteredOrders.length} orders match ${targetCountryCode}`);
        return filteredOrders;
    } catch (e: any) {
        console.error('[Merge Action] FATAL: Failed to fetch mergeable orders:', e?.message || e);
        return [];
    }
}

export async function setMergeCookieAction(orderCode: string) {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    cookieStore.set('merge_order_code', orderCode, { maxAge: 60 * 60 * 24 * 7 }); // 7 days
    return { success: true };
}

export async function clearMergeCookieAction() {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    cookieStore.delete('merge_order_code');
    return { success: true };
}
