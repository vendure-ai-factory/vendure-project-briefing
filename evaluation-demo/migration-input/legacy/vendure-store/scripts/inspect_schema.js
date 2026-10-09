
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

console.log('--- User Table Schema ---');
const schema = db.prepare('PRAGMA table_info(user)').all();
console.log(JSON.stringify(schema, null, 2));

console.log('--- Table List ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(JSON.stringify(tables, null, 2));

db.close();
