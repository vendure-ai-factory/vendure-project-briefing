import { ProductCarousel } from "@/components/commerce/product-carousel";
import { cacheLife } from "next/cache";
import { query, COUNTRY_CHANNEL_MAP } from "@/lib/vendure/api";
import { SearchProductsQuery } from "@/lib/vendure/queries";

/**
 * 获取当前 Channel 的推荐商品
 * 
 * 由于每个国家 Channel 已独立管理商品，无需 Facet 过滤。
 * Channel Token 由 api.ts 根据 country_code cookie 自动注入。
 */



async function getFeaturedProducts(countryCode?: string) {
    const result = await query(SearchProductsQuery, {
        input: {
            take: 12,
            skip: 0,
            groupByProduct: true,
        }
    }, { useAuthToken: true, channelToken: countryCode ? COUNTRY_CHANNEL_MAP[countryCode] : undefined });

    return result.data.search.items;
}


export async function FeaturedProducts({ countryCode }: { countryCode?: string }) {
    const products = await getFeaturedProducts(countryCode);

    return (
        <ProductCarousel
            title="Featured Designs"
            products={products}
            countryCode={countryCode}
        />
    );
}