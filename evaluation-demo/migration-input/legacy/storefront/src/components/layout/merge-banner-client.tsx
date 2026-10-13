'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { cancelOrderMerge } from '@/app/(shop)/[country]/account/orders/actions';
import { useRouter } from 'next/navigation';

export function MergeBannerClient({ initialOrderCode }: { initialOrderCode: string | null }) {
    const router = useRouter();
    const [isVisible, setIsVisible] = useState(!!initialOrderCode);

    useEffect(() => {
        setIsVisible(!!initialOrderCode);
    }, [initialOrderCode]);

    if (!isVisible || !initialOrderCode) return null;

    const handleCancel = async () => {
        await cancelOrderMerge();
        setIsVisible(false);
        router.refresh();
    };

    return (
        <div className="bg-orange-600 text-white py-2 px-4 shadow-md sticky top-0 z-50">
            <div className="container mx-auto flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="font-bold flex items-center gap-1">
                        📦 Order Merge Mode:
                    </span>
                    <span>
                        You are adding items to order <span className="font-mono font-bold">#{initialOrderCode}</span>.
                    </span>
                    <span className="hidden md:inline ml-2 text-sm bg-orange-500 px-2 py-0.5 rounded-full">
                        FREE SHIPPING applied at checkout
                    </span>
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCancel}
                    className="h-8 w-8 hover:bg-orange-700 text-white p-0"
                    title="Cancel merging"
                >
                    <X className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
