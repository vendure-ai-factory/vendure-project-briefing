#!/usr/bin/env node

const Database = require('better-sqlite3');
const fs = require('fs');

const orderCode = process.argv[2];
const dbPath = process.env.VENDURE_DB_PATH;
const commissionConfigPath = process.env.COMMISSION_CONFIG_PATH || '';

if (!orderCode) {
  console.error('Usage: node query_order_revenue.js <order-code>');
  process.exit(1);
}
if (!dbPath) {
  console.error('VENDURE_DB_PATH must point to the intended test database.');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

try {
  const order = db.prepare(`
    SELECT id, code, totalWithTax, currencyCode, orderPlacedAt
    FROM "order"
    WHERE code = ?
  `).get(orderCode);

  if (!order) {
    console.log(`No order found for ${orderCode}.`);
    process.exitCode = 0;
  } else {
    const lines = db.prepare(`
      SELECT ol.quantity, ol.listPrice,
             p.customFieldsDesignerid AS designerId,
             p.customFieldsDesignfee AS designFee,
             p.customFieldsCountrycode AS productCountry,
             c.firstName, c.lastName,
             c.customFieldsCountrycode AS designerCountry
      FROM order_line ol
      JOIN product_variant v ON ol.productVariantId = v.id
      JOIN product p ON v.productId = p.id
      LEFT JOIN customer c ON p.customFieldsDesignerid = c.id
      WHERE ol.orderId = ? AND p.customFieldsIscustomerdesign = 1
    `).all(order.id);

    const commissionConfig = readJson(commissionConfigPath);
    console.log(JSON.stringify({
      order: {
        code: order.code,
        totalWithTax: order.totalWithTax,
        currencyCode: order.currencyCode,
        orderPlacedAt: order.orderPlacedAt,
      },
      customerDesignLines: lines.map((line) => ({
        ...line,
        commissionTier: resolveTier(commissionConfig, line.productCountry, line.designFee),
      })),
      note: 'This read-only report does not change commission configuration or wallet balances.',
    }, null, 2));
  }
} finally {
  db.close();
}

function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read COMMISSION_CONFIG_PATH: ${error.message}`);
  }
}

function resolveTier(config, countryCode, designFeeMinor) {
  const entry = config?.[countryCode];
  if (!entry?.tiers) return null;
  const amount = Number(designFeeMinor || 0) / 100;
  return entry.tiers.find((tier) => amount >= tier.from && amount < tier.to) || entry.tiers.at(-1) || null;
}
