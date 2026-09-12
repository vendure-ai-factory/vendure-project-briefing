// @ts-nocheck
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, 'vendure.sqlite');
console.log(`Connecting to: ${dbPath}`);
const db = new Database(dbPath, { readonly: true });

try {
    const hufCount = db.prepare("SELECT count(*) as count FROM product_variant_price WHERE currencyCode = 'HUF'").get();
    console.log(`--- HUF Prices Count ---`);
    console.log(hufCount);

    const eurCount = db.prepare("SELECT count(*) as count FROM product_variant_price WHERE currencyCode = 'EUR'").get();
    console.log(`--- EUR Prices Count ---`);
    console.log(eurCount);

    const countryProductsCount = db.prepare("SELECT count(*) as count FROM product WHERE customFieldsCountrycode IN ('HU', 'AT', 'DE')").get();
    console.log(`--- AT/HU Products Count ---`);
    console.log(countryProductsCount);

    // Check product columns
    const productColumns = db.prepare("PRAGMA table_info(product)").all();
    console.log("--- Product Columns ---");
    console.log(productColumns.map(c => c.name).join(', '));

} catch (err) {
    console.error("Error querying DB:", err);
} finally {
    db.close();
}
