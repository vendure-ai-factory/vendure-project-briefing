import gql from 'graphql-tag';

export const onboardingApiExtensions = gql`
    input OnboardCountryInput {
        countryCode: String!
        countryName: String!
        currencyCode: String!
        continent: String
        worldFirstId: String
        shippingCalculatorCode: String
    }

    extend type Mutation {
        onboardCountry(input: OnboardCountryInput!): Boolean!
    }
`;
