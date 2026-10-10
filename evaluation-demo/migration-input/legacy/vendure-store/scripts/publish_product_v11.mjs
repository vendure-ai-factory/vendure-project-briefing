#!/usr/bin/env node

import { File } from 'buffer';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.PUBLISH_PRODUCT_DRY_RUN === '1';
const MANIFEST_PATH = resolveManifestPath();
const ARTIFACT_DIR = process.env.PUBLISH_PRODUCT_ARTIFACT_DIR
  ? path.resolve(process.env.PUBLISH_PRODUCT_ARTIFACT_DIR)
  : path.resolve(SCRIPT_DIR, '../work/tmp/publish-product-v11');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'result.json');

const ADMIN_API_URL = process.env.VENDURE_ADMIN_API_URL || '';
const SHOP_API_URL = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL || '';
const AUTH_HEADER = process.env.VENDURE_AUTH_TOKEN_HEADER || 'vendure-auth-token';
const ADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
const DEFAULT_CHANNEL_TOKENS = ['__default_channel__', 'de-token', 'at-token', 'hu-token', 'gb-token'];
const SEARCH_VISIBILITY_TIMEOUT_MS = Number(process.env.PUBLISH_PRODUCT_SEARCH_TIMEOUT_MS || 60_000);
const SEARCH_VISIBILITY_POLL_MS = Number(process.env.PUBLISH_PRODUCT_SEARCH_POLL_MS || 1_000);

const LOGIN_MUTATION = /* GraphQL */ `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      __typename
      ... on CurrentUser {
        id
        identifier
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const CHANNELS_QUERY = /* GraphQL */ `
  query Channels($options: ChannelListOptions) {
    channels(options: $options) {
      items {
        id
        code
        token
      }
    }
  }
`;

const ASSETS_QUERY = /* GraphQL */ `
  query Assets($options: AssetListOptions) {
    assets(options: $options) {
      items {
        id
        preview
        source
        translations {
          languageCode
          name
        }
      }
    }
  }
`;

const PRODUCT_QUERY = /* GraphQL */ `
  query ProductBySlug($slug: String!) {
    product(slug: $slug) {
      id
      name
      slug
      featuredAsset {
        id
        preview
      }
      assets {
        id
        preview
      }
      optionGroups {
        id
        code
      }
      variants {
        id
        sku
        name
      }
    }
  }
`;

const CREATE_ASSETS_MUTATION = /* GraphQL */ `
  mutation CreateAssets($input: [CreateAssetInput!]!) {
    createAssets(input: $input) {
      __typename
      ... on Asset {
        id
        preview
        source
        translations {
          languageCode
          name
        }
      }
      ... on MimeTypeError {
        message
      }
    }
  }
`;

const CREATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation CreateProduct($input: CreateProductInput!) {
    createProduct(input: $input) {
      id
      name
      slug
      enabled
      featuredAsset {
        id
        preview
      }
      assets {
        id
        preview
      }
      optionGroups {
        id
        code
      }
      variants {
        id
        sku
        name
      }
    }
  }
`;

const UPDATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation UpdateProduct($input: UpdateProductInput!) {
    updateProduct(input: $input) {
      id
      name
      slug
      enabled
      featuredAsset {
        id
        preview
      }
      assets {
        id
        preview
      }
      optionGroups {
        id
        code
      }
      variants {
        id
        sku
        name
      }
    }
  }
`;

const CREATE_PRODUCT_VARIANTS_MUTATION = /* GraphQL */ `
  mutation CreateProductVariants($input: [CreateProductVariantInput!]!) {
    createProductVariants(input: $input) {
      id
      sku
      name
      enabled
    }
  }
`;

const ADD_OPTION_GROUP_TO_PRODUCT_MUTATION = /* GraphQL */ `
  mutation AddOptionGroupToProduct($productId: ID!, $optionGroupId: ID!) {
    addOptionGroupToProduct(productId: $productId, optionGroupId: $optionGroupId) {
      id
      slug
      optionGroups {
        id
        code
      }
    }
  }
`;

const UPDATE_PRODUCT_VARIANT_MUTATION = /* GraphQL */ `
  mutation UpdateProductVariant($input: UpdateProductVariantInput!) {
    updateProductVariant(input: $input) {
      id
      sku
      name
      enabled
    }
  }
`;

const ASSIGN_PRODUCTS_TO_CHANNEL_MUTATION = /* GraphQL */ `
  mutation AssignProductsToChannel($input: AssignProductsToChannelInput!) {
    assignProductsToChannel(input: $input) {
      id
      name
      slug
    }
  }
`;

const COUNTRY_OPTION_GROUP_CODE = 'country';
const COUNTRY_OPTION_GROUP_NAME = 'Country';
const RAW_MATERIAL_OPTION_GROUP_CODE = 'nail-raw-material-items';
const COUNTRY_OPTION_NAMES = {
  DE: 'Germany',
  AT: 'Austria',
  HU: 'Hungary',
  GB: 'United Kingdom',
};

const COUNTRY_OPTION_GROUP_QUERY = /* GraphQL */ `
  query CountryOptionGroups($options: ProductOptionGroupListOptions) {
    productOptionGroups(options: $options) {
      items {
        id
        code
        name
        options {
          id
          code
          name
          group {
            code
          }
        }
      }
    }
  }
`;

const CREATE_PRODUCT_OPTION_GROUP_MUTATION = /* GraphQL */ `
  mutation CreateProductOptionGroup($input: CreateProductOptionGroupInput!) {
    createProductOptionGroup(input: $input) {
      id
      code
      name
      options {
        id
        code
        name
        group {
          code
        }
      }
    }
  }
`;

const CREATE_PRODUCT_OPTION_MUTATION = /* GraphQL */ `
  mutation CreateProductOption($input: CreateProductOptionInput!) {
    createProductOption(input: $input) {
      id
      code
      name
      group {
        code
      }
    }
  }
`;

const ASSIGN_PRODUCT_OPTION_GROUPS_TO_CHANNEL_MUTATION = /* GraphQL */ `
  mutation AssignProductOptionGroupsToChannel($input: AssignProductOptionGroupsToChannelInput!) {
    assignProductOptionGroupsToChannel(input: $input) {
      id
      code
      name
    }
  }
`;

const REINDEX_MUTATION = /* GraphQL */ `
  mutation Reindex {
    reindex {
      id
      state
      isSettled
    }
  }
`;

const SEARCH_QUERY = /* GraphQL */ `
  query SearchProducts($input: SearchInput!) {
    search(input: $input) {
      totalItems
      items {
        slug
        productName
        productAsset {
          id
          preview
        }
      }
    }
  }
`;

async function main() {
  const manifest = await loadManifest(MANIFEST_PATH);
  const envDesignerId = String(process.env.PUBLISH_PRODUCT_DESIGNER_ID || '').trim();
  if (envDesignerId) {
    manifest.product.customFields = {
      ...(manifest.product.customFields || {}),
      designerId: envDesignerId,
    };
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const adminToken = await login();
  const targetChannels = await resolveTargetChannels(adminToken, manifest.channels);

  if (DRY_RUN) {
    const dryRunResult = {
      manifestPath: MANIFEST_PATH,
      dryRun: true,
      targetChannels,
      status: 'dry-run',
    };
    await writeFile(RESULT_PATH, JSON.stringify(dryRunResult, null, 2), 'utf8');
    console.log(`DRY RUN publish product ${manifest.product.slug}`);
    console.log(`Manifest: ${MANIFEST_PATH}`);
    console.log(`Result: ${RESULT_PATH}`);
    return;
  }

  const uploadedAssets = await uploadAssets(
    adminToken,
    manifest.baseDir,
    manifest.product.assets || [],
    manifest.product.slug,
  );
  const { countryOptionIdsByCode, countryOptionGroupId } = await ensureCountryOptionSetup(adminToken, targetChannels);
  const product = await upsertProduct(adminToken, manifest.product, uploadedAssets);
  const hasCountryOptionGroup = Array.isArray(product.optionGroups) && product.optionGroups.some((optionGroup) => String(optionGroup.id) === String(countryOptionGroupId));
  if (!hasCountryOptionGroup) {
    await attachOptionGroupToProduct(adminToken, product.id, countryOptionGroupId);
  }
  const variants = await upsertVariants(adminToken, product.id, manifest.product.slug, manifest.variants || [], countryOptionIdsByCode);
  const assignedChannels = await assignProductToChannels(adminToken, product.id, targetChannels);

  let reindexJob = null;
  if (manifest.sync?.reindex !== false) {
    reindexJob = await reindexSearchIndex(adminToken);
  }

  if (!DRY_RUN && manifest.sync?.restartStorefront !== false) {
    await restartStorefrontService();
  }

  let verification = [];
  if (!DRY_RUN) {
    verification = await verifyAcrossChannels(product.slug, product.name, targetChannels);
  }

  const result = {
    manifestPath: MANIFEST_PATH,
    dryRun: DRY_RUN,
    product,
    uploadedAssets,
    variants,
    assignedChannels,
    reindexJob,
    verification,
    status: DRY_RUN ? 'dry-run' : 'passed',
  };

  await writeFile(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');

  console.log(`${DRY_RUN ? 'DRY RUN' : 'PASS'} publish product ${product.slug}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(`Result: ${RESULT_PATH}`);
}

async function loadManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.product?.slug) {
    throw new Error(`Manifest ${manifestPath} is missing product.slug`);
  }
  if (!Array.isArray(parsed.product.translations) || parsed.product.translations.length === 0) {
    throw new Error(`Manifest ${manifestPath} is missing product.translations`);
  }
  if (Array.isArray(parsed.variants)) {
    for (const [index, variant] of parsed.variants.entries()) {
      if (!variant?.sku) {
        throw new Error(`Manifest ${manifestPath} variant[${index}] is missing sku`);
      }
      if (!Array.isArray(variant.translations) || variant.translations.length === 0) {
        throw new Error(`Manifest ${manifestPath} variant[${index}] is missing translations`);
      }
    }
  }
  return {
    ...parsed,
    baseDir: path.dirname(manifestPath),
  };
}

async function uploadAssets(adminToken, baseDir, assetSpecs, productSlug) {
  const uploaded = [];
  for (const [index, spec] of assetSpecs.entries()) {
    const normalized = await normalizeAssetSpec(spec, baseDir, index, productSlug);
    const asset = await uploadAsset(adminToken, normalized);
    uploaded.push(asset);
  }
  return uploaded;
}

async function normalizeAssetSpec(spec, baseDir, index, productSlug) {
  const normalized = typeof spec === 'string' ? { path: spec } : { ...spec };
  if (!normalized.path) {
    throw new Error(`Asset spec[${index}] is missing path`);
  }
  const resolvedPath = path.isAbsolute(normalized.path)
    ? normalized.path
    : path.resolve(baseDir, normalized.path);
  const logicalName = normalized.name || path.basename(resolvedPath);
  const fingerprint = createHash('sha256')
    .update(await readFile(resolvedPath))
    .digest('hex')
    .slice(0, 16);
  const scope = `${productSlug || 'asset'}__${logicalName}__${fingerprint}`;
  const translations = Array.isArray(normalized.translations) && normalized.translations.length > 0
    ? normalized.translations.map((translation, translationIndex) => ({
        ...translation,
        name: translationIndex === 0
          ? scope
          : `${productSlug || 'asset'}__${translation.name || logicalName}__${fingerprint}`,
      }))
    : [{ languageCode: 'en', name: scope }];
  return {
    path: resolvedPath,
    name: scope,
    logicalName,
    tags: Array.isArray(normalized.tags) ? normalized.tags : [],
    translations,
    customFields: normalized.customFields || {},
    featured: Boolean(normalized.featured),
    mimeType: normalized.mimeType,
  };
}

async function uploadAsset(adminToken, spec) {
  const existing = await findExistingAsset(adminToken, spec.name);
  if (existing) {
    return {
      ...existing,
      name: spec.name,
      path: spec.path,
      featured: spec.featured,
      existing: true,
    };
  }

  const fileBuffer = await readFile(spec.path);
  const file = new File([fileBuffer], spec.name, {
    type: spec.mimeType || guessMimeType(spec.path),
  });

  const created = await graphqlUpload(
    CREATE_ASSETS_MUTATION,
    {
      input: [
        {
          customFields: spec.customFields,
          tags: spec.tags,
          translations: spec.translations.length > 0
            ? spec.translations
            : [{
                languageCode: 'en',
                name: spec.name,
              }],
          file: null,
        },
      ],
    },
    file,
    adminToken,
    ADMIN_API_URL,
  );

  const asset = created.createAssets?.[0];
  if (!asset || asset.__typename === 'MimeTypeError') {
    throw new Error(`Asset upload failed for ${spec.path}: ${JSON.stringify(created)}`);
  }

  return {
    ...asset,
    name: spec.name,
    path: spec.path,
    featured: spec.featured,
    existing: false,
  };
}

async function findExistingAsset(adminToken, assetName) {
  const result = await graphql(
    ASSETS_QUERY,
    {
      options: {
        take: 100,
        filter: {
          name: {
            eq: assetName,
          },
        },
      },
    },
    adminToken,
    ADMIN_API_URL,
  );

  return result.assets.items.find((item) =>
    item.translations?.some((translation) => translation.name === assetName)
  );
}

async function upsertProduct(adminToken, productSpec, uploadedAssets) {
  const assetIds = uploadedAssets.map((asset) => asset.id);
  const featuredAssetId = resolveFeaturedAssetId(productSpec, uploadedAssets);
  const existingResult = await graphql(PRODUCT_QUERY, { slug: productSpec.slug }, adminToken, ADMIN_API_URL);
  const existingProduct = existingResult.product;

  const input = {
    assetIds: assetIds.length > 0 ? assetIds : undefined,
    customFields: productSpec.customFields,
    enabled: productSpec.enabled ?? true,
    facetValueIds: productSpec.facetValueIds,
    featuredAssetId,
    translations: productSpec.translations.map((translation) => ({
      ...translation,
      slug: translation.slug || productSpec.slug,
    })),
  };

  if (existingProduct) {
    const updated = await graphql(
      UPDATE_PRODUCT_MUTATION,
      {
        input: {
          ...input,
          id: existingProduct.id,
        },
      },
      adminToken,
      ADMIN_API_URL,
    );
    return updated.updateProduct;
  }

  const created = await graphql(
    CREATE_PRODUCT_MUTATION,
    {
      input,
    },
    adminToken,
    ADMIN_API_URL,
  );
  return created.createProduct;
}

async function upsertVariants(adminToken, productId, productSlug, variantSpecs, countryOptionIdsByCode) {
  const result = await graphql(PRODUCT_QUERY, { slug: productSlug }, adminToken, ADMIN_API_URL).catch(() => ({ product: null }));
  const existingVariants = new Map((result.product?.variants || []).map((variant) => [variant.sku, variant]));
  const createdOrUpdated = [];

  for (const [index, spec] of variantSpecs.entries()) {
    const input = normalizeVariantInput(productId, spec, index, countryOptionIdsByCode);
    const existing = existingVariants.get(input.sku);
    if (existing) {
      const { productId: _ignoredProductId, ...updateInput } = input;
      const updated = await graphql(
        UPDATE_PRODUCT_VARIANT_MUTATION,
        {
          input: {
            ...updateInput,
            id: existing.id,
          },
        },
        adminToken,
        ADMIN_API_URL,
      );
      createdOrUpdated.push(updated.updateProductVariant);
      continue;
    }

    const created = await graphql(
      CREATE_PRODUCT_VARIANTS_MUTATION,
      {
        input: [input],
      },
      adminToken,
      ADMIN_API_URL,
    );
    createdOrUpdated.push(created.createProductVariants[0]);
  }

  return createdOrUpdated;
}

function normalizeVariantInput(productId, spec, index, countryOptionIdsByCode = new Map()) {
  const translations = Array.isArray(spec.translations) ? spec.translations : [];
  if (translations.length === 0) {
    throw new Error(`Variant spec[${index}] is missing translations`);
  }
  const explicitOptionIds = Array.isArray(spec.optionIds) ? spec.optionIds.filter(Boolean) : [];
  const countryCode = typeof spec.countryCode === 'string' ? spec.countryCode.trim().toUpperCase() : '';
  const resolvedCountryOptionIds = countryCode ? (countryOptionIdsByCode.get(countryCode) || []) : [];
  const optionIds = explicitOptionIds.length > 0
    ? explicitOptionIds
    : resolvedCountryOptionIds;

  if (countryCode && (!optionIds || optionIds.length === 0)) {
    throw new Error(`Variant spec[${index}] cannot resolve country option ids for ${countryCode}`);
  }

  return {
    productId,
    sku: spec.sku,
    enabled: spec.enabled ?? true,
    translations,
    price: spec.price,
    stockOnHand: spec.stockOnHand,
    outOfStockThreshold: spec.outOfStockThreshold,
    trackInventory: spec.trackInventory,
    customFields: spec.customFields,
    taxCategoryId: spec.taxCategoryId,
    facetValueIds: spec.facetValueIds,
    optionIds,
    assetIds: spec.assetIds,
    featuredAssetId: spec.featuredAssetId,
    useGlobalOutOfStockThreshold: spec.useGlobalOutOfStockThreshold,
    prices: Array.isArray(spec.prices) ? spec.prices : undefined,
  };
}

async function ensureCountryOptionSetup(adminToken, targetChannels) {
  const groupsResult = await graphql(
    COUNTRY_OPTION_GROUP_QUERY,
    { options: { take: 100 } },
    adminToken,
    ADMIN_API_URL,
  );

  const matchingGroups = groupsResult.productOptionGroups.items.filter((item) => String(item.code || '').trim().toLowerCase() === COUNTRY_OPTION_GROUP_CODE);
  let group = matchingGroups
    .slice()
    .sort((left, right) => Number(right.productCount || 0) - Number(left.productCount || 0))[0];
  const requiredChannelCodes = Array.from(new Set(targetChannels.map((channel) => String(channel.code || '').trim().toUpperCase()).filter(Boolean)));

  if (!group) {
    const created = await graphql(
      CREATE_PRODUCT_OPTION_GROUP_MUTATION,
      {
        input: {
          code: COUNTRY_OPTION_GROUP_CODE,
          translations: [{ languageCode: 'en', name: COUNTRY_OPTION_GROUP_NAME }],
          options: requiredChannelCodes.map((code) => ({
            code: code.toLowerCase(),
            translations: [{ languageCode: 'en', name: COUNTRY_OPTION_NAMES[code] || code }],
          })),
        },
      },
      adminToken,
      ADMIN_API_URL,
    );
    group = created.createProductOptionGroup;
  } else {
    const existingOptionCodes = new Set((group.options || []).map((option) => String(option.code || '').trim().toUpperCase()));
    for (const code of requiredChannelCodes) {
      if (existingOptionCodes.has(code)) {
        continue;
      }
      await graphql(
        CREATE_PRODUCT_OPTION_MUTATION,
        {
          input: {
            productOptionGroupId: group.id,
            code: code.toLowerCase(),
            translations: [{ languageCode: 'en', name: COUNTRY_OPTION_NAMES[code] || code }],
          },
        },
        adminToken,
        ADMIN_API_URL,
      );
    }

    const refreshed = await graphql(
      COUNTRY_OPTION_GROUP_QUERY,
      { options: { take: 100 } },
      adminToken,
      ADMIN_API_URL,
    );
    group = refreshed.productOptionGroups.items.find((item) => String(item.code || '').trim().toLowerCase() === COUNTRY_OPTION_GROUP_CODE) || group;
  }

    const refreshed = await graphql(
      COUNTRY_OPTION_GROUP_QUERY,
      { options: { take: 100 } },
      adminToken,
      ADMIN_API_URL,
    );
    const matchingGroupsAfterRefresh = refreshed.productOptionGroups.items.filter((item) => String(item.code || '').trim().toLowerCase() === COUNTRY_OPTION_GROUP_CODE);

    for (const channel of targetChannels) {
      await graphql(
        ASSIGN_PRODUCT_OPTION_GROUPS_TO_CHANNEL_MUTATION,
        {
          input: {
            productOptionGroupIds: [group.id],
            channelId: channel.id,
          },
        },
        adminToken,
        ADMIN_API_URL,
      );
    }

    const countryOptionIdsByCode = new Map();
  // A legacy database can contain duplicate groups with the same code. The product
  // is attached to `group`, so variant options must come from that group only.
  const countryGroupsToIndex = [group];
    for (const countryGroup of countryGroupsToIndex) {
      for (const option of countryGroup.options || []) {
        const code = String(option.code || '').trim().toUpperCase();
        if (!code) {
          continue;
        }
        const ids = countryOptionIdsByCode.get(code) || [];
        if (!ids.includes(option.id)) {
          ids.push(option.id);
        }
        countryOptionIdsByCode.set(code, ids);
      }
    }
  for (const code of requiredChannelCodes) {
    if (!countryOptionIdsByCode.has(code) || countryOptionIdsByCode.get(code).length === 0) {
      throw new Error(`Country option ${code} is missing from product option group ${COUNTRY_OPTION_GROUP_CODE}`);
    }
  }

  return { countryOptionIdsByCode, countryOptionGroupId: group.id };
}

async function attachOptionGroupToProduct(adminToken, productId, optionGroupId) {
  await graphql(
    ADD_OPTION_GROUP_TO_PRODUCT_MUTATION,
    {
      productId,
      optionGroupId,
    },
    adminToken,
    ADMIN_API_URL,
  );
}

async function assignProductToChannels(adminToken, productId, targetChannels) {
  const results = [];
  for (const channel of targetChannels) {
    const assigned = await graphql(
      ASSIGN_PRODUCTS_TO_CHANNEL_MUTATION,
      {
        input: {
          channelId: channel.id,
          priceFactor: channel.priceFactor,
          productIds: [productId],
        },
      },
      adminToken,
      ADMIN_API_URL,
    );

    results.push({
      channelCode: channel.code,
      token: channel.token,
      priceFactor: channel.priceFactor ?? null,
      assignedCount: assigned.assignProductsToChannel.length,
    });
  }
  return results;
}

async function resolveTargetChannels(adminToken, channelsSpec) {
  const channelsResult = await graphql(CHANNELS_QUERY, { options: { take: 100 } }, adminToken, ADMIN_API_URL);
  const channelSpecs = normalizeChannelSpecs(channelsSpec);
  const availableChannels = channelsResult.channels.items;
  const resolved = [];

  for (const spec of channelSpecs) {
    const channel = availableChannels.find((item) => item.token === spec.token || item.code === spec.code);
    if (!channel) {
      throw new Error(`Channel not found for token/code ${spec.token || spec.code}`);
    }
    resolved.push({
      ...channel,
      priceFactor: spec.priceFactor,
    });
  }
  return resolved;
}

function normalizeChannelSpecs(channelsSpec) {
  const raw = Array.isArray(channelsSpec) && channelsSpec.length > 0
    ? channelsSpec
    : DEFAULT_CHANNEL_TOKENS.map((token) => ({ token }));

  return raw.map((spec, index) => {
    if (typeof spec === 'string') {
      return { token: spec, priceFactor: 1 };
    }
    if (!spec?.token && !spec?.code) {
      throw new Error(`Channel spec[${index}] is missing token/code`);
    }
    return {
      token: spec.token,
      code: spec.code,
      priceFactor: spec.priceFactor ?? 1,
    };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSearchVisibility(productSlug, productName, channel) {
  const term = productName || productSlug;
  const deadline = Date.now() + SEARCH_VISIBILITY_TIMEOUT_MS;
  let lastSearchResult = null;

  while (Date.now() < deadline) {
    const searchResult = await graphql(
      SEARCH_QUERY,
      {
        input: {
          term,
          take: 100,
          skip: 0,
          groupByProduct: true,
          sort: { name: 'ASC' },
        },
      },
      undefined,
      SHOP_API_URL,
      channel.token,
    );

    lastSearchResult = searchResult;
    const foundProduct = searchResult.search.items.find((item) => item.slug === productSlug);
    if (foundProduct) {
      return { searchResult, foundProduct };
    }

    await delay(SEARCH_VISIBILITY_POLL_MS);
  }

  const lastItems = lastSearchResult?.search?.items?.map((item) => item.slug).filter(Boolean).join(', ') || '(none)';
  throw new Error(
    `Search result missing ${productSlug} for channel ${channel.code} after waiting ${SEARCH_VISIBILITY_TIMEOUT_MS}ms; last items: ${lastItems}`,
  );
}

async function verifyAcrossChannels(productSlug, productName, targetChannels) {
  const verification = [];
  for (const channel of targetChannels) {
    const { foundProduct } = await waitForSearchVisibility(productSlug, productName, channel);

    const productResult = await graphql(
      PRODUCT_QUERY,
      { slug: productSlug },
      undefined,
      SHOP_API_URL,
      channel.token,
    );

    const product = productResult.product;
    if (!product) {
      throw new Error(`Product ${productSlug} missing in channel ${channel.code}`);
    }
    if (!product.featuredAsset) {
      throw new Error(`Product ${productSlug} has no featured asset in channel ${channel.code}`);
    }

    verification.push({
      channelCode: channel.code,
      token: channel.token,
      productSlug,
      featuredAssetId: product.featuredAsset.id,
      searchAssetId: foundProduct.productAsset?.id || '',
    });
  }
  return verification;
}

async function reindexSearchIndex(adminToken) {
  const result = await graphql(REINDEX_MUTATION, {}, adminToken, ADMIN_API_URL);
  const job = result.reindex;
  if (!job) {
    throw new Error('Reindex mutation returned no job');
  }
  console.log(`Reindex job: ${job.id} state=${job.state} settled=${job.isSettled}`);
  return job;
}

async function restartStorefrontService() {
  await new Promise((resolve, reject) => {
    execFile('sudo', ['systemctl', 'restart', 'vendure-product-storefront.service'], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Storefront restart failed: ${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve();
    });
  });
}

async function login() {
  if (!ADMIN_API_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
    throw new Error('VENDURE_ADMIN_API_URL, SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD are required.');
  }
  const result = await graphql(
    LOGIN_MUTATION,
    {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    },
    undefined,
    ADMIN_API_URL,
  );

  const loginResult = result.login;
  if (!loginResult || loginResult.__typename !== 'CurrentUser') {
    const message = loginResult?.__typename === 'ErrorResult'
      ? `${loginResult.errorCode}: ${loginResult.message}`
      : 'Unexpected login response';
    throw new Error(`Admin login failed: ${message}`);
  }

  if (!result.__token) {
    throw new Error(`Admin login did not return the ${AUTH_HEADER} auth token header.`);
  }

  return result.__token;
}

async function graphql(query, variables, token, url, channelToken) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(channelToken ? { 'vendure-token': channelToken } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(', '));
  }

  return {
    ...payload.data,
    __token: response.headers.get(AUTH_HEADER),
  };
}

async function graphqlUpload(query, variables, file, token, url) {
  const form = new FormData();
  form.append('operations', JSON.stringify({ query, variables }));
  form.append('map', JSON.stringify({ 0: ['variables.input.0.file'] }));
  form.append('0', file);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(', '));
  }

  return payload.data;
}

function resolveManifestPath() {
  if (process.env.PUBLISH_PRODUCT_MANIFEST) {
    return path.resolve(process.env.PUBLISH_PRODUCT_MANIFEST);
  }
  const preferred = path.resolve(SCRIPT_DIR, 'product_info.json');
  if (existsSync(preferred)) {
    return preferred;
  }
  const example = path.resolve(SCRIPT_DIR, 'product_info.example.json');
  if (DRY_RUN && existsSync(example)) {
    return example;
  }
  return preferred;
}

function resolveAdminApiUrl() {
  if (process.env.VENDURE_ADMIN_API_URL) {
    return process.env.VENDURE_ADMIN_API_URL;
  }

  const shopApiUrl = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL;
  if (shopApiUrl) {
    return shopApiUrl.replace(/\/shop-api\/?$/, '/admin-api');
  }

  const vendureHost = process.env.VENDURE_HOST;
  if (vendureHost) {
    return `${vendureHost.replace(/\/$/, '')}/admin-api`;
  }

  throw new Error('VENDURE_ADMIN_API_URL must be set explicitly.');
}

function resolveFeaturedAssetId(productSpec, uploadedAssets) {
  if (productSpec.featuredAssetId) {
    return productSpec.featuredAssetId;
  }
  const explicitPath = productSpec.featuredAssetPath;
  if (explicitPath) {
    const resolved = uploadedAssets.find((asset) => asset.path === resolveMaybeRelativePath(explicitPath, MANIFEST_PATH));
    if (resolved) {
      return resolved.id;
    }
  }
  if (uploadedAssets.length > 0) {
    return uploadedAssets[0].id;
  }
  return undefined;
}

function resolveMaybeRelativePath(candidatePath, manifestPath) {
  return path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(path.dirname(manifestPath), candidatePath);
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
