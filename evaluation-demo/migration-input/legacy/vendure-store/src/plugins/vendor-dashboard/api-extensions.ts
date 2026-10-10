import { gql } from 'graphql-tag';

export const shopApiExtensions = gql`
  type VendorOverview {
    totalSales: Int!
    activeProductCount: Int!
    pendingOrderCount: Int!
  }

  extend type Query {
    vendorOverview: VendorOverview!
  }
`;
