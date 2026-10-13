import { LocalizedLink } from '@/components/ui/localized-link';
import {Button} from '@/components/ui/button';
import {Price} from '@/components/commerce/price';

type ActiveOrder = {
    id: string;
    currencyCode: string;
    subTotalWithTax: number;
    shippingWithTax: number;
    totalWithTax: number;
    discounts?: Array<{
        description: string;
        amountWithTax: number;
    }> | null;
};

export async function CartOrderSummary({activeOrder}: { activeOrder: ActiveOrder }) {
    return (
        <div className="border rounded-lg p-6 bg-card sticky top-4">
            <h2 className="text-xl font-bold mb-4">Order Summary</h2>

            <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>
                        <Price value={activeOrder.subTotalWithTax} currencyCode={activeOrder.currencyCode}/>
                    </span>
                </div>
                {activeOrder.discounts && activeOrder.discounts.length > 0 && (
                    <>
                        {activeOrder.discounts.map((discount, index) => (
                            <div key={index} className="flex justify-between text-sm text-green-600">
                                <span>{discount.description}</span>
                                <span>
                                    <Price value={discount.amountWithTax} currencyCode={activeOrder.currencyCode}/>
                                </span>
                            </div>
                        ))}
                    </>
                )}
                <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Shipping</span>
                    <span>
                        {activeOrder.shippingWithTax > 0
                            ? <Price value={activeOrder.shippingWithTax} currencyCode={activeOrder.currencyCode}/>
                            : 'Calculated at checkout'}
                    </span>
                </div>
            </div>

            <div className="border-t pt-4 mb-6">
                <div className="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span>
                        <Price value={activeOrder.totalWithTax} currencyCode={activeOrder.currencyCode}/>
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-3">
                <Button className="w-full" size="lg" asChild>
                    <LocalizedLink href="/checkout">Proceed to Checkout</LocalizedLink>
                </Button>

                <Button variant="outline" className="w-full" asChild>
                    <LocalizedLink href="/">Continue Shopping</LocalizedLink>
                </Button>
            </div>
        </div>
    );
}
