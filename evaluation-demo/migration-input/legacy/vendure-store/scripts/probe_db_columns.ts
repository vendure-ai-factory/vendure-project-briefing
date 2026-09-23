
import { bootstrapWorker } from '@vendure/core';
import { config } from '../src/vendure-config';

async function probe() {
    console.log('--- Database Probe Started ---');
    const { app } = await bootstrapWorker(config);
    const connection = (app as any).connection;
    const queryRunner = connection.rawConnection.createQueryRunner();

    console.log('Checking columns for Product table...');
    const productColumns = await queryRunner.query('PRAGMA table_info(product)');
    console.log('Product Columns:', JSON.stringify(productColumns, null, 2));

    console.log('Checking columns for ProductVariant table...');
    const variantColumns = await queryRunner.query('PRAGMA table_info(product_variant)');
    console.log('Variant Columns:', JSON.stringify(variantColumns, null, 2));

    await app.close();
    process.exit(0);
}

probe().catch(err => {
    console.error(err);
    process.exit(1);
});
