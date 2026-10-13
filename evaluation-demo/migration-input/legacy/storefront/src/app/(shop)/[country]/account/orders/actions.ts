'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const MERGE_ORDER_COOKIE = 'merge_order_code';

export async function initiateOrderMerge(orderCode: string) {
    const cookieStore = await cookies();
    cookieStore.set(MERGE_ORDER_COOKIE, orderCode, {
        path: '/',
        maxAge: 60 * 60 * 2, // 2 hours
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
    });

    // Redirect to home to start shopping
    redirect('/');
}

export async function cancelOrderMerge() {
    const cookieStore = await cookies();
    cookieStore.delete(MERGE_ORDER_COOKIE);
}

export async function getMergeOrderCode() {
    const cookieStore = await cookies();
    return cookieStore.get(MERGE_ORDER_COOKIE)?.value || null;
}
