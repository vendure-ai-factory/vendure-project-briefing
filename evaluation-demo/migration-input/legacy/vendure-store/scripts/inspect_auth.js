
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

console.log('--- Auth Method Table Schema ---');
const schema = db.prepare('PRAGMA table_info(authentication_method)').all();
console.log(JSON.stringify(schema, null, 2));

console.log('--- Sample Auth Data ---');
const data = db.prepare('SELECT * FROM authentication_method LIMIT 5').all();
console.log(JSON.stringify(data, null, 2));

db.close();
