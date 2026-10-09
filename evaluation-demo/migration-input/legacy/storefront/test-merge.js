const { request, gql } = require('graphql-request');

async function testFetch() {
    // Note: We'd need a valid token to test, which we don't naturally have here.
    // Instead we will query activeCustomer -> orders just to see if we can get anything as guest.
    const query = gql`
        query GetMergeableOrders {
            getMergeableOrders {
                id
                code
                totalWithTax
                active
                state
            }
        }
    `;

    try {
        const data = await request('http://localhost:3000/api/shop', query);
        console.log("Success:", JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Error:", error.response ? JSON.stringify(error.response, null, 2) : error.message);
    }
}

testFetch();
