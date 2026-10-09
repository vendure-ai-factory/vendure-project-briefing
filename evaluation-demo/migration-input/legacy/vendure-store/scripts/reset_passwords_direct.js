
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, '../vendure.sqlite');
const db = new Database(dbPath);

async function run() {
    const configuredPassword = process.env.EVALUATION_TEST_PASSWORD;
    if (!configuredPassword) throw new Error('Set EVALUATION_TEST_PASSWORD before resetting test passwords.');
    const hashedPassword = await bcrypt.hash(configuredPassword, 10);
    const emails = ['test1@example.com', 'test2@example.com', 'test3@example.com'];

    for (const email of emails) {
        console.log(`Resetting password for ${email}...`);
        const result = db.prepare('UPDATE user SET passwordHash = ? WHERE identifier = ?').run(hashedPassword, email);
        if (result.changes > 0) {
            console.log(`Successfully reset password for ${email}`);
        } else {
            console.log(`User ${email} not found in database.`);
        }
    }
    db.close();
}

run().catch(console.error);
