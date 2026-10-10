import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { VendorSidebar } from "@/components/layout/vendor-sidebar"
import { Suspense } from "react"

export default function VendorLayout({ children }: { children: React.ReactNode }) {
    return (
        <SidebarProvider>
            <Suspense fallback={<div className="w-64 h-screen bg-muted animate-pulse" />}>
                <VendorSidebar />
            </Suspense>
            <main className="w-full">
                <div className="p-4">
                    <SidebarTrigger />
                    <Suspense fallback={<div className="p-8 animate-pulse">Loading dashboard...</div>}>
                        {children}
                    </Suspense>
                </div>
            </main>
        </SidebarProvider>
    )
}
