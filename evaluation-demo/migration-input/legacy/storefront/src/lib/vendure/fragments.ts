import { graphql } from '@/graphql';

export const ProductCardFragment = graphql(`
    fragment ProductCard on SearchResult {
        productId
        productName
        slug
        productAsset {
            id
            preview
        }
        priceWithTax {
            __typename
            ... on PriceRange {
                min
                max
            }
            ... on SinglePrice {
                value
            }
        }
        currencyCode
    }
`);

export const ActiveCustomerFragment = graphql(`
    fragment ActiveCustomer on Customer {
        id
        firstName
        lastName
        emailAddress
        customFields {
            countryCode
            balanceWithdrawable
            balanceBonus
            balanceNonWithdrawable
            isDesigner
            isKycVerified
            agbVersion
            lastCountrySwitchAt
            annualSpentEur
        }
        addresses {
            country {
                code
            }
        }
        payouts {
            id
            createdAt
            amount
            currencyCode
            state
            methodCode
            errorMessage
        }
    }
`);

export const AffiliateKycFormFragment = graphql(`
    fragment AffiliateKycForm on AffiliateKycForm {
        id
        firstName
        lastName
        street
        houseNumber
        zip
        city
        country
        taxId
        vatId
        isSmallBusiness
        agbAccepted
        agbIpAddress
        agbTimestamp
        hash
        source
    }
`);
