import { fetchNailProfiles } from '@/lib/vendure/nail-api';
import type { Metadata } from 'next';
import { query, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { GetProductDetailQuery } from '@/lib/vendure/queries';
import { ProductView } from '@/components/commerce/product-view';
import { RelatedProducts } from '@/components/commerce/related-products';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { notFound } from 'next/navigation';
import { cacheLife, cacheTag } from 'next/cache';
import {
    SITE_NAME,
    truncateDescription,
    buildCanonicalUrl,
    buildOgImages,
} from '@/lib/metadata';

async function getProductData(slug: string, channelToken?: string) {
    console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] getProductData start: slug=${slug}, channel=${channelToken}`);
    try {
        const res = await query(GetProductDetailQuery, { slug }, { channelToken, suppressDynamics: true });
        console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] getProductData success: slug=${slug}`);
        return res;
    } catch (e) {
        console.error(`[DEBUG-PAGE] [${new Date().toISOString()}] getProductData ERROR: slug=${slug}, error=${e instanceof Error ? e.message : e}`);
        throw e;
    }
}

export async function generateMetadata({
    params,
}: { params: Promise<{ country: string; slug: string }> }): Promise<Metadata> {
    const { country, slug } = await params;
    const decodedSlug = decodeURIComponent(slug);

    // In Path Mode, we strictly use the country from the URL segments
    const channelToken = COUNTRY_CHANNEL_MAP[country.toLowerCase()];

    // We no longer loop through multiple channels. One products, one channel.
    let product: any = null;
    try {
        const result = await getProductData(decodedSlug, channelToken);
        if (result?.data?.product) {
            product = result.data.product;
        }
    } catch (e) {
        // Silently fail metadata for missing products
    }

    if (!product) {
        return {
            title: 'Product Not Found',
        };
    }

    const description = truncateDescription(product.description);
    const ogImage = product.assets?.[0]?.preview;

    return {
        title: product.name,
        description: description || `Shop ${product.name} at ${SITE_NAME}`,
        alternates: {
            canonical: buildCanonicalUrl(`/${country.toLowerCase()}/product/${product.slug}`),
        },
        openGraph: {
            title: product.name,
            description: description || `Shop ${product.name} at ${SITE_NAME}`,
            type: 'website',
            url: buildCanonicalUrl(`/${country.toLowerCase()}/product/${product.slug}`),
            images: buildOgImages(ogImage, product.name),
        },
        twitter: {
            card: 'summary_large_image',
            title: product.name,
            description: description || `Shop ${product.name} at ${SITE_NAME}`,
            images: ogImage ? [ogImage] : undefined,
        },
    };
}

export default async function ProductDetailPage({ params, searchParams }: { 
    params: Promise<{ country: string; slug: string }>;
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
    const { country, slug } = await params;
    const searchParamsResolved = await searchParams;
    const decodedSlug = decodeURIComponent(slug);

    // Strictly resolve channel from URL path
    const channelToken = COUNTRY_CHANNEL_MAP[country.toLowerCase()];

    if (!channelToken) {
        notFound();
    }

    let product: any = null;
    console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] ProductDetailPage body start: country=${country}, slug=${decodedSlug}`);
    try {
        const result = await getProductData(decodedSlug, channelToken);
        if (result?.data?.product) {
            product = result.data.product;
            console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] ProductDetailPage product found: ${product.name}`);
        } else {
            console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] ProductDetailPage product NOT found in Vendure`);
        }
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[DEBUG-PAGE] [${new Date().toISOString()}] ProductDetailPage catch error: ${errorMessage}`);
        
        // If Vendure specifically says no price was found, it means the product is effectively 
        // unavailable in this channel. Return 404.
        if (errorMessage.includes('No price information was found')) {
            notFound();
        }
        // Don't swallow other errors here yet for debugging
        throw e;
    }

    if (!product) {
        console.log(`[DEBUG-PAGE] [${new Date().toISOString()}] ProductDetailPage triggering notFound()`);
        notFound();
    }

    // Fetch Nail Profiles Server-Side
    let initialProfiles: any[] = [];
    try {
        initialProfiles = await fetchNailProfiles();
    } catch (e) {
        // Silently fail nail profiles fetch
    }

    const primaryCollection = product.collections?.find((c: any) => c.parent?.id) ?? product.collections?.[0];

    return (
        <>
            <div className="container mx-auto px-4 py-8 mt-16">
                <ProductView product={product} searchParams={searchParamsResolved} initialProfiles={initialProfiles} country={country} />
            </div>

            {/* Product Benefits Section */}
            <section className="py-16 bg-muted/30 mt-12">
                <div className="container mx-auto px-4">
                    <h2 className="text-2xl font-bold text-center mb-8">Why Choose Us</h2>
                    <div className="grid md:grid-cols-3 gap-8 text-center">
                        <div className="space-y-3">
                            <div className="w-12 h-12 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                                <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                                </svg>
                            </div>
                            <h3 className="text-xl font-semibold">Premium Quality</h3>
                            <p className="text-muted-foreground">Crafted with care using the finest materials</p>
                        </div>
                        <div className="space-y-3">
                            <div className="w-12 h-12 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                                <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                </svg>
                            </div>
                            <h3 className="text-xl font-semibold">Eco-Friendly</h3>
                            <p className="text-muted-foreground">Sustainably sourced and environmentally conscious</p>
                        </div>
                        <div className="space-y-3">
                            <div className="w-12 h-12 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                                <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                </svg>
                            </div>
                            <h3 className="text-xl font-semibold">Satisfaction Guaranteed</h3>
                            <p className="text-muted-foreground">100% happiness or your money back</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Store FAQ Section */}
            <section className="py-16 bg-muted/30">
                <div className="container mx-auto px-4 max-w-3xl">
                    <h2 className="text-2xl font-bold text-center mb-8">Frequently Asked Questions</h2>
                    <Accordion type="single" collapsible className="w-full">
                        <AccordionItem value="shipping">
                            <AccordionTrigger>What are your shipping options?</AccordionTrigger>
                            <AccordionContent>
                                We offer standard shipping (5-7 business days), express shipping (2-3 business days), and next-day delivery for select areas. Free standard shipping is available on orders over $50.
                            </AccordionContent>
                        </AccordionItem>
                        <AccordionItem value="returns">
                            <AccordionTrigger>What is your return policy?</AccordionTrigger>
                            <AccordionContent>
                                We accept returns within 30 days of purchase. Items must be unused and in their original packaging. Simply contact our support team to initiate a return and receive a prepaid shipping label.
                            </AccordionContent>
                        </AccordionItem>
                        <AccordionItem value="tracking">
                            <AccordionTrigger>How can I track my order?</AccordionTrigger>
                            <AccordionContent>
                                Once your order ships, you&apos;ll receive an email with a tracking number. You can also view your order status anytime by logging into your account and visiting the order history section.
                            </AccordionContent>
                        </AccordionItem>
                        <AccordionItem value="international">
                            <AccordionTrigger>Do you offer international shipping?</AccordionTrigger>
                            <AccordionContent>
                                Yes! We ship to over 50 countries worldwide. International shipping rates and delivery times vary by location. You can see the exact cost at checkout before completing your purchase.
                            </AccordionContent>
                        </AccordionItem>
                    </Accordion>
                </div>
            </section>

            {primaryCollection && (
                <RelatedProducts
                    collectionSlug={primaryCollection.slug}
                    currentProductId={product.id}
                    countryCode={country}
                />
            )}
        </>
    );
}
