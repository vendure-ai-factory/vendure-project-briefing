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

interface SearchResultsProps {
    searchParams: Promise<{
        page?: string
    }>
}

export async function SearchResults({ searchParams }: SearchResultsProps) {
    const searchParamsResolved = await searchParams;

    // Logic: Profile Country > Address Country > Cookie Country
    const customer = await getActiveCustomer().catch(() => null);
    const cookieStore = await cookies();

    let countryCode = (customer as any)?.customFields?.countryCode;
    if (!countryCode && (customer as any)?.addresses?.length > 0) {
        countryCode = (customer as any).addresses[0]?.country?.code;
    }
    if (!countryCode) {
        countryCode = cookieStore.get('country_code')?.value;
    }

    const page = getCurrentPage(searchParamsResolved);

    const productDataPromise = query(SearchProductsQuery, {
        input: buildSearchInput({
            searchParams: searchParamsResolved,
            countryCode
        })
    }, { useAuthToken: true, countryCode });

    return (
        <div className="flex flex-col gap-6">
            <div className="flex justify-end pr-4">
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
                        <ProductGrid productDataPromise={productDataPromise} currentPage={page} take={12} />
                    </Suspense>
                </main>
            </div>
        </div>
    );
}