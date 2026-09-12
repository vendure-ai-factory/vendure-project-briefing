import { ProductCarousel } from "@/components/commerce/product-carousel";
import { cacheLife, cacheTag } from "next/cache";
import { query, COUNTRY_CHANNEL_MAP } from "@/lib/vendure/api";
import { GetCollectionProductsQuery } from "@/lib/vendure/queries";
import { readFragment } from "@/graphql";
import { ProductCardFragment } from "@/lib/vendure/fragments";

interface RelatedProductsProps {
    collectionSlug: string;
    currentProductId: string;
    countryCode?: string;
}

async function getRelatedProducts(collectionSlug: string, currentProductId: string, countryCode: string = 'DE') {
    const channelToken = COUNTRY_CHANNEL_MAP[countryCode.toLowerCase()] || COUNTRY_CHANNEL_MAP['de'];

    const result = await query(GetCollectionProductsQuery, {
        slug: collectionSlug,
        input: {
            collectionSlug: collectionSlug,
            take: 13,
            skip: 0,
            groupByProduct: true
        }
    }, { 
        channelToken, 
        suppressDynamics: true 
    });

    // Filter out the current product and limit to 12
    return result.data.search.items
        .filter(item => {
            const product = readFragment(ProductCardFragment, item);
            return product.productId !== currentProductId;
        })
        .slice(0, 12);
}

export async function RelatedProducts({ collectionSlug, currentProductId, countryCode }: RelatedProductsProps) {
    const products = await getRelatedProducts(collectionSlug, currentProductId, countryCode);

    if (products.length === 0) {
        return null;
    }

    return (
        <ProductCarousel
            title="Related Products"
            products={products}
        />
    );
}
