#!/usr/bin/env node
// Public-safe version: credentials and API origin must be supplied by the authorized staging environment.
// Dry-run remains available without credentials; commit modes require explicit environment variables.

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_API_URL = process.env.VENDURE_ADMIN_API_URL || '';
const AUTH_HEADER = process.env.VENDURE_AUTH_TOKEN_HEADER || 'vendure-auth-token';
const ADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
const DEFAULT_OUTPUT_DIR = process.env.PROCESS_SHIPPING_ARTIFACT_DIR
  ? path.resolve(process.env.PROCESS_SHIPPING_ARTIFACT_DIR)
  : path.resolve(SCRIPT_DIR, '../work/tmp/process-shipping-csv');

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

const ORDER_BY_CODE_QUERY = /* GraphQL */ `
  query OrderByCode($code: String!) {
    orders(options: { filter: { code: { eq: $code } }, take: 1 }) {
      items {
        id
        code
        state
        fulfillments {
          id
          state
          trackingCode
        }
        lines {
          id
          quantity
          productVariant {
            id
            sku
            name
            stockOnHand
          }
        }
      }
    }
  }
`;

const ADD_FULFILLMENT_MUTATION = /* GraphQL */ `
  mutation FulfillOrder($input: FulfillOrderInput!) {
    addFulfillmentToOrder(input: $input) {
      __typename
      ... on Fulfillment {
        id
        state
        trackingCode
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const UPDATE_PRODUCT_VARIANT_MUTATION = /* GraphQL */ `
  mutation UpdateProductVariant($input: UpdateProductVariantInput!) {
    updateProductVariant(input: $input) {
      id
      sku
      stockOnHand
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = args.csv || args._[0];
  if (!csvPath) {
    throw new Error('Usage: npm run process:shipping-csv -- --csv=<path-to-orders.csv> [--commit]');
  }

  const commit = Boolean(args.commit);
  const reconcileStockOnly = Boolean(args['reconcile-stock'] || args['stock-only']);
  if (commit && reconcileStockOnly) {
    throw new Error('Use either --commit or --reconcile-stock, not both');
  }
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(DEFAULT_OUTPUT_DIR, safeTimestamp(new Date()));

  await mkdir(outputDir, { recursive: true });

  const rawCsv = await readFile(path.resolve(csvPath), 'utf8');
  const rows = parseCsv(rawCsv);
  if (rows.length === 0) {
    throw new Error(`CSV file ${csvPath} has no data rows`);
  }

  const requiredColumns = ['orderCode', 'lineId', 'lineQuantity', 'variantSku'];
  for (const column of requiredColumns) {
    if (!(column in rows[0])) {
      throw new Error(`CSV file ${csvPath} is missing required column ${column}`);
    }
  }

  const plans = buildPlans(rows);
  const deductionPlan = buildDeductionPlan(plans);

  let committed = [];
  let stockAdjustments = [];
  if (commit) {
    const authToken = await login();
    const commitResult = await commitPlans(authToken, plans);
    committed = commitResult.committed;
    stockAdjustments = await applyStockDeductions(authToken, commitResult.fulfilledLines);
  } else if (reconcileStockOnly) {
    const authToken = await login();
    stockAdjustments = await reconcileStockAdjustments(authToken, plans);
  }

  const jsonPath = path.join(outputDir, 'shipping-plan.json');
  const summaryPath = path.join(outputDir, 'summary.txt');
  const resultPath = path.join(outputDir, 'result.json');

  const result = {
    csvPath: path.resolve(csvPath),
    commit,
    reconcileStockOnly,
    totalRows: rows.length,
    totalOrders: plans.length,
    deductionPlan,
    committed,
    stockAdjustments,
    outputDir,
    status: 'passed',
  };

  await writeFile(jsonPath, `${JSON.stringify({ rows, plans, deductionPlan }, null, 2)}\n`, 'utf8');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(summaryPath, `${[
    `CSV: ${path.resolve(csvPath)}`,
    `Commit: ${commit ? 'yes' : 'no'}`,
    `Reconcile stock only: ${reconcileStockOnly ? 'yes' : 'no'}`,
    `Orders: ${plans.length}`,
    `Rows: ${rows.length}`,
    `Committed: ${committed.length}`,
    `Output dir: ${outputDir}`,
    `Shipping plan: ${jsonPath}`,
    `Result: ${resultPath}`,
  ].join('\n')}\n`, 'utf8');

  console.log(`PASS process shipping csv`);
  console.log(`CSV: ${path.resolve(csvPath)}`);
  console.log(`Commit: ${commit ? 'yes' : 'no'}`);
  console.log(`Reconcile stock only: ${reconcileStockOnly ? 'yes' : 'no'}`);
  console.log(`Orders: ${plans.length}, rows: ${rows.length}`);
  console.log(`Output: ${outputDir}`);
  if (commit) {
    console.log(`Committed: ${committed.length} order(s)`);
    console.log(`Stock adjustments: ${stockAdjustments.length} variant(s)`);
  } else if (reconcileStockOnly) {
    console.log(`Stock adjustments: ${stockAdjustments.length} variant(s)`);
  }
}

function buildPlans(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const orderCode = String(row.orderCode || '').trim();
    if (!orderCode) {
      continue;
    }

    if (!grouped.has(orderCode)) {
      grouped.set(orderCode, {
        orderCode,
        orderState: String(row.orderState || '').trim(),
        shippingCountryCode: String(row.shippingCountryCode || '').trim().toUpperCase(),
        customerEmail: String(row.customerEmail || '').trim(),
        customerName: String(row.customerName || '').trim(),
        lineItems: [],
      });
    }

    const plan = grouped.get(orderCode);
    plan.lineItems.push({
      lineId: String(row.lineId || '').trim(),
      lineQuantity: Number(row.lineQuantity || 0),
      variantSku: String(row.variantSku || '').trim(),
      variantName: String(row.variantName || '').trim(),
    });
  }

  return Array.from(grouped.values()).map((plan) => ({
    ...plan,
    lineCount: plan.lineItems.length,
    totalQuantity: plan.lineItems.reduce((sum, line) => sum + (Number(line.lineQuantity) || 0), 0),
  }));
}

function buildDeductionPlan(plans) {
  const byVariantSku = new Map();

  for (const order of plans) {
    for (const line of order.lineItems) {
      const sku = line.variantSku || '<unknown>';
      const current = byVariantSku.get(sku) || 0;
      byVariantSku.set(sku, current + (Number(line.lineQuantity) || 0));
    }
  }

  return Array.from(byVariantSku.entries()).map(([variantSku, quantity]) => ({
    variantSku,
    quantity,
    note: 'stock deduction preview; applied during commit mode',
  }));
}

async function commitPlans(authToken, plans) {
  const committed = [];
  const fulfilledLines = [];

  for (const plan of plans) {
    const orderPayload = await graphql(
      ORDER_BY_CODE_QUERY,
      { code: plan.orderCode },
      authToken,
      ADMIN_API_URL,
    );

    const order = orderPayload.orders?.items?.[0];
    if (!order) {
      committed.push({
        orderCode: plan.orderCode,
        status: 'skipped',
        reason: 'order not found',
      });
      continue;
    }

    if (order.fulfillments?.length > 0) {
      committed.push({
        orderCode: plan.orderCode,
        status: 'skipped',
        reason: 'already fulfilled',
      });
      continue;
    }

    if (order.state !== 'PaymentSettled') {
      committed.push({
        orderCode: plan.orderCode,
        status: 'skipped',
        reason: `order state is ${order.state}, expected PaymentSettled`,
      });
      continue;
    }

    const fulfillInput = {
      lines: plan.lineItems.map((line) => ({
        orderLineId: line.lineId,
        quantity: line.lineQuantity,
      })),
      handler: {
        code: 'manual-fulfillment',
        arguments: [
          { name: 'method', value: 'CSV Batch' },
          { name: 'trackingNumber', value: `CSV-${plan.orderCode}-${Date.now()}` },
        ],
      },
    };

    const fulfillPayload = await graphql(
      ADD_FULFILLMENT_MUTATION,
      { input: fulfillInput },
      authToken,
      ADMIN_API_URL,
    );

    const fulfillResult = fulfillPayload.addFulfillmentToOrder;
    if (!fulfillResult || fulfillResult.__typename !== 'Fulfillment') {
      throw new Error(`Failed to fulfill ${plan.orderCode}: ${JSON.stringify(fulfillResult)}`);
    }

    committed.push({
      orderCode: plan.orderCode,
      status: 'committed',
      fulfillmentId: fulfillResult.id,
      fulfillmentState: fulfillResult.state,
      trackingCode: fulfillResult.trackingCode || '',
      lineCount: plan.lineCount,
      totalQuantity: plan.totalQuantity,
    });

    for (const line of order.lines || []) {
      const variant = line.productVariant;
      if (!variant?.id) {
        continue;
      }

      fulfilledLines.push({
        variantId: variant.id,
        variantSku: variant.sku || '',
        variantName: variant.name || '',
        quantity: Number(line.quantity) || 0,
        stockOnHand: typeof variant.stockOnHand === 'number' ? variant.stockOnHand : null,
      });
    }
  }

  return { committed, fulfilledLines };
}

async function applyStockDeductions(authToken, fulfilledLines) {
  const grouped = new Map();

  for (const line of fulfilledLines) {
    const key = line.variantId || line.variantSku;
    if (!key) {
      continue;
    }

    const quantity = Number(line.quantity) || 0;
    if (quantity <= 0) {
      continue;
    }

    const current = grouped.get(key) || {
      variantId: line.variantId,
      variantSku: line.variantSku,
      variantName: line.variantName,
      stockOnHand: line.stockOnHand,
      quantity: 0,
    };

    current.quantity += quantity;
    if (typeof current.stockOnHand !== 'number' && typeof line.stockOnHand === 'number') {
      current.stockOnHand = line.stockOnHand;
    }
    grouped.set(key, current);
  }

  const adjustments = [];

  for (const entry of grouped.values()) {
    if (typeof entry.stockOnHand !== 'number') {
      adjustments.push({
        variantId: entry.variantId,
        variantSku: entry.variantSku,
        variantName: entry.variantName,
        quantity: entry.quantity,
        status: 'skipped',
        reason: 'missing stockOnHand on the fulfilled variant',
      });
      continue;
    }

    const nextStockOnHand = entry.stockOnHand - entry.quantity;
    if (nextStockOnHand < 0) {
      throw new Error(`Stock deduction would go negative for ${entry.variantSku || entry.variantId}: ${entry.stockOnHand} - ${entry.quantity}`);
    }

    const updatePayload = await graphql(
      UPDATE_PRODUCT_VARIANT_MUTATION,
      {
        input: {
          id: entry.variantId,
          stockOnHand: nextStockOnHand,
        },
      },
      authToken,
      ADMIN_API_URL,
    );

    const updatedVariant = updatePayload.updateProductVariant;
    adjustments.push({
      variantId: entry.variantId,
      variantSku: entry.variantSku,
      variantName: entry.variantName,
      quantity: entry.quantity,
      previousStockOnHand: entry.stockOnHand,
      nextStockOnHand: updatedVariant?.stockOnHand ?? nextStockOnHand,
      status: 'committed',
    });
  }

  return adjustments;
}

async function reconcileStockAdjustments(authToken, plans) {
  const fulfilledLines = [];

  for (const plan of plans) {
    const orderPayload = await graphql(
      ORDER_BY_CODE_QUERY,
      { code: plan.orderCode },
      authToken,
      ADMIN_API_URL,
    );

    const order = orderPayload.orders?.items?.[0];
    if (!order) {
      continue;
    }

    if (order.state !== 'PaymentSettled' && (order.fulfillments?.length || 0) === 0) {
      continue;
    }

    for (const line of order.lines || []) {
      const variant = line.productVariant;
      if (!variant?.id) {
        continue;
      }

      fulfilledLines.push({
        variantId: variant.id,
        variantSku: variant.sku || '',
        variantName: variant.name || '',
        quantity: Number(line.quantity) || 0,
        stockOnHand: typeof variant.stockOnHand === 'number' ? variant.stockOnHand : null,
      });
    }
  }

  return applyStockDeductions(authToken, fulfilledLines);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (const arg of argv) {
    if (arg === '--commit') {
      parsed.commit = true;
      continue;
    }
    if (arg === '--reconcile-stock' || arg === '--stock-only') {
      parsed['reconcile-stock'] = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      parsed[match[1]] = match[2];
      continue;
    }
    parsed._.push(arg);
  }
  return parsed;
}

function parseCsv(text) {
  const rows = [];
  const record = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      record.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n') {
      record.push(cell);
      rows.push(record.splice(0, record.length));
      cell = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    rows.push(record.splice(0, record.length));
  }

  if (rows.length === 0) {
    return [];
  }

  const headers = rows.shift().map((header) => String(header).trim());
  return rows
    .filter((row) => row.some((cellValue) => String(cellValue).trim() !== ''))
    .map((row) => {
      const entry = {};
      headers.forEach((header, index) => {
        entry[header] = row[index] ?? '';
      });
      return entry;
    });
}

function requireAdminConfig() {
  if (!ADMIN_API_URL) {
    throw new Error('VENDURE_ADMIN_API_URL is required for commit or stock reconciliation.');
  }
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    throw new Error('SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD are required for commit or stock reconciliation.');
  }
}

async function login() {
  requireAdminConfig();
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

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function resolveAdminApiUrl() {
  throw new Error('VENDURE_ADMIN_API_URL must be set explicitly.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
