const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

try {
    const productId = 67;
    const assetIds = [69, 70]; // From previous scan

    console.log(`--- Fixing Product Assets for Product ID ${productId} ---`);

    // Check if assets exist
    const assets = db.prepare(`SELECT id FROM asset WHERE id IN (${assetIds.join(',')})`).all();
    console.log(`Existing Assets in DB: ${JSON.stringify(assets)}`);

    if (assets.length === assetIds.length) {
        // Insert into product_asset
        const insert = db.prepare('INSERT INTO product_asset (productId, assetId, position) VALUES (?, ?, ?)');

        const transaction = db.transaction(() => {
            // Delete existing just in case
            db.prepare('DELETE FROM product_asset WHERE productId = ?').run(productId);

            assetIds.forEach((id, index) => {
                insert.run(productId, id, index);
                console.log(`Linked Asset ${id} to Product ${productId} at position ${index}`);
            });
        });

        transaction();
        console.log('✅ Success: Product assets linked.');

        // Final check
        const finalCheck = db.prepare('SELECT * FROM product_asset WHERE productId = ?').all(productId);
        console.log('Final product_asset entries:', JSON.stringify(finalCheck, null, 2));
    } else {
        console.error('❌ Error: Not all expected assets (69, 70) exist in database.');
    }

} catch (err) {
    console.error(err);
} finally {
    db.close();
}
