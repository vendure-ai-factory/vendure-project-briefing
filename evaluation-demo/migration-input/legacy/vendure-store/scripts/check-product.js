const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

try {
    console.log('--- List All Tables ---');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log(tables.map(t => t.name).join(', '));

    const productId = 67;
    // Try potential table names for product-asset relation
    const potentialTables = ['product_assets_asset', 'product_asset', 'product_assets'];

    for (const table of potentialTables) {
        try {
            console.log(`\n--- Checking Table: ${table} ---`);
            const data = db.prepare(`SELECT * FROM ${table} WHERE productId = ?`).all(productId);
            console.log(`Found ${data.length} records in ${table}:`);
            console.log(JSON.stringify(data, null, 2));

            if (data.length > 0) {
                const assetIds = data.map(d => d.assetId);
                console.log(`\n--- Fetching Asset Details for IDs: ${assetIds.join(', ')} ---`);
                const assets = db.prepare(`SELECT * FROM asset WHERE id IN (${assetIds.join(',')})`).all();
                console.log(JSON.stringify(assets, null, 2));
            }
        } catch (e) {
            console.log(`Table ${table} does not exist or error occurred.`);
        }
    }

} catch (err) {
    console.error(err);
} finally {
    db.close();
}
