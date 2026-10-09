import { query, mutate, COUNTRY_CHANNEL_MAP } from './src/lib/vendure/api';
import { graphql } from './src/graphql';

const GET_PRODUCTS_IN_CHANNEL = graphql(`
    query GetProductsInChannel {
        products(options: { take: 100 }) {
            items {
                id
                name
                slug
                customFields {
                    countryCode
                }
            }
        }
    }
`);

const UPDATE_PRODUCT_COUNTRY_CODE = graphql(`
    mutation UpdateProductCountryCode($id: ID!, $countryCode: String!) {
        updateProduct(input: { id: $id, customFields: { countryCode: $countryCode } }) {
            id
            customFields {
                countryCode
            }
        }
    }
`);

async function fix() {
    console.log('--- Starting Product Country Code Fix ---');

    for (const [country, channelToken] of Object.entries(COUNTRY_CHANNEL_MAP)) {
        if (country.length !== 2) continue; // Skip full names like 'Germany'
        
        const normalizedCountry = country.toUpperCase();
        console.log(`\nChecking channel: ${channelToken} (Target: ${normalizedCountry})`);

        try {
            const res = await query(GET_PRODUCTS_IN_CHANNEL, {}, { channelToken });
            const products = res.data.products.items;
            
            console.log(`Found ${products.length} products in ${channelToken}`);

            for (const product of products) {
                const currentCode = product.customFields?.countryCode;
                if (currentCode !== normalizedCountry) {
                    console.log(`  Updating [${product.name}] (${product.id}): ${currentCode || 'NONE'} -> ${normalizedCountry}`);
                    await mutate(UPDATE_PRODUCT_COUNTRY_CODE, { 
                        id: product.id, 
                        countryCode: normalizedCountry 
                    }, { channelToken });
                } else {
                    console.log(`  [${product.name}] already correct: ${normalizedCountry}`);
                }
            }
        } catch (e) {
            console.error(`Error processing channel ${channelToken}:`, e);
        }
    }

    console.log('\n--- Fix Completed ---');
}

fix().catch(console.error);
