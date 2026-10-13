/**
 * 按货币代码格式化价格（纯显示，不做换算，实际金额由后端决定）
 * @param price        价格（Vendure 内部格式，所有货币统一 ×100）
 * @param currencyCode Vendure 返回的货币代码，如 "EUR" "HUF" "USD"
 */
export function formatPrice(price: number, currencyCode: string = 'EUR'): string {
    const code = currencyCode.toUpperCase();
    const isZeroDecimal = code === 'HUF';
    const amount = isZeroDecimal ? price : price / 100;

    if (isZeroDecimal) {
        return new Intl.NumberFormat('hu-HU', {
            style: 'currency',
            currency: 'HUF',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
        }).format(amount);
    }

    // EUR / 其他：保留两位小数
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: code || 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

type DateFormat = 'short' | 'long';

/**
 * Format a date string
 * @param dateString ISO date string
 * @param format 'short' (Jan 15, 2024) or 'long' (January 15, 2024)
 */
export function formatDate(dateString: string, format: DateFormat = 'short'): string {
    const options: Intl.DateTimeFormatOptions = format === 'long'
        ? { year: 'numeric', month: 'long', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' };

    return new Date(dateString).toLocaleDateString('en-US', options);
}
