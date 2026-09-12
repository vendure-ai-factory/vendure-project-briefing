import { cacheLife, cacheTag } from 'next/cache';
import { query, COUNTRY_CHANNEL_MAP } from './api';
import { GetActiveChannelQuery, GetAvailableCountriesQuery, GetTopCollectionsQuery } from './queries';

/**
 * Get the active channel with caching enabled.
 * Channel configuration rarely changes, so we cache it for 1 hour.
 */
export async function getActiveChannelCached() {
    'use cache';
    cacheLife('hours');

    const result = await query(GetActiveChannelQuery, undefined, { suppressDynamics: true });
    return result.data.activeChannel;
}

/**
 * Get available countries with caching enabled.
 * Cached per channel token.
 */
export async function getAvailableCountriesCached(channelToken?: string) {
    'use cache';
    cacheLife('max');
    cacheTag('countries');

    // Default to germany-channel if no token provided, to ensure strict filtering
    const token = channelToken || 'germany-channel';

    const result = await query(GetAvailableCountriesQuery, undefined, {
        channelToken: token,
        suppressDynamics: true
    });

    let filtered = result.data.availableCountries || [];

    // Handle channel-specific country filtering
    // Since Vendure 2.x Shop API might not automatically filter availableCountries by channel
    // based on default shipping zone, we apply the filtering here as a hard requirement.
    if (token === 'germany-channel') {
        filtered = filtered.filter(c => c.code === 'DE');
    } else if (token === 'hungary-channel') {
        filtered = filtered.filter(c => c.code === 'HU');
    } else if (token === 'austria-channel') {
        filtered = filtered.filter(c => c.code === 'AT');
    }

    return filtered;
}



/**
 * Get top-level collections with caching enabled.
 * Collections rarely change, so we cache them for 1 day.
 */
export async function getTopCollections(countryCode?: string) {
    'use cache';
    cacheLife('days');
    cacheTag('collections');

    const channelToken = countryCode ? COUNTRY_CHANNEL_MAP[countryCode] : undefined;
    const result = await query(GetTopCollectionsQuery, undefined, {
        channelToken,
        suppressDynamics: true
    });
    return result.data.collections.items;
}
