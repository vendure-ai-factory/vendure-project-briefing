import { query } from '../src/lib/vendure/api';
import { SearchProductsQuery, GetProductDetailQuery } from '../src/lib/vendure/queries';

async function comparePrices(sku: string, country: string) {
    const channelToken = 'hungary-channel'; // HU channel
    console.log(`\n--- 🕵️ Diagnostic: Price Discrepancy Check [${country}] ---`);
    
    // 1. Fetch from Listing (Search)
    const searchRes = await query(SearchProductsQuery, { 
        input: { term: sku, groupByProduct: true } 
    }, { channelToken });
    
    const listingPrice = searchRes.data?.search?.items?.[0]?.priceWithTax;
    console.log(`[Listing] Price:`, listingPrice);

    // 2. Fetch from Detail
    const slug = searchRes.data?.search?.items?.[0]?.slug;
    if (slug) {
        const detailRes = await query(GetProductDetailQuery, { slug }, { channelToken });
        const variant = detailRes.data?.product?.variants?.find(v => v.sku === sku);
        console.log(`[Detail] Price:`, variant?.priceWithTax);
        
        if (listingPrice && variant) {
            const listVal = listingPrice.__typename === 'SinglePrice' ? listingPrice.value : (listingPrice as any).min;
            const diff = listVal - variant.priceWithTax;
            if (diff !== 0) {
                console.error(`❌ DISCREPANCY DETECTED: Delta = ${diff}`);
            } else {
                console.log(`✅ PRICES MATCH`);
            }
        }
    }
}

comparePrices('MC-TEST-SKU-HU', 'HU').catch(console.error);
