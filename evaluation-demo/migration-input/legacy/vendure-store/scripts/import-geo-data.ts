// @ts-ignore
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// European country ISO codes
const EUROPE_CODES = new Set([
    'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BY', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GG', 'GI', 'GR', 'HR', 'HU', 'IE', 'IM', 'IS', 'IT', 'JE', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SJ', 'SK', 'SM', 'UA', 'VA'
]);

const DB_PATH = path.join(__dirname, '../vendure.sqlite');
const DATA_DIR = path.join(__dirname, 'geo-data');

function parseCsvLine(line: string) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

async function run() {
    console.log('>>> Opening database at', DB_PATH);
    const db = new Database(DB_PATH);

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS geo_countries (
            id INTEGER PRIMARY KEY,
            name TEXT,
            iso2 TEXT,
            region TEXT,
            subregion TEXT
        );
        CREATE TABLE IF NOT EXISTS geo_states (
            id INTEGER PRIMARY KEY,
            name TEXT,
            country_id INTEGER,
            country_code TEXT,
            state_code TEXT
        );
        CREATE TABLE IF NOT EXISTS geo_cities (
            id INTEGER PRIMARY KEY,
            name TEXT,
            state_id INTEGER,
            state_code TEXT,
            country_id INTEGER,
            country_code TEXT,
            latitude TEXT,
            longitude TEXT
        );
    `);

    console.log('>>> Importing Countries...');
    if (!fs.existsSync(path.join(DATA_DIR, 'countries.csv'))) {
        throw new Error('countries.csv not found. Make sure to download it first.');
    }
    const countriesData = fs.readFileSync(path.join(DATA_DIR, 'countries.csv'), 'utf8').split('\n');
    const countryStmt = db.prepare('INSERT OR REPLACE INTO geo_countries (id, name, iso2, region, subregion) VALUES (?, ?, ?, ?, ?)');

    const euroCountryIds = new Set<number>();

    db.transaction(() => {
        for (let i = 1; i < countriesData.length; i++) {
            const row = parseCsvLine(countriesData[i]);
            if (row.length < 14) continue;
            const iso2 = row[3];
            if (EUROPE_CODES.has(iso2)) {
                const id = parseInt(row[0]);
                countryStmt.run(id, row[1], iso2, row[12], row[13]);
                euroCountryIds.add(id);
            }
        }
    })();
    console.log(`>>> Imported ${euroCountryIds.size} European countries.`);

    console.log('>>> Importing States...');
    const statesData = fs.readFileSync(path.join(DATA_DIR, 'states.csv'), 'utf8').split('\n');
    const stateStmt = db.prepare('INSERT OR REPLACE INTO geo_states (id, name, country_id, country_code, state_code) VALUES (?, ?, ?, ?, ?)');
    const euroStateIds = new Set<number>();

    db.transaction(() => {
        for (let i = 1; i < statesData.length; i++) {
            const row = parseCsvLine(statesData[i]);
            if (row.length < 5) continue;
            const countryId = parseInt(row[2]);
            if (euroCountryIds.has(countryId)) {
                const id = parseInt(row[0]);
                stateStmt.run(id, row[1], countryId, row[3], row[4]);
                euroStateIds.add(id);
            }
        }
    })();
    console.log(`>>> Imported ${euroStateIds.size} European states/regions.`);

    console.log('>>> Importing Cities...');
    const citiesData = fs.readFileSync(path.join(DATA_DIR, 'cities.csv'), 'utf8').split('\n');
    const cityStmt = db.prepare('INSERT OR REPLACE INTO geo_cities (id, name, state_id, state_code, country_id, country_code, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    let cityCount = 0;
    db.transaction(() => {
        for (let i = 1; i < citiesData.length; i++) {
            const row = parseCsvLine(citiesData[i]);
            if (row.length < 10) continue;
            const countryId = parseInt(row[5]);
            if (euroCountryIds.has(countryId)) {
                cityStmt.run(parseInt(row[0]), row[1], parseInt(row[2]), row[3], countryId, row[6], row[8], row[9]);
                cityCount++;
            }
        }
    })();
    console.log(`>>> Imported ${cityCount} European cities.`);

    db.close();
    console.log('>>> Import complete.');
}

run().catch(console.error);
