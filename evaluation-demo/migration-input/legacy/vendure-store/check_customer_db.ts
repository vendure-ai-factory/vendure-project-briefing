// @ts-nocheck
import Database from 'better-sqlite3';

function checkCustomer() {
    const db = new Database('./vendure.sqlite');

    // Check if test2@example.com exists and what their country code is
    console.log("--- Customer Data ---");
    const customer = db.prepare(`
        SELECT u.identifier, c.id as customerId, c.firstName, c.lastName, c.customFieldsCountrycode 
        FROM user u 
        JOIN customer c ON c.userId = u.id 
        WHERE u.identifier = 'test2@example.com'
    `).get();

    console.log(customer);

    // Check addresses for this customer
    if (customer && customer.customerId) {
        console.log("--- Address Data ---");
        const addresses = db.prepare(`
            SELECT a.id, a.countryId, co.code as countryCode 
            FROM address a 
            JOIN country co ON a.countryId = co.id 
            WHERE a.customerId = ?
        `).all(customer.customerId);
        console.log(addresses);
    }
}

checkCustomer();
