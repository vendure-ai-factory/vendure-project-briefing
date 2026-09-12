import { query } from './api';
import { graphql } from '@/graphql';

// Note: Since we cannot run codegen to update the schema definition for gql.tada,
// we will define the query and manually type the expected response for now.
// In a real workflow, we would run `npm run codegen` first.

export const VendorOverviewQuery = graphql(`
  query VendorOverview {
    vendorOverview {
      totalSales
      activeProductCount
      pendingOrderCount
    }
  }
`);

export async function getVendorOverview() {
  // Pass useAuthToken: true to automatically attach the user's session token
  const { data } = await query(VendorOverviewQuery, {}, { useAuthToken: true });
  return data.vendorOverview;
}

// ─── 客户发布设计 API ───────────────────────────────────────────────────────

const VENDURE_API_URL = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL || 'http://127.0.0.1:54321/shop-api';

/**
 * 获取制作费信息（服务端调用）
 */
export async function getCraftFeeInfo(channelToken?: string): Promise<{ channelToken: string; currency: string; craftFee: number }> {
  const { data } = await query(
    graphql(`query CraftFeeInfo($channelToken: String) { craftFeeInfo(channelToken: $channelToken) { channelToken currency craftFee } }`),
    { channelToken },
    { useAuthToken: true },
  );
  return (data as any).craftFeeInfo;
}

/**
 * 获取所有国家/渠道的制作费信息
 */
export async function getAllCraftFeeInfo(): Promise<Array<{ channelToken: string; currency: string; craftFee: number }>> {
  const { data } = await query(
    graphql(`query AllCraftFeeInfo { allCraftFeeInfo { channelToken currency craftFee } }`),
    {},
    { useAuthToken: true },
  );
  return (data as any).allCraftFeeInfo || [];
}

/**
 * 获取分成规则（服务端调用）
 */
export async function getCommissionInfo(channelToken?: string): Promise<{
  channelToken: string;
  currency: string;
  tiers: Array<{ from: number; to: number; platformRate: number; designerRate: number }>;
}> {
  const { data } = await query(
    graphql(`query CommissionInfo($channelToken: String) { commissionInfo(channelToken: $channelToken) { channelToken currency tiers { from to platformRate designerRate } } }`),
    { channelToken },
    { useAuthToken: true },
  );
  return (data as any).commissionInfo;
}

/**
 * 获取所有国家的分成规则
 */
export async function getAllCommissionInfo(): Promise<Array<{
  channelToken: string;
  currency: string;
  tiers: Array<{ from: number; to: number; platformRate: number; designerRate: number }>;
}>> {
  const { data } = await query(
    graphql(`query AllCommissionInfo { allCommissionInfo { channelToken currency tiers { from to platformRate designerRate } } }`),
    {},
    { useAuthToken: true },
  );
  return (data as any).allCommissionInfo || [];
}

/**
 * 获取我发布的所有设计（服务端调用）
 */
export async function getMyDesigns(): Promise<Array<{
  productId: string;
  name: string;
  sku: string;
  designFee: number;
  craftFee: number;
  totalPrice: number;
  status: string;
  salesCount: number;
  totalEarnings: number;
  createdAt: string;
  featuredAssetUrl: string | null;
}>> {
  const { data } = await query(
    graphql(`query MyDesigns { myDesigns { productId name sku designFee craftFee totalPrice status salesCount totalEarnings createdAt featuredAssetUrl } }`),
    {},
    { useAuthToken: true },
  );
  return (data as any).myDesigns || [];
}

/**
 * 发布新设计（客户端调用，使用 multipart/form-data 上传文件）
 *
 * GraphQL Upload 需要使用 multipart/form-data 规范：
 * https://github.com/jaydenseric/graphql-multipart-request-spec
 */
export async function publishDesign(input: {
  name: string;
  priceSettings: Array<{ channelToken: string; designFee: number; stockLevel?: number }>;
  mainEffectImage?: File;
  designPairs?: Array<{ designImage: File; effectImage: File }>;
  authToken: string;
  channelToken?: string;
  templateProductId?: string;
}): Promise<{ success: boolean; productId?: string; sku?: string; message?: string }> {
  // 构建 GraphQL multipart request
  const operations = {
    query: `mutation PublishDesign(
            $name: String!
            $priceSettings: [PriceSettingInput!]!
            $mainEffectImage: Upload
            $designPairs: [DesignImagePairInput!]
            $templateProductId: ID
        ) {
            publishDesign(
                name: $name
                priceSettings: $priceSettings
                mainEffectImage: $mainEffectImage
                designPairs: $designPairs
                templateProductId: $templateProductId
            ) {
                success
                productId
                sku
                message
            }
        }`,
    variables: {
      name: input.name,
      priceSettings: input.priceSettings,
      mainEffectImage: null,
      designPairs: input.designPairs ? input.designPairs.map(() => ({
        designImage: null,
        effectImage: null,
      })) : null,
      templateProductId: input.templateProductId || null,
    },
  };

  // 构建文件映射关系
  const map: Record<string, string[]> = {};
  let fileIndex = 0;

  // 主效果大图 (如果存在)
  if (input.mainEffectImage && input.mainEffectImage instanceof File) {
    map[String(fileIndex)] = ['variables.mainEffectImage'];
    fileIndex++;
  }

  // 设计图+效果图配对 (如果存在)
  if (input.designPairs) {
    for (let i = 0; i < input.designPairs.length; i++) {
      if (input.designPairs[i].designImage instanceof File) {
        map[String(fileIndex)] = [`variables.designPairs.${i}.designImage`];
        fileIndex++;
      }
      if (input.designPairs[i].effectImage instanceof File) {
        map[String(fileIndex)] = [`variables.designPairs.${i}.effectImage`];
        fileIndex++;
      }
    }
  }

  // 构建 FormData
  const formData = new FormData();
  formData.append('operations', JSON.stringify(operations));
  formData.append('map', JSON.stringify(map));

  // 按照 map 的顺序添加文件
  let fi = 0;
  if (input.mainEffectImage && input.mainEffectImage instanceof File) {
    formData.append(String(fi++), input.mainEffectImage);
  }
  if (input.designPairs && input.designPairs.length > 0) {
    for (const pair of input.designPairs) {
      if (pair.designImage instanceof File) {
        formData.append(String(fi++), pair.designImage);
      }
      if (pair.effectImage instanceof File) {
        formData.append(String(fi++), pair.effectImage);
      }
    }
  }

  const response = await fetch(VENDURE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${input.authToken}`,
      'vendure-auth-token': input.authToken,
      ...(input.channelToken && { 'vendure-token': input.channelToken }),
    },
    body: formData,
  });

  const result = await response.json();

  if (result.errors) {
    return { success: false, message: result.errors.map((e: any) => e.message).join(', ') };
  }

  return result.data?.publishDesign || { success: false, message: '未知错误' };
}

/**
 * 获取单个设计详情（用于模板/克隆）
 */
export async function getDesignById(id: string): Promise<{
  productId: string;
  name: string;
  mainEffectImage: string | null;
  designPairs: Array<{ designImageUrl: string; effectImageUrl: string }>;
  priceSettings: Array<{ channelToken: string; designFee: number }>;
} | null> {
  const { data } = await query(
    graphql(`query GetDesignTemplate($id: ID!) { 
      getDesignTemplate(productId: $id) { 
        productId name mainEffectImage 
        designPairs { designImageUrl effectImageUrl }
        priceSettings { channelToken designFee }
      } 
    }`),
    { id },
    { useAuthToken: true },
  );

  const template = (data as any)?.getDesignTemplate;
  if (!template) return null;

  return {
    productId: template.productId,
    name: template.name,
    mainEffectImage: template.mainEffectImage,
    designPairs: template.designPairs,
    priceSettings: template.priceSettings,
  };
}

/**
 * 下架设计（客户端调用）
 */
export async function delistDesign(productId: string, authToken: string): Promise<boolean> {
  const response = await fetch(VENDURE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'vendure-auth-token': authToken,
    },
    body: JSON.stringify({
      query: `mutation DelistMyDesign($productId: ID!) { delistMyDesign(productId: $productId) }`,
      variables: { productId },
    }),
  });

  const result = await response.json();
  return result.data?.delistMyDesign ?? false;
}
