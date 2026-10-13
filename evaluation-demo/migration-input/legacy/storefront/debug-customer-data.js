const fetch = require('node-fetch');

async function debug() {
    const shopUrl = 'http://localhost:3000/shop-api';
    
    console.log('--- Step 1: Login ---');
    const loginRes = await fetch(shopUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: `
                mutation Login($username: String!, $password: String!) {
                    login(username: $username, password: $password) {
                        ... on CurrentUser { id identifier }
                        ... on ErrorResult { errorCode message }
                    }
                }
            `,
            variables: { username: 'test3@example.com', password: process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD' }
        })
    });
    
    const loginJson = await loginRes.json();
    console.log('Login Response:', JSON.stringify(loginJson, null, 2));
    
    // Extract token from header
    const token = loginRes.headers.get('vendure-auth-token');
    console.log('Auth Token:', token ? 'RECEIVED' : 'MISSING');

    if (!token) {
        console.error('Failed to get auth token. Cannot proceed.');
        return;
    }

    console.log('\n--- Step 2: Get Active Customer ---');
    const customerRes = await fetch(shopUrl, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            query: `
                query {
                    activeCustomer {
                        id
                        emailAddress
                        customFields {
                            countryCode
                        }
                        addresses {
                            city
                            country { code name }
                        }
                    }
                }
            `
        })
    });

    const customerJson = await customerRes.json();
    console.log('RAW_CUSTOMER_DATA:', JSON.stringify(customerJson, null, 2));
}

debug().catch(console.error);
