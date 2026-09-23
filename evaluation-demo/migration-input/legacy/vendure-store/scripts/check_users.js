
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

console.log('--- Customers and Linked Users ---');
const rows = db.prepare(`
    SELECT c.emailAddress, u.identifier, u.verified, u.id as userId
    FROM customer c
    LEFT JOIN user u ON c.userId = u.id
    WHERE c.emailAddress LIKE '%test%@example.com'
`).all();

console.log(JSON.stringify(rows, null, 2));
db.close();
