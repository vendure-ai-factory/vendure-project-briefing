import { query } from './src/lib/vendure/api';
import { SearchProductsQuery, GetProductDetailQuery } from './src/lib/vendure/queries';
import { ProductCardFragment } from './src/lib/vendure/fragments';
import { readFragment } from './src/graphql';

async function verify() {
    console.log('--- Verification Started ---');
    const country = 'HU';
    const channelToken = 'hungary-channel';
    
    // 1. Search for a product (e.g. slug 'organic-almond-milk' or similar)
    // We'll just search for empty string to get first products
    const searchRes = await query(SearchProductsQuery, { 
        input: { term: "" } 
    }, { channelToken });
    
    const searchItemMasked = searchRes.data.search.items[0];
    if (!searchItemMasked) {
        console.log('No search items found.');
        return;
    }

    const searchItem = readFragment(ProductCardFragment, searchItemMasked);
    
    console.log(`Search Item: ${searchItem.productName}, Price: ${JSON.stringify(searchItem.priceWithTax)}, Currency: ${searchItem.currencyCode}`);
    
    // 2. Get detail for the same product
    const detailRes = await query(GetProductDetailQuery, { 
        slug: searchItem.slug || ''
    }, { channelToken });
    
    const product = detailRes.data.product;
    if (!product) {
        console.log('Product not found in detail query.');
        return;
    }
    const variant = product.variants[0];
    console.log(`Detail Variant: ${variant.name}, Price: ${variant.priceWithTax}, Currency: ${variant.currencyCode}`);
    
    // Compare
    const searchPrice = searchItem.priceWithTax.__typename === 'PriceRange' ? searchItem.priceWithTax.min : searchItem.priceWithTax.value;
    const detailPrice = variant.priceWithTax;
    
    if (searchPrice === detailPrice) {
        console.log('SUCCESS: Prices match!');
    } else {
        console.log(`FAILURE: Price mismatch! Search=${searchPrice}, Detail=${detailPrice}`);
    }
}

verify().catch(console.error);
