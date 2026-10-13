'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { MapPin } from 'lucide-react';
import { AVAILABLE_COUNTRIES } from '@/lib/vendure/api';

export function CountryFilter({ currentCountry }: { currentCountry?: string }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const handleCountryChange = (value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        
        // 我们改为通过改变 URL 路径前缀（Path Prefix）来切换国家频道
        const segments = pathname.split('/').filter(Boolean);
        let newPathname = pathname;

        if (value !== 'DEFAULT' && segments.length > 0) {
            // 替换第一个段（国家码），例如 /de/search -> /hu/search
            segments[0] = value.toLowerCase();
            newPathname = '/' + segments.join('/');
            // 同时也保留过滤器的参数，但删除冗余的 country params（因为路径已经体现了）
            params.delete('country');
        } else if (value === 'DEFAULT') {
            params.delete('country');
        } else {
            params.set('country', value);
        }

        // Reset page when changing country
        params.delete('page');
        
        const finalUrl = params.toString() ? `${newPathname}?${params.toString()}` : newPathname;
        router.push(finalUrl);
    };

    return (
        <div className="flex items-center gap-2">
            <label className="text-sm font-medium flex items-center gap-1 text-muted-foreground">
                <MapPin className="w-4 h-4" /> Country:
            </label>
            <Select
                value={currentCountry || 'DEFAULT'}
                onValueChange={handleCountryChange}
            >
                <SelectTrigger className="w-[180px] h-9">
                    <SelectValue placeholder="Display Country" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="DEFAULT">
                        Default (My Setting)
                    </SelectItem>
                    {AVAILABLE_COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                            <span className="flex items-center gap-2">
                                <span>{c.flag}</span>
                                <span>{c.name}</span>
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
