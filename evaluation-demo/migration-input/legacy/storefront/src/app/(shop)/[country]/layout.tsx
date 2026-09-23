import { Suspense } from "react";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { MergeBanner } from "@/components/layout/merge-banner";
import { ChannelSync } from "@/components/commerce/channel-sync";

export default function ShopLayout({ 
    children,
    params 
}: { 
    children: React.ReactNode;
    params: Promise<{ country: string }>;
}) {
    // Note: We do NOT await params here. 
    // Data fetching or param resolution happens inside Suspense-wrapped children.

    return (
        <div className="flex flex-col min-h-screen">
            <ChannelSync />
            <Suspense fallback={null}>
                <MergeBanner />
            </Suspense>
            
            <Suspense fallback={<div className="h-16 border-b bg-background" />}>
                <NavbarWrapper params={params} />
            </Suspense>
            
            <main className="flex-1">{children}</main>
            
            <Suspense fallback={<div className="h-64 border-t bg-muted/30" />}>
                <FooterWrapper params={params} />
            </Suspense>
        </div>
    );
}

async function NavbarWrapper({ params }: { params: Promise<{ country: string }> }) {
    const { country } = await params;
    return <Navbar countryCode={country} />;
}

async function FooterWrapper({ params }: { params: Promise<{ country: string }> }) {
    const { country } = await params;
    return <Footer countryCode={country} />;
}
