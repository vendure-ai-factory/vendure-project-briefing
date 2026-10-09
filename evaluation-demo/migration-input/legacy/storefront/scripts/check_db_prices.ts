import { DataSource } from 'typeorm';
import path from 'path';

async function checkDb() {
    console.log('--- 🗄️ Database Price Inspection ---');
    const dbPath = path.join(__dirname, '../vendure.sqlite');
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: dbPath,
        entities: [], // We'll use raw queries
    });

    await dataSource.initialize();
    
    const sku = 'MC-TEST-SKU-HU';
    
    // 1. Get Variant and its base price
    const variantRaw = await dataSource.query(`
        SELECT pv.id, pv.sku, pv.enabled, p.name as productName
        FROM product_variant pv
        JOIN product p ON pv.productId = p.id
        WHERE pv.sku = ? AND pv.deletedAt IS NULL
    `, [sku]);
    
    if (variantRaw.length === 0) {
        console.error(`Variant ${sku} not found`);
        return;
    }
    
    const variantId = variantRaw[0].id;
    console.log(`Variant: ${variantRaw[0].productName} (${sku}), ID: ${variantId}`);

    // 2. Get Prices per Channel
    const prices = await dataSource.query(`
        SELECT pvp.price, pvp.channelId, c.token as channelToken, c.currencyCode
        FROM product_variant_price pvp
        JOIN channel c ON pvp.channelId = c.id
        WHERE pvp.variantId = ?
    `, [variantId]);
    
    console.log('Prices in DB:');
    console.table(prices);

    await dataSource.destroy();
}

checkDb().catch(console.error);
