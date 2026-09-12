import { Suspense } from "react";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";

export default function ShopLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <Suspense>
                <Navbar />
            </Suspense>
            <main className="flex-1">{children}</main>
            <Suspense>
                <Footer />
            </Suspense>
        </>
    );
}
