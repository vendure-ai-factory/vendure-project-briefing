'use server';

import { mutate, query } from '@/lib/vendure/api';
import {
    RemoveFromCartMutation,
    AdjustCartItemMutation,
    ApplyPromotionCodeMutation,
    RemovePromotionCodeMutation
} from '@/lib/vendure/mutations';
import { GetActiveOrderQuery } from '@/lib/vendure/queries';
import { updateTag } from 'next/cache';

export async function removeFromCart(lineId: string) {
    await mutate(RemoveFromCartMutation, { lineId }, { useAuthToken: true });
    updateTag('cart');
    updateTag('active-order');
}

export async function adjustQuantity(lineId: string, quantity: number) {
    await mutate(AdjustCartItemMutation, { lineId, quantity }, { useAuthToken: true });
    updateTag('cart');
    updateTag('active-order');
}

export async function applyPromotionCode(formData: FormData) {
    const code = formData.get('code') as string;
    if (!code) return;

    const res = await mutate(ApplyPromotionCodeMutation, { couponCode: code }, { useAuthToken: true });
    console.log({ res: res.data.applyCouponCode })
    updateTag('cart');
    updateTag('active-order');
}

export async function removePromotionCode(formData: FormData) {
    const code = formData.get('code') as string;
    if (!code) return;

    const res = await mutate(RemovePromotionCodeMutation, { couponCode: code }, { useAuthToken: true });
    console.log({ removeRes: res.data.removeCouponCode });
    updateTag('cart');
    updateTag('active-order');
}

/**
 * Clears all items from the active order.
 * Since Vendure doesn't have a single "clear order" mutation in Shop API,
 * we remove all lines individually.
 */
export async function clearActiveOrder() {
    try {
        const activeOrderRes = await query(GetActiveOrderQuery, {}, { useAuthToken: true });
        const lines = activeOrderRes.data.activeOrder?.lines || [];

        if (lines.length === 0) return { success: true };

        // Sequential removal to avoid potential race conditions in Vendure's internal state machine
        for (const line of lines) {
            await mutate(RemoveFromCartMutation, { lineId: line.id }, { useAuthToken: true });
        }

        updateTag('cart');
        updateTag('active-order');
        return { success: true };
    } catch (e: any) {
        console.error('Error clearing cart:', e);
        return { success: false, error: e.message };
    }
}
