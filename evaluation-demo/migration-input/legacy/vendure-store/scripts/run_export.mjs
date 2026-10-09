#!/usr/bin/env node

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_API_URL = process.env.VENDURE_ADMIN_API_URL || resolveAdminApiUrl();
const AUTH_HEADER = process.env.VENDURE_AUTH_TOKEN_HEADER || 'vendure-auth-token';
const ADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
const DEFAULT_OUTPUT_DIR = process.env.EXPORT_ORDERS_ARTIFACT_DIR
  ? path.resolve(process.env.EXPORT_ORDERS_ARTIFACT_DIR)
  : path.resolve(SCRIPT_DIR, '../work/tmp/order-export');

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

const ORDERS_QUERY = /* GraphQL */ `
  query Orders($options: OrderListOptions) {
    orders(options: $options) {
      totalItems
      items {
        id
        code
        state
        createdAt
        updatedAt
        orderPlacedAt
        currencyCode
        total
        totalWithTax
        subTotal
        subTotalWithTax
        shipping
        shippingWithTax
        totalQuantity
        customer {
          id
          firstName
          lastName
          emailAddress
        }
        shippingAddress {
          fullName
          country
          countryCode
          province
          city
          postalCode
          streetLine1
          streetLine2
          phoneNumber
        }
        lines {
          id
          quantity
          customFields {
            isSelectedAsGift
          }
          productVariant {
            id
            sku
            name
          }
        }
      }
    }
  }
`;

const TRANSITION_ORDER_TO_STATE_MUTATION = /* GraphQL */ `
  mutation TransitionOrderToState($id: ID!, $state: String!) {
    transitionOrderToState(id: $id, state: $state) {
      __typename
      ... on Order {
        id
        code
        state
      }
      ... on OrderStateTransitionError {
        errorCode
        message
        fromState
        toState
        transitionError
      }
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = normalizeDateArg(args.start || defaultYesterdayUtcStart());
  const end = normalizeDateArg(args.end || new Date().toISOString());
  const countryFilter = normalizeCountryCode(args.country || '');
  const settleState = args.settle ? (args.settleState || 'PaymentSettled') : '';
  const pageSize = Number(args.take || 100);

  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error(`Invalid --take value: ${args.take}`);
  }

  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(DEFAULT_OUTPUT_DIR, safeTimestamp(new Date()));
  await mkdir(outputDir, { recursive: true });

  const authToken = await login();
  const orders = await fetchOrders(authToken, { start, end, pageSize });
  const filteredOrders = countryFilter
    ? orders.filter((order) => resolveOrderCountry(order) === countryFilter)
    : orders;

  const rows = flattenOrders(filteredOrders);
  const jsonPath = path.join(outputDir, 'orders.json');
  const csvPath = path.join(outputDir, 'orders.csv');
  const summaryPath = path.join(outputDir, 'summary.txt');

  await writeFile(jsonPath, `${JSON.stringify({
    start,
    end,
    countryFilter: countryFilter || null,
    totalFetched: orders.length,
    totalExported: filteredOrders.length,
    orders: filteredOrders,
  }, null, 2)}\n`, 'utf8');

  await writeFile(csvPath, `${toCsv(rows)}\n`, 'utf8');

  let settled = [];
  if (settleState) {
    settled = await settleExportedOrders(authToken, filteredOrders, settleState);
  }

  const summaryLines = [
    `Export window: ${start} -> ${end}`,
    `Country filter: ${countryFilter || 'ALL'}`,
    `Orders fetched: ${orders.length}`,
    `Orders exported: ${filteredOrders.length}`,
    `CSV rows: ${rows.length}`,
    `Output dir: ${outputDir}`,
    `JSON: ${jsonPath}`,
    `CSV: ${csvPath}`,
    `Settle state: ${settleState || '<none>'}`,
    `Settled orders: ${settled.length}`,
  ];

  await writeFile(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

  const result = {
    start,
    end,
    countryFilter: countryFilter || null,
    outputDir,
    jsonPath,
    csvPath,
    summaryPath,
    totalFetched: orders.length,
    totalExported: filteredOrders.length,
    csvRows: rows.length,
    settled,
    status: 'passed',
  };

  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`PASS export orders`);
  console.log(`Window: ${start} -> ${end}`);
  console.log(`Country: ${countryFilter || 'ALL'}`);
  console.log(`Exported: ${filteredOrders.length} order(s), ${rows.length} CSV row(s)`);
  console.log(`Output: ${outputDir}`);
  if (settleState) {
    console.log(`Settled: ${settled.length} order(s) to ${settleState}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === '--settle') {
      parsed.settle = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    parsed[key] = value;
  }
  return parsed;
}

async function login() {
  if (!ADMIN_API_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
    throw new Error('VENDURE_ADMIN_API_URL, SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD are required.');
  }
  const result = await graphql(
    LOGIN_MUTATION,
    { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
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

async function fetchOrders(authToken, { start, end, pageSize }) {
  const items = [];
  let skip = 0;

  while (true) {
    const payload = await graphql(
      ORDERS_QUERY,
      {
        options: {
          take: pageSize,
          skip,
          sort: {
            orderPlacedAt: 'ASC',
          },
          filter: {
            orderPlacedAt: {
              between: {
                start,
                end,
              },
            },
            state: {
              in: ['PaymentAuthorized', 'PaymentSettled'],
            },
          },
        },
      },
      authToken,
      ADMIN_API_URL,
    );

    const page = payload.orders?.items || [];
    items.push(...page);
    if (page.length < pageSize) {
      break;
    }
    skip += pageSize;
  }

  return items;
}

async function settleExportedOrders(authToken, orders, settleState) {
  const settled = [];
  for (const order of orders) {
    if (order.state !== 'PaymentAuthorized') {
      continue;
    }

    const payload = await graphql(
      TRANSITION_ORDER_TO_STATE_MUTATION,
      {
        id: order.id,
        state: settleState,
      },
      authToken,
      ADMIN_API_URL,
    );

    const result = payload.transitionOrderToState;
    if (!result || result.__typename !== 'Order') {
      throw new Error(`Failed to transition order ${order.code}: ${JSON.stringify(result)}`);
    }
    settled.push({
      id: result.id,
      code: result.code,
      state: result.state,
    });
  }
  return settled;
}

function flattenOrders(orders) {
  const rows = [];
  for (const order of orders) {
    const base = {
      orderId: order.id,
      orderCode: order.code,
      orderState: order.state,
      orderPlacedAt: order.orderPlacedAt || '',
      createdAt: order.createdAt || '',
      updatedAt: order.updatedAt || '',
      currencyCode: order.currencyCode || '',
      total: order.total ?? '',
      totalWithTax: order.totalWithTax ?? '',
      subTotal: order.subTotal ?? '',
      subTotalWithTax: order.subTotalWithTax ?? '',
      shipping: order.shipping ?? '',
      shippingWithTax: order.shippingWithTax ?? '',
      totalQuantity: order.totalQuantity ?? '',
      customerEmail: order.customer?.emailAddress || '',
      customerName: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' '),
      shippingFullName: order.shippingAddress?.fullName || '',
      shippingCountryCode: order.shippingAddress?.countryCode || '',
      shippingCountry: order.shippingAddress?.country || '',
      shippingProvince: order.shippingAddress?.province || '',
      shippingCity: order.shippingAddress?.city || '',
      shippingPostalCode: order.shippingAddress?.postalCode || '',
      shippingStreetLine1: order.shippingAddress?.streetLine1 || '',
      shippingStreetLine2: order.shippingAddress?.streetLine2 || '',
      shippingPhoneNumber: order.shippingAddress?.phoneNumber || '',
      lineCount: order.lines?.length || 0,
    };

    if (!order.lines || order.lines.length === 0) {
      rows.push({
        ...base,
        lineId: '',
        variantId: '',
        variantSku: '',
        variantName: '',
        lineQuantity: '',
        lineIsGift: '',
      });
      continue;
    }

    for (const line of order.lines) {
      rows.push({
        ...base,
        lineId: line.id,
        variantId: line.productVariant?.id || '',
        variantSku: line.productVariant?.sku || '',
        variantName: line.productVariant?.name || '',
        lineQuantity: line.quantity,
        lineIsGift: line.customFields?.isSelectedAsGift ? '1' : '0',
      });
    }
  }
  return rows;
}

function toCsv(rows) {
  if (rows.length === 0) {
      return 'orderId,orderCode,orderState,orderPlacedAt,createdAt,updatedAt,currencyCode,total,totalWithTax,subTotal,subTotalWithTax,shipping,shippingWithTax,totalQuantity,customerEmail,customerName,shippingFullName,shippingCountryCode,shippingCountry,shippingProvince,shippingCity,shippingPostalCode,shippingStreetLine1,shippingStreetLine2,shippingPhoneNumber,lineCount,lineId,variantId,variantSku,variantName,lineQuantity,lineIsGift';
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return lines.join('\n');
}

function csvEscape(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function resolveOrderCountry(order) {
  return (
    order.shippingAddress?.countryCode ||
    ''
  ).toUpperCase();
}

function normalizeDateArg(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return date.toISOString();
}

function defaultYesterdayUtcStart() {
  const now = new Date();
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
    0,
    0,
    0,
    0,
  ));
  return yesterday.toISOString();
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function normalizeCountryCode(value) {
  return value ? String(value).trim().toUpperCase() : '';
}

async function graphql(query, variables, token, url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
