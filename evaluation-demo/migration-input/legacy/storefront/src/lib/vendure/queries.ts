import { graphql } from '@/graphql';
import { 
    ActiveCustomerFragment, 
    ProductCardFragment, 
    AffiliateKycFormFragment 
} from './fragments';

export const GetTopCollectionsQuery = graphql(`
    query GetTopCollections {
        collections(options: { filter: { parentId: { eq: "1" } } }) {
            items {
                id
                name
                slug
            }
        }
    }
`);

export const GetActiveCustomerQuery = graphql(`
    query GetActiveCustomer {
        activeCustomer {
            customFields {
                countryCode
            }
            ...ActiveCustomer
        }
    }
`, [ActiveCustomerFragment]);

export const SearchProductsQuery = graphql(`
    query SearchProducts($input: SearchInput!) {
        search(input: $input) {
            totalItems
            items {
                ...ProductCard
            }
            facetValues {
                count
                facetValue {
                    id
                    name
                    facet {
                        id
                        name
                    }
                }
            }
        }
    }
`, [ProductCardFragment]);

export const GetProductDetailQuery = graphql(`
    query GetProductDetail($slug: String!) {
        product(slug: $slug) {
            id
            name
            description
            slug
            featuredAsset {
                id
            }
            assets {
                id
                name
                preview
                source
            }
            variants {
                id
                name
                sku
                priceWithTax
                currencyCode
                stockLevel
                options {
                    id
                    code
                    name
                    groupId
                    group {
                        id
                        code
                        name
                    }
                }
            }
            optionGroups {
                id
                code
                name
                options {
                    id
                    code
                    name
                }
            }
            customFields {
                designFee
                designTemplate
            }
            collections {
                id
                name
                slug
                parent {
                    id
                }
            }
        }
    }
`);

export const GetActiveOrderQuery = graphql(`
    query GetActiveOrder {
        activeOrder {
            id
            code
            state
            totalQuantity
            subTotal
            subTotalWithTax
            shipping
            shippingWithTax
            total
            totalWithTax
            currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
            couponCodes
            discounts {
                description
                amountWithTax
            }
            lines {
                id
                productVariant {
                    id
                    name
                    sku
                    product {
                        id
                        name
                        slug
                        featuredAsset {
                            id
                            preview
                        }
                        customFields {
                            designFee
                        }
                    }
                }
                unitPriceWithTax
                quantity
                linePriceWithTax
            }
        }
    }
`);

export const GetActiveOrderForCheckoutQuery = graphql(`
    query GetActiveOrderForCheckout {
        activeOrder {
            id
            code
            state
            totalQuantity
            subTotal
            subTotalWithTax
            shipping
            shippingWithTax
            total
            totalWithTax
            currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
            couponCodes
            customer {
                emailAddress
                firstName
                lastName
                phoneNumber
                ...ActiveCustomer
            }
            shippingAddress {
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country
                countryCode
                phoneNumber
            }
            billingAddress {
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country
                countryCode
                phoneNumber
            }
            shippingLines {
                priceWithTax
                shippingMethod {
                    id
                    name
                }
            }
            discounts {
                description
                amountWithTax
            }
            lines {
                id
                productVariant {
                    id
                    name
                    sku
                    product {
                        id
                        name
                        slug
                        featuredAsset {
                            id
                            preview
                        }
                        customFields {
                            designFee
                        }
                    }
                }
                unitPriceWithTax
                quantity
                linePriceWithTax
            }
        }
    }
`, [ActiveCustomerFragment]);

export const GetCustomerAddressesQuery = graphql(`
    query GetCustomerAddresses {
        activeCustomer {
            id
            addresses {
                id
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country {
                    id
                    code
                    name
                }
                phoneNumber
                defaultShippingAddress
                defaultBillingAddress
            }
        }
    }
`);

export const GetEligibleShippingMethodsQuery = graphql(`
    query GetEligibleShippingMethods {
        eligibleShippingMethods {
            id
            name
            code
            description
            priceWithTax
        }
    }
`);

export const GetEligiblePaymentMethodsQuery = graphql(`
    query GetEligiblePaymentMethods {
        eligiblePaymentMethods {
            id
            name
            code
            description
            isEligible
            eligibilityMessage
        }
    }
`);

export const GetAvailableCountriesQuery = graphql(`
    query GetAvailableCountries {
        availableCountries {
            id
            code
            name
        }
    }
`);

export const GetCustomerOrdersQuery = graphql(`
    query GetCustomerOrders($options: OrderListOptions) {
        activeCustomer {
            id
            orders(options: $options) {
                totalItems
                items {
                    id
                    code
                    state
                    totalWithTax
                    currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
                    createdAt
                    updatedAt
                    lines {
                        id
                        productVariant {
                            id
                            name
                            product {
                                id
                                name
                                featuredAsset {
                                    id
                                    preview
                                }
                            }
                        }
                    }
                    customFields {
                        batchExportedAt
                        isMergingWithOrderCode
                    }
                }
            }
        }
    }
`);

export const GetCustomerOrdersForCheckoutQuery = graphql(`
    query GetCustomerOrdersForCheckout($options: OrderListOptions) {
        activeCustomer {
            orders(options: $options) {
                 items { id code
                     shippingAddress { fullName company streetLine1 streetLine2 city province postalCode country phoneNumber }
                     shippingLines { 
                         priceWithTax 
                         shippingMethod {
                             id
                         }
                     }
                 }
            }
        }
    }
`);

export const GetOrderDetailQuery = graphql(`
    query GetOrderDetail($code: String!) {
        orderByCode(code: $code) {
            id
            code
            state
            active
            createdAt
            updatedAt
            totalQuantity
            subTotal
            subTotalWithTax
            shipping
            shippingWithTax
            total
            totalWithTax
            currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
            customer {
                id
                firstName
                lastName
                emailAddress
            }
            shippingAddress {
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country
                countryCode
                phoneNumber
            }
            billingAddress {
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country
                countryCode
                phoneNumber
            }
            shippingLines {
                priceWithTax
                shippingMethod {
                    id
                    name
                    description
                }
            }
            payments {
                id
                method
                amount
                state
                transactionId
                createdAt
            }
            lines {
                id
                productVariant {
                    id
                    name
                    sku
                    product {
                        id
                        name
                        slug
                        featuredAsset {
                            id
                            preview
                        }
                    }
                }
                unitPriceWithTax
                quantity
                linePriceWithTax
            }
            discounts {
                description
                amountWithTax
            }
            customFields {
                batchExportedAt
                isMergingWithOrderCode
            }
        }
    }
`);

export const GetActiveChannelQuery = graphql(`
    query GetActiveChannel {
        activeChannel {
            id
            code
            defaultLanguageCode
            availableLanguageCodes
            defaultCurrencyCode
            availableCurrencyCodes
        }
    }
`);

export const GetCollectionProductsQuery = graphql(`
    query GetCollectionProducts($slug: String!, $input: SearchInput!) {
        collection(slug: $slug) {
            id
            name
            slug
            description
            featuredAsset {
                id
                preview
            }
        }
        search(input: $input) {
            totalItems
            items {
                ...ProductCard
            }
        }
    }
`, [ProductCardFragment]);

export const GetMergeableOrdersQuery = graphql(`
    query GetMergeableOrders {
        getMergeableOrders {
            id
            code
            state
            orderPlacedAt
            totalWithTax
            currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
            shippingAddress {
                fullName
                company
                streetLine1
                streetLine2
                city
                province
                postalCode
                country
                countryCode
                phoneNumber
            }
            shippingMethodId
            shippingMethodName
        }
    }
`);
export const GetMyAllChannelOrdersQuery = graphql(`
    query GetMyAllChannelOrders {
        myAllChannelOrders {
            id
            code
            state
            active
            orderPlacedAt
            createdAt
            totalWithTax
            currencyCode
            taxSummary {
                description
                taxRate
                taxTotal
            }
            lineCount
            channelToken
            fulfillmentNames
            shippingAddress
        }
    }
`);

export const GetActiveWorldFirstPaymentsQuery = graphql(`
    query GetActiveWorldFirstPayments {
        activeWorldFirstPayments {
            id
            regionCode
            paymentMethodCode
            displayName
            logoUrl
        }
    }
`);

export const GetWorldFirstPaymentManifestQuery = graphql(`
    query GetWorldFirstPaymentManifest($countryCode: String!) {
        worldFirstPaymentManifest(countryCode: $countryCode) {
            paymentMethodCode
            displayName
            logoUrl
        }
    }
`);

export const GET_ACTIVE_KYC_FORM = graphql(`
    query GetActiveKycForm {
        activeAffiliateKycForm {
            ...AffiliateKycForm
        }
    }
`, [AffiliateKycFormFragment]);

export const SUBMIT_KYC_FORM = graphql(`
    mutation SubmitKycForm($input: KycFormInput!) {
        submitAffiliateKycForm(input: $input) {
            ...AffiliateKycForm
        }
    }
`, [AffiliateKycFormFragment]);
