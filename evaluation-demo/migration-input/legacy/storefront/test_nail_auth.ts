
const API_URL = 'http://localhost:54321/shop-api';
const EMAIL = 'test3@example.com';
const PASSWORD = 'test';

async function run() {
    // 1. Login
    const loginRes = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'vendure-token': 'germany-channel' },
        body: JSON.stringify({
            query: `
                mutation Login($username: String!, $password: String!) {
                    login(username: $username, password: $password) {
                        ... on CurrentUser {
                            id
                        }
                    }
                }
            `,
            variables: { username: EMAIL, password: PASSWORD }
        })
    });

    const loginData = await loginRes.json() as any;
    console.log('Login Result:', JSON.stringify(loginData));
    const token = loginRes.headers.get('vendure-auth-token');
    console.log('Auth Token:', token);

    if (!token) {
        console.error("No token received!");
        return;
    }

    // 2. Create Nail Profile using the exact headers we use in nail-api.ts
    const createRes = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'vendure-token': 'germany-channel',
            'vendure-auth-token': token,
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            query: `
                mutation CreateNailProfile($input: CreateNailProfileInput!) {
                    createNailProfile(input: $input) {
                        id
                        profileName
                    }
                }
            `,
            variables: {
                input: {
                    profileName: 'ApiTestProfile',
                    fingerSizes: { 'leftThumb': 15 }
                }
            }
        })
    });

    const createData = await createRes.json();
    console.log('Create Result:', JSON.stringify(createData, null, 2));

    // 3. Delete it so we don't pollute
    if (createData.data?.createNailProfile?.id) {
        await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'vendure-token': 'germany-channel',
                'vendure-auth-token': token,
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                query: `mutation { deleteNailProfile(id: "${createData.data.createNailProfile.id}") { result } }`
            })
        });
        console.log('Cleaned up test profile.');
    }
}

run().catch(console.error);
