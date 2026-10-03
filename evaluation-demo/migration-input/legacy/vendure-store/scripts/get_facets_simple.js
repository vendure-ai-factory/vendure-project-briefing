
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

console.log('--- Country Facet Values ---');
const rows = db.prepare(`
    SELECT f.id as facetId, f.code as facetCode, fv.id as valueId, fv.code as valueCode
    FROM facet f
    JOIN facet_value fv ON f.id = fv.facetId
    WHERE f.code = 'Country'
`).all();

console.log(JSON.stringify(rows, null, 2));
db.close();
