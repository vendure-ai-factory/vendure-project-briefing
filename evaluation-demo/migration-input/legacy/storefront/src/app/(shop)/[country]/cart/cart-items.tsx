import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Minus, Plus, X } from 'lucide-react';
import { Price } from '@/components/commerce/price';
import { removeFromCart, adjustQuantity } from './actions';
import dynamic from 'next/dynamic';

type ActiveOrder = {
    id: string;
    currencyCode: string;
    lines: Array<{
        id: string;
        quantity: number;
        unitPriceWithTax: number;
        linePriceWithTax: number;
        productVariant: {
            id: string;
            name: string;
            sku: string;
            product: {
                name: string;
                slug: string;
                featuredAsset?: {
                    preview: string;
                } | null;
            };
        };
    }>;
};

const OrderMergePrompt = dynamic(() => import('@/components/cart/order-merge-prompt').then(mod => mod.OrderMergePrompt), {
    ssr: true,
    loading: () => <div className="mb-6 h-20 bg-muted/20 animate-pulse rounded-lg border border-dashed border-muted" />
});
import { LocalizedLink } from '@/components/ui/localized-link';
import { AVAILABLE_COUNTRIES } from '@/lib/vendure/api';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export async function CartItems({ activeOrder, country }: { activeOrder: ActiveOrder | null, country: string }) {
    if (!activeOrder || activeOrder.lines.length === 0) {
        return (
            <div className="container mx-auto px-4 py-16">
                <div className="text-center">
                    <h1 className="text-3xl font-bold mb-4">Your Cart is Empty</h1>
                    <p className="text-muted-foreground mb-8">
                        Add some items to your cart to get started
                    </p>
                    <OrderMergePrompt />
                    <Button asChild>
                        <LocalizedLink href="/">Continue Shopping</LocalizedLink>
                    </Button>
                </div>
            </div>
        );
    }

    const currentCountry = AVAILABLE_COUNTRIES.find(c => c.code.toLowerCase() === country.toLowerCase());
    const isCurrencyMismatch = activeOrder && activeOrder.currencyCode !== currentCountry?.currency;

    return (
        <div className="lg:col-span-2 space-y-4">
            {isCurrencyMismatch && (
                <Alert variant="destructive" className="mb-6 border-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>频道/语境冲突 (Channel Mismatch)</AlertTitle>
                    <AlertDescription className="mt-2">
                        <p>您当前正处于 <strong>{currentCountry?.name}</strong> 站点，但您的购物车属于 <strong>{activeOrder.currencyCode}</strong> 频道。</p>
                        <p className="mt-2 text-sm opacity-90">为确保价格和库存准确，请切回对应国家或清空当前购物车后重新加购。</p>
                    </AlertDescription>
                </Alert>
            )}
            <OrderMergePrompt />
            {activeOrder.lines.map((line) => (
                <div
                    key={line.id}
                    className="flex flex-col sm:flex-row gap-4 p-4 border rounded-lg bg-card"
                >
                    {line.productVariant.product.featuredAsset && (
                        <LocalizedLink
                            href={`/product/${line.productVariant.product.slug}`}
                            className="flex-shrink-0"
                        >
                            <Image
                                src={line.productVariant.product.featuredAsset.preview}
                                alt={line.productVariant.name}
                                width={120}
                                height={120}
                                className="rounded-md object-cover w-full sm:w-[120px] h-[120px]"
                            />
                        </LocalizedLink>
                    )}

                    <div className="flex-grow min-w-0">
                        <LocalizedLink
                            href={`/product/${line.productVariant.product.slug}`}
                            className="font-semibold hover:underline block"
                        >
                            {line.productVariant.product.name}
                        </LocalizedLink>
                        {line.productVariant.name !== line.productVariant.product.name && (
                            <p className="text-sm text-muted-foreground mt-1">
                                {line.productVariant.name}
                            </p>
                        )}
                        <p className="text-sm text-muted-foreground mt-1">
                            SKU: {line.productVariant.sku}
                        </p>
                        <p className="text-sm text-muted-foreground mt-2 sm:hidden">
                            <Price value={line.unitPriceWithTax} currencyCode={activeOrder.currencyCode} /> each
                        </p>

                        <div className="flex items-center gap-3 mt-4">
                            <div className="flex items-center gap-2 border rounded-md">
                                <form action={adjustQuantity.bind(null, line.id, Math.max(1, line.quantity - 1))}>
                                    <Button
                                        type="submit"
                                        variant="ghost"
                                        size="icon"
                                        className="h-9 w-9 rounded-none"
                                        disabled={line.quantity <= 1}
                                    >
                                        <Minus className="h-4 w-4" />
                                    </Button>
                                </form>

                                <span className="w-12 text-center font-medium">{line.quantity}</span>

                                <form action={adjustQuantity.bind(null, line.id, line.quantity + 1)}>
                                    <Button
                                        type="submit"
                                        variant="ghost"
                                        size="icon"
                                        className="h-9 w-9 rounded-none"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </Button>
                                </form>
                            </div>

                            <form action={removeFromCart.bind(null, line.id)}>
                                <Button
                                    type="submit"
                                    variant="ghost"
                                    size="icon"
                                    className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                                >
                                    <X className="h-5 w-5" />
                                </Button>
                            </form>

                            <div className="sm:hidden ml-auto">
                                <p className="font-semibold text-lg">
                                    <Price value={line.linePriceWithTax}
                                        currencyCode={activeOrder.currencyCode} />
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="hidden sm:block text-right flex-shrink-0">
                        <p className="font-semibold text-lg">
                            <Price value={line.linePriceWithTax} currencyCode={activeOrder.currencyCode} />
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">
                            <Price value={line.unitPriceWithTax} currencyCode={activeOrder.currencyCode} /> each
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
}
