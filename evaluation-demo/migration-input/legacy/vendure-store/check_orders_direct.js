
const Database = require('better-sqlite3');
const path = require('path');

try {
    const db = new Database(path.join(__dirname, 'vendure.sqlite'), { readonly: true });
    const row = db.prepare("SELECT id, code, state, createdAt FROM 'order' ORDER BY createdAt DESC LIMIT 5").all();
    console.log('Latest 5 orders:');
    console.log(JSON.stringify(row, null, 2));
    db.close();
} catch (err) {
    console.error('Error querying database:', err);
}
