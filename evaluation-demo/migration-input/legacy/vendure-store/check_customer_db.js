const Database = require('better-sqlite3');

function checkCustomer() {
    const db = new Database('./vendure.sqlite');

    console.log("--- Customer test2@example.com Data ---");
    const customer = db.prepare(`
        SELECT u.identifier, c.id as customerId, c.firstName, c.lastName, c.customFieldsCountrycode 
        FROM user u 
        JOIN customer c ON c.userId = u.id 
        WHERE u.identifier = 'test2@example.com'
    `).get();

    console.log(JSON.stringify(customer, null, 2));

    if (customer && customer.customerId) {
        console.log("--- Address Data ---");
        const addresses = db.prepare(`
            SELECT a.id, a.countryId, co.code as countryCode 
            FROM address a 
            JOIN country co ON a.countryId = co.id 
            WHERE a.customerId = ?
        `).all(customer.customerId);
        console.log(JSON.stringify(addresses, null, 2));
    }
}

checkCustomer();
