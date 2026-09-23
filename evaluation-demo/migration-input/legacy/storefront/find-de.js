async function findDe() {
    const shopUrl = 'http://127.0.0.1:54321/shop-api';
    
    // We can't list all customers from Shop API, but we can try to find them or use a guess.
    // Let's try to login as 'test3@example.com' with the configured evaluation password.
    
    const account = { email: 'test3@example.com', pass: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD' };
    console.log(`\n--- Attempting Login: ${account.email} ---`);
    
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
        console.log('Login failed. Trying admin bootstrap to check database...');
        return;
    }

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
                    }
                }
            `
        })
    });

    const customerJson = await customerRes.json();
    console.log('ACTIVE_CUSTOMER_DATA:', JSON.stringify(customerJson, null, 2));
}

findDe().catch(console.error);
