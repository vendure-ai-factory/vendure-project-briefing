'use client';

import { formatPrice } from '@/lib/format';

interface PriceProps {
    value: number;
    currencyCode?: string;
}

export function Price({ value, currencyCode = 'EUR' }: PriceProps) {
    return <>{formatPrice(value, currencyCode)}</>;
}
