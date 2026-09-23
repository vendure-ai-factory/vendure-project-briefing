'use server';

import { mutate, query, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { AddToCartMutation } from '@/lib/vendure/mutations';
import { GetActiveOrderQuery } from '@/lib/vendure/queries';
import { updateTag } from 'next/cache';
import { setAuthToken } from '@/lib/auth';

export async function addToCart(variantId: string, quantity: number = 1, customFields?: Record<string, any>, targetCountryCode?: string) {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();

    // 1. Determine target channel from provided country code (from URL path)
    const normalizedCountry = targetCountryCode?.toLowerCase();
    const targetChannelToken = normalizedCountry ? COUNTRY_CHANNEL_MAP[normalizedCountry] : undefined;

    // 2. Fetch active order to check for channel consistency
    const activeOrderRes = await query(GetActiveOrderQuery, {}, { 
      useAuthToken: true,
      channelToken: targetChannelToken // Explicitly use target channel to see if there's an order there
    });
    
    // Vendure technically keeps separate orders per channel. 
    // Our goal is to ensure the item is added to the channel corresponding to the current URL.
    
    if (targetCountryCode) {
      // Sync country_code cookie for consistency
      cookieStore.set('country_code', targetCountryCode.toUpperCase(), { path: '/' });
    }

    const variables: any = { variantId, quantity };
    if (customFields) {
      variables.customFields = customFields;
    }

    const result = await mutate(AddToCartMutation, variables, {
      useAuthToken: true,
      channelToken: targetChannelToken
    });

    if (result.token) {
      await setAuthToken(result.token);
    }

    if (result.data.addItemToOrder.__typename === 'Order') {
      updateTag('cart');
      updateTag('active-order');
      return { success: true, order: result.data.addItemToOrder };
    } else {
      return { 
        success: false, 
        error: result.data.addItemToOrder.message,
        errorCode: (result.data.addItemToOrder as any).errorCode 
      };
    }
  } catch (e: any) {
    console.error('Error in addToCart:', e);
    return { success: false, error: e.message || 'Failed to add item to cart' };
  }
}
