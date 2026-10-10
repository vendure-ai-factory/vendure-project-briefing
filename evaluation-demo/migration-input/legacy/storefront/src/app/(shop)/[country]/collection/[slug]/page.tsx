import type { Metadata } from 'next';
import { Suspense } from 'react';
import { query, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { SearchProductsQuery, GetCollectionProductsQuery } from '@/lib/vendure/queries';
import { ProductGrid } from '@/components/commerce/product-grid';
import { FacetFilters } from '@/components/commerce/facet-filters';
import { ProductGridSkeleton } from '@/components/shared/product-grid-skeleton';
import { buildSearchInput, getCurrentPage } from '@/lib/search-helpers';
import { cacheLife, cacheTag } from 'next/cache';
import {
    SITE_NAME,
    truncateDescription,
    buildCanonicalUrl,
    buildOgImages,
} from '@/lib/metadata';
import { notFound } from 'next/navigation';

async function getCollectionProducts(slug: string, searchParams: { [key: string]: string | string[] | undefined }, channelToken?: string) {
    'use cache';
    cacheLife('hours');
    cacheTag(`collection-${slug}-${channelToken || 'default'}`);

    return query(SearchProductsQuery, {
        input: buildSearchInput({
            searchParams,
            collectionSlug: slug
        })
    }, { channelToken, suppressDynamics: true });
}

async function getCollectionMetadata(slug: string, channelToken?: string) {
    'use cache';
    cacheLife('hours');
    cacheTag(`collection-meta-${slug}-${channelToken || 'default'}`);

    return query(GetCollectionProductsQuery, {
        slug,
        input: { take: 0, collectionSlug: slug, groupByProduct: true },
    }, { channelToken, suppressDynamics: true });
}

export async function generateMetadata({
    params,
}: { params: Promise<{ country: string; slug: string }> }): Promise<Metadata> {
    const { country, slug } = await params;
    const decodedSlug = decodeURIComponent(slug);

    const channelToken = COUNTRY_CHANNEL_MAP[country.toLowerCase()];

    if (!channelToken) return { title: 'Invalid Region' };

    const result = await getCollectionMetadata(decodedSlug, channelToken);
    const collection = result.data.collection;

    if (!collection) {
        return {
            title: 'Collection Not Found',
        };
    }

    const description =
        truncateDescription(collection.description) ||
        `Browse our ${collection.name} collection at ${SITE_NAME}`;

    return {
        title: collection.name,
        description,
        alternates: {
            canonical: buildCanonicalUrl(`/${country.toLowerCase()}/collection/${collection.slug}`),
        },
        openGraph: {
            title: collection.name,
            description,
            type: 'website',
            url: buildCanonicalUrl(`/${country.toLowerCase()}/collection/${collection.slug}`),
            images: buildOgImages(collection.featuredAsset?.preview, collection.name),
        },
        twitter: {
            card: 'summary_large_image',
            title: collection.name,
            description,
            images: collection.featuredAsset?.preview
                ? [collection.featuredAsset.preview]
                : undefined,
        },
    };
}

export default async function CollectionPage({ params, searchParams }: {
    params: Promise<{ country: string; slug: string }>;
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
    const { country, slug } = await params;
    const searchParamsResolved = await searchParams;
    const page = getCurrentPage(searchParamsResolved);

    const channelToken = COUNTRY_CHANNEL_MAP[country.toLowerCase()];

    if (!channelToken) {
        notFound();
    }

    const decodedSlug = decodeURIComponent(slug);
    const productDataPromise = getCollectionProducts(decodedSlug, searchParamsResolved, channelToken);

    return (
        <div className="container mx-auto px-4 py-8 mt-16">
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Filters Sidebar */}
                <aside className="lg:col-span-1">
                    <Suspense fallback={<div className="h-64 animate-pulse bg-muted rounded-lg" />}>
                        <FacetFilters productDataPromise={productDataPromise} />
                    </Suspense>
                </aside>

                {/* Product Grid */}
                <div className="lg:col-span-3">
                    <Suspense fallback={<ProductGridSkeleton />}>
                        <ProductGrid productDataPromise={productDataPromise} currentPage={page} take={12} />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}