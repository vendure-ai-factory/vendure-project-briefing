const Database = require('better-sqlite3');
const db = new Database('./vendure.sqlite');

console.log("--- All Facets belonging to the 'Country' Facet ---");
// Facet Code for country is usually 'country'
const facets = db.prepare(`
    SELECT fv.id, fv.code, fvt.name, f.code as facetCode
    FROM facet_value fv
    JOIN facet f ON fv.facetId = f.id
    JOIN facet_value_translation fvt ON fvt.baseId = fv.id
    WHERE f.code = 'country' OR fvt.name = '国家' OR fvt.name = 'Country' OR fvt.name = 'Hungary' OR fv.code = 'hu'
`).all();
console.log(JSON.stringify(facets, null, 2));

console.log("--- Let's see an example product's facet value links ---");
const links = db.prepare(`
    SELECT p.id as productId, pvt.name as productName, pfv.facetValueId, fv.code
    FROM product p
    JOIN product_translation pvt ON pvt.baseId = p.id
    JOIN product_facet_values_facet_value pfv ON pfv.productId = p.id
    JOIN facet_value fv on fv.id = pfv.facetValueId
    WHERE pvt.languageCode = 'zh' AND (pvt.name LIKE '%[HU]%' OR pvt.name LIKE '%[DE]%')
    LIMIT 20
`).all();
console.log(JSON.stringify(links, null, 2));
