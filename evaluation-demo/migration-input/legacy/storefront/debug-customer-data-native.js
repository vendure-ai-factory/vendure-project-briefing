async function debug() {
    const shopUrl = 'http://127.0.0.1:54321/shop-api';
    
    const accounts = [
        { email: 'test1@example.com', pass: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD' },
        { email: 'test2@example.com', pass: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD' },
        { email: 'test3@example.com', pass: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD' }
    ];

    for (const account of accounts) {
        console.log(`\n--- Login Attempt: ${account.email} ---`);
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
                variables: { username: account.email, password: account.pass }
            })
        });
        
        const loginJson = await loginRes.json();
        const token = loginRes.headers.get('vendure-auth-token');
        
        if (!token) {
            console.log(`Login Failed for ${account.email}:`, JSON.stringify(loginJson, null, 2));
            continue;
        }

        console.log(`Login Success for ${account.email}. Token received.`);

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
        console.log(`RAW_CUSTOMER_DATA for ${account.email}:`, JSON.stringify(customerJson, null, 2));
    }
}

debug().catch(console.error);
