import { Suspense } from "react";
import { FacetFilters } from "@/components/commerce/facet-filters";
import { ProductGridSkeleton } from "@/components/shared/product-grid-skeleton";
import { ProductGrid } from "@/components/commerce/product-grid";
import { buildSearchInput, getCurrentPage } from "@/lib/search-helpers";
import { query } from "@/lib/vendure/api";
import { SearchProductsQuery } from "@/lib/vendure/queries";
import { SortSelect } from "@/components/commerce/sort-select";

import { cookies } from "next/headers";
import { getActiveCustomer } from "@/lib/vendure/actions";

import { COUNTRY_CHANNEL_MAP } from "@/lib/vendure/api";
import { CountryFilter } from "@/components/commerce/country-filter";

interface SearchResultsProps {
    params: Promise<{ country: string }>;
    searchParams: Promise<{
        page?: string;
        country?: string;
        q?: string;
    }>
}

export async function SearchResults({ searchParams, params }: SearchResultsProps) {
    const searchParamsResolved = await searchParams;
    const { country: overrideCountry } = searchParamsResolved;
    // Extract country from the URL path [country]
    const { country: pathCountry } = await params;

    // Logic: URL Query > URL Path > Profile Country > Address Country > Cookie Country
    const customer = await getActiveCustomer().catch(() => null);
    const cookieStore = await cookies();

    let countryCode: string | undefined = overrideCountry || pathCountry;

    if (!countryCode) {
        countryCode = (customer as any)?.customFields?.countryCode;
        if (!countryCode && (customer as any)?.addresses?.length > 0) {
            countryCode = (customer as any).addresses[0]?.country?.code;
        }
        if (!countryCode) {
            countryCode = cookieStore.get('country_code')?.value;
        }
    }

    const channelToken = countryCode ? COUNTRY_CHANNEL_MAP[countryCode.toLowerCase()] : undefined;

    const page = getCurrentPage(searchParamsResolved);

    const productDataPromise = query(SearchProductsQuery, {
        input: buildSearchInput({
            searchParams: searchParamsResolved
        })
    }, {
        useAuthToken: true,
        channelToken // Explicitly override channel if country is provided
    });

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between pr-4">
                <CountryFilter currentCountry={overrideCountry} />
                <SortSelect />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                <aside className="lg:col-span-1">
                    <Suspense fallback={<div className="h-64 animate-pulse bg-muted rounded-lg" />}>
                        <FacetFilters productDataPromise={productDataPromise} />
                    </Suspense>
                </aside>

                <main className="lg:col-span-3">
                    <Suspense fallback={<ProductGridSkeleton />}>
                        <ProductGrid productDataPromise={productDataPromise} currentPage={page} take={12} countryCode={countryCode} />
                    </Suspense>
                </main>
            </div>
        </div>
    );
}