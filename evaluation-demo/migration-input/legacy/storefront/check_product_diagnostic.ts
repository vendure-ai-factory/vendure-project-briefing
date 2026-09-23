import { query } from './src/lib/vendure/api';
import { graphql } from './src/graphql';

const CheckProductOrVariant = graphql(`
    query CheckProductOrVariant($slug: String!, $sku: String!) {
        product(slug: $slug) {
            id
            name
            slug
        }
        productVariants(options: { filter: { sku: { eq: $sku } } }) {
            items {
                id
                name
                sku
                product {
                    id
                    name
                    slug
                }
            }
        }
    }
`);

async function main() {
    const slug = '6-sku-20260226-093645';
    const result = await query(CheckProductOrVariant, { slug, sku: slug });
    console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
