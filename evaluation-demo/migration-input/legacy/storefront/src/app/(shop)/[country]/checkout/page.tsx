import type { Metadata } from 'next';
import { query } from '@/lib/vendure/api';
import {
    GetActiveOrderForCheckoutQuery,
    GetAvailableCountriesQuery,
    GetCustomerAddressesQuery,
    GetMergeableOrdersQuery,
    GetEligiblePaymentMethodsQuery,
    GetEligibleShippingMethodsQuery,
    GetWorldFirstPaymentManifestQuery,
} from '@/lib/vendure/queries';
import { redirect } from 'next/navigation';
import CheckoutFlow from './checkout-flow';
import { CheckoutProvider } from './checkout-provider';
import { noIndexRobots } from '@/lib/metadata';
import { getActiveCustomer } from '@/lib/vendure/actions';
import { cookies } from 'next/headers';

export const metadata: Metadata = {
    title: 'Checkout',
    description: 'Complete your purchase.',
    robots: noIndexRobots(),
};

export default async function CheckoutPage(props: any) {
    const params = await props.params;
    const country = params?.country as string;
    const customer = await getActiveCustomer();
    const isGuest = !customer;

    const cookieStore = await cookies();
    const countryCodeCode = cookieStore.get('country_code')?.value;
    const { COUNTRY_CHANNEL_MAP } = await import('@/lib/vendure/api');

    // 0. 从 URL 参数中明确获取频道 (Determine channel explicitly from URL params)
    const channelToken = (COUNTRY_CHANNEL_MAP as any)[country] || (COUNTRY_CHANNEL_MAP as any)['DE'];

    // 1. 获取基础订单 (Fetch base order using the correct channelToken)
    const initialOrderRes = await query(GetActiveOrderForCheckoutQuery, {}, { useAuthToken: true, channelToken });
    const orderForChannel = initialOrderRes.data.activeOrder;

    if (!orderForChannel) {
        console.warn(`[Checkout Page] No active order found for channel ${channelToken}. Redirecting to /${country}/cart`);
        redirect(`/${country}/cart`);
    }

    // 2. 核心逻辑升级：通过订单内的商品确认频道 (Double check if goods match)
    const productCountryCode = null;
    const effectiveCountryCode = (productCountryCode || country || countryCodeCode || orderForChannel.shippingAddress?.countryCode || 'DE') as string;
    const finalChannelToken = (COUNTRY_CHANNEL_MAP as any)[effectiveCountryCode] || channelToken;

    console.log(`[Checkout Page] Channel Detection: Param=${country}, Product=${productCountryCode}, Cookie=${countryCodeCode}, OrderAddrCode=${orderForChannel.shippingAddress?.countryCode}, Effective=${effectiveCountryCode} -> Token=${finalChannelToken}`);

    // 3. 并发获取所有必要数据 (Parallel fetch in the CORRECT channel)
    const [orderRes, addressesRes, countriesRes, shippingMethodsRes, paymentMethodsRes, wfManifestRes] =
        await Promise.all([
            query(GetActiveOrderForCheckoutQuery, {}, { useAuthToken: true, channelToken: finalChannelToken }),
            isGuest
                ? Promise.resolve({ data: { activeCustomer: null } })
                : query(GetCustomerAddressesQuery, {}, { useAuthToken: true, channelToken: finalChannelToken }),
            query(GetAvailableCountriesQuery, {}),
            query(GetEligibleShippingMethodsQuery, {}, { useAuthToken: true, channelToken: finalChannelToken }),
            query(GetEligiblePaymentMethodsQuery, {}, { useAuthToken: true, channelToken: finalChannelToken }),
            query(GetWorldFirstPaymentManifestQuery, { countryCode: effectiveCountryCode.toUpperCase() }, { useAuthToken: true, channelToken: finalChannelToken }),
        ]);

    console.log(`[Checkout Debug] Order Status: ${orderRes.data.activeOrder?.state}, Total: ${orderRes.data.activeOrder?.totalWithTax}`);
    console.log(`[Checkout Debug] Order Shipping Address: ${JSON.stringify(orderRes.data.activeOrder?.shippingAddress)}`);
    console.log(`[Checkout Debug] Eligible Shipping Methods (Count: ${shippingMethodsRes.data.eligibleShippingMethods?.length || 0}):`,
        JSON.stringify(shippingMethodsRes.data.eligibleShippingMethods?.map(m => ({ id: m.id, name: m.name, price: m.priceWithTax }))));
    
    const wfManifest = wfManifestRes?.data?.worldFirstPaymentManifest || [];
    console.log(`[Checkout Debug] WF Manifest Count: ${wfManifest.length}`);

    if (shippingMethodsRes.data.eligibleShippingMethods?.length === 0) {
        console.warn(`[Checkout Warning] NO SHIPPING METHODS RETURNED for channelToken: ${finalChannelToken} and country: ${orderRes.data.activeOrder?.shippingAddress?.countryCode}`);
    }

    const activeOrder = orderRes.data.activeOrder;
    if (!activeOrder) redirect(`/${country}/cart`);

    // 4. 处理合并订单逻辑 (Handle Order Merge logic)
    const mergeOrderCode = cookieStore.get('merge_order_code')?.value;
    let targetOrder = null;

    if (mergeOrderCode) {
        try {
            const mergeableOrdersRes = await query(
                GetMergeableOrdersQuery,
                {},
                { useAuthToken: true, channelToken: finalChannelToken }
            );

            const orders = mergeableOrdersRes.data.getMergeableOrders as any[];
            const foundOrder = orders?.find(o => o.code === mergeOrderCode);

            if (foundOrder) {
                targetOrder = {
                    id: foundOrder.id,
                    code: foundOrder.code,
                    shippingAddress: foundOrder.shippingAddress,
                    shippingMethodId: foundOrder.shippingMethodId,
                    shippingMethodName: foundOrder.shippingMethodName
                };
            } else {
                cookieStore.delete('merge_order_code');
            }
        } catch (e) {
            console.error("Failed to fetch target order for merge.", e);
        }
    }

    const Flow = CheckoutFlow as any;
    const Provider = CheckoutProvider as any;

    return (
        <Provider
            order={activeOrder as any}
            addresses={addressesRes.data?.activeCustomer?.addresses || []}
            countries={countriesRes.data.availableCountries as any}
            shippingMethods={shippingMethodsRes.data.eligibleShippingMethods as any}
            paymentMethods={paymentMethodsRes.data.eligiblePaymentMethods as any}
            worldFirstManifest={wfManifest as any}
            isGuest={isGuest}
            customer={activeOrder.customer}
            targetOrder={targetOrder}
            channelCountryCode={effectiveCountryCode} // [LTS] 新增
        >
            <Flow
                targetOrder={targetOrder}
            />
        </Provider>
    );
}
