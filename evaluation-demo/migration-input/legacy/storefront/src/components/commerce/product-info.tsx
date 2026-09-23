'use client';

import { useState, useMemo, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ShoppingCart, CheckCircle2 } from 'lucide-react';
import { addToCart } from '@/app/(shop)/[country]/product/[slug]/actions';
import { clearActiveOrder } from '@/app/(shop)/[country]/cart/actions';
import { toast } from 'sonner';
import { Price } from '@/components/commerce/price';
import { NailSizeSelector } from '@/components/commerce/nail-size-selector';

interface ProductInfoProps {
    product: {
        id: string;
        name: string;
        description: string;
        variants: Array<{
            id: string;
            name: string;
            sku: string;
            priceWithTax: number;
            currencyCode: string;
            stockLevel: string;
            options: Array<{
                id: string;
                code: string;
                name: string;
                groupId: string;
                group: {
                    id: string;
                    code: string;
                    name: string;
                };
            }>;
        }>;
        optionGroups: Array<{
            id: string;
            code: string;
            name: string;
            options: Array<{
                id: string;
                code: string;
                name: string;
            }>;
        }>;
        customFields?: {
            designFee: number;
        };
    };
    searchParams: { [key: string]: string | string[] | undefined };
    // Customization Props
    selectedDesign: string | null;
    selectedShape: string | null;
    selectedProfileId: string | null;
    matchResults: any[];
    shapes: any[];
    profiles: any[];
    loadingProfiles?: boolean;
    onShapeChange: (shapeCode: string) => void;
    onProfileChange: (profileId: string) => void;
    onManageProfiles: () => void;
    countryCode?: string;
}

export function ProductInfo({
    product,
    searchParams,
    selectedDesign,
    selectedShape,
    selectedProfileId,
    matchResults,
    shapes,
    profiles,
    loadingProfiles = false,
    onShapeChange,
    onProfileChange,
    onManageProfiles,
    countryCode,
}: ProductInfoProps) {
    const pathname = usePathname();
    const router = useRouter();
    const currentSearchParams = useSearchParams();
    const [isPending, startTransition] = useTransition();
    const [isAdded, setIsAdded] = useState(false);
    const [selectedFinger, setSelectedFinger] = useState<string | null>(null);

    // Initialize selected options from URL
    const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>(() => {
        const initialOptions: Record<string, string> = {};
        product.optionGroups.forEach((group) => {
            const paramValue = searchParams[group.code];
            if (typeof paramValue === 'string') {
                const option = group.options.find((opt) => opt.code === paramValue);
                if (option) {
                    initialOptions[group.id] = option.id;
                }
            }
        });
        return initialOptions;
    });

    // Find the matching variant based on selected options
    const selectedVariant = useMemo(() => {
        if (product.variants.length === 1) {
            return product.variants[0];
        }
        if (Object.keys(selectedOptions).length !== product.optionGroups.length) {
            return null;
        }
        return product.variants.find((variant) => {
            const variantOptionIds = variant.options.map((opt) => opt.id);
            const selectedOptionIds = Object.values(selectedOptions);
            return selectedOptionIds.every((optId) => variantOptionIds.includes(optId));
        });
    }, [selectedOptions, product.variants, product.optionGroups]);

    const handleOptionChange = (groupId: string, optionId: string) => {
        setSelectedOptions((prev) => ({
            ...prev,
            [groupId]: optionId,
        }));
        const group = product.optionGroups.find((g) => g.id === groupId);
        const option = group?.options.find((opt) => opt.id === optionId);
        if (group && option) {
            const params = new URLSearchParams(currentSearchParams);
            params.set(group.code, option.code);
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
        }
    };

    const handleAddToCart = async () => {
        if (!selectedVariant) return;

        // Custom Validation: Must select a finger for customization
        if (matchResults.length > 0 && !selectedFinger) {
            toast.error('请选择手指', {
                description: '请在尺寸匹配结果中点击选择一个要定制的手指',
            });
            return;
        }

        startTransition(async () => {
            const customFields: Record<string, any> = {};

            if (selectedDesign) {
                customFields.designNumber = selectedDesign;
            }

            if (selectedFinger && matchResults.length > 0) {
                const result = matchResults.find(r => r.finger === selectedFinger);
                if (result) {
                    // Only pass the selected finger's data
                    customFields.nailSizes = `${result.finger}:${result.arcLength}`;
                    customFields.matchedNailModel = result.matchedModel;
                }
            }

            if (selectedShape) {
                customFields.nailShape = selectedShape;
            }

            const result = await addToCart(selectedVariant.id, 1, customFields, countryCode || '');

            if (result.success) {
                setIsAdded(true);
                toast.success('Added to cart', {
                    description: `${product.name} has been added to your cart`,
                });
                setTimeout(() => setIsAdded(false), 2000);
            } else if (result.errorCode === 'CLEAR_CART_REQUIRED') {
                toast.error('购物车冲突', {
                    description: result.error,
                    action: {
                        label: '清空并加购',
                        onClick: async () => {
                            const clearRes = await clearActiveOrder();
                            if (clearRes.success) {
                                // Retry adding to cart after clearing
                                handleAddToCart();
                            } else {
                                toast.error('清空失败', { description: clearRes.error });
                            }
                        }
                    }
                });
            } else {
                toast.error('Error', {
                    description: result.error || 'Failed to add item to cart',
                });
            }
        });
    };

    const isInStock = selectedVariant && selectedVariant.stockLevel !== 'OUT_OF_STOCK';
    const canAddToCart = selectedVariant && isInStock;

    return (
        <div className="space-y-6">
            {/* Product Title */}
            <div>
                <h1 className="text-3xl font-bold">{product.name}</h1>
                {selectedVariant && (
                    <p className="text-2xl font-bold mt-2">
                        <Price value={selectedVariant.priceWithTax} currencyCode={selectedVariant.currencyCode} />
                    </p>
                )}
            </div>

            {/* Product Description */}
            <div className="prose prose-sm max-w-none">
                <div dangerouslySetInnerHTML={{ __html: product.description }} />
            </div>

            {/* Standard Option Groups */}
            {product.optionGroups.length > 0 && (
                <div className="space-y-4">
                    {product.optionGroups.map((group) => (
                        <div key={group.id} className="space-y-3">
                            <Label className="text-base font-semibold">
                                {group.name}
                            </Label>
                            <RadioGroup
                                value={selectedOptions[group.id] || ''}
                                onValueChange={(value) => handleOptionChange(group.id, value)}
                            >
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                    {group.options.map((option) => (
                                        <div key={option.id}>
                                            <RadioGroupItem
                                                value={option.id}
                                                id={option.id}
                                                className="peer sr-only"
                                            />
                                            <Label
                                                htmlFor={option.id}
                                                className="flex items-center justify-center rounded-md border-2 border-muted bg-popover px-4 py-3 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary cursor-pointer transition-colors"
                                            >
                                                {option.name}
                                            </Label>
                                        </div>
                                    ))}
                                </div>
                            </RadioGroup>
                        </div>
                    ))}
                </div>
            )}

            {/* ---- 穿戴甲定制选项 (Nail Customization) ---- */}
            <div className="pt-4 border-t">
                <h3 className="text-lg font-bold mb-4">定制你的穿戴甲 (Customization)</h3>
                <NailSizeSelector
                    shapes={shapes}
                    profiles={profiles}
                    selectedShape={selectedShape}
                    selectedProfileId={selectedProfileId}
                    selectedFinger={selectedFinger}
                    matchResults={matchResults}
                    loading={loadingProfiles}
                    onShapeChange={onShapeChange}
                    onProfileChange={onProfileChange}
                    onFingerSelect={setSelectedFinger}
                    onManageProfiles={onManageProfiles}
                />

                {selectedDesign && (
                    <div className="mt-4 p-3 bg-primary/5 rounded-md border border-primary/20 flex items-center justify-between">
                        <span className="text-sm font-medium">已选择设计款式</span>
                        <span className="text-secondary-foreground font-bold">{selectedDesign}</span>
                    </div>
                )}
            </div>

            {/* Stock Status */}
            {selectedVariant && (
                <div className="text-sm">
                    {isInStock ? (
                        <span className="text-green-600 font-medium">In Stock</span>
                    ) : (
                        <span className="text-destructive font-medium">Out of Stock</span>
                    )}
                </div>
            )}

            {/* Add to Cart Button */}
            <div className="pt-4">
                <Button
                    size="lg"
                    className="w-full"
                    disabled={!canAddToCart || isPending}
                    onClick={handleAddToCart}
                >
                    {isAdded ? (
                        <>
                            <CheckCircle2 className="mr-2 h-5 w-5" />
                            Added to Cart
                        </>
                    ) : (
                        <>
                            <ShoppingCart className="mr-2 h-5 w-5" />
                            {isPending
                                ? 'Adding...'
                                : !selectedVariant && product.optionGroups.length > 0
                                    ? 'Select Options'
                                    : !isInStock
                                        ? 'Out of Stock'
                                        : 'Add to Cart'}
                        </>
                    )}
                </Button>
            </div>

            {/* SKU */}
            {selectedVariant && (
                <div className="text-xs text-muted-foreground">
                    SKU: {selectedVariant.sku}
                </div>
            )}
        </div>
    );
}
