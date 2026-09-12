import { DataSource } from 'typeorm';
import path from 'path';

async function deduplicate() {
    console.log('--- 🧹 Surgical Database Deduplication [Pilot] ---');
    const dbPath = path.join(__dirname, '../../vendure-store/vendure.sqlite'); // Corrected path
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
        console.log('No duplicates found or only one remains. Checking price cleanup...');
    }
    
    // We'll clean up variant 121 regardless
    const keepVariantId = 121;
    
    // 2. Delete duplicate price entries for the KEPT variant
    console.log(`Cleaning up duplicate prices for Variant ${keepVariantId}...`);
    const channels = [1, 2, 3, 4];
    for (const channelId of channels) {
        const prices = await dataSource.query(`
            SELECT id FROM product_variant_price 
            WHERE variantId = ? AND channelId = ?
            ORDER BY updatedAt DESC
        `, [keepVariantId, channelId]);
        
        if (prices.length > 1) {
            const idsToDelete = prices.slice(1).map((p: any) => p.id);
            console.log(`Channel ${channelId}: Keeping ${prices[0].id}, Deleting ${idsToDelete.join(', ')}`);
            await dataSource.query(`DELETE FROM product_variant_price WHERE id IN (${idsToDelete.join(',')})`);
        }
    }

    if (variants.length > 1) {
        const keepProductId = 90; // The product ID for variant 121
        const toDeleteVariantIds = variants.filter((v: any) => v.id !== keepVariantId).map((v: any) => v.id);
        const toDeleteProductIds = variants.filter((v: any) => v.productId !== keepProductId).map((v: any) => v.productId);

        // 3. Mark duplicate products/variants as deleted
        console.log('Soft-deleting duplicate products and variants...');
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        if (toDeleteVariantIds.length > 0) {
            await dataSource.query(`UPDATE product_variant SET deletedAt = ? WHERE id IN (${toDeleteVariantIds.join(',')})`, [now]);
        }
        if (toDeleteProductIds.length > 0) {
            await dataSource.query(`UPDATE product SET deletedAt = ? WHERE id IN (${toDeleteProductIds.join(',')})`, [now]);
        }
    }

    // 4. Force specific price for Pilot (1500 HUF)
    console.log('Ensuring Pilot Price is 1500 HUF on Hungary Channel...');
    await dataSource.query(`UPDATE product_variant_price SET price = 1500 WHERE variantId = ? AND channelId = 3`, [keepVariantId]);

    await dataSource.destroy();
    console.log('--- ✅ Deduplication Complete ---');
}

deduplicate().catch(console.error);
