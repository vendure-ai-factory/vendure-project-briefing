'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

export function SortSelect() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const currentSort = searchParams.get('sort') || 'newest';

    const handleSortChange = (value: string) => {
        const params = new URLSearchParams(searchParams);
        params.set('sort', value);
        router.push(`${pathname}?${params.toString()}`);
    };

    return (
        <Select value={currentSort} onValueChange={handleSortChange}>
            <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="newest">Newest Arrivals</SelectItem>
                <SelectItem value="name-asc">Name: A to Z</SelectItem>
                <SelectItem value="name-desc">Name: Z to A</SelectItem>
                <SelectItem value="price-asc">Price: Low to High</SelectItem>
                <SelectItem value="price-desc">Price: High to Low</SelectItem>
            </SelectContent>
        </Select>
    );
}
