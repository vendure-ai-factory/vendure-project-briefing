/**
 * URL utility for localized paths
 */

/**
 * Prepends the country code to an internal URL if it's not already prefixed.
 * 
 * @param href The original URL (e.g., '/cart')
 * @param country The current country code (e.g., 'hu')
 * @returns The localized URL (e.g., '/hu/cart')
 */
export function getLocalizedHref(href: string, country?: string | string[]): string {
    // Only localize internal absolute-path links
    const isInternal = href.startsWith('/') && !href.startsWith('//');
    
    if (!isInternal || !country) {
        return href;
    }

    const countryCode = Array.isArray(country) ? country[0] : country;
    const prefix = `/${countryCode.toLowerCase()}`;
    
    // Avoid double-prefixing
    if (href.startsWith(prefix)) {
        return href;
    }

    // Handle homepage specially
    if (href === '/') {
        return prefix;
    }

    return `${prefix}${href}`;
}
