import { cookies } from 'next/headers';
import { MergeBannerClient } from './merge-banner-client';

export async function MergeBanner() {
    const cookieStore = await cookies();
    const mergeOrderCode = cookieStore.get('merge_order_code')?.value || null;

    if (!mergeOrderCode) return null;

    return <MergeBannerClient initialOrderCode={mergeOrderCode} />;
}
