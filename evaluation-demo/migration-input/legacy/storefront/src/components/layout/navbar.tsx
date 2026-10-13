import Image from "next/image";
import Link from "next/link";
import { LocalizedLink } from '@/components/ui/localized-link';
import { NavbarCollections, NavbarCollectionsProps } from '@/components/layout/navbar/navbar-collections';
import { NavbarCart } from '@/components/layout/navbar/navbar-cart';
import { NavbarUser } from '@/components/layout/navbar/navbar-user';
import { ThemeSwitcher } from '@/components/layout/navbar/theme-switcher';
import { Suspense } from "react";
import { SearchInput } from '@/components/layout/search-input';
import { NavbarUserSkeleton } from '@/components/shared/skeletons/navbar-user-skeleton';
import { SearchInputSkeleton } from '@/components/shared/skeletons/search-input-skeleton';

export function Navbar({ countryCode }: { countryCode?: string }) {
    return (
        <header className="fixed top-0 left-0 right-0 z-50 border-b bg-background" suppressHydrationWarning>
            <div className="container mx-auto px-4">
                <div className="flex items-center justify-between h-16">
                    <div className="flex items-center gap-8">
                        <LocalizedLink href="/" className="text-xl font-bold" countryCode={countryCode}>
                            <Image src="/vendure.svg" alt="Vendure" width={40} height={27} className="h-6 w-auto dark:invert" />
                        </LocalizedLink>
                        <nav className="hidden md:flex items-center gap-6">
                            <Suspense>
                                <NavbarCollections countryCode={countryCode} />
                            </Suspense>
                        </nav>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="hidden lg:flex">
                            <Suspense fallback={<SearchInputSkeleton />}>
                                <SearchInput />
                            </Suspense>
                        </div>
                        <ThemeSwitcher />
                        <Suspense>
                            <NavbarCart />
                        </Suspense>
                        <Suspense fallback={<NavbarUserSkeleton />}>
                            <NavbarUser />
                        </Suspense>
                    </div>
                </div>
            </div>
        </header>
    );
}