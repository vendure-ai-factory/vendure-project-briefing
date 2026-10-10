
import { bootstrapWorker, TransactionalConnection } from '@vendure/core';
import { config } from '../src/vendure-config';

async function listFacets() {
    const { app } = await bootstrapWorker(config);
    const connection = app.get(TransactionalConnection);

    console.log('--- Country Facet Values ---');
    const facets = await connection.rawConnection.query(`
        SELECT f.id as facetId, f.code as facetCode, fv.id as valueId, fv.code as valueCode
        FROM facet f
        JOIN facet_value fv ON f.id = fv.facetId
        WHERE f.code = 'Country'
    `);
    console.log(JSON.stringify(facets, null, 2));

    await app.close();
    process.exit(0);
}

listFacets().catch(err => {
    console.error(err);
    process.exit(1);
});
