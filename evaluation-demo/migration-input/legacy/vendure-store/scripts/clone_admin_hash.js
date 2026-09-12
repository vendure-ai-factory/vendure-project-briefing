
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

console.log('--- Superadmin Hash ---');
const admin = db.prepare('SELECT passwordHash FROM user WHERE identifier = "superadmin"').get();
console.log(JSON.stringify(admin, null, 2));

if (admin && admin.passwordHash) {
    const emails = ['test1@example.com', 'test2@example.com', 'test3@example.com'];
    for (const email of emails) {
        db.prepare('UPDATE user SET passwordHash = ?, verified = 1 WHERE identifier = ?').run(admin.passwordHash, email);
        console.log(`Updated ${email} with superadmin hash and verified=1`);
    }
}
db.close();
