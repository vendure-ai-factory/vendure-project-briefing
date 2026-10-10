const Database = require('better-sqlite3');

function checkFacets() {
    const db = new Database('./vendure.sqlite');

    console.log("--- Facet Values ---");
    const facets = db.prepare(`
        SELECT fv.id, fvt.name, fv.code 
        FROM facet_value fv
        JOIN facet_value_translation fvt ON fvt.baseId = fv.id
        WHERE fvt.languageCode = 'en'
    `).all();

    console.log(JSON.stringify(facets, null, 2));
}

checkFacets();
