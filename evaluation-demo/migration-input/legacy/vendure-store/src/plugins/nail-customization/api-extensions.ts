import gql from 'graphql-tag';

/**
 * GraphQL Schema 扩展
 * 
 * 为 Shop API 添加指甲档案管理和甲片尺寸查询功能。
 */
export const shopApiExtensions = gql`
    type NailProfile {
        id: ID!
        profileName: String!
        fingerSizes: JSON!
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    type NailSizeEntry {
        index: Int!
        number: String!
        arcLength: Float!
        chordLength: Float
    }

    type NailSizeMatch {
        number: String!
        arcLength: Float!
        chordLength: Float
        exact: Boolean!
    }

    type NailShapeInfo {
        code: String!
        nameZh: String!
        nameDe: String!
        sizes: [NailSizeEntry!]!
    }

    input CreateNailProfileInput {
        profileName: String!
        fingerSizes: JSON!
    }

    input UpdateNailProfileInput {
        profileName: String
        fingerSizes: JSON
    }

    extend type Query {
        """ 获取当前登录用户的所有指甲档案 """
        myNailProfiles: [NailProfile!]!
        """ 获取指定甲型的尺寸对照表 """
        nailSizeChart(shapeCode: String!): [NailSizeEntry!]!
        """ 获取所有甲型信息 """
        allNailShapes: [NailShapeInfo!]!
        """ 根据弧长和甲型匹配甲片型号 """
        matchNailSize(arcLength: Float!, shapeCode: String!): NailSizeMatch
    }

    extend type Mutation {
        """ 创建新的指甲档案 """
        createNailProfile(input: CreateNailProfileInput!): NailProfile!
        """ 更新指定的指甲档案 """
        updateNailProfile(id: ID!, input: UpdateNailProfileInput!): NailProfile!
        """ 删除指定的指甲档案 """
        deleteNailProfile(id: ID!): DeletionResponse!
    }
`;

export const adminApiExtensions = gql`
    type NailProfile {
        id: ID!
        profileName: String!
        fingerSizes: JSON!
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    extend type Query {
        """ 管理员：获取指定客户的指甲档案 """
        customerNailProfiles(customerId: ID!): [NailProfile!]!
    }
`;
