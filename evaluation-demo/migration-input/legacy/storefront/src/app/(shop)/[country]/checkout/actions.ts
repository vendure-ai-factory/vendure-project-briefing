'use server';

import { query, mutate } from '@/lib/vendure/api';
import {
    SetOrderShippingAddressMutation,
    SetOrderBillingAddressMutation,
    SetOrderShippingMethodMutation,
    AddPaymentToOrderMutation,
    CreateCustomerAddressMutation,
    TransitionOrderToStateMutation,
    SetCustomerForOrderMutation,
    SetOrderMergeCustomFieldsMutation,
} from '@/lib/vendure/mutations';
import {
    GetActiveOrderForCheckoutQuery,
    GetEligibleShippingMethodsQuery,
} from '@/lib/vendure/queries';
import { revalidatePath, updateTag } from 'next/cache';
import { redirect } from "next/navigation";
import { cookies } from 'next/headers';

interface AddressInput {
    fullName: string;
    streetLine1: string;
    streetLine2?: string;
    city: string;
    province: string;
    postalCode: string;
    countryCode: string;
    phoneNumber: string;
    company?: string;
}

export async function setShippingAddress(
    shippingAddress: AddressInput,
    useSameForBilling: boolean
) {
    console.log(`[Checkout Action] Attempting to set shipping address: ${JSON.stringify(shippingAddress)}`);
    const shippingResult = await mutate(
        SetOrderShippingAddressMutation,
        { input: shippingAddress },
        { useAuthToken: true }
    );

    console.log(`[Checkout Action] Mutation result: ${JSON.stringify(shippingResult.data.setOrderShippingAddress)}`);

    if (shippingResult.data.setOrderShippingAddress.__typename !== 'Order') {
        const error = shippingResult.data.setOrderShippingAddress as any;
        console.error(`[Checkout Action] Failed: ${error.errorCode} - ${error.message}`);
        throw new Error(error.message || 'Failed to set shipping address');
    }

    if (useSameForBilling) {
        await mutate(
            SetOrderBillingAddressMutation,
            { input: shippingAddress },
            { useAuthToken: true }
        );
    }

    // 强刷国家 Cookie，确保频道对齐 (Force-sync country cookie to align channels)
    // 即使在多频道架构下，这也保证了 revalidatePath 后的页面渲染能拿到正确的 channelToken
    const cookieStore = await cookies();
    cookieStore.set('country_code', shippingAddress.countryCode, {
        path: '/',
        maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    console.log(`[Checkout Action] Country cookie synced to ${shippingAddress.countryCode}. Revalidating...`);
    revalidatePath('/checkout');
}

export async function setShippingMethod(shippingMethodId: string) {
    const cookieStore = await cookies();
    const mergeOrderCode = cookieStore.get('merge_order_code')?.value;

    if (mergeOrderCode) {
        await mutate(
            SetOrderMergeCustomFieldsMutation,
            {
                input: {
                    isMergingWithOrderCode: mergeOrderCode,
                },
            } as any,
            { useAuthToken: true }
        );
    }

    // [Consistency Guard 2.0] Validate that the selected method is actually eligible for this channel/order
    const eligibleMethodsRes = await query(GetEligibleShippingMethodsQuery, {}, { useAuthToken: true });
    const eligibleMethods = eligibleMethodsRes.data.eligibleShippingMethods || [];
    const isActuallyEligible = eligibleMethods.some(m => m.id === shippingMethodId);

    if (!isActuallyEligible) {
        console.error(`[Consistency Guard] Rejected shippingMethodId ${shippingMethodId} - not eligible for current channel/order context.`);
        throw new Error('所选配送方式与当前地区不匹配 (Shipping method mismatch for this region)');
    }

    const result = await mutate(
        SetOrderShippingMethodMutation,
        { shippingMethodId: [shippingMethodId] },
        { useAuthToken: true }
    );

    if (result.data.setOrderShippingMethod.__typename !== 'Order') {
        throw new Error('Failed to set shipping method');
    }

    revalidatePath('/checkout');
}

export async function createCustomerAddress(address: AddressInput) {
    const result = await mutate(
        CreateCustomerAddressMutation,
        { input: address },
        { useAuthToken: true }
    );

    if (!result.data.createCustomerAddress) {
        throw new Error('Failed to create customer address');
    }

    revalidatePath('/checkout');
    return result.data.createCustomerAddress;
}

export async function transitionToArrangingPayment() {
    // 强制获取当前最新订单状态 (Fetch current active order state)
    const orderRes = await query(GetActiveOrderForCheckoutQuery, {}, { useAuthToken: true });
    const order = orderRes.data.activeOrder;

    if (!order) {
        return {
            success: false,
            errorCode: 'NO_ACTIVE_ORDER',
            message: 'No active order found.',
        };
    }

    // 如果订单仍处于 AddingItems 状态，尝试先转换到 ShippingMethodSelected
    // 在 Vendure 中，通常设置了 ShippingMethod 后会进入此状态，但合并操作可能会将其重置
    if (order.state === 'AddingItems') {
        console.log(`[Checkout Action] Order ${order.code} is in AddingItems. Attempting to force transition or re-set shipping.`);

        // 尝试直接转换
        const preTransition = await mutate(
            TransitionOrderToStateMutation,
            { state: 'ShippingMethodSelected' },
            { useAuthToken: true }
        );

        if (preTransition.data.transitionOrderToState?.__typename === 'OrderStateTransitionError') {
            console.warn(`[Checkout Action] Direct pre-transition failed: ${preTransition.data.transitionOrderToState.message}. Attempting re-set shipping trick.`);

            // 如果直接转换失败，尝试刷新配送方式
            const methodsRes = await query(GetEligibleShippingMethodsQuery, {}, { useAuthToken: true });

            const firstMethodId = methodsRes.data.eligibleShippingMethods?.[0]?.id;
            if (firstMethodId) {
                await mutate(SetOrderShippingMethodMutation, { shippingMethodId: [firstMethodId] }, { useAuthToken: true });
                // 再次尝试转换
                await mutate(TransitionOrderToStateMutation, { state: 'ShippingMethodSelected' }, { useAuthToken: true });
            }
        }
    }

    const result = await mutate(
        TransitionOrderToStateMutation,
        { state: 'ArrangingPayment' },
        { useAuthToken: true }
    );

    const transitionResult = result.data.transitionOrderToState;

    if (transitionResult?.__typename === 'OrderStateTransitionError') {
        console.error(`[Checkout Action] Order state transition to ArrangingPayment FAILED for ${order.code}: ${transitionResult.errorCode} - ${transitionResult.message}`);
        return {
            success: false,
            errorCode: transitionResult.errorCode,
            message: transitionResult.message,
        };
    }

    if (transitionResult?.__typename !== 'Order') {
        return {
            success: false,
            errorCode: 'UNKNOWN_ERROR',
            message: 'An unexpected error occurred during state transition.',
        };
    }

    revalidatePath('/checkout');
    return { success: true };
}

export async function placeOrder(paymentMethodCode: string, targetOrderId?: string) {
    const { getAuthToken } = await import('@/lib/auth');
    const token = await getAuthToken();

    // If we have a target order ID, perform the REAL merge on the backend first
    if (targetOrderId && token) {
        console.log(`[Checkout Action] Performing backend merge for order ${targetOrderId}`);
        const { MergeCartWithUnexportedOrderMutation } = await import('@/lib/vendure/merge-operations');
        const mergeResult = await mutate(
            MergeCartWithUnexportedOrderMutation,
            { targetOrderId },
            { token, useAuthToken: true }
        ) as any;

        if (!mergeResult.data?.mergeCartWithUnexportedOrder?.success) {
            return {
                success: false,
                errorCode: 'MERGE_FAILED',
                message: mergeResult.data?.mergeCartWithUnexportedOrder?.message || 'Failed to merge orders before placement.',
            };
        }
        console.log(`[Checkout Action] Merge successful. Merged into code: ${mergeResult.data.mergeCartWithUnexportedOrder.orderCode}`);
    }

    // First, transition the order to ArrangingPayment state
    const transition = await transitionToArrangingPayment();
    if (!transition.success) {
        return transition;
    }

    // Prepare metadata based on payment method
    let finalMethodCode = paymentMethodCode;
    const metadata: Record<string, unknown> = {};

    // [LTS-ENHANCEMENT] Handle composite WorldFirst IDs (e.g. worldfirst-payment:KLARNA)
    if (paymentMethodCode.startsWith('worldfirst-payment:')) {
        const [base, sub] = paymentMethodCode.split(':');
        finalMethodCode = base;
        metadata.paymentMethodCode = sub;
        console.log(`[Checkout Action] WorldFirst Composite detected: Base=${base}, Sub=${sub}`);
    }

    // For standard payment, include the required fields
    if (finalMethodCode === 'standard-payment') {
        metadata.shouldDecline = false;
        metadata.shouldError = false;
        metadata.shouldErrorOnSettle = false;
        metadata.shouldSettle = true;
    }

    // Add payment to the order
    const result = await mutate(
        AddPaymentToOrderMutation,
        {
            input: {
                method: finalMethodCode,
                metadata,
            },
        },
        { useAuthToken: true }
    );

    if (result.data.addPaymentToOrder.__typename !== 'Order') {
        const errorResult = result.data.addPaymentToOrder;
        return {
            success: false,
            errorCode: errorResult.errorCode,
            message: errorResult.message,
        };
    }

    const orderCode = result.data.addPaymentToOrder.code;

    // Success! Clear merge cookie if it was set
    const cookieStore = await cookies();
    cookieStore.delete('merge_order_code');

    // Update the cart tag to immediately invalidate cached cart data
    updateTag('cart');
    updateTag('active-order');

    redirect(`/order-confirmation/${orderCode}`);
}

interface GuestCustomerInput {
    emailAddress: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
}

export type SetCustomerForOrderResult =
    | { success: true }
    | { success: false; errorCode: 'EMAIL_CONFLICT'; message: string }
    | { success: false; errorCode: 'GUEST_CHECKOUT_DISABLED'; message: string }
    | { success: false; errorCode: 'NO_ACTIVE_ORDER'; message: string }
    | { success: false; errorCode: 'UNKNOWN'; message: string };

export async function setCustomerForOrder(
    input: GuestCustomerInput
): Promise<SetCustomerForOrderResult> {
    const result = await mutate(
        SetCustomerForOrderMutation,
        { input },
        { useAuthToken: true }
    );

    const response = result.data.setCustomerForOrder;

    switch (response.__typename) {
        case 'Order':
            revalidatePath('/checkout');
            return { success: true };
        case 'AlreadyLoggedInError':
            return { success: true };
        case 'EmailAddressConflictError':
            return { success: false, errorCode: 'EMAIL_CONFLICT', message: response.message };
        case 'GuestCheckoutError':
            return { success: false, errorCode: 'GUEST_CHECKOUT_DISABLED', message: response.message };
        case 'NoActiveOrderError':
            return { success: false, errorCode: 'NO_ACTIVE_ORDER', message: response.message };
        default:
            return { success: false, errorCode: 'UNKNOWN', message: 'Unknown error' };
    }
}

export async function cancelMerge() {
    const cookieStore = await cookies();
    const mergeOrderCode = cookieStore.get('merge_order_code')?.value;

    if (mergeOrderCode) {
        console.log(`[Checkout Action] Cancelling merge with code ${mergeOrderCode}. Reverting its state...`);
        const { RevertOrderMergeMutation } = await import('@/lib/vendure/merge-operations');
        try {
            await mutate(
                RevertOrderMergeMutation,
                { orderCode: mergeOrderCode },
                { useAuthToken: true }
            );
        } catch (e) {
            console.error("Failed to revert order state during merge cancellation", e);
        }
    }

    cookieStore.delete('merge_order_code');
    revalidatePath('/checkout');
}
