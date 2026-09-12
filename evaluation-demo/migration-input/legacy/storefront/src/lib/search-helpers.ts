/**
 * 搜索辅助工具
 * 
 * 通过 collectionSlug 按国家过滤商品，而不是硬编码 Facet ID。
 * 这比硬编码数据库 ID 更稳健，因为 collection slug 是可控的。
 */

export interface SearchInputParams {
    term?: string;
    collectionSlug?: string;
    countryCode?: string;
    take: number;
    skip: number;
    groupByProduct: boolean;
    sort: { name?: 'ASC' | 'DESC'; price?: 'ASC' | 'DESC' };
    facetValueFilters?: Array<{ and: string }>;
}

interface BuildSearchInputOptions {
    searchParams: { [key: string]: string | string[] | undefined };
    collectionSlug?: string;
    countryCode?: string;
}

export function buildSearchInput({ searchParams, collectionSlug }: BuildSearchInputOptions): SearchInputParams {
    const page = Number(searchParams.page) || 1;
    const take = 12;
    const skip = (page - 1) * take;
    const sort = (searchParams.sort as string) || 'newest';
    const searchTerm = searchParams.q as string;

    // Extract facet value IDs from search params (user-selected filters)
    const facetValueIds = searchParams.facets
        ? Array.isArray(searchParams.facets)
            ? searchParams.facets
            : [searchParams.facets]
        : [];

    // Map sort parameter to Vendure SearchResultSortParameter
    const sortMapping: Record<string, { name?: 'ASC' | 'DESC'; price?: 'ASC' | 'DESC' }> = {
        'newest': {},
        'name-asc': { name: 'ASC' },
        'name-desc': { name: 'DESC' },
        'price-asc': { price: 'ASC' },
        'price-desc': { price: 'DESC' },
    };

    const facetValueFilters = facetValueIds.map(id => ({ and: id }));

    return {
        ...(searchTerm && { term: searchTerm }),
        ...(collectionSlug && { collectionSlug }),
        take,
        skip,
        groupByProduct: true,
        sort: sortMapping[sort] || sortMapping['newest'],
        ...(facetValueFilters.length > 0 && { facetValueFilters })
    };
}

export function getCurrentPage(searchParams: { [key: string]: string | string[] | undefined }): number {
    return Number(searchParams.page) || 1;
}
