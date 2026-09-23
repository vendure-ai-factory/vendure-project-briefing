import { DataSource } from 'typeorm';
import path from 'path';

async function deduplicate() {
    console.log('--- 🧹 Surgical Database Deduplication [Pilot] ---');
    const dbPath = path.join(__dirname, '../vendure.sqlite');
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: dbPath,
    });

    await dataSource.initialize();
    const sku = 'MC-TEST-SKU-HU';

    // 1. Identify all products with this SKU
    const variants = await dataSource.query(`
        SELECT id, productId FROM product_variant WHERE sku = ? AND deletedAt IS NULL
    `, [sku]);

    console.log(`Found ${variants.length} variants for SKU ${sku}`);

    if (variants.length <= 1) {
        console.log('No duplicates found. Skipping product deduplication.');
    } else {
        // Keep the first one (ID 121 usually if it was first)
        const keepVariantId = variants[0].id;
        const keepProductId = variants[0].productId;
        
        console.log(`Keeping Variant ID: ${keepVariantId}, Product ID: ${keepProductId}`);

        const toDeleteVariantIds = variants.slice(1).map((v: any) => v.id);
        const toDeleteProductIds = variants.slice(1).map((v: any) => v.productId);

        // 2. Delete duplicate price entries for the KEPT variant
        console.log(`Cleaning up duplicate prices for Variant ${keepVariantId}...`);
        // We'll keep one price per channel.
        const channels = [1, 2, 3, 4];
        for (const channelId of channels) {
            const prices = await dataSource.query(\`
                SELECT id FROM product_variant_price 
                WHERE variantId = ? AND channelId = ?
                ORDER BY updatedAt DESC
            \`, [keepVariantId, channelId]);
            
            if (prices.length > 1) {
                const idsToDelete = prices.slice(1).map((p: any) => p.id);
                console.log(\`Channel \${channelId}: Keeping \${prices[0].id}, Deleting \${idsToDelete.join(', ')}\`);
                await dataSource.query(\`DELETE FROM product_variant_price WHERE id IN (\${idsToDelete.join(',')})\`);
            }
        }

        // 3. Mark duplicate products/variants as deleted
        console.log('Soft-deleting duplicate products and variants...');
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        await dataSource.query(\`UPDATE product_variant SET deletedAt = ? WHERE id IN (\${toDeleteVariantIds.join(',')})\`, [now]);
        await dataSource.query(\`UPDATE product SET deletedAt = ? WHERE id IN (\${toDeleteProductIds.join(',')})\`, [now]);
        
        // 4. Force specific price for Pilot (1500 HUF)
        console.log('Ensuring Pilot Price is 1500 HUF on Hungary Channel...');
        await dataSource.query(\`UPDATE product_variant_price SET price = 1500 WHERE variantId = ? AND channelId = 3\`, [keepVariantId]);
    }

    await dataSource.destroy();
    console.log('--- ✅ Deduplication Complete ---');
}

deduplicate().catch(console.error);
