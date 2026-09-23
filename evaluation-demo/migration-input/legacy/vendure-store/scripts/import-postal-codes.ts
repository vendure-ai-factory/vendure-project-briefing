import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.GEO_DATA_DIR || path.resolve(__dirname, 'geo-data');
const DB_PATH = process.env.VENDURE_DB_PATH || path.resolve(__dirname, '..', 'runtime', 'vendure.sqlite');

// 欧洲国家代码列表
const EURO_CODES = new Set([
    'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FO', 'FR',
    'GB', 'GI', 'GR', 'HR', 'HU', 'IE', 'IM', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT',
    'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SJ', 'SK', 'SM', 'UA', 'VA'
]);

function run() {
    console.log('>>> Opening database at', DB_PATH);
    const db = new Database(DB_PATH);

    // 提高写入性能的配置
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    console.log('>>> Ensuring geo_postal_codes table exists...');
    db.exec(`
        CREATE TABLE IF NOT EXISTS geo_postal_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            country_code TEXT NOT NULL,
            postal_code TEXT NOT NULL,
            place_name TEXT,
            state_name TEXT,
            latitude REAL,
            longitude REAL
        )
    `);

    // 清理旧数据（可选，根据需求确定是否全量重刷）
    // db.exec('DELETE FROM geo_postal_codes');

    const insertStmt = db.prepare(`
        INSERT INTO geo_postal_codes (country_code, postal_code, place_name, state_name, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    console.log('>>> Reading postal code data...');
    const filePath = path.join(DATA_DIR, 'postal_codes_all.txt');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');

    let count = 0;
    let skipped = 0;

    console.log(`>>> Total lines to process: ${lines.length}`);

    db.transaction(() => {
        for (const line of lines) {
            if (!line.trim()) continue;

            // GeoNames postal codes 格式是 Tab 分隔:
            // country code, postal code, place name, admin name1, admin code1, admin name2, admin code2, admin name3, admin code3, latitude, longitude, accuracy
            const cols = line.split('\t');
            if (cols.length < 11) continue;

            const countryCode = cols[0];
            if (EURO_CODES.has(countryCode)) {
                insertStmt.run(
                    countryCode,
                    cols[1], // postal_code
                    cols[2], // place_name
                    cols[3], // state_name (admin name1)
                    cols[9] ? parseFloat(cols[9]) : null, // latitude
                    cols[10] ? parseFloat(cols[10]) : null // longitude
                );
                count++;
                if (count % 10000 === 0) {
                    process.stdout.write(`...Processed ${count} records\r`);
                }
            } else {
                skipped++;
            }
        }
    })();

    console.log(`\n>>> Import complete.`);
    console.log(`>>> Imported ${count} European postal codes.`);
    console.log(`>>> Skipped ${skipped} non-European records.`);

    console.log('>>> Building indexes for performance...');
    db.exec('CREATE INDEX IF NOT EXISTS idx_postal_country ON geo_postal_codes (country_code, postal_code)');
    console.log('>>> Indexing complete.');

    db.close();
    console.log('>>> Database connection closed.');
}

try {
    run();
} catch (err) {
    console.error('!!! Import failed:', err);
    process.exit(1);
}
