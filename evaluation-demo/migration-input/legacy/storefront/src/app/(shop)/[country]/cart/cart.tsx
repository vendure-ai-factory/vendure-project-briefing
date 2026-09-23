import { CartItems } from "@/app/(shop)/[country]/cart/cart-items";
import { CartOrderSummary } from "@/app/(shop)/[country]/cart/order-summary";
import { PromotionCode } from "@/app/(shop)/[country]/cart/promotion-code";
import { query } from "@/lib/vendure/api";
import { GetActiveOrderQuery } from "@/lib/vendure/queries";

export async function Cart({ country }: { country: string }) {
    "use cache: private"

    const { data } = await query(GetActiveOrderQuery, {}, {
        useAuthToken: true,
    });

    const activeOrder = data.activeOrder;

    // Handle empty cart case
    if (!activeOrder || activeOrder.lines.length === 0) {
        return <CartItems activeOrder={null} country={country} />;
    }

    return (
        <div className="grid lg:grid-cols-3 gap-8">
            <CartItems activeOrder={activeOrder} country={country} />

            <div className="lg:col-span-1">
                <CartOrderSummary activeOrder={activeOrder} />
                <PromotionCode activeOrder={activeOrder} />
            </div>
        </div>
    )
}