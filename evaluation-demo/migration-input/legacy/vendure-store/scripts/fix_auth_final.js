
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

// Supply a hash created from the local evaluation password; never commit a hash here.
const adminHash = process.env.SUPERADMIN_PASSWORD_HASH;
if (!adminHash) throw new Error('Set SUPERADMIN_PASSWORD_HASH before running this local repair script.');

const emails = ['test1@example.com', 'test2@example.com', 'test3@example.com'];

console.log('--- Fixing Auth and Verification ---');

for (const email of emails) {
    // 1. Update Password Hash in authentication_method
    const authResult = db.prepare('UPDATE authentication_method SET passwordHash = ? WHERE identifier = ?').run(adminHash, email);

    // 2. Force Verification in user table
    const userResult = db.prepare('UPDATE user SET verified = 1 WHERE identifier = ?').run(email);

    console.log(`${email}: Auth updated (${authResult.changes}), Verified updated (${userResult.changes})`);
}

db.close();
