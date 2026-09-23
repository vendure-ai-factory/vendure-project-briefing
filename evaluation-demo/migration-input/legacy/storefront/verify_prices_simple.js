const url = "http://127.0.0.1:54321/shop-api";
const channelToken = "hungary-channel";

async function query(gql, variables = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'vendure-token': channelToken
        },
        body: JSON.stringify({ query: gql, variables })
    });
    return res.json();
}

const SEARCH_GQL = `
    query {
        search(input: { term: "" }) {
            items {
                productName
                priceWithTax {
                    ... on PriceRange { min max }
                    ... on SinglePrice { value }
                }
                currencyCode
                slug
            }
        }
    }
`;

const DETAIL_GQL = `
    query($slug: String!) {
        product(slug: $slug) {
            name
            variants {
                priceWithTax
                currencyCode
            }
        }
    }
`;

async function verify() {
    console.log('--- Price Verification (Simple Node) ---');
    const searchRes = await query(SEARCH_GQL);
    if (searchRes.errors) {
        console.error('Search Errors:', searchRes.errors);
        return;
    }
    
    const items = searchRes.data.search.items;
    if (!items || items.length === 0) {
        console.log('No items found in search.');
        return;
    }
    
    const item = items[0];
    const searchPrice = item.priceWithTax.min !== undefined ? item.priceWithTax.min : item.priceWithTax.value;
    console.log(`Search: ${item.productName}, Price: ${searchPrice}, Currency: ${item.currencyCode}`);
    
    const detailRes = await query(DETAIL_GQL, { slug: item.slug });
    const detailVariant = detailRes.data.product.variants[0];
    console.log(`Detail: ${detailRes.data.product.name}, Price: ${detailVariant.priceWithTax}, Currency: ${detailVariant.currencyCode}`);
    
    if (searchPrice === detailVariant.priceWithTax) {
        console.log('✅ SUCCESS: Search and Detail prices match.');
    } else {
        console.log('❌ FAILURE: Price discrepancy found.');
    }
}

verify().catch(console.error);
