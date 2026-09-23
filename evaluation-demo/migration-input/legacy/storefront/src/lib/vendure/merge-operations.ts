import { graphql } from '@/graphql';

export const HasMergeableOrderQuery = graphql(`
    query HasMergeableOrder {
        hasMergeableOrder
    }
`);

export const GetMergeableOrdersQuery = graphql(`
    query GetMergeableOrders {
        getMergeableOrders {
            id
            code
            totalWithTax
            currencyCode
            state
            orderPlacedAt
            shippingAddress {
                fullName
                streetLine1
                city
                postalCode
                country
                countryCode
            }
            shippingMethodId
            shippingMethodName
        }
    }
`);

export const MergeCartWithUnexportedOrderMutation = graphql(`
    mutation MergeCartWithUnexportedOrder($targetOrderId: ID) {
        mergeCartWithUnexportedOrder(targetOrderId: $targetOrderId) {
            success
            message
            orderCode
        }
    }
`);
export const RevertOrderMergeMutation = graphql(`
    mutation RevertOrderMerge($orderCode: String!) {
        revertOrderMerge(orderCode: $orderCode) {
            success
            message
        }
    }
`);
