import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    extend type Mutation {
        transferBalance(receiverId: ID!, amount: Int!): TransferBalanceResult!
    }

    type TransferBalanceResult {
        success: Boolean!
        message: String
        newBalance: Int
    }
`;
