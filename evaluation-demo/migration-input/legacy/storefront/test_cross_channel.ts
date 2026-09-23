
const API_URL = 'http://localhost:54321/shop-api';
const EMAIL = 'test3@example.com';
const PASSWORD = process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD';

async function run() {
    // 1. Login on Default/Germany channel
    const loginRes = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'vendure-token': 'germany-channel' },
        body: JSON.stringify({
            query: `
                mutation Login($username: String!, $password: String!) {
                    login(username: $username, password: $password) {
                        ... on CurrentUser { id }
                    }
                }
            `,
            variables: { username: EMAIL, password: PASSWORD }
        })
    });

    const token = loginRes.headers.get('vendure-auth-token');
    console.log('Login Auth Token:', token);

    if (!token) {
        console.error("No token received!");
        return;
    }

    // 2. Try to fetch / create profile on AUSTRIA channel
    const fetchRes = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'vendure-token': 'austria-channel', // different channel!
            'vendure-auth-token': token,
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            query: `
                query {
                    myNailProfiles {
                        id
                        profileName
                    }
                }
            `
        })
    });

    const body = await fetchRes.json();
    console.log('Cross-channel Fetch Result:', JSON.stringify(body, null, 2));
}

run().catch(console.error);
export {}
